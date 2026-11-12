import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findLedgerAccount, recordLedgerEntry } from './ledger.js';
import { recallMarketMakerFunds, checkMarketMakerRecallBooks } from './market-maker-recall.js';
import { readMarketMakerRiskSnapshot } from './market-maker-risk.js';
import { settleMarketPositions } from './market-settlement.js';
import { transitionMarket } from './market-transitions.js';
import { runMarketReconciliation, runSupplyReconciliation } from './reconciliation-audit.js';
import {
  balances,
  ledgerEntries,
  marketMakerRecalls,
  markets,
  positions,
  positionSettlements,
  reconciliationHolds,
  reconciliationResults,
  marketSettlementSteps,
} from './schema/index.js';
import {
  createMarket,
  createMarketPause,
  createMarketMakerAccount,
  createOpenedMarket,
  createUser,
  createPosition,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import {
  damageActualCoinForTest,
  fundMarketMakerFunds,
  fundTestTreasury,
  ledgerAccountBalance,
  ledgerSupply,
  mintTestPairs,
  recordLegacyMarketMakerCapitalForTest,
  withLedgerGuardsOff,
} from './test/ledger.js';
import { createOrder, closeTestMarket, passMarketClose } from './test/orders.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';
import { waitForLockWaiter } from './test/wait.js';

describe.skipIf(!hasTestDb())('terminal market maker recall (#181)', () => {
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
  const run = (marketId: string) =>
    t.db.transaction((tx) => recallMarketMakerFunds(tx, { marketId }));
  const audit = (marketId: string) =>
    t.db.transaction((tx) => runMarketReconciliation(tx, marketId, { source: 'manual' }));
  const transfers = () =>
    t.db.select().from(ledgerEntries).where(eq(ledgerEntries.type, 'BOT_RECALL'));
  async function legacyTerminal(status: 'settled' | 'cancelled' = 'cancelled', amount = 1_000n) {
    const market = await createMarket(t.db, {
      status,
      ...(status === 'settled' ? { resolvedResult: 'YES' as const } : {}),
    });
    const owner = await createMarketMakerAccount(t.db);
    if (amount) await fundMarketMakerFunds(t.db, market.id, amount);
    return { market, owner };
  }
  async function settled(result: 'YES' | 'NO' | 'VOID') {
    const market = await createMarket(t.db, { status: 'settling', resolvedResult: result });
    const owner = await createMarketMakerAccount(t.db);
    const person = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    await fundMarketMakerFunds(t.db, market.id, 1_000n);
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: owner,
      noHolderId: person,
      qty: 2,
      yesPriceCoin: 60,
    });
    await t.db.transaction(async (tx) => {
      await settleMarketPositions(tx, market.id);
      const at = await clockTimestamp(tx);
      await tx
        .update(marketSettlementSteps)
        .set({ status: 'done', attempts: 1, completedAt: at })
        .where(eq(marketSettlementSteps.marketId, market.id));
      await transitionMarket(tx, {
        marketId: market.id,
        from: 'settling',
        to: 'settled',
        type: 'finalized',
        actorId: null,
        at,
        set: { settledAt: at },
      });
    });
    return { market, owner, person };
  }
  it.each(['YES', 'NO', 'VOID'] as const)(
    'recalls settled %s actual funds once, preserving payout, people, PnL and supply',
    async (result) => {
      const { market } = await settled(result);
      const before = (await ledgerAccountBalance(t.db, fundsRef(market.id)))!;
      const treasuryBefore = (await ledgerAccountBalance(t.db, { kind: 'treasury' }))!;
      const supply = await ledgerSupply(t.db);
      const claims = await t.db.select().from(positionSettlements);
      const holdings = await t.db.select().from(positions);
      const state = await t.db.select().from(markets).where(eq(markets.id, market.id));
      const people = await t.db
        .select()
        .from(balances)
        .where(sql`${balances.userId} IS NOT NULL`);
      expect((await audit(market.id)).result.passed).toBe(true); // pending is not an audit failure
      const done = await run(market.id);
      expect(done).toMatchObject({
        outcome: 'recalled',
        recall: {
          marketId: market.id,
          terminalStatus: 'settled',
          amountCoin: before.availableCoin,
        },
      });
      expect(await run(market.id)).toEqual({ ...done, outcome: 'duplicate' });
      expect(await transfers()).toHaveLength(1);
      expect((await ledgerAccountBalance(t.db, fundsRef(market.id)))!.availableCoin).toBe(0n);
      expect((await ledgerAccountBalance(t.db, { kind: 'treasury' }))!.availableCoin).toBe(
        treasuryBefore.availableCoin + before.availableCoin,
      );
      expect(await ledgerSupply(t.db)).toEqual(supply);
      expect(await t.db.select().from(positionSettlements)).toEqual(claims);
      expect(await t.db.select().from(positions)).toEqual(holdings);
      expect(await t.db.select().from(markets).where(eq(markets.id, market.id))).toEqual(state);
      expect(
        await t.db
          .select()
          .from(balances)
          .where(sql`${balances.userId} IS NOT NULL`),
      ).toEqual(people);
      expect((await audit(market.id)).result.passed).toBe(true);
    },
  );
  it('recalls a real funded opening after automatic zero-human-fill cancellation', async () => {
    const { market } = await createOpenedMarket(t.db);
    await passMarketClose(t.db, market.id);
    await closeTestMarket(t.db, market.id);
    const before = (await ledgerAccountBalance(t.db, fundsRef(market.id)))!;
    const supply = await ledgerSupply(t.db);
    const riskBefore = await t.db.transaction((tx) => readMarketMakerRiskSnapshot(tx, market.id));
    expect(await run(market.id)).toMatchObject({
      outcome: 'recalled',
      recall: { terminalStatus: 'cancelled', amountCoin: before.availableCoin },
    });
    expect(await ledgerSupply(t.db)).toEqual(supply);
    const riskAfter = await t.db.transaction((tx) => readMarketMakerRiskSnapshot(tx, market.id));
    if (riskBefore.kind !== 'ready' || riskAfter.kind !== 'ready')
      throw new Error('Expected preserved capital facts');
    expect(riskAfter.book.coin + riskAfter.book.recovered - riskAfter.book.invested).toBe(
      riskBefore.book.coin + riskBefore.book.recovered - riskBefore.book.invested,
    );
    expect(
      (await t.db.transaction((tx) => runSupplyReconciliation(tx, { source: 'manual' }))).result
        .passed,
    ).toBe(true);
    expect((await audit(market.id)).result.passed).toBe(true);
  });
  it('records an unallocated cancellation without creating funds, treasury or a zero ledger row', async () => {
    const market = await createMarket(t.db, { status: 'cancelled' });
    expect(await findLedgerAccount(t.db, { kind: 'treasury' })).toBeNull();
    const done = await run(market.id);
    expect(done).toMatchObject({
      outcome: 'recalled',
      recall: { amountCoin: 0n, ledgerEntryId: null, fundsAccountId: null },
    });
    expect(await run(market.id)).toEqual({ ...done, outcome: 'duplicate' });
    expect(await findLedgerAccount(t.db, fundsRef(market.id))).toBeNull();
    expect(await findLedgerAccount(t.db, { kind: 'treasury' })).toBeNull();
    expect(await transfers()).toEqual([]);
  });
  it('records zero remaining funds after a complete loss without a zero transfer', async () => {
    const market = await createMarket(t.db, { status: 'settling', resolvedResult: 'NO' });
    const owner = await createMarketMakerAccount(t.db);
    const person = (await createUser(t.db, { balanceCoin: 100n })).user.id;
    await fundMarketMakerFunds(t.db, market.id, 60n);
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: owner,
      noHolderId: person,
      qty: 1,
      yesPriceCoin: 60,
    });
    await t.db.transaction(async (tx) => {
      await settleMarketPositions(tx, market.id);
      await transitionMarket(tx, {
        marketId: market.id,
        from: 'settling',
        to: 'settled',
        type: 'finalized',
        actorId: null,
        at: await clockTimestamp(tx),
      });
    });
    const funds = await findLedgerAccount(t.db, fundsRef(market.id));
    expect(await run(market.id)).toMatchObject({
      outcome: 'recalled',
      recall: { amountCoin: 0n, ledgerEntryId: null, fundsAccountId: funds!.id },
    });
    expect(await transfers()).toEqual([]);
  });
  it.each([
    'draft',
    'review',
    'scheduled',
    'open',
    'paused',
    'closed',
    'provisional',
    'resolved',
    'settling',
  ] as const)('never recalls while %s', async (status) => {
    const market = await createMarket(t.db, { status });
    expect(await run(market.id)).toEqual({ outcome: 'unavailable', reason: 'not_terminal' });
    expect(await t.db.select().from(marketMakerRecalls)).toEqual([]);
  });
  it('preserves held terminal funds and does not release hold after a passing audit', async () => {
    const { market } = await legacyTerminal();
    const funds = (await findLedgerAccount(t.db, fundsRef(market.id)))!;
    await damageActualCoinForTest(funds.id, -1n);
    const broken = await audit(market.id);
    expect(broken.hold).not.toBeNull();
    await damageActualCoinForTest(funds.id, 1n);
    expect((await audit(market.id)).result.passed).toBe(true);
    const before = await t.db.select().from(balances);
    expect(await run(market.id)).toEqual({ outcome: 'unavailable', reason: 'ledger_hold' });
    expect(await t.db.select().from(balances)).toEqual(before);
    expect(await t.db.select().from(reconciliationHolds)).toHaveLength(1);
    expect(await transfers()).toEqual([]);
  });
  it('also waits for recovery of a legacy ledger pause that ended at the automatic close', async () => {
    const { market } = await createOpenedMarket(t.db);
    await createMarketPause(t.db, { marketId: market.id, reason: 'ledger_failure' });
    await passMarketClose(t.db, market.id);
    await closeTestMarket(t.db, market.id);
    expect(await t.db.select().from(reconciliationHolds)).toEqual([]);
    const before = await t.db.select().from(balances);
    expect(await run(market.id)).toEqual({ outcome: 'unavailable', reason: 'ledger_hold' });
    expect(await t.db.select().from(balances)).toEqual(before);
    expect(await transfers()).toEqual([]);
  });
  it.each(['funds', 'treasury'] as const)(
    'refuses a missing %s balance instead of assuming zero',
    async (kind) => {
      const { market } = await legacyTerminal();
      const account = (await findLedgerAccount(
        t.db,
        kind === 'funds' ? fundsRef(market.id) : { kind: 'treasury' },
      ))!;
      await withLedgerGuardsOff((client) =>
        client.query('DELETE FROM balances WHERE account_id=$1', [account.id]),
      );
      expect(await run(market.id)).toEqual({
        outcome: 'unavailable',
        reason: 'books_inconsistent',
      });
      expect(await transfers()).toEqual([]);
    },
  );
  it.each(['funds', 'treasury'] as const)(
    'checks actual ledger chain and sum for %s, not just matching mirrors',
    async (kind) => {
      const { market } = await legacyTerminal();
      const account = (await findLedgerAccount(
        t.db,
        kind === 'funds' ? fundsRef(market.id) : { kind: 'treasury' },
      ))!;
      await withLedgerGuardsOff((client) =>
        client.query(
          'UPDATE balances SET available_coin=available_coin+1,ledger_coin=ledger_coin+1 WHERE account_id=$1',
          [account.id],
        ),
      );
      expect(await run(market.id)).toEqual({
        outcome: 'unavailable',
        reason: 'books_inconsistent',
      });
      expect(await transfers()).toEqual([]);
    },
  );
  it('does not hide unexpected live orders, contracts or collateral behind terminal status', async () => {
    const { market, owner } = await legacyTerminal();
    await createOrder(t.db, { marketId: market.id, userId: owner, qty: 1, limitPriceCoin: 50 });
    expect(await run(market.id)).toEqual({ outcome: 'unavailable', reason: 'books_inconsistent' });
    expect(await transfers()).toEqual([]);
    const other = await legacyTerminal();
    await createPosition(t.db, {
      marketId: other.market.id,
      userId: other.owner,
      outcome: 'YES',
      qty: 1,
      costBasisCoin: 0n,
    });
    expect(await run(other.market.id)).toEqual({
      outcome: 'unavailable',
      reason: 'books_inconsistent',
    });
  });
  it('rolls back the transfer and completion together and then retries once', async () => {
    const { market } = await legacyTerminal();
    const before = await t.db.select().from(balances);
    await expect(
      t.db.transaction(async (tx) => {
        expect((await recallMarketMakerFunds(tx, { marketId: market.id })).outcome).toBe(
          'recalled',
        );
        throw new Error('after completion before commit');
      }),
    ).rejects.toThrow('after completion');
    expect(await t.db.select().from(balances)).toEqual(before);
    expect(await t.db.select().from(marketMakerRecalls)).toEqual([]);
    expect(await transfers()).toEqual([]);
    expect((await run(market.id)).outcome).toBe('recalled');
  });
  it('refuses a hold added after completion in the same transaction and rolls all economic writes back', async () => {
    const { market } = await settled('YES');
    const money = await t.db.select().from(balances);
    const ledger = await t.db.select().from(ledgerEntries);
    const payouts = await t.db.select().from(positionSettlements);
    const holdings = await t.db.select().from(positions);
    await expect(
      t.db.transaction(async (tx) => {
        const result = await recallMarketMakerFunds(tx, { marketId: market.id });
        expect(result.outcome).toBe('recalled');
        // App-role valid failure/hold rows are legal after an earlier operation in one tx. The
        // deferred recall guard must see this later evidence, not just its own INSERT instant.
        const at = await clockTimestamp(tx);
        const [failure] = await tx
          .insert(reconciliationResults)
          .values({
            scope: 'market',
            targetKey: `market:${market.id}`,
            marketId: market.id,
            accountId: null,
            userId: null,
            source: 'manual',
            actorId: null,
            passed: false,
            checkedAt: at,
            ledgerCursor: 0,
            findings: [{ code: 'account_balance', expected: '1', actual: '0' }],
            facts: {},
          })
          .returning();
        await tx.insert(reconciliationHolds).values({
          scope: 'market',
          targetKey: `market:${market.id}`,
          marketId: market.id,
          userId: null,
          failureResultId: failure!.id,
          startedAt: at,
        });
      }),
    ).rejects.toThrow();
    expect(await t.db.select().from(balances)).toEqual(money);
    expect(await t.db.select().from(ledgerEntries)).toEqual(ledger);
    expect(await t.db.select().from(positionSettlements)).toEqual(payouts);
    expect(await t.db.select().from(positions)).toEqual(holdings);
    expect(await t.db.select().from(marketMakerRecalls)).toEqual([]);
    expect(await t.db.select().from(reconciliationHolds)).toEqual([]);
  });
  it('serializes same-market retries and different markets sharing the treasury', async () => {
    const a = await legacyTerminal();
    const b = await legacyTerminal();
    const supply = await ledgerSupply(t.db);
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = t.db.transaction(async (tx) => {
      await lockMarket(tx, a.market.id);
      locked();
      await unblock;
      return recallMarketMakerFunds(tx, { marketId: a.market.id });
    });
    await acquired;
    const replay = run(a.market.id);
    const other = run(b.market.id);
    try {
      await waitForLockWaiter(t.db.$client, 'recall waits for the first terminal transfer');
    } finally {
      release();
    }
    expect((await Promise.all([first, replay, other])).map((r) => r.outcome)).toEqual([
      'recalled',
      'duplicate',
      'recalled',
    ]);
    expect(await transfers()).toHaveLength(2);
    expect(await ledgerSupply(t.db)).toEqual(supply);
  });
  it('rejects a new raw recall without its completion and leaves every balance unchanged', async () => {
    const { market } = await legacyTerminal();
    const before = await t.db.select().from(balances);
    await expect(
      t.db.transaction((tx) =>
        recordLedgerEntry(tx, {
          type: 'BOT_RECALL',
          amountCoin: 1_000n,
          from: fundsRef(market.id),
          to: { kind: 'treasury' },
          marketId: market.id,
          refType: 'market',
          refId: market.id,
          idempotencyKey: market.id,
        }),
      ),
    ).rejects.toThrow();
    expect(await t.db.select().from(balances)).toEqual(before);
    expect(await transfers()).toEqual([]);
  });
  it.each([
    { transferred: 1n, claimed: 1n, status: 'cancelled' as const },
    { transferred: 1_000n, claimed: 999n, status: 'cancelled' as const },
    { transferred: 1_000n, claimed: 1_000n, status: 'settled' as const },
    { transferred: 0n, claimed: 0n, status: 'cancelled' as const },
  ])(
    'rejects a partial/false raw completion $transferred/$claimed/$status atomically',
    async ({ transferred, claimed, status }) => {
      const { market } = await legacyTerminal();
      const funds = (await findLedgerAccount(t.db, fundsRef(market.id)))!;
      const before = await t.db.select().from(balances);
      await expect(
        t.db.transaction(async (tx) => {
          const at = await clockTimestamp(tx);
          const transfer =
            transferred > 0n
              ? await recordLedgerEntry(tx, {
                  type: 'BOT_RECALL',
                  amountCoin: transferred,
                  from: fundsRef(market.id),
                  to: { kind: 'treasury' },
                  marketId: market.id,
                  refType: 'market',
                  refId: market.id,
                  idempotencyKey: market.id,
                  at,
                })
              : null;
          await tx.insert(marketMakerRecalls).values({
            marketId: market.id,
            terminalStatus: status,
            statusEventId: null,
            judgementVersion: null,
            fundsAccountId: funds.id,
            amountCoin: claimed,
            ledgerEntryId: transfer?.entry.id ?? null,
            appliedTxid: sql`pg_current_xact_id()::text`,
            completedAt: at,
          });
        }),
      ).rejects.toThrow();
      expect(await t.db.select().from(balances)).toEqual(before);
      expect(await t.db.select().from(marketMakerRecalls)).toEqual([]);
      expect(await transfers()).toEqual([]);
    },
  );
  it('cannot retroactively bind an old full ledger return to a new completion', async () => {
    const { market } = await legacyTerminal();
    const funds = (await findLedgerAccount(t.db, fundsRef(market.id)))!;
    const old = await recordLegacyMarketMakerCapitalForTest({
      type: 'BOT_RECALL',
      amountCoin: 1_000n,
      from: fundsRef(market.id),
      to: { kind: 'treasury' },
      marketId: market.id,
      refType: 'market',
      refId: market.id,
      idempotencyKey: market.id,
    });
    await expect(
      t.db.transaction((tx) =>
        tx.insert(marketMakerRecalls).values({
          marketId: market.id,
          terminalStatus: 'cancelled',
          statusEventId: null,
          judgementVersion: null,
          fundsAccountId: funds.id,
          amountCoin: 1_000n,
          ledgerEntryId: old.entry.id,
          appliedTxid: sql`pg_current_xact_id()::text`,
          completedAt: old.entry.createdAt,
        }),
      ),
    ).rejects.toThrow();
    expect(await t.db.select().from(marketMakerRecalls)).toEqual([]);
  });
  it('refuses SETTLED with no final result or with incomplete preserved settlement claims', async () => {
    const { market } = await legacyTerminal('settled');
    await t.db.update(markets).set({ resolvedResult: null }).where(eq(markets.id, market.id));
    expect(await run(market.id)).toEqual({ outcome: 'unavailable', reason: 'books_inconsistent' });
    const other = await settled('YES');
    await withLedgerGuardsOff(async (client) => {
      await client.query('ALTER TABLE position_settlements DISABLE TRIGGER USER');
      await client.query('DELETE FROM position_settlements WHERE market_id=$1', [other.market.id]);
      await client.query('ALTER TABLE position_settlements ENABLE TRIGGER USER');
    });
    expect(await run(other.market.id)).toEqual({
      outcome: 'unavailable',
      reason: 'books_inconsistent',
    });
    expect(await transfers()).toEqual([]);
  });
  it('waits if the existing treasury has no Coin capacity instead of dropping or burning the return', async () => {
    const { market } = await legacyTerminal();
    await fundTestTreasury(t.db, 1_000_000_000_000_000n);
    const before = await t.db.select().from(balances);
    expect(await run(market.id)).toEqual({ outcome: 'unavailable', reason: 'treasury_capacity' });
    expect(await t.db.select().from(balances)).toEqual(before);
    expect(await transfers()).toEqual([]);
  });
  it('keeps completions immutable and detects owner-injected funds after completion without paying twice', async () => {
    const { market } = await legacyTerminal();
    await run(market.id);
    await expect(
      t.db
        .update(marketMakerRecalls)
        .set({ amountCoin: 1n })
        .where(eq(marketMakerRecalls.marketId, market.id)),
    ).rejects.toThrow();
    await expect(
      t.db.delete(marketMakerRecalls).where(eq(marketMakerRecalls.marketId, market.id)),
    ).rejects.toThrow();
    await fundMarketMakerFunds(t.db, market.id, 10n); // explicit legacy/owner incident helper
    expect(await run(market.id)).toEqual({ outcome: 'unavailable', reason: 'recall_inconsistent' });
    const observed = await audit(market.id);
    expect(observed.result.findings).toContainEqual(
      expect.objectContaining({ code: 'market_maker_recall' }),
    );
    expect(observed.hold).not.toBeNull();
    expect(await transfers()).toHaveLength(1);
  });
  it('does not invent completion for an old unbound recall and observes it as an audit failure', async () => {
    const { market } = await legacyTerminal();
    await recordLegacyMarketMakerCapitalForTest({
      type: 'BOT_RECALL',
      amountCoin: 10n,
      from: fundsRef(market.id),
      to: { kind: 'treasury' },
      marketId: market.id,
      refType: 'market',
      refId: market.id,
      idempotencyKey: randomUUID(),
    });
    expect(await t.db.transaction((tx) => checkMarketMakerRecallBooks(tx, market.id))).toEqual([
      'recall ledger has no permanent completion',
    ]);
    expect(await run(market.id)).toEqual({ outcome: 'unavailable', reason: 'recall_inconsistent' });
    expect(await t.db.select().from(marketMakerRecalls)).toEqual([]);
    expect((await audit(market.id)).result.passed).toBe(false);
  });
});
