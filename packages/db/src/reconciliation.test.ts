import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { orderBookOf, quoteOrder } from '@buddha/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeMarketAtClose } from './market-close.js';
import { endMarketPause } from './market-pause.js';
import { openScheduledMarket } from './market-open.js';
import { lockForOrder } from './contracts.js';
import { readMarketTradingFacts, readPublicBook } from './order-book.js';
import { ledgerHeldMarketIds } from './ledger-held-markets.js';
import { expireLockedOrders, lockMarketOrders } from './order-cancel.js';
import { settleMarketPositions } from './market-settlement.js';
import {
  activeReconciliationHold,
  lockReconciliationUser,
  reconciliationMarketKey,
  reconciliationUserKey,
  runAccountReconciliation,
  runMarketReconciliation,
  runSupplyReconciliation,
  selectDueMarketReconciliationIds,
  selectReconciliationAccountTargets,
} from './reconciliation-audit.js';
import { recoverReconciliationHold } from './reconciliation-recovery.js';
import { previewReconciliationCorrections } from './reconciliation-correction.js';
import {
  markets,
  balances,
  orders,
  positions,
  ledgerEntries,
  marketPauses,
  reconciliationHolds,
  reconciliationRecoveries,
  reconciliationResults,
  auditFailures,
} from './schema/index.js';
import {
  createApprovalRequest,
  closeAccount,
  createMarket,
  createMarketPause,
  createScheduledMarket,
  createUser,
  createPosition,
  createProvisionalMarket,
  resolveMarketNow,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import {
  balanceOf,
  fundMarketMakerFunds,
  mintTestPairs,
  withLedgerGuardsOff,
} from './test/ledger.js';
import {
  cancelTestOrder,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
} from './test/orders.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

describe.skipIf(!hasTestDb())('reconciliation and persistent recovery (#93)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
  });
  const audit = (id: string) =>
    t.db.transaction((tx) => runMarketReconciliation(tx, id, { source: 'manual' }));
  const account = (id: string) =>
    t.db.transaction((tx) => runAccountReconciliation(tx, { userId: id }, { source: 'manual' }));
  async function admins() {
    return {
      requester: (await createUser(t.db, { role: 'admin' })).user.id,
      approver: (await createUser(t.db, { role: 'admin' })).user.id,
    };
  }
  async function bumpUser(userId: string, amount: bigint) {
    await withLedgerGuardsOff((c) =>
      c.query('UPDATE balances SET available_coin=available_coin+$1 WHERE user_id=$2', [
        String(amount),
        userId,
      ]),
    );
  }
  async function bumpCollateral(marketId: string, amount: bigint) {
    await withLedgerGuardsOff((c) =>
      c.query(
        "UPDATE balances SET available_coin=available_coin+$1 WHERE account_id=(SELECT id FROM ledger_accounts WHERE kind='market_collateral' AND market_id=$2)",
        [String(amount), marketId],
      ),
    );
  }
  async function paired() {
    const market = await createMarket(t.db);
    const yes = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    const no = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: yes,
      noHolderId: no,
      qty: 2,
      yesPriceCoin: 60,
    });
    return { market, yes, no };
  }
  async function approve(
    hold: typeof reconciliationHolds.$inferSelect,
    actors: Awaited<ReturnType<typeof admins>>,
  ) {
    const approval = await createApprovalRequest(t.db, {
      kind: 'reconciliation_recovery',
      targetType: 'reconciliation_hold',
      targetId: hold.id,
      payload: {
        holdId: hold.id,
        failureResultId: hold.failureResultId === null ? null : String(hold.failureResultId),
      },
      requestedBy: actors.requester,
      decision: { status: 'approved', by: actors.approver },
    });
    return {
      holdId: hold.id,
      failureResultId: hold.failureResultId,
      approvalId: approval.id,
      requestedBy: actors.requester,
      approverId: actors.approver,
    };
  }

  it('passes normal pairs, bot funds, account books and total Coin without creating holds', async () => {
    const { market, yes, no } = await paired();
    await fundMarketMakerFunds(t.db, market.id, 300n);
    expect((await audit(market.id)).result.passed).toBe(true);
    expect((await account(yes)).result.passed).toBe(true);
    expect((await account(no)).result.passed).toBe(true);
    expect(
      (await t.db.transaction((tx) => runSupplyReconciliation(tx, { source: 'manual' }))).result
        .passed,
    ).toBe(true);
    expect(await t.db.select().from(reconciliationHolds)).toEqual([]);
    const targets = await selectReconciliationAccountTargets(t.db);
    expect(targets).toEqual(expect.arrayContaining([{ userId: yes }, { userId: no }]));
  });

  it.each(['open', 'settling'] as const)(
    'records and holds a closed positive holder in %s',
    async (status) => {
      const { market, yes } = await paired();
      await t.db
        .update(markets)
        .set({ status, resolvedResult: status === 'settling' ? 'YES' : null })
        .where(eq(markets.id, market.id));
      // The closure fixture preserves legacy positive holdings, unlike normal closure intake.
      await closeAccount(t.db, yes);
      const before = {
        positions: await t.db.select().from(positions),
        entries: await t.db.select().from(ledgerEntries),
      };
      const run = await audit(market.id);
      expect(run.result.passed).toBe(false);
      expect(run.result.findings).toContainEqual({
        code: 'closed_position_holder',
        expected: '0',
        actual: '2',
        detail: `${yes}:YES`,
      });
      expect(run.hold?.failureResultId).toBe(run.result.id);
      expect((await t.db.select().from(auditFailures))[0]!.payload).toMatchObject({
        resultId: String(run.result.id),
      });
      expect(await t.db.select().from(positions)).toEqual(before.positions);
      expect(await t.db.select().from(ledgerEntries)).toEqual(before.entries);
      expect(run.statusEvent?.status ?? status).toBe(status === 'open' ? 'paused' : 'settling');
    },
  );

  it.each(['open', 'settling'] as const)(
    'records and holds orphan cost on a zero holding in %s without swallowing execution errors',
    async (status) => {
      const { market } = await paired();
      await t.db
        .update(markets)
        .set({ status, resolvedResult: status === 'settling' ? 'YES' : null })
        .where(eq(markets.id, market.id));
      const empty = (await createUser(t.db)).user.id;
      await createPosition(t.db, {
        marketId: market.id,
        userId: empty,
        outcome: 'NO',
        qty: 0,
        costBasisCoin: 1n,
      });
      const run = await audit(market.id);
      expect(run.result.passed).toBe(false);
      expect(run.result.findings).toContainEqual({
        code: 'empty_position_cost',
        expected: '0',
        actual: '1',
        detail: `${empty}:NO`,
      });
      expect(run.hold?.failureResultId).toBe(run.result.id);
      expect((await t.db.select().from(auditFailures))[0]!.payload).toMatchObject({
        resultId: String(run.result.id),
      });
      expect(run.statusEvent?.status ?? status).toBe(status === 'open' ? 'paused' : 'settling');
    },
  );

  it.each(['open', 'settling'] as const)(
    'never offers a Coin correction to cover orphan zero-holding cost in %s',
    async (status) => {
      const { market } = await paired();
      await t.db
        .update(markets)
        .set({ status, resolvedResult: status === 'settling' ? 'YES' : null })
        .where(eq(markets.id, market.id));
      await bumpCollateral(market.id, 10n);
      const failed = await audit(market.id);
      expect(
        await t.db.transaction((tx) => previewReconciliationCorrections(tx, failed.result.id)),
      ).toHaveLength(1);
      const empty = (await createUser(t.db)).user.id;
      await createPosition(t.db, {
        marketId: market.id,
        userId: empty,
        outcome: 'NO',
        qty: 0,
        costBasisCoin: 1n,
      });
      expect(
        await t.db.transaction((tx) => previewReconciliationCorrections(tx, failed.result.id)),
      ).toEqual([]);
    },
  );

  it('allows a closed member with only empty holdings and a properly settled closed holder', async () => {
    const { market, yes } = await paired();
    const empty = (await createUser(t.db)).user.id;
    await createPosition(t.db, {
      marketId: market.id,
      userId: empty,
      outcome: 'YES',
      qty: 0,
      costBasisCoin: 0n,
    });
    await closeAccount(t.db, empty);
    expect((await audit(market.id)).result.passed).toBe(true);
    await t.db
      .update(markets)
      .set({ status: 'settling', resolvedResult: 'YES' })
      .where(eq(markets.id, market.id));
    await t.db.transaction((tx) => settleMarketPositions(tx, market.id));
    await t.db.update(markets).set({ status: 'settled' }).where(eq(markets.id, market.id));
    await closeAccount(t.db, yes);
    const result = await audit(market.id);
    expect(result.result.passed).toBe(true);
    expect(result.hold).toBeNull();
  });
  it('propagates a real PostgreSQL timeout instead of recording a structural finding', async () => {
    const market = await createMarket(t.db);
    let release!: () => void;
    let ready!: () => void;
    const unlock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const holder = t.db.transaction(async (tx) => {
      await lockMarket(tx, market.id);
      ready();
      await unlock;
    });
    await locked;
    try {
      await expect(
        t.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout='25ms'`);
          return runMarketReconciliation(tx, market.id, { source: 'manual' });
        }),
      ).rejects.toMatchObject({ cause: { code: '57014' } });
    } finally {
      release();
      await holder;
    }
    expect(await t.db.select().from(reconciliationResults)).toEqual([]);
    expect(await t.db.select().from(reconciliationHolds)).toEqual([]);
    expect(await t.db.select().from(auditFailures)).toEqual([]);
  });

  async function judgedPair() {
    const pair = await paired();
    await t.db.update(markets).set({ status: 'closed' }).where(eq(markets.id, pair.market.id));
    await createProvisionalMarket(t.db, { marketId: pair.market.id, result: 'YES' });
    await resolveMarketNow(t.db, pair.market.id);
    const [market] = await t.db
      .update(markets)
      .set({ status: 'settling' })
      .where(eq(markets.id, pair.market.id))
      .returning();
    return { ...pair, market: market! };
  }
  const judgementFaults = [
    { name: 'missing judgement', fields: { judgementVersion: 2 }, reason: 'final result' },
    { name: 'different result', fields: { resolvedResult: 'NO' as const }, reason: 'final result' },
    { name: 'different rules', fields: { ruleVersion: 2 }, reason: 'final rules' },
    { name: 'missing result', fields: { resolvedResult: null }, reason: 'result is missing' },
  ];

  it.each(judgementFaults)(
    'records a failed audit and hold for balanced settlement books with $name',
    async ({ fields, reason }) => {
      const { market } = await judgedPair();
      expect((await audit(market.id)).result.passed).toBe(true);
      const beforeLedger = await t.db.select().from(ledgerEntries);
      const beforePositions = await t.db.select().from(positions);
      await t.db.update(markets).set(fields).where(eq(markets.id, market.id));
      const failed = await audit(market.id);
      expect(failed.result.passed).toBe(false);
      const finding = failed.result.findings.find((item) => item.code === 'settlement_books');
      expect(finding?.expected).toBe('reconciled');
      expect(finding?.actual).toContain(reason);
      expect(failed.hold?.failureResultId).toBe(failed.result.id);
      expect(await t.db.select().from(auditFailures)).toHaveLength(1);
      expect(await t.db.select().from(ledgerEntries)).toEqual(beforeLedger);
      expect(await t.db.select().from(positions)).toEqual(beforePositions);
      await expect(t.db.transaction((tx) => settleMarketPositions(tx, market.id))).rejects.toThrow(
        reason,
      );
    },
  );

  it.each(judgementFaults)(
    'refuses recovery when $name appears after the last passing audit',
    async ({ fields }) => {
      const { market } = await judgedPair();
      await bumpCollateral(market.id, 1n);
      const failed = await audit(market.id);
      await bumpCollateral(market.id, -1n);
      const passed = await audit(market.id);
      expect(passed.result.passed).toBe(true);
      const input = await approve(failed.hold!, await admins());
      await t.db.update(markets).set(fields).where(eq(markets.id, market.id));
      const beforeResults = await t.db.select().from(reconciliationResults);
      const beforeLedger = await t.db.select().from(ledgerEntries);
      await expect(
        t.db.transaction((tx) => recoverReconciliationHold(tx, input)),
      ).rejects.toMatchObject({ code: 'not_passed' });
      expect(await t.db.select().from(reconciliationRecoveries)).toEqual([]);
      expect((await t.db.select().from(reconciliationHolds))[0]!.recoveredAt).toBeNull();
      expect(await t.db.select().from(reconciliationResults)).toEqual(beforeResults);
      expect(await t.db.select().from(ledgerEntries)).toEqual(beforeLedger);
    },
  );

  it.each(['modern', 'legacy'] as const)(
    'accepts a valid %s judgement both before payment and after settled',
    async (kind) => {
      const { market } = kind === 'modern' ? await judgedPair() : await paired();
      if (kind === 'legacy')
        await t.db
          .update(markets)
          .set({ status: 'settling', resolvedResult: 'YES', judgementVersion: null })
          .where(eq(markets.id, market.id));
      expect((await audit(market.id)).result.passed).toBe(true);
      const paid = await t.db.transaction((tx) => settleMarketPositions(tx, market.id));
      expect(paid.paidCoin).toBe(200n);
      await t.db.update(markets).set({ status: 'settled' }).where(eq(markets.id, market.id));
      const done = await audit(market.id);
      expect(done.result.passed).toBe(true);
      expect(done.hold).toBeNull();
    },
  );

  it('does not offer a Coin repair when a settling market has lost its result', async () => {
    const { market } = await judgedPair();
    await bumpCollateral(market.id, 10n);
    const failed = await audit(market.id);
    expect(
      await t.db.transaction((tx) => previewReconciliationCorrections(tx, failed.result.id)),
    ).toHaveLength(1);
    await t.db.update(markets).set({ resolvedResult: null }).where(eq(markets.id, market.id));
    expect(
      await t.db.transaction((tx) => previewReconciliationCorrections(tx, failed.result.id)),
    ).toEqual([]);
  });

  it.each(['YES', 'NO', 'VOID'] as const)(
    'reuses settlement books after %s and keeps CANCELLED bot assets',
    async (result) => {
      const { market } = await paired();
      await t.db
        .update(markets)
        .set({ status: 'settling', resolvedResult: result })
        .where(eq(markets.id, market.id));
      await t.db.transaction((tx) => settleMarketPositions(tx, market.id));
      await t.db.update(markets).set({ status: 'settled' }).where(eq(markets.id, market.id));
      expect((await audit(market.id)).result.passed).toBe(true);
      const cancelled = await createMarket(t.db, { status: 'cancelled' });
      await fundMarketMakerFunds(t.db, cancelled.id, 1000n);
      expect((await audit(cancelled.id)).result.passed).toBe(true);
    },
  );

  it('auto-pauses an overdue OPEN with broken locks and lets its scheduled close escape', async () => {
    const actors = await admins();
    await openOrderIntake(t.db, { adminId: actors.requester });
    const market = await createMarket(t.db);
    const person = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    const placed = await placeTestOrder(t.db, { marketId: market.id, ownerId: person });
    if (placed.kind !== 'placed') throw new Error('order');
    await fundMarketMakerFunds(t.db, market.id, 100n);
    await withLedgerGuardsOff((c) =>
      c.query(
        "UPDATE balances SET locked_coin=1,available_coin=99 WHERE account_id=(SELECT id FROM ledger_accounts WHERE kind='market_maker_funds' AND market_id=$1)",
        [market.id],
      ),
    );
    await passMarketClose(t.db, market.id);
    const failed = await audit(market.id);
    expect(failed.result.passed).toBe(false);
    expect(failed.statusEvent?.status).toBe('paused');
    const [pause] = await t.db
      .select()
      .from(marketPauses)
      .where(eq(marketPauses.marketId, market.id));
    expect(pause?.pausedBy).toBeNull();
    expect(await t.db.transaction((tx) => closeMarketAtClose(tx, market.id))).toMatchObject({
      closed: true,
      status: 'cancelled',
    });
    expect((await ledgerHeldMarketIds(t.db, [market.id])).has(market.id)).toBe(true);
    expect((await balanceOf(t.db, person))!.lockedCoin).toBe(50n);
  });

  it('records a separate hold for a market already paused for another reason', async () => {
    const { market } = await paired();
    const actors = await admins();
    const pause = await createMarketPause(t.db, {
      marketId: market.id,
      by: actors.requester,
      reason: 'basis_change',
    });
    await bumpCollateral(market.id, 1n);
    const failed = await audit(market.id);
    expect(failed.statusEvent).toBeNull();
    expect(failed.hold).not.toBeNull();
    expect(
      await t.db.select().from(marketPauses).where(eq(marketPauses.marketId, market.id)),
    ).toEqual([pause.pause]);
    await bumpCollateral(market.id, -1n);
    expect((await audit(market.id)).result.passed).toBe(true);
    expect((await ledgerHeldMarketIds(t.db, [market.id])).has(market.id)).toBe(true);
  });

  it.each([
    { missing: 'market_maker_funds', traded: false, live: false },
    { missing: 'market_maker_funds', traded: false, live: true },
    { missing: 'market_collateral', traded: true, live: true },
    { missing: 'user', traded: true, live: true },
  ] as const)(
    'closes held markets even with a missing $missing balance (traded=$traded, live=$live)',
    async ({ missing, traded, live }) => {
      const market = traded ? (await paired()).market : await createMarket(t.db);
      await openOrderIntake(t.db, { adminId: market.createdBy });
      const person = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
      await fundMarketMakerFunds(t.db, market.id, 100n);
      if (live) await placeTestOrder(t.db, { marketId: market.id, ownerId: person });
      await withLedgerGuardsOff(async (c) => {
        if (missing === 'user') {
          await c.query('DELETE FROM balances WHERE user_id=$1', [person]);
        }
        // User balances have their own account audit. A missing market funds balance also
        // provides the market hold in that case, while the close must avoid either asset.
        await c.query(
          'DELETE FROM balances WHERE account_id=(SELECT id FROM ledger_accounts WHERE kind=$1 AND market_id=$2)',
          [missing === 'user' ? 'market_maker_funds' : missing, market.id],
        );
      });
      await passMarketClose(t.db, market.id);
      const failed = await audit(market.id);
      expect(failed.statusEvent?.status).toBe('paused');
      expect(failed.result.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'balance_missing' })]),
      );
      const assets = async () => ({
        balances: await t.db.select().from(balances),
        orders: await t.db.select().from(orders),
        positions: await t.db.select().from(positions),
        ledger: await t.db.select().from(ledgerEntries),
      });
      const before = await assets();

      const closed = await t.db.transaction((tx) => closeMarketAtClose(tx, market.id));
      expect(closed).toMatchObject({
        closed: true,
        status: traded ? 'closed' : 'cancelled',
        pause: { reason: 'ledger_failure', endKind: 'closed_at_close' },
        expired: { expired: [] },
      });
      if (!closed.closed) throw new Error('Market did not close');
      expect(closed.expired.held).toHaveLength(live ? 1 : 0);
      expect(await assets()).toEqual(before);
      expect((await ledgerHeldMarketIds(t.db, [market.id])).has(market.id)).toBe(true);
      expect(await activeReconciliationHold(t.db, reconciliationMarketKey(market.id))).toEqual(
        failed.hold,
      );
      // A recovery still requires the real account balances; the no-write close is the only
      // escape. The ordinary lock path must not silently forgive the missing balance.
      await expect(t.db.transaction((tx) => lockMarketOrders(tx, market.id))).rejects.toThrow();
      await expect(
        t.db.transaction(async (tx) => {
          const kept = await lockMarketOrders(tx, market.id, { preserveHold: true });
          await expireLockedOrders(tx, kept, { at: new Date(), endsHold: true });
        }),
      ).rejects.toThrow('a batch preserving a ledger hold cannot end it');
    },
  );

  it('keeps a passing scheduled market closed to opening, orders and quotes until recovery', async () => {
    const actors = await admins();
    await openOrderIntake(t.db, { adminId: actors.requester });
    const { market } = await createScheduledMarket(t.db);
    const person = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    await fundMarketMakerFunds(t.db, market.id, 100n);
    const corrupt = (amount: number) =>
      withLedgerGuardsOff((c) =>
        c.query(
          "UPDATE balances SET available_coin=available_coin+$1 WHERE account_id=(SELECT id FROM ledger_accounts WHERE kind='market_maker_funds' AND market_id=$2)",
          [amount, market.id],
        ),
      );
    await corrupt(1);
    const failed = await audit(market.id);
    await corrupt(-1);
    expect((await audit(market.id)).result.passed).toBe(true);
    expect(await selectDueMarketReconciliationIds(t.db)).not.toContain(market.id);
    const open = () =>
      t.db.transaction(async (tx) => {
        await lockMarket(tx, market.id);
        const [current] = await tx
          .select()
          .from(markets)
          .where(eq(markets.id, market.id))
          .for('update');
        return openScheduledMarket(tx, {
          market: current!,
          now: await clockTimestamp(tx),
          actorId: null,
          source: 'job',
        });
      });
    expect(await open()).toEqual({ opened: false, reason: 'ledger_hold' });

    // Even a status changed outside the opening path must not bypass the persistent hold.
    await t.db.update(markets).set({ status: 'open' }).where(eq(markets.id, market.id));
    const facts = (await readMarketTradingFacts(t.db, market.id))!;
    expect(facts.ledgerHeld).toBe(true);
    expect(await placeTestOrder(t.db, { marketId: market.id, ownerId: person })).toMatchObject({
      kind: 'placed',
      order: { status: 'rejected', rejectReason: 'paused' },
    });
    const book = await readPublicBook(t.db, market.id);
    expect(orderBookOf(market.id, facts, book)).toMatchObject({ marketRejectReason: 'paused' });
    expect(
      quoteOrder(
        book,
        facts,
        {
          outcome: 'YES',
          side: 'buy',
          timeInForce: 'gtc',
          qty: 1,
          budgetCoin: null,
          limitPriceCoin: 50,
        },
        null,
      ),
    ).toMatchObject({
      kind: 'quoted',
      figures: { status: 'rejected', rejectReason: 'paused', filledQty: 0 },
    });
    await expect(
      t.db.transaction((tx) =>
        lockForOrder(tx, {
          marketId: market.id,
          ownerId: person,
          lock: { kind: 'coin', amountCoin: 50n },
        }),
      ),
    ).rejects.toThrow('held for reconciliation');

    await t.db.update(markets).set({ status: 'scheduled' }).where(eq(markets.id, market.id));
    const input = await approve(failed.hold!, actors);
    await t.db.transaction((tx) => recoverReconciliationHold(tx, input));
    expect(await open()).toMatchObject({ opened: true });
    expect(await placeTestOrder(t.db, { marketId: market.id, ownerId: person })).toMatchObject({
      kind: 'placed',
      order: { status: 'open' },
    });
  });

  it('keeps a user hold after a pass, refuses only new orders, and recovers once', async () => {
    const actors = await admins();
    await openOrderIntake(t.db, { adminId: actors.requester });
    const { market, yes } = await paired();
    const placed = await placeTestOrder(t.db, { marketId: market.id, ownerId: yes });
    if (placed.kind !== 'placed') throw new Error('order');
    await bumpUser(yes, 1n);
    const failed = await account(yes);
    expect(failed.hold).not.toBeNull();
    const refused = await placeTestOrder(t.db, { marketId: market.id, ownerId: yes });
    expect(refused).toMatchObject({
      kind: 'placed',
      order: { status: 'rejected', rejectReason: 'ledger_hold' },
    });
    expect((await cancelTestOrder(t.db, { ownerId: yes, orderId: placed.order.id })).kind).toBe(
      'cancelled',
    );
    await bumpUser(yes, -1n);
    const clean = await account(yes);
    expect(clean.result.passed).toBe(true);
    expect(clean.hold?.recoveredAt).toBeNull();
    const input = await approve(clean.hold!, actors);
    const done = await t.db.transaction((tx) => recoverReconciliationHold(tx, input));
    expect(done.hold?.recoveredAt).not.toBeNull();
    await expect(t.db.transaction((tx) => recoverReconciliationHold(tx, input))).rejects.toThrow(
      'stale',
    );
    expect(await placeTestOrder(t.db, { marketId: market.id, ownerId: yes })).toMatchObject({
      kind: 'placed',
      order: { status: 'open' },
    });
  });

  it.each(['quantity', 'budget'] as const)(
    "persists a held account's IOC %s rejection before quote lookup and replays it without spending",
    async (size) => {
      const actors = await admins();
      await openOrderIntake(t.db, { adminId: actors.requester });
      const market = await createMarket(t.db);
      const person = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
      await bumpUser(person, 1n);
      const failed = await account(person);
      expect(failed.hold).not.toBeNull();
      await bumpUser(person, -1n);
      expect((await account(person)).result.passed).toBe(true);
      const before = await balanceOf(t.db, person);
      const input = {
        marketId: market.id,
        ownerId: person,
        requestId: randomUUID(),
        timeInForce: 'ioc' as const,
        qty: size === 'quantity' ? 2 : null,
        budgetCoin: size === 'budget' ? 100n : null,
      };
      const refused = await placeTestOrder(t.db, input);
      expect(refused).toMatchObject({
        kind: 'placed',
        order: {
          status: 'rejected',
          rejectReason: 'ledger_hold',
          referencePrice: null,
          protectionTicks: null,
          limitPrice: 50,
          protectedLimitPrice: 50,
          qty: input.qty,
          budgetCoin: input.budgetCoin,
          unspentCoin: input.budgetCoin,
          filledQty: 0,
          filledAmountCoin: 0n,
        },
        fills: [],
      });
      if (refused.kind !== 'placed') throw new Error('order');
      expect(await placeTestOrder(t.db, input)).toMatchObject({
        kind: 'replayed',
        order: refused.order,
      });
      expect(await balanceOf(t.db, person)).toEqual(before);
      const inputRecovery = await approve(failed.hold!, actors);
      await t.db.transaction((tx) => recoverReconciliationHold(tx, inputRecovery));
      expect(await placeTestOrder(t.db, { ...input, requestId: randomUUID() })).toMatchObject({
        kind: 'placed',
        order: { status: 'rejected', rejectReason: 'no_quote' },
      });
    },
  );

  it('rejects stale failure evidence and a new mismatch after the last pass', async () => {
    const actors = await admins();
    const person = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    await bumpUser(person, 1n);
    const first = await account(person);
    const oldInput = await approve(first.hold!, actors);
    await account(person);
    await bumpUser(person, -1n);
    const clean = await account(person);
    await expect(t.db.transaction((tx) => recoverReconciliationHold(tx, oldInput))).rejects.toThrow(
      'stale',
    );
    const input = await approve(clean.hold!, actors);
    await bumpUser(person, 1n);
    await expect(t.db.transaction((tx) => recoverReconciliationHold(tx, input))).rejects.toThrow(
      'not_passed',
    );
    expect(
      (await activeReconciliationHold(t.db, reconciliationUserKey(person)))?.recoveredAt,
    ).toBeNull();
    expect(await t.db.select().from(reconciliationRecoveries)).toEqual([]);
  });

  it('recovers a closed-at-close legacy pause and expires its orders without rewinding CANCELLED', async () => {
    const actors = await admins();
    await openOrderIntake(t.db, { adminId: actors.requester });
    const market = await createMarket(t.db);
    const person = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    await placeTestOrder(t.db, { marketId: market.id, ownerId: person });
    await createMarketPause(t.db, {
      marketId: market.id,
      by: actors.requester,
      reason: 'ledger_failure',
    });
    await passMarketClose(t.db, market.id);
    await t.db.transaction((tx) => closeMarketAtClose(tx, market.id));
    const clean = await audit(market.id);
    expect(clean.result.passed).toBe(true);
    expect(clean.hold?.failureResultId).toBeNull();
    const input = await approve(clean.hold!, actors);
    const done = await t.db.transaction((tx) => recoverReconciliationHold(tx, input));
    expect(done.expired.expired).toHaveLength(1);
    expect((await balanceOf(t.db, person))!.lockedCoin).toBe(0n);
    expect((await ledgerHeldMarketIds(t.db, [market.id])).size).toBe(0);
    expect((await t.db.select().from(markets).where(eq(markets.id, market.id)))[0]?.status).toBe(
      'cancelled',
    );
    expect((await t.db.select().from(reconciliationRecoveries))[0]?.legacyPauseId).toBe(
      clean.hold?.legacyPauseId,
    );
  });

  it('couples a paused market recovery with the existing different-admin resume approval', async () => {
    const actors = await admins();
    const { market } = await paired();
    await bumpCollateral(market.id, 1n);
    await audit(market.id);
    await bumpCollateral(market.id, -1n);
    const clean = await audit(market.id);
    const hold = clean.hold!;
    const [pause] = await t.db
      .select()
      .from(marketPauses)
      .where(eq(marketPauses.marketId, market.id));
    const recovery = { holdId: hold.id, failureResultId: String(hold.failureResultId) };
    const approval = await createApprovalRequest(t.db, {
      kind: 'market_pause_decision',
      targetType: 'market',
      targetId: market.id,
      payload: { pauseId: pause!.id, path: 'resume', reviewResult: null, recovery },
      requestedBy: actors.requester,
      decision: { status: 'approved', by: actors.approver },
    });
    const resumed = await t.db.transaction(async (tx) => {
      await lockMarket(tx, market.id);
      const [row] = await tx.select().from(markets).where(eq(markets.id, market.id)).for('update');
      const orders = await lockMarketOrders(tx, market.id);
      return endMarketPause(tx, {
        market: row!,
        orders,
        pause: pause!,
        now: await clockTimestamp(tx),
        approverId: actors.approver,
        path: 'resume',
        reviewResult: null,
        approvalId: approval.id,
        requestedBy: actors.requester,
        recovery: { holdId: hold.id, failureResultId: hold.failureResultId },
      });
    });
    expect(resumed).toMatchObject({ ended: true, market: { status: 'open' } });
    expect(await activeReconciliationHold(t.db, reconciliationMarketKey(market.id))).toBeNull();
  });

  it('records total mismatch without a global hold and preserves immutable observations', async () => {
    const person = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    await bumpUser(person, 1n);
    const run = await t.db.transaction((tx) => runSupplyReconciliation(tx, { source: 'manual' }));
    expect(run.result.passed).toBe(false);
    expect(run.hold).toBeNull();
    expect(await t.db.select().from(reconciliationHolds)).toEqual([]);
    await expect(
      t.db.delete(reconciliationResults).where(eq(reconciliationResults.id, run.result.id)),
    ).rejects.toThrow();
    await expect(
      t.db
        .update(reconciliationResults)
        .set({ passed: true })
        .where(eq(reconciliationResults.id, run.result.id)),
    ).rejects.toThrow();
  });

  it('selects never-checked and failed markets fairly, then only ledger changes', async () => {
    const first = await paired();
    const second = await paired();
    expect(await selectDueMarketReconciliationIds(t.db)).toEqual(
      expect.arrayContaining([first.market.id, second.market.id]),
    );
    await audit(first.market.id);
    await audit(second.market.id);
    expect(await selectDueMarketReconciliationIds(t.db)).toEqual([]);
    await fundMarketMakerFunds(t.db, first.market.id, 100n);
    expect(await selectDueMarketReconciliationIds(t.db)).toEqual([first.market.id]);
    await bumpCollateral(first.market.id, 1n);
    await audit(first.market.id);
    expect(await selectDueMarketReconciliationIds(t.db)).toEqual([first.market.id]);
    const third = await createMarket(t.db);
    expect(await selectDueMarketReconciliationIds(t.db, { limit: 1 })).toEqual([third.id]);
  });

  it('serializes a new order behind an account audit and rejects it after hold commit', async () => {
    const actors = await admins();
    await openOrderIntake(t.db, { adminId: actors.requester });
    const { market, yes } = await paired();
    await bumpUser(yes, 1n);
    let order: ReturnType<typeof placeTestOrder> | undefined;
    await t.db.transaction(async (tx) => {
      await lockReconciliationUser(tx, yes);
      order = placeTestOrder(t.db, { marketId: market.id, ownerId: yes });
      await runAccountReconciliation(tx, { userId: yes }, { source: 'scheduled' });
    });
    expect(await order).toMatchObject({
      kind: 'placed',
      order: { rejectReason: 'ledger_hold', status: 'rejected' },
    });
  });

  it('keeps account holds while settlement pays and preserves a preexisting balance gap', async () => {
    const { market, yes } = await paired();
    await bumpUser(yes, 1n);
    const failed = await account(yes);
    expect(failed.hold).not.toBeNull();
    await t.db
      .update(markets)
      .set({ status: 'settling', resolvedResult: 'YES' })
      .where(eq(markets.id, market.id));
    expect(await t.db.transaction((tx) => settleMarketPositions(tx, market.id))).toMatchObject({
      paidCoin: 200n,
    });
    const balance = (await balanceOf(t.db, yes))!;
    expect(balance.availableCoin + balance.lockedCoin - balance.ledgerCoin).toBe(1n);
    expect((await activeReconciliationHold(t.db, reconciliationUserKey(yes)))?.id).toBe(
      failed.hold?.id,
    );
  });

  it('detects a missing balance and forbids deleting or directly clearing a hold', async () => {
    const person = (await createUser(t.db)).user.id;
    await withLedgerGuardsOff((c) => c.query('DELETE FROM balances WHERE user_id=$1', [person]));
    const failed = await account(person);
    expect(failed.result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'balance_missing' })]),
    );
    expect(failed.hold).not.toBeNull();
    await expect(
      t.db
        .update(reconciliationHolds)
        .set({ recoveredAt: new Date() })
        .where(eq(reconciliationHolds.id, failed.hold!.id)),
    ).rejects.toThrow();
    await expect(
      t.db.delete(reconciliationHolds).where(eq(reconciliationHolds.id, failed.hold!.id)),
    ).rejects.toThrow();
    await expect(
      withLedgerGuardsOff((c) =>
        c.query('DELETE FROM reconciliation_results WHERE id=$1', [failed.result.id]),
      ),
    ).rejects.toThrow('permanent reconciliation record');
  });
});
