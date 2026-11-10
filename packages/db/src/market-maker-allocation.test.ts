import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allocateMarketMakerInitial } from './market-maker-allocation.js';
import { findLedgerAccount, lockLedgerAccounts } from './ledger.js';
import { insertRuleVersion } from './market-rules-content.js';
import { transitionMarket } from './market-transitions.js';
import { mintTreasury } from './treasury.js';
import {
  readMarketMakerRuntime,
  recordMarketMakerOpenAttempt,
  readMarketMakerOpenAttempt,
  requestMarketMakerRefresh,
  recordMarketMakerRun,
} from './market-maker-runtime.js';
import {
  balances,
  ledgerEntries,
  marketMakerAllocations,
  marketMakerRuntime,
  marketMakerRuns,
  markets,
  positions,
  profiles,
} from './schema/index.js';
import {
  createApprovalRequest,
  createMarket,
  createMarketMakerAccount,
  createScheduledMarket,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { ledgerSupply } from './test/ledger.js';
import { clockTimestamp } from './tx-helpers.js';
import { waitForLockWaiter } from './test/wait.js';

describe.skipIf(!hasTestDb())('initial market maker allocation and runtime (#129)', () => {
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

  async function treasury(amountCoin = 10_000n) {
    const requestedBy = (await createUser(t.db, { role: 'admin' })).user.id;
    const by = (await createUser(t.db, { role: 'admin' })).user.id;
    const approved = await createApprovalRequest(t.db, {
      kind: 'treasury_issue',
      targetType: 'treasury',
      targetId: 'treasury',
      requestedBy,
      payload: { amountCoin: String(amountCoin) },
      decision: { status: 'approved', by },
    });
    return t.db.transaction((tx) => mintTreasury(tx, { approvalId: approved.id }));
  }
  async function prepared(amount = 10_000n) {
    const owner = await createMarketMakerAccount(t.db);
    const scheduled = await createScheduledMarket(t.db);
    await treasury(amount);
    return { ...scheduled, owner };
  }
  // Exercise the primitive without stage settings or worker scheduling. The production opening
  // path performs these same transitions; omitting any one must fail at COMMIT.
  async function allocateAndOpen(marketId: string) {
    return t.db.transaction(async (tx) => {
      const result = await allocateMarketMakerInitial(tx, { marketId, liquidityVersion: 1 });
      if (result.outcome !== 'allocated') return result;
      const [market] = await tx.select().from(markets).where(eq(markets.id, marketId));
      const at = result.at;
      await transitionMarket(tx, {
        marketId,
        from: 'scheduled',
        to: 'open',
        type: 'opened',
        actorId: null,
        payload: {
          openAt: at.toISOString(),
          closeAt: market!.closeAt.toISOString(),
          source: 'job',
        },
        at,
        set: { openAt: at, ruleVersion: 1, openedLiquidityVersion: 1 },
      });
      await insertRuleVersion(tx, {
        marketId,
        version: 1,
        createdAt: at,
        createdBy: null,
        supplement: null,
      });
      return result;
    });
  }

  it('allocates exactly A once with the approved version, OPEN and no initial pairs', async () => {
    const { market, request } = await prepared();
    const before = await ledgerSupply(t.db);
    const result = await allocateAndOpen(market.id);
    expect(result.outcome).toBe('allocated');
    if (result.outcome !== 'allocated') throw new Error('expected allocation');
    expect(result.allocation).toMatchObject({
      marketId: market.id,
      amountCoin: 10_000n,
      liquidityVersion: 1,
      approvalId: request.id,
      approvedEventId: market.statusEventId,
    });
    expect(await ledgerSupply(t.db)).toEqual(before);
    expect(await t.db.select().from(positions)).toEqual([]);
    const funds = await findLedgerAccount(t.db, {
      kind: 'market_maker_funds',
      marketId: market.id,
    });
    expect(
      (await t.db.select().from(balances).where(eq(balances.accountId, funds!.id)))[0],
    ).toMatchObject({ availableCoin: 10_000n, lockedCoin: 0n, ledgerCoin: 10_000n });
    expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
      desiredEnabled: true,
      generation: 1n,
      completedGeneration: 0n,
      state: 'waiting',
      lastConfigVersion: 1,
      createdAt: result.at,
      updatedAt: result.at,
      lastAttemptAt: null,
    });
    expect(await allocateAndOpen(market.id)).toEqual({ ...result, outcome: 'duplicate' });
    expect(await t.db.select().from(marketMakerAllocations)).toHaveLength(1);
    expect(await t.db.select().from(ledgerEntries)).toHaveLength(2);
  });

  it('does not invalidate the historical approved review when its admins later lose roles', async () => {
    const { market, request } = await prepared();
    await t.db
      .update(profiles)
      .set({ role: 'user' })
      .where(eq(profiles.userId, request.requestedBy));
    await t.db
      .update(profiles)
      .set({ role: 'user' })
      .where(eq(profiles.userId, request.decidedBy!));
    expect((await allocateAndOpen(market.id)).outcome).toBe('allocated');
  });

  it('insufficient treasury leaves accounts, money, allocation and runtime untouched', async () => {
    const { market } = await prepared(9_999n);
    const entries = await t.db.select().from(ledgerEntries);
    const money = await t.db.select().from(balances);
    expect(await allocateAndOpen(market.id)).toEqual({
      outcome: 'unavailable',
      reason: 'treasury_insufficient',
      requiredCoin: 10_000n,
      availableCoin: 9_999n,
    });
    expect(
      await findLedgerAccount(t.db, { kind: 'market_maker_funds', marketId: market.id }),
    ).toBeNull();
    expect(await t.db.select().from(ledgerEntries)).toEqual(entries);
    expect(await t.db.select().from(balances)).toEqual(money);
    expect(await readMarketMakerRuntime(t.db, market.id)).toBeNull();
    await treasury(1n);
    expect((await allocateAndOpen(market.id)).outcome).toBe('allocated');
  });

  it('serializes two markets competing for one budget without negative treasury or empty loser funds', async () => {
    const { market: first } = await prepared();
    const { market: second } = await createScheduledMarket(t.db);
    const results = await Promise.all([allocateAndOpen(first.id), allocateAndOpen(second.id)]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['allocated', 'unavailable']);
    const loser = results[0].outcome === 'unavailable' ? first : second;
    expect(results.find((result) => result.outcome === 'unavailable')).toMatchObject({
      reason: 'treasury_insufficient',
      availableCoin: 0n,
    });
    expect(
      await findLedgerAccount(t.db, { kind: 'market_maker_funds', marketId: loser.id }),
    ).toBeNull();
    expect(await t.db.select().from(marketMakerAllocations)).toHaveLength(1);
    expect(await t.db.select().from(marketMakerRuntime)).toHaveLength(1);
    expect(await ledgerSupply(t.db)).toEqual({
      mintedCoin: 10_000n,
      burnedCoin: 0n,
      heldCoin: 10_000n,
      carriedCoin: 10_000n,
    });
  });

  it('absent treasury and wrong configuration never create empty system accounts', async () => {
    await createMarketMakerAccount(t.db);
    const { market } = await createScheduledMarket(t.db);
    expect(await allocateAndOpen(market.id)).toMatchObject({ reason: 'treasury_missing' });
    expect(await findLedgerAccount(t.db, { kind: 'treasury' })).toBeNull();
    expect(
      await t.db.transaction((tx) =>
        allocateMarketMakerInitial(tx, { marketId: market.id, liquidityVersion: 2 }),
      ),
    ).toMatchObject({ reason: 'liquidity_missing' });
    expect(
      await findLedgerAccount(t.db, { kind: 'market_maker_funds', marketId: market.id }),
    ).toBeNull();
  });

  it('rolls back funding if the required opening is missing at commit', async () => {
    const { market } = await prepared();
    const before = await ledgerSupply(t.db);
    await expect(
      t.db.transaction((tx) =>
        allocateMarketMakerInitial(tx, { marketId: market.id, liquidityVersion: 1 }),
      ),
    ).rejects.toThrow();
    expect(await ledgerSupply(t.db)).toEqual(before);
    expect(await t.db.select().from(marketMakerAllocations)).toEqual([]);
    expect(await readMarketMakerRuntime(t.db, market.id)).toBeNull();
    expect(
      await findLedgerAccount(t.db, { kind: 'market_maker_funds', marketId: market.id }),
    ).toBeNull();
  });

  it('rechecks the close clock after waiting for the treasury lock', async () => {
    const { market } = await prepared();
    const closing = new Date(Date.now() + 500);
    await t.db.update(markets).set({ closeAt: closing }).where(eq(markets.id, market.id));
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = t.db.transaction(async (tx) => {
      await lockLedgerAccounts(tx, [{ kind: 'treasury' }]);
      locked();
      await unblock;
    });
    await acquired;
    const pending = allocateAndOpen(market.id);
    try {
      await waitForLockWaiter(t.db.$client, 'allocation waits on the treasury balance');
      // The DB owns the clock; this wait only crosses the fixture's close boundary.
      await t.db.execute(
        sql`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ${closing}::timestamptz-clock_timestamp()))+0.05)`,
      );
    } finally {
      release();
    }
    await holder;
    expect(await pending).toMatchObject({ outcome: 'unavailable', reason: 'close_passed' });
    expect(await t.db.select().from(marketMakerAllocations)).toEqual([]);
    expect(
      await findLedgerAccount(t.db, { kind: 'market_maker_funds', marketId: market.id }),
    ).toBeNull();
  });

  it('only ready completes its captured generation, retaining newer work and stale failure evidence', async () => {
    const { market } = await prepared();
    await allocateAndOpen(market.id);
    const second = await t.db.transaction((tx) => requestMarketMakerRefresh(tx, market.id));
    expect(second!.generation).toBe(2n);
    const run = (generation: bigint, outcome: 'ready' | 'waiting' | 'error') =>
      t.db.transaction(async (tx) =>
        recordMarketMakerRun(tx, {
          marketId: market.id,
          generation,
          outcome,
          startedAt: await clockTimestamp(tx),
          ...(outcome === 'error' ? { error: 'execution failure', reason: 'runtime_error' } : {}),
        }),
      );
    expect((await run(1n, 'waiting'))!.runtime.completedGeneration).toBe(0n);
    expect((await run(1n, 'error'))!.runtime).toMatchObject({
      desiredEnabled: true,
      completedGeneration: 0n,
      generation: 2n,
      consecutiveFailures: 1,
      state: 'error',
      lastError: 'execution failure',
    });
    expect((await run(1n, 'ready'))!.runtime).toMatchObject({
      generation: 2n,
      completedGeneration: 1n,
      consecutiveFailures: 0,
      lastError: null,
    });
    const successful = (await run(2n, 'ready'))!.runtime;
    expect(await run(1n, 'error')).toMatchObject({ stale: true, runtime: successful });
    expect(await t.db.select().from(marketMakerRuns)).toHaveLength(5);
    expect(await ledgerSupply(t.db)).toEqual({
      mintedCoin: 10_000n,
      burnedCoin: 0n,
      heldCoin: 10_000n,
      carriedCoin: 10_000n,
    });
    await expect(t.db.update(marketMakerRuntime).set({ desiredEnabled: false })).rejects.toThrow();
    await expect(t.db.delete(marketMakerRuns)).rejects.toThrow();
  });

  it('observes opening waits without backfilling an operational runtime', async () => {
    const legacy = await createMarket(t.db);
    const wait = await t.db.transaction((tx) =>
      recordMarketMakerOpenAttempt(tx, {
        marketId: legacy.id,
        reason: 'settings_missing',
        requiredCoin: null,
        availableCoin: null,
        liquidityVersion: null,
      }),
    );
    expect(await readMarketMakerOpenAttempt(t.db, legacy.id)).toEqual(wait);
    expect(await t.db.transaction((tx) => requestMarketMakerRefresh(tx, legacy.id))).toBeNull();
    expect(await readMarketMakerRuntime(t.db, legacy.id)).toBeNull();
    expect(await t.db.select().from(ledgerEntries)).toEqual([]);
  });
});
