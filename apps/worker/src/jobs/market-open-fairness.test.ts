/** Actual PG coverage of bounded opening scans after completed, unfunded one-shot jobs. */
import {
  beginMarketMakerOpenAttempt,
  clockTimestamp,
  ensureLedgerAccount,
  lockMarket,
  recordMarketMakerOpenAttempt,
  recordMarketMakerOpenFailure,
  runMarketReconciliation,
  schema,
  type Db,
} from '@buddha/db';
import {
  connectTestDb,
  createMarketMakerAccount,
  createScheduledMarket,
  createUser,
  fundTestTreasury,
  hasTestDb,
  ledgerSupply,
  setReleaseSetting,
  withLedgerGuardsOff,
  type TestDb,
} from '@buddha/db/test';
import { MARKET_SCAN_BATCH_MAX } from '@buddha/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDueMarkets, openMarket } from './market-open.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

describe.skipIf(!hasTestDb())('bounded opening scan fairness (integration)', () => {
  let t: TestDb;
  let creator: string;
  let approver: string;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    creator = (await createUser(t.db, { role: 'admin' })).user.id;
    approver = (await createUser(t.db, { role: 'admin' })).user.id;
    await createMarketMakerAccount(t.db);
    for (const [key, value] of [
      ['market_maker.reduce_at_bp', 7000],
      ['market_maker.halt_at_bp', 9000],
      ['market_maker.reduce_ratio_bp', 5000],
    ] as const) {
      await setReleaseSetting(t.db, { key, value, status: 'test', adminId: creator });
    }
    await fundTestTreasury(t.db, 1n);
  });

  async function scheduled(budgetCoin: bigint, scheduledOpenAt: Date) {
    return (
      await createScheduledMarket(t.db, {
        createdBy: creator,
        approvedBy: approver,
        scheduledOpenAt,
        closeAt: new Date(Date.now() + 3_600_000),
        liquiditySettings: {
          budgetCoin,
          maxLossCoin: budgetCoin,
          b: 100,
          levels: 3,
          quantity: 10,
          safetyTicks: 1,
        },
      })
    ).market;
  }

  it('rotates past 500 completed unfunded jobs, then re-enters them after funding without duplicate allocations', async () => {
    const publish = vi.fn(async () => {});
    const blocked = [];
    const due = Date.now() - 600_000;
    for (let i = 0; i < MARKET_SCAN_BATCH_MAX; i++) {
      blocked.push(await scheduled(1000n, new Date(due + i)));
    }
    const affordable = await scheduled(100n, new Date(due + MARKET_SCAN_BATCH_MAX));
    // Every original delayed job completed as a normal skip, including the later cheap market.
    for (const market of [...blocked, affordable]) {
      await expect(openMarket(t.db, market.id, publish)).resolves.toMatchObject({
        outcome: 'skipped',
        reason: 'treasury_insufficient',
      });
    }
    await fundTestTreasury(t.db, 99n);
    const first = await openDueMarkets(t.db, publish);
    expect(first).toEqual({ opened: 0, skipped: 500, failed: 0, failures: [] });
    const second = await openDueMarkets(t.db, publish);
    expect(second).toMatchObject({ opened: 1, skipped: 499, failed: 0 });
    expect(second.opened + second.skipped + second.failed).toBe(MARKET_SCAN_BATCH_MAX);
    const [opened] = await t.db
      .select()
      .from(schema.markets)
      .where(eq(schema.markets.id, affordable.id));
    expect(opened?.status).toBe('open');
    expect(await t.db.select().from(schema.marketMakerAllocations)).toHaveLength(1);
    const before = await ledgerSupply(t.db);
    // The failed large markets remain eligible. Two overlapping scans must allocate each once.
    await fundTestTreasury(t.db, 500_000n);
    const overlapping = await Promise.all([
      openDueMarkets(t.db, publish),
      openDueMarkets(t.db, publish),
    ]);
    expect(overlapping.reduce((sum, result) => sum + result.opened, 0)).toBe(500);
    for (const result of overlapping) {
      expect(result.failed).toBe(0);
      expect(result.opened + result.skipped).toBeLessThanOrEqual(MARKET_SCAN_BATCH_MAX);
    }
    const allocations = await t.db.select().from(schema.marketMakerAllocations);
    expect(allocations).toHaveLength(501);
    expect(new Set(allocations.map((row) => row.marketId)).size).toBe(501);
    expect(allocations.reduce((sum, row) => sum + row.amountCoin, 0n)).toBe(500_100n);
    expect(publish).toHaveBeenCalledTimes(501);
    const after = await ledgerSupply(t.db);
    expect(after.mintedCoin - before.mintedCoin).toBe(500_000n);
    expect(after.heldCoin).toBe(after.carriedCoin);
    expect(after.heldCoin).toBe(after.mintedCoin - after.burnedCoin);
    expect(await openDueMarkets(t.db, publish)).toEqual({
      opened: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    });
  }, 120_000);

  it('records all 500 held skips so an unattempted affordable market is reached by the next bounded scan', async () => {
    const publish = vi.fn(async () => {});
    const due = Date.now() - 600_000;
    const held = [];
    for (let i = 0; i < MARKET_SCAN_BATCH_MAX; i++) {
      const market = await scheduled(1000n, new Date(due + i));
      held.push(market);
      await t.db.transaction((tx) =>
        ensureLedgerAccount(tx, { kind: 'market_maker_funds', marketId: market.id }),
      );
    }
    // Owner-only corruption is limited to this disposable test DB. The lasting holds themselves
    // come from real reconciliation; repairing the original gap alone must not recover them.
    const corrupt = (delta: number) =>
      withLedgerGuardsOff((client) =>
        client.query(
          "UPDATE balances SET available_coin=available_coin+$1 WHERE account_id IN (SELECT id FROM ledger_accounts WHERE kind='market_maker_funds')",
          [delta],
        ),
      );
    await corrupt(1);
    for (const market of held) {
      const audit = await t.db.transaction((tx) =>
        runMarketReconciliation(tx, market.id, { source: 'manual' }),
      );
      expect(audit.hold).not.toBeNull();
    }
    await corrupt(-1);
    const affordable = await scheduled(100n, new Date(due + MARKET_SCAN_BATCH_MAX));
    await fundTestTreasury(t.db, 99n);
    const assets = await t.db
      .select()
      .from(schema.balances)
      .orderBy(asc(schema.balances.accountId));
    expect(await openDueMarkets(t.db, publish)).toEqual({
      opened: 0,
      skipped: 500,
      failed: 0,
      failures: [],
    });
    expect(
      await t.db.select().from(schema.balances).orderBy(asc(schema.balances.accountId)),
    ).toEqual(assets);
    const observations = await t.db.select().from(schema.marketMakerOpenAttempts);
    expect(observations).toHaveLength(500);
    expect(observations.every((row) => row.reason === 'ledger_hold')).toBe(true);
    expect(await openDueMarkets(t.db, publish)).toMatchObject({
      opened: 1,
      skipped: 499,
      failed: 0,
    });
    const allocations = await t.db.select().from(schema.marketMakerAllocations);
    expect(allocations.map((row) => row.marketId)).toEqual([affordable.id]);
    expect(await t.db.select().from(schema.reconciliationHolds)).toHaveLength(500);
    expect(publish).toHaveBeenCalledTimes(1);
  }, 120_000);

  /** Roll back an actual statement timeout after the common helper has run. */
  function timeoutOnce(marketId: string, afterRollback?: () => Promise<void>): Db {
    let injected = false;
    return new Proxy(t.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async (run: (tx: Tx) => Promise<unknown>) => {
            let thisAttempt = false;
            try {
              return await target.transaction(async (tx) => {
                const done = await run(tx);
                if (
                  !injected &&
                  typeof done === 'object' &&
                  done !== null &&
                  'marketId' in done &&
                  done.marketId === marketId
                ) {
                  injected = thisAttempt = true;
                  await tx.execute(sql`SET LOCAL statement_timeout = '1ms'`);
                  await tx.execute(sql`SELECT pg_sleep(0.1)`);
                }
                return done;
              });
            } catch (error) {
              if (thisAttempt) await afterRollback?.();
              throw error;
            }
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  }

  it('retains a real PG failure in the scan while rotating its rolled-back attempt and continuing', async () => {
    const earlier = await scheduled(1000n, new Date(Date.now() - 120_000));
    const later = await scheduled(100n, new Date(Date.now() - 60_000));
    await fundTestTreasury(t.db, 99n);
    const publish = vi.fn(async () => {});
    const result = await openDueMarkets(timeoutOnce(earlier.id), publish);
    expect(result).toMatchObject({ opened: 1, skipped: 0, failed: 1 });
    expect(result.failures[0]).toMatchObject({ marketId: earlier.id });
    expect(result.failures[0]!.message).toContain('57014');
    const [failed] = await t.db
      .select()
      .from(schema.marketMakerOpenAttempts)
      .where(eq(schema.marketMakerOpenAttempts.marketId, earlier.id));
    expect(failed).toMatchObject({
      reason: 'execution_failed',
      requiredCoin: 1000n,
      availableCoin: null,
      succeededAt: null,
    });
    expect(
      (await t.db.select().from(schema.marketMakerAllocations)).map((row) => row.marketId),
    ).toEqual([later.id]);
    expect(publish).toHaveBeenCalledTimes(1);
    // The next successful observation supersedes this error without any automatic issuance.
    await expect(openMarket(t.db, earlier.id, publish)).resolves.toMatchObject({
      reason: 'treasury_insufficient',
    });
    const [next] = await t.db
      .select()
      .from(schema.marketMakerOpenAttempts)
      .where(eq(schema.marketMakerOpenAttempts.marketId, earlier.id));
    expect(next!.lastAttemptAt > failed!.lastAttemptAt).toBe(true);
    expect(next!.reason).toBe('treasury_insufficient');
  });

  it('does not overwrite a newer committed opening after an older transaction rolls back', async () => {
    const market = await scheduled(100n, new Date(Date.now() - 60_000));
    const publish = vi.fn(async () => {});
    await expect(
      openMarket(
        timeoutOnce(market.id, async () => {
          await fundTestTreasury(t.db, 99n);
          await expect(openMarket(t.db, market.id, publish)).resolves.toMatchObject({
            outcome: 'opened',
          });
        }),
        market.id,
        publish,
      ),
    ).rejects.toThrow();
    const [observation] = await t.db.select().from(schema.marketMakerOpenAttempts);
    expect(observation!.reason).toBeNull();
    expect(observation!.succeededAt).not.toBeNull();
    expect(await t.db.select().from(schema.marketMakerAllocations)).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('keeps a newer skip at an equal millisecond and refuses a failed observation after rescheduling', async () => {
    const market = await scheduled(100n, new Date(Date.now() - 60_000));
    const context = await t.db.transaction(async (tx) => {
      await lockMarket(tx, market.id);
      return beginMarketMakerOpenAttempt(tx, market, await clockTimestamp(tx));
    });
    expect(context).not.toBeNull();
    await t.db.transaction((tx) =>
      recordMarketMakerOpenAttempt(tx, {
        marketId: market.id,
        reason: 'ledger_hold',
        requiredCoin: 100n,
        availableCoin: null,
        liquidityVersion: 1,
        at: context!.startedAt,
      }),
    );
    const before = await t.db.select().from(schema.marketMakerOpenAttempts);
    await t.db.transaction((tx) => recordMarketMakerOpenFailure(tx, context!));
    expect(await t.db.select().from(schema.marketMakerOpenAttempts)).toEqual(before);
    await t.db
      .update(schema.markets)
      .set({ scheduledOpenAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.markets.id, market.id));
    await t.db.transaction((tx) =>
      recordMarketMakerOpenFailure(tx, {
        ...context!,
        startedAt: new Date(context!.startedAt.getTime() + 1),
      }),
    );
    expect(await t.db.select().from(schema.marketMakerOpenAttempts)).toEqual(before);
  });

  it('does not convert a post-COMMIT publication failure into a failed economic observation', async () => {
    const market = await scheduled(100n, new Date(Date.now() - 60_000));
    await fundTestTreasury(t.db, 99n);
    await expect(
      openMarket(t.db, market.id, () => Promise.reject(new Error('publish fixture'))),
    ).rejects.toThrow('publish fixture');
    const [observation] = await t.db.select().from(schema.marketMakerOpenAttempts);
    expect(observation!.reason).toBeNull();
    expect(observation!.succeededAt).not.toBeNull();
    expect(await t.db.select().from(schema.marketMakerAllocations)).toHaveLength(1);
  });

  it('keeps committed success when its transaction acknowledgement is lost', async () => {
    const market = await scheduled(100n, new Date(Date.now() - 60_000));
    await fundTestTreasury(t.db, 99n);
    let lost = false;
    const ambiguous = new Proxy(t.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async (run: (tx: Tx) => Promise<unknown>) => {
            const done = await target.transaction(run);
            if (!lost) {
              lost = true;
              throw new Error('COMMIT acknowledgement fixture');
            }
            return done;
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const publish = vi.fn(async () => {});
    await expect(openMarket(ambiguous, market.id, publish)).rejects.toThrow(
      'COMMIT acknowledgement fixture',
    );
    const before = await t.db.select().from(schema.marketMakerOpenAttempts);
    expect(before[0]!.reason).toBeNull();
    expect(before[0]!.succeededAt).toBeInstanceOf(Date);
    await expect(openMarket(t.db, market.id, publish)).resolves.toMatchObject({
      reason: 'not_scheduled',
    });
    expect(await t.db.select().from(schema.marketMakerOpenAttempts)).toEqual(before);
    expect(await t.db.select().from(schema.marketMakerAllocations)).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
  });
});
