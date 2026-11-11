import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { placeOrder } from './orders.js';
import type { FillClassificationAction } from '@buddha/shared';
import {
  applyFillClassification,
  lockFillClassificationDecision,
  readFillClassification,
} from './fill-classification.js';
import { isFillExcludedSql } from './fill-classification-read.js';
import { settleMarketPositions } from './market-settlement.js';
import { transitionMarket } from './market-transitions.js';
import { hasMarketFill } from './market-dispute.js';
import { lockAdminRoles, lockMarket, clockTimestamp } from './tx-helpers.js';
import {
  approvalRequests,
  balances,
  fillClassifications,
  fills,
  ledgerEntries,
  markets,
  orders,
  positions,
  profiles,
} from './schema/index.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import {
  createApprovalRequest,
  createMarket,
  createMarketPause,
  createUser,
} from './test/factories.js';
import { checkMarketStats, openOrderIntake, placeTestOrder } from './test/orders.js';
import { mintTestPairs, withLedgerGuardsOff } from './test/ledger.js';

describe.skipIf(!hasTestDb())('immutable individual fill classifications (#132)', () => {
  let t: TestDb;
  let asker: string, decider: string, a: string, b: string, marketId: string, fillId: number;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    asker = (await createUser(t.db, { role: 'admin' })).user.id;
    decider = (await createUser(t.db, { role: 'admin' })).user.id;
    a = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    b = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    await openOrderIntake(t.db, { adminId: asker });
    marketId = (await createMarket(t.db, { createdBy: asker })).id;
    fillId = await pair();
  });
  async function pair(other = b) {
    const first = await placeTestOrder(t.db, {
      ownerId: other,
      marketId,
      outcome: 'NO',
      side: 'buy',
      limitPriceCoin: 40,
      qty: 1,
      timeInForce: 'gtc',
    });
    expect(first.kind).toBe('placed');
    const second = await placeTestOrder(t.db, {
      ownerId: a,
      marketId,
      outcome: 'YES',
      side: 'buy',
      limitPriceCoin: 60,
      qty: 1,
      timeInForce: 'gtc',
    });
    if (second.kind !== 'placed' || second.fills.length !== 1)
      throw new Error('expected actual pair fill');
    return second.fills[0]!.id;
  }
  async function request(action: FillClassificationAction = 'mark', target = fillId) {
    const current = await readFillClassification(t.db, target);
    return createApprovalRequest(t.db, {
      kind: 'fill_classification',
      targetType: 'fill',
      targetId: String(target),
      requestedBy: asker,
      reason: '확인된 인위적 거래량에 대한 운영 근거',
      payload: {
        fillId: String(target),
        marketId,
        action,
        baseRevision: String(current?.revision ?? 0n),
      },
    });
  }
  async function approve(id: string, by = decider) {
    return t.db.transaction(async (tx) => {
      const [r] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, id));
      await lockMarket(tx, marketId);
      await lockAdminRoles(tx, 'shared');
      await lockFillClassificationDecision(
        tx,
        r!.payload as {
          fillId: string;
          marketId: string;
          action: FillClassificationAction;
          baseRevision: string;
        },
      );
      await tx
        .update(approvalRequests)
        .set({
          status: 'approved',
          decidedBy: by,
          decisionReason: '독립 검토 완료',
          decidedAt: await clockTimestamp(tx),
        })
        .where(eq(approvalRequests.id, id));
      return applyFillClassification(tx, id);
    });
  }
  const market = async () =>
    (await t.db.select().from(markets).where(eq(markets.id, marketId)))[0]!;
  const economics = async () => ({
    fills: await t.db.select().from(fills).orderBy(fills.id),
    orders: await t.db.select().from(orders).orderBy(orders.id),
    positions: await t.db
      .select()
      .from(positions)
      .orderBy(positions.userId, positions.marketId, positions.outcome),
    ledger: await t.db.select().from(ledgerEntries).orderBy(ledgerEntries.id),
    balances: await t.db.select().from(balances).orderBy(balances.accountId),
  });
  it('marks and clears without changing raw economic history, prices or eligibility', async () => {
    const before = await economics(),
      m = await market();
    const marked = await approve((await request()).id);
    expect(marked.stats).toMatchObject({
      marketId,
      traderCount: 0,
      statsRevision: String(m.statsRevision + 1n),
    });
    expect(await economics()).toEqual(before);
    expect(await market()).toMatchObject({
      lastPrice: m.lastPrice,
      lastFillAt: m.lastFillAt,
      volumeCoin: m.volumeCoin,
      tradeCount: m.tradeCount,
      traderCount: 0,
    });
    expect(await hasMarketFill(t.db, a, marketId)).toBe(true);
    expect(await checkMarketStats(t.db)).toEqual([]);
    await approve((await request('clear')).id);
    expect((await market()).traderCount).toBe(2);
    expect(await economics()).toEqual(before);
    expect(await t.db.select().from(fillClassifications)).toHaveLength(2);
  });
  it('counts a participant with another normal fill and restores a previously excluded person on a new fill', async () => {
    const c = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    const second = await pair(c);
    await approve((await request('mark', fillId)).id);
    expect((await market()).traderCount).toBe(2); // a and c remain, b has no normal fill.
    await approve((await request('mark', second)).id);
    expect((await market()).traderCount).toBe(0);
    await pair();
    expect((await market()).traderCount).toBe(2);
    await approve((await request('clear', fillId)).id);
    expect((await market()).traderCount).toBe(2);
    expect(await checkMarketStats(t.db)).toEqual([]);
  });
  it('keeps a committed decision cutoff stable through a later clear', async () => {
    const marked = await approve((await request()).id);
    await approve((await request('clear')).id);
    const [row] = await t.db
      .select({
        old: isFillExcludedSql(sql`${fillId}`, sql`${marked.execution.revision}`),
        current: isFillExcludedSql(sql`${fillId}`),
      })
      .from(fills)
      .limit(1);
    expect(row).toEqual({ old: true, current: false });
  });
  it('serializes competing requests and refuses stale ones without extra decisions', async () => {
    const first = await request(),
      second = await request();
    const results = await Promise.allSettled([approve(first.id), approve(second.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await t.db.select().from(fillClassifications)).toHaveLength(1);
    expect(
      await t.db.select().from(approvalRequests).where(eq(approvalRequests.status, 'pending')),
    ).toHaveLength(1);
    expect(await checkMarketStats(t.db)).toEqual([]);
  });
  it('is idempotent for the same completed approval', async () => {
    const r = await request();
    await approve(r.id);
    const before = await market();
    const again = await t.db.transaction((tx) => applyFillClassification(tx, r.id));
    expect(again.outcome).toBe('duplicate');
    expect(again.stats).toBeNull();
    expect(await market()).toEqual(before);
  });
  it('requires two current administrators and preserves a pending request after refusal', async () => {
    const r = await request();
    await expect(approve(r.id, asker)).rejects.toThrow();
    await t.db.transaction(async (tx) => {
      await lockAdminRoles(tx, 'exclusive');
      await tx.update(profiles).set({ role: 'user' }).where(eq(profiles.userId, asker));
    });
    await expect(approve(r.id)).rejects.toThrow();
    expect(
      (await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, r.id)))[0]?.status,
    ).toBe('pending');
    expect(await t.db.select().from(fillClassifications)).toEqual([]);
  });
  it('refuses approval-only commits, immutable record changes and wrong fill bindings', async () => {
    const r = await request();
    await expect(
      t.db.transaction(async (tx) => {
        await lockMarket(tx, marketId);
        await lockAdminRoles(tx, 'shared');
        await tx
          .update(approvalRequests)
          .set({
            status: 'approved',
            decidedBy: decider,
            decisionReason: '근거',
            decidedAt: await clockTimestamp(tx),
          })
          .where(eq(approvalRequests.id, r.id));
      }),
    ).rejects.toHaveProperty(
      'cause.message',
      'approved classification requires immutable decision',
    );
    const completed = await approve(r.id);
    await expect(
      t.db
        .update(fillClassifications)
        .set({ action: 'clear' })
        .where(eq(fillClassifications.revision, completed.execution.revision)),
    ).rejects.toThrow();
    await expect(
      t.db
        .delete(fillClassifications)
        .where(eq(fillClassifications.revision, completed.execution.revision)),
    ).rejects.toThrow();
  });
  it('rolls back approval, record and participant projection after later failure', async () => {
    const r = await request(),
      before = await market(),
      books = await economics();
    await expect(
      t.db.transaction(async (tx) => {
        await lockMarket(tx, marketId);
        await lockAdminRoles(tx, 'shared');
        await tx
          .update(approvalRequests)
          .set({
            status: 'approved',
            decidedBy: decider,
            decisionReason: '근거',
            decidedAt: await clockTimestamp(tx),
          })
          .where(eq(approvalRequests.id, r.id));
        await applyFillClassification(tx, r.id);
        throw new Error('later failure');
      }),
    ).rejects.toThrow('later failure');
    expect(await market()).toEqual(before);
    expect(await economics()).toEqual(books);
    expect(await t.db.select().from(fillClassifications)).toEqual([]);
  });
  it('rechecks a classified market after a forced constraint flush and later corrupt projection', async () => {
    const r = await request(),
      before = await market(),
      books = await economics();
    await expect(
      t.db.transaction(async (tx) => {
        await lockMarket(tx, marketId);
        await lockAdminRoles(tx, 'shared');
        await tx
          .update(approvalRequests)
          .set({
            status: 'approved',
            decidedBy: decider,
            decisionReason: '근거',
            decidedAt: await clockTimestamp(tx),
          })
          .where(eq(approvalRequests.id, r.id));
        await applyFillClassification(tx, r.id);
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        await tx
          .update(markets)
          .set({ traderCount: 7, statsRevision: before.statsRevision })
          .where(eq(markets.id, marketId));
      }),
    ).rejects.toHaveProperty('cause.message', 'classification requires participant projection');
    expect(await market()).toEqual(before);
    expect(await economics()).toEqual(books);
    expect(await t.db.select().from(fillClassifications)).toEqual([]);
    expect(
      (await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, r.id)))[0]?.status,
    ).toBe('pending');
  });
  it('allows a normal fill after a classification constraint flush and preserves its newer participant revision', async () => {
    await placeTestOrder(t.db, {
      marketId,
      ownerId: b,
      outcome: 'NO',
      side: 'buy',
      limitPriceCoin: 40,
      qty: 1,
      timeInForce: 'gtc',
    });
    const r = await request();
    await t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      await lockAdminRoles(tx, 'shared');
      await tx
        .update(approvalRequests)
        .set({
          status: 'approved',
          decidedBy: decider,
          decisionReason: '근거',
          decidedAt: await clockTimestamp(tx),
        })
        .where(eq(approvalRequests.id, r.id));
      await applyFillClassification(tx, r.id);
      await tx.execute(
        sql`SET CONSTRAINTS fill_classifications_complete,fill_classification_market_stats_complete IMMEDIATE`,
      );
      const placed = await placeOrder(tx, {
        marketId,
        ownerId: a,
        requestId: randomUUID(),
        outcome: 'YES',
        side: 'buy',
        limitPriceCoin: 60,
        qty: 1,
        budgetCoin: null,
        timeInForce: 'gtc',
      });
      expect(placed.kind).toBe('placed');
      if (placed.kind !== 'placed') throw Error('expected actual fill');
      expect(placed.fills).toHaveLength(1);
    });
    expect(await market()).toMatchObject({ tradeCount: 2, traderCount: 2, statsRevision: 3n });
    expect(await checkMarketStats(t.db)).toEqual([]);
  });
  it('does not require or repair economic assets when classifying a damaged book', async () => {
    const r = await request();
    await withLedgerGuardsOff((client) =>
      client.query(
        'DELETE FROM balances WHERE account_id=(SELECT id FROM ledger_accounts WHERE kind=$1 AND owner_id=$2)',
        ['user', a],
      ),
    );
    const before = await economics();
    await approve(r.id);
    expect((await market()).traderCount).toBe(0);
    expect(await economics()).toEqual(before);
  });
  it('does not accept temp-table approval or participant projections in place of the public records', async () => {
    const pending = await request();
    const before = await economics();
    const [market] = await t.db.select().from(markets).where(eq(markets.id, marketId));
    await expect(
      t.db.transaction(async (tx) => {
        await tx.execute(
          sql`CREATE TEMP TABLE approval_requests (LIKE public.approval_requests INCLUDING DEFAULTS) ON COMMIT DROP`,
        );
        await tx.execute(
          sql`INSERT INTO pg_temp.approval_requests SELECT * FROM public.approval_requests WHERE id=${pending.id}::uuid`,
        );
        await tx.execute(
          sql`UPDATE pg_temp.approval_requests SET status='approved',decided_by=${decider},decision_reason='forged',decided_at=clock_timestamp() WHERE id=${pending.id}::uuid`,
        );
        await tx.execute(
          sql`CREATE TEMP TABLE markets (LIKE public.markets INCLUDING DEFAULTS) ON COMMIT DROP`,
        );
        await tx.execute(
          sql`INSERT INTO pg_temp.markets SELECT * FROM public.markets WHERE id=${marketId}::uuid`,
        );
        await tx.execute(sql`INSERT INTO public.fill_classifications
        (revision,approval_id,fill_id,market_id,action,base_revision,before_stats_revision,after_stats_revision,requested_by,approved_by,performed_at,applied_txid)
        VALUES(1,${pending.id}::uuid,${fillId},${marketId}::uuid,'mark',0,${market!.statsRevision},${market!.statsRevision + 1n},${asker},${decider},clock_timestamp(),pg_current_xact_id()::text)`);
        await tx.execute(
          sql`UPDATE pg_temp.markets SET trader_count=0,stats_revision=stats_revision+1 WHERE id=${marketId}::uuid`,
        );
      }),
    ).rejects.toHaveProperty('cause.message', 'classification approved request binding');
    expect(await economics()).toEqual(before);
    expect(await t.db.select().from(fillClassifications)).toEqual([]);
    expect(
      (await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, pending.id)))[0]
        ?.status,
    ).toBe('pending');
  });
  it('keeps ledger holds, pause history and market status intact while excluding only statistics', async () => {
    await createMarketPause(t.db, { marketId, by: asker, reason: 'ledger_failure' });
    const before = await market(),
      books = await economics();
    const pending = await request();
    await approve(pending.id);
    expect(await market()).toMatchObject({
      status: before.status,
      statusEventId: before.statusEventId,
      tradeCount: before.tradeCount,
      volumeCoin: before.volumeCoin,
      traderCount: 0,
    });
    expect(await economics()).toEqual(books);
  });
  it('classifies a settled historical fill without changing payout or position settlement records', async () => {
    const legacy = await createMarket(t.db, {
      createdBy: asker,
      status: 'settling',
      resolvedResult: 'YES',
      judgementVersion: null,
    });
    marketId = legacy.id;
    await mintTestPairs(t.db, {
      marketId,
      yesHolderId: a,
      noHolderId: b,
      qty: 1,
      yesPriceCoin: 60,
    });
    fillId = (await t.db.select().from(fills).where(eq(fills.marketId, marketId)))[0]!.id;
    await t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const paid = await settleMarketPositions(tx, marketId);
      await transitionMarket(tx, {
        marketId,
        from: 'settling',
        to: 'settled',
        type: 'finalized',
        actorId: null,
        payload: {
          result: 'YES',
          settledAccounts: paid.settledAccounts,
          paidAccounts: paid.paidAccounts,
          paidCoin: paid.paidCoin.toString(),
          positions: paid.positions,
        },
        at: paid.at,
        set: { settledAt: paid.at },
      });
    });
    const before = await market(),
      books = await economics();
    const records = (
      await t.db.execute(sql`SELECT * FROM position_settlements ORDER BY market_id,user_id,outcome`)
    ).rows;
    const pending = await request();
    await approve(pending.id);
    expect(await market()).toMatchObject({
      status: 'settled',
      settledAt: before.settledAt,
      statusEventId: before.statusEventId,
      traderCount: 0,
    });
    expect(await economics()).toEqual(books);
    expect(
      (
        await t.db.execute(
          sql`SELECT * FROM position_settlements ORDER BY market_id,user_id,outcome`,
        )
      ).rows,
    ).toEqual(records);
  });
});
