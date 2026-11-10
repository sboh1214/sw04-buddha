import { randomUUID } from 'node:crypto';
import type { BookOrder } from '@buddha/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lockForOrder } from './contracts.js';
import { ensureLedgerAccount, findLedgerAccount } from './ledger.js';
import { readMarketMakerRiskSnapshot } from './market-maker-risk.js';
import { setMarketLiquidity } from './market-liquidity.js';
import { readLiveBook } from './orders.js';
import { runMarketReconciliation } from './reconciliation-audit.js';
import {
  applyReconciliationCorrection,
  previewReconciliationCorrections,
} from './reconciliation-correction.js';
import { recoverReconciliationHold } from './reconciliation-recovery.js';
import { balances, ledgerAccounts, ledgerEntries, orders, positions } from './schema/index.js';
import {
  createApprovalRequest,
  createMarket,
  createMarketMakerAccount,
  createPosition,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import {
  damageActualCoinForTest,
  fundMarketMakerFunds,
  fundTestTreasury,
  mintTestPairs,
  recordLegacyCorrectionForTest,
  recordLegacyMarketMakerCapitalForTest,
  withLedgerGuardsOff,
} from './test/ledger.js';
import { createOrder, openOrderIntake, placeTestOrder } from './test/orders.js';

const SETTINGS = {
  budgetCoin: 10_000n,
  maxLossCoin: 5_000n,
  b: 100,
  levels: 3,
  quantity: 10,
  safetyTicks: 1,
};

describe.skipIf(!hasTestDb())('read-only market maker risk snapshot (#128)', () => {
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
  const fundsRef = (marketId: string) => ({ kind: 'market_maker_funds' as const, marketId });
  const snapshot = (marketId: string) =>
    t.db.transaction((tx) => readMarketMakerRiskSnapshot(tx, marketId), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  async function configured() {
    const actorId = (await createUser(t.db, { role: 'admin' })).user.id;
    const market = await createMarket(t.db, { createdBy: actorId, status: 'draft' });
    await t.db.transaction((tx) =>
      setMarketLiquidity(tx, {
        marketId: market.id,
        actorId,
        settings: SETTINGS,
        baseVersion: null,
        reason: 'risk reader fixture',
      }),
    );
    return { market, actorId };
  }
  async function ready(marketId: string) {
    const value = await snapshot(marketId);
    expect(value.kind).toBe('ready');
    if (value.kind !== 'ready')
      throw new Error(`Expected risk facts, got ${value.kind}:${value.reason}`);
    return value;
  }
  async function recall(marketId: string, amountCoin: bigint) {
    // Historical partial returns are reader fixtures, never a new terminal recall.
    await recordLegacyMarketMakerCapitalForTest({
      type: 'BOT_RECALL',
      amountCoin,
      from: fundsRef(marketId),
      to: { kind: 'treasury' },
      refType: 'approval_request',
      refId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
  }
  const legacyCorrection = async (
    from: Parameters<typeof recordLegacyCorrectionForTest>[0]['from'],
    to: Parameters<typeof recordLegacyCorrectionForTest>[0]['to'],
    amountCoin: bigint,
  ) =>
    recordLegacyCorrectionForTest({
      from,
      to,
      amountCoin,
      refType: 'audit_failure',
      refId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
  async function written() {
    return {
      accounts: await t.db.select().from(ledgerAccounts).orderBy(ledgerAccounts.id),
      balances: await t.db.select().from(balances).orderBy(balances.accountId),
      entries: await t.db.select().from(ledgerEntries).orderBy(ledgerEntries.id),
      orders: await t.db.select().from(orders).orderBy(orders.id),
      positions: await t.db
        .select()
        .from(positions)
        .orderBy(positions.marketId, positions.userId, positions.outcome),
    };
  }

  it('keeps missing config, missing global MM and missing funds explicit, without creating them', async () => {
    const old = await createMarket(t.db);
    const before = await written();
    expect(await snapshot(old.id)).toEqual({
      kind: 'unavailable',
      marketId: old.id,
      reason: 'missing_config',
    });
    expect(await written()).toEqual(before);
    const { market } = await configured();
    expect(await snapshot(market.id)).toEqual({
      kind: 'unavailable',
      marketId: market.id,
      reason: 'missing_market_maker',
    });
    await createMarketMakerAccount(t.db);
    expect(await snapshot(market.id)).toEqual({
      kind: 'unavailable',
      marketId: market.id,
      reason: 'missing_funds',
    });
    await t.db.transaction((tx) => ensureLedgerAccount(tx, fundsRef(market.id)));
    expect((await ready(market.id)).book).toEqual({
      coin: 0n,
      yesQty: 0,
      noQty: 0,
      invested: 0n,
      recovered: 0n,
    });
    expect(await findLedgerAccount(t.db, { kind: 'treasury' })).toBeNull();
  });

  it('uses current L and actual capital, not configured A or stage-policy defaults', async () => {
    const { market, actorId } = await configured();
    await t.db.transaction((tx) =>
      setMarketLiquidity(tx, {
        marketId: market.id,
        actorId,
        settings: { ...SETTINGS, maxLossCoin: 4_000n },
        baseVersion: 1,
        reason: 'new current L',
      }),
    );
    const ownerId = await fundMarketMakerFunds(t.db, market.id, 700n);
    const risk = await ready(market.id);
    expect(risk).toMatchObject({
      ownerId,
      configVersion: 2,
      limits: { maxLoss: 4_000n },
      book: { coin: 700n, invested: 700n },
    });
    expect(Object.keys(risk.limits)).toEqual(['maxLoss']);
  });

  it('includes locked Coin/contracts once and only live MM remainders from this market', async () => {
    const { market } = await configured();
    const ownerId = await fundMarketMakerFunds(t.db, market.id, 1_000n);
    const human = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: ownerId,
      noHolderId: human,
      qty: 5,
      yesPriceCoin: 40,
    });
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: human,
      noHolderId: ownerId,
      qty: 3,
      yesPriceCoin: 60,
    });
    // Read fixtures model the current order rows. Lock their remaining assets through the real
    // helpers; historical filled quantity is not charged again by the snapshot reader.
    const buy = await createOrder(t.db, {
      marketId: market.id,
      userId: ownerId,
      outcome: 'NO',
      qty: 4,
      filledQty: 1,
      status: 'partially_filled',
      limitPriceCoin: 20,
      protectedLimitPriceCoin: 20,
    });
    const sell = await createOrder(t.db, {
      marketId: market.id,
      userId: ownerId,
      side: 'sell',
      outcome: 'YES',
      qty: 2,
      limitPriceCoin: 80,
    });
    await t.db.transaction(async (tx) => {
      expect(
        await lockForOrder(tx, {
          marketId: market.id,
          ownerId,
          lock: { kind: 'coin', amountCoin: 60n },
        }),
      ).toMatchObject({ locked: true });
      expect(
        await lockForOrder(tx, {
          marketId: market.id,
          ownerId,
          lock: { kind: 'contracts', outcome: 'YES', qty: 2 },
        }),
      ).toMatchObject({ locked: true });
    });
    await createOrder(t.db, { marketId: market.id, userId: human, qty: 100 });
    await createOrder(t.db, {
      marketId: market.id,
      userId: ownerId,
      qty: 100,
      status: 'cancelled',
    });
    const other = await configured();
    await fundMarketMakerFunds(t.db, other.market.id, 9_000n);
    await createOrder(t.db, { marketId: other.market.id, userId: ownerId, qty: 50 });
    const before = await written();
    const risk = await ready(market.id);
    expect(risk.book).toEqual({ coin: 680n, yesQty: 5, noQty: 3, invested: 1_000n, recovered: 0n });
    expect(risk.liveOrders).toEqual([
      { id: buy.id, outcome: 'NO', side: 'buy', priceCoin: 20, qty: 3 },
      { id: sell.id, outcome: 'YES', side: 'sell', priceCoin: 80, qty: 2 },
    ]);
    expect(
      await t.db.transaction(
        async (tx) => readMarketMakerRiskSnapshot(tx, market.id, await readLiveBook(tx, market.id)),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    ).toEqual(risk);
    expect(await written()).toEqual(before);
  });

  it('ignores settled holdings and does not add historical realized PnL to Coin', async () => {
    const { market } = await configured();
    const ownerId = await fundMarketMakerFunds(t.db, market.id, 100n);
    // Narrow reader fixtures: the audit, not this SELECT projection, validates retired supply.
    await createPosition(t.db, {
      marketId: market.id,
      userId: ownerId,
      outcome: 'YES',
      qty: 2,
      realizedPnlCoin: 999n,
    });
    await createPosition(t.db, {
      marketId: market.id,
      userId: ownerId,
      outcome: 'NO',
      qty: 7,
      settled: true,
      realizedPnlCoin: 999n,
    });
    expect((await ready(market.id)).book).toEqual({
      coin: 100n,
      yesQty: 2,
      noQty: 0,
      invested: 100n,
      recovered: 0n,
    });
  });

  it('counts only exact treasury/fund capital flows, including both historical correction directions', async () => {
    const { market } = await configured();
    const other = await configured();
    await fundMarketMakerFunds(t.db, market.id, 1_000n);
    await fundMarketMakerFunds(t.db, other.market.id, 200n);
    await fundTestTreasury(t.db, 500n);
    const human = (await createUser(t.db)).user.id;
    const treasury = { kind: 'treasury' as const };
    const collateral = { kind: 'market_collateral' as const, marketId: market.id };
    await legacyCorrection(treasury, fundsRef(market.id), 25n);
    await legacyCorrection(fundsRef(market.id), treasury, 7n);
    await recall(market.id, 10n);
    await legacyCorrection(treasury, collateral, 11n);
    await legacyCorrection(collateral, treasury, 3n);
    await legacyCorrection(treasury, { kind: 'user', userId: human }, 13n);
    await legacyCorrection(treasury, fundsRef(other.market.id), 17n);
    await legacyCorrection(fundsRef(other.market.id), treasury, 5n);
    expect((await ready(market.id)).book).toEqual({
      coin: 1_008n,
      yesQty: 0,
      noQty: 0,
      invested: 1_025n,
      recovered: 17n,
    });
    expect((await ready(other.market.id)).book).toMatchObject({
      coin: 212n,
      invested: 217n,
      recovered: 5n,
    });
  });

  it('keeps lifetime capital sums exact above Number.MAX_SAFE_INTEGER', async () => {
    const { market } = await configured();
    const part = 999_999_999_999_999n;
    for (let n = 0; n < 11; n++) {
      await fundMarketMakerFunds(t.db, market.id, part);
      await recall(market.id, part);
    }
    const risk = await ready(market.id);
    expect(risk.book.invested).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(risk.book).toMatchObject({ coin: 0n, invested: 11n * part, recovered: 11n * part });
  });

  it.each([10n, -10n])(
    'uses approved #93 correction accounting for actual/ledger gap %s',
    async (delta) => {
      const { market, actorId } = await configured();
      const approver = (await createUser(t.db, { role: 'admin' })).user.id;
      await fundMarketMakerFunds(t.db, market.id, 1_000n);
      const account = (await findLedgerAccount(t.db, fundsRef(market.id)))!;
      await damageActualCoinForTest(account.id, delta);
      expect(await snapshot(market.id)).toMatchObject({ kind: 'inconsistent', reason: 'coin_gap' });
      const audit = await t.db.transaction((tx) =>
        runMarketReconciliation(tx, market.id, { source: 'manual' }),
      );
      const candidates = await t.db.transaction((tx) =>
        previewReconciliationCorrections(tx, audit.result.id),
      );
      const candidate = candidates.find((row) => row.accountId === String(account.id));
      expect(candidate?.mode).toBe(delta > 0n ? 'replenish_ledger' : 'restore_actual');
      if (!candidate || !audit.hold)
        throw new Error('Expected real MM correction and persistent hold');
      if (delta > 0n) await fundTestTreasury(t.db, delta);
      const request = await createApprovalRequest(t.db, {
        kind: 'reconciliation_correction',
        targetType: 'ledger_account',
        targetId: String(account.id),
        requestedBy: actorId,
        payload: { failureResultId: String(audit.result.id), candidate, userReason: null },
        decision: { status: 'approved', by: approver },
      });
      const corrected = await t.db.transaction((tx) =>
        applyReconciliationCorrection(tx, {
          approvalId: request.id,
          requestedBy: actorId,
          approverId: approver,
        }),
      );
      expect(corrected.correction.ledgerEntryId === null).toBe(delta < 0n);
      const passed = await t.db.transaction((tx) =>
        runMarketReconciliation(tx, market.id, { source: 'manual' }),
      );
      expect(passed.result.passed).toBe(true);
      const recovery = await createApprovalRequest(t.db, {
        kind: 'reconciliation_recovery',
        targetType: 'reconciliation_hold',
        targetId: audit.hold.id,
        requestedBy: actorId,
        payload: { holdId: audit.hold.id, failureResultId: String(audit.hold.failureResultId) },
        decision: { status: 'approved', by: approver },
      });
      await t.db.transaction((tx) =>
        recoverReconciliationHold(tx, {
          holdId: audit.hold!.id,
          failureResultId: audit.hold!.failureResultId,
          approvalId: recovery.id,
          requestedBy: actorId,
          approverId: approver,
        }),
      );
      const expected = delta > 0n ? 1_010n : 1_000n;
      expect((await ready(market.id)).book).toMatchObject({
        coin: expected,
        invested: expected,
        recovered: 0n,
      });
    },
  );

  it('does not normalize active MM orders or positions without funds into a zero active bot', async () => {
    const { market } = await configured();
    const ownerId = await createMarketMakerAccount(t.db);
    await createOrder(t.db, { marketId: market.id, userId: ownerId });
    expect(await snapshot(market.id)).toMatchObject({
      kind: 'inconsistent',
      reason: 'missing_funds',
    });
    const second = await configured();
    await createPosition(t.db, {
      marketId: second.market.id,
      userId: ownerId,
      outcome: 'NO',
      qty: 1,
    });
    expect(await snapshot(second.market.id)).toMatchObject({
      kind: 'inconsistent',
      reason: 'missing_funds',
    });
  });

  it('reports a missing global MM behind a supplied nonhuman live order, without inventing an owner', async () => {
    const { market } = await configured();
    const live: BookOrder[] = [
      {
        id: randomUUID(),
        owner: { id: randomUUID(), human: false },
        outcome: 'YES',
        side: 'buy',
        priceCoin: 50,
        remainingQty: 1,
        arrival: 1,
      },
    ];
    expect(await readMarketMakerRiskSnapshot(t.db, market.id, live)).toMatchObject({
      kind: 'inconsistent',
      reason: 'missing_market_maker',
    });
  });

  it('marks a missing automatic balance row as damaged, even without configuration', async () => {
    const old = await createMarket(t.db);
    await fundMarketMakerFunds(t.db, old.id, 100n);
    const account = (await findLedgerAccount(t.db, fundsRef(old.id)))!;
    await withLedgerGuardsOff((client) =>
      client.query('DELETE FROM balances WHERE account_id=$1', [account.id]),
    );
    expect(await snapshot(old.id)).toEqual({
      kind: 'inconsistent',
      marketId: old.id,
      reason: 'missing_balance',
    });
  });

  it('detects Coin and contract lock mismatches before returning missing legacy config', async () => {
    const old = await createMarket(t.db);
    const ownerId = await fundMarketMakerFunds(t.db, old.id, 100n);
    const account = (await findLedgerAccount(t.db, fundsRef(old.id)))!;
    expect(await snapshot(old.id)).toMatchObject({ kind: 'unavailable', reason: 'missing_config' });
    await damageActualCoinForTest(account.id, 1n);
    expect(await snapshot(old.id)).toMatchObject({ kind: 'inconsistent', reason: 'coin_gap' });
    await damageActualCoinForTest(account.id, -1n);
    await createOrder(t.db, { marketId: old.id, userId: ownerId });
    expect(await snapshot(old.id)).toMatchObject({ kind: 'inconsistent', reason: 'coin_lock' });
    const second = await configured();
    await fundMarketMakerFunds(t.db, second.market.id, 100n);
    await createPosition(t.db, {
      marketId: second.market.id,
      userId: ownerId,
      outcome: 'YES',
      qty: 4,
      lockedQty: 1,
    });
    expect(await snapshot(second.market.id)).toMatchObject({
      kind: 'inconsistent',
      reason: 'contract_lock',
    });
  });

  it('reports impossible retired contract locks rather than dropping them with settled quantities', async () => {
    const { market } = await configured();
    const ownerId = await fundMarketMakerFunds(t.db, market.id, 100n);
    await createPosition(t.db, {
      marketId: market.id,
      userId: ownerId,
      outcome: 'NO',
      qty: 2,
      lockedQty: 1,
      settled: true,
    });
    expect(await snapshot(market.id)).toMatchObject({
      kind: 'inconsistent',
      reason: 'contract_lock',
    });
  });

  it('reads without market locks or writes and keeps one snapshot across a concurrent capital commit', async () => {
    const { market } = await configured();
    await fundMarketMakerFunds(t.db, market.id, 100n);
    const before = await written();
    const holder = await t.db.$client.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1::uuid::text))', [market.id]);
      await t.db.transaction(
        async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '1000ms'`);
          expect((await readMarketMakerRiskSnapshot(tx, market.id)).kind).toBe('ready');
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await written()).toEqual(before);
    const [first, second] = await t.db.transaction(
      async (tx) => {
        const first = await readMarketMakerRiskSnapshot(tx, market.id);
        await fundMarketMakerFunds(t.db, market.id, 25n);
        return [first, await readMarketMakerRiskSnapshot(tx, market.id)];
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    expect(second).toEqual(first);
    expect((await ready(market.id)).book).toMatchObject({ coin: 125n, invested: 125n });
    const refusal = await t.db
      .transaction((tx) => tx.execute(sql`UPDATE balances SET updated_at=updated_at`), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      })
      .catch((error: unknown) => error);
    expect((refusal as { cause?: { code: string } }).cause?.code).toBe('25006');
  });

  it('leaves human-only legacy intake usable when no MM configuration or funds exist', async () => {
    const adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
    const market = await createMarket(t.db, { createdBy: adminId });
    const first = (await createUser(t.db, { balanceCoin: 100n })).user.id;
    const second = (await createUser(t.db, { balanceCoin: 100n })).user.id;
    expect(await snapshot(market.id)).toMatchObject({
      kind: 'unavailable',
      reason: 'missing_config',
    });
    expect(
      await placeTestOrder(t.db, {
        marketId: market.id,
        ownerId: first,
        outcome: 'YES',
        limitPriceCoin: 50,
        qty: 1,
      }),
    ).toMatchObject({ kind: 'placed', order: { status: 'open' } });
    expect(
      await placeTestOrder(t.db, {
        marketId: market.id,
        ownerId: second,
        outcome: 'NO',
        limitPriceCoin: 50,
        qty: 1,
      }),
    ).toMatchObject({
      kind: 'placed',
      order: { status: 'filled' },
      fills: [{ kind: 'pair_mint', qty: 1 }],
    });
  });
});
