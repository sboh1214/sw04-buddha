import {
  readMarketMakerRuntime,
  recordMarketMakerRun,
  requestMarketMakerRefresh,
  schema,
  type Db,
} from '@buddha/db';
import {
  connectTestDb,
  createMarket,
  createMarketPause,
  createOpenedMarket,
  createUser,
  hasTestDb,
  mintTestPairs,
  openOrderIntake,
  placeTestOrder,
  setReleaseSetting,
  type TestDb,
} from '@buddha/db/test';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshMarketMaker, scanMarketMakers } from './market-maker.js';
import type { Publish } from '../realtime.js';
import type { EnqueueMarketMaker } from '../market-maker-jobs.js';

const logger = pino({ level: 'silent' });
const settings = {
  budgetCoin: 10_000n,
  maxLossCoin: 5_000n,
  b: 100_000,
  levels: 3,
  quantity: 10,
  safetyTicks: 1,
};

describe.skipIf(!hasTestDb())('maker worker transactions and delivery (#129)', () => {
  let t: TestDb;
  let adminId: string;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
  });
  const opened = async () =>
    (await createOpenedMarket(t.db, { liquiditySettings: settings })).market;

  it('publishes one committed book, no trade/tick for quotes, and a duplicate publishes nothing', async () => {
    const market = await opened();
    const publish = vi.fn<Publish>().mockImplementation(async () => {
      expect((await readMarketMakerRuntime(t.db, market.id))?.completedGeneration).toBe(1n);
      expect(
        await t.db.select().from(schema.orders).where(eq(schema.orders.marketId, market.id)),
      ).toHaveLength(2);
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    expect(await refreshMarketMaker(t.db, market.id, publish, enqueue, logger)).toMatchObject({
      outcome: 'ready',
      placedOrders: 2,
    });
    expect(publish.mock.calls.map(([, event]) => event.type)).toEqual(['market:book']);
    publish.mockClear();
    expect(await refreshMarketMaker(t.db, market.id, publish, enqueue, logger)).toMatchObject({
      outcome: 'skipped',
      reason: 'already_completed',
    });
    expect(publish).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('publishes a committed immediate fill once and enqueues the newer durable generation', async () => {
    const market = await opened();
    const a = (await createUser(t.db, { balanceCoin: 4_000n })).user.id;
    const b = (await createUser(t.db, { balanceCoin: 4_000n })).user.id;
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: a, noHolderId: b, qty: 1 });
    await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: a,
      outcome: 'YES',
      side: 'sell',
      limitPriceCoin: 1,
      qty: 1,
    });
    const preparedFillCount = (await t.db.select().from(schema.fills)).length;
    const publish = vi.fn<Publish>().mockImplementation(async () => {
      expect(await t.db.select().from(schema.fills)).toHaveLength(preparedFillCount + 1);
      expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
        completedGeneration: 1n,
        generation: 2n,
      });
    });
    const enqueue = vi.fn().mockImplementation(async () => {
      expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
        completedGeneration: 1n,
        generation: 2n,
      });
    });
    const result = await refreshMarketMaker(t.db, market.id, publish, enqueue, logger);
    expect(result).toMatchObject({ generation: '1', fills: 1, nextGeneration: '2' });
    for (const type of ['market:book', 'market:tick', 'market:trade']) {
      expect(publish.mock.calls.filter(([, event]) => event.type === type)).toHaveLength(1);
    }
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(market.id, 2n);
    const publicEvents = publish.mock.calls.filter(([, event]) => event.type.startsWith('market:'));
    for (const [, event] of publicEvents) {
      expect(JSON.stringify(event)).not.toMatch(
        /generation|desiredEnabled|lastConfigVersion|riskReason/,
      );
    }
  });

  it('rolls back economic writes before recording an error, emits nothing, and retries the same work', async () => {
    const market = await opened();
    const before = await t.db.select().from(schema.balances);
    let fail = true;
    const failing = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop !== 'transaction') return Reflect.get(target, prop, receiver) as unknown;
        return (callback: Parameters<Db['transaction']>[0]) =>
          target.transaction(async (tx) => {
            const value = await callback(tx);
            if (fail) {
              fail = false;
              throw new Error('commit-boundary fixture failure');
            }
            return value;
          });
      },
    });
    const publish = vi.fn<Publish>().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    await expect(refreshMarketMaker(failing, market.id, publish, enqueue, logger)).rejects.toThrow(
      'commit-boundary fixture failure',
    );
    expect(await t.db.select().from(schema.orders)).toEqual([]);
    expect(await t.db.select().from(schema.balances)).toEqual(before);
    expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
      generation: 1n,
      completedGeneration: 0n,
      state: 'error',
      consecutiveFailures: 1,
      desiredEnabled: true,
    });
    expect(await t.db.select().from(schema.marketMakerRuns)).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(await refreshMarketMaker(t.db, market.id, publish, enqueue, logger)).toMatchObject({
      outcome: 'ready',
      generation: '1',
    });
    expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
      completedGeneration: 1n,
      state: 'ready',
      consecutiveFailures: 0,
    });
  });

  it('the periodic scan preserves dirty generations, creates new work after settings change, and never backfills legacy markets', async () => {
    const market = await opened();
    const legacy = await createMarket(t.db, { status: 'open' });
    const enqueue = vi.fn().mockImplementation(async (id: string, generation: bigint) => {
      expect((await readMarketMakerRuntime(t.db, id))?.generation).toBe(generation);
    });
    expect(await scanMarketMakers(t.db, enqueue)).toMatchObject({ queued: 1, failed: 0 });
    expect(enqueue).toHaveBeenLastCalledWith(market.id, 1n);
    await scanMarketMakers(t.db, enqueue);
    expect(enqueue).toHaveBeenLastCalledWith(market.id, 1n);
    await refreshMarketMaker(t.db, market.id, () => Promise.resolve(), enqueue, logger);
    for (const key of [
      'market_maker.reduce_at_bp',
      'market_maker.halt_at_bp',
      'market_maker.reduce_ratio_bp',
    ]) {
      await setReleaseSetting(t.db, { adminId, key, value: 0, status: 'test' });
    }
    await scanMarketMakers(t.db, enqueue);
    expect(enqueue).toHaveBeenLastCalledWith(market.id, 2n);
    expect(await readMarketMakerRuntime(t.db, legacy.id)).toBeNull();
    const publish = vi.fn<Publish>().mockResolvedValue(undefined);
    await refreshMarketMaker(t.db, market.id, publish, enqueue, logger);
    expect(publish.mock.calls.map(([, event]) => event.type)).toEqual(['market:book']);
  });

  function failOneTransaction(afterCommit = false) {
    let first = true;
    return new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop !== 'transaction') return Reflect.get(target, prop, receiver) as unknown;
        return async (callback: Parameters<Db['transaction']>[0]) => {
          if (!first) return target.transaction(callback);
          first = false;
          if (afterCommit) {
            await target.transaction(callback);
            throw new Error('lost commit reply');
          }
          return target.transaction(async (tx) => {
            await callback(tx);
            throw new Error('rolled-back fixture failure');
          });
        };
      },
    });
  }

  it('exhaustion stops only this bot, safely clears its quotes, and never auto-restarts', async () => {
    const market = await opened();
    const other = await opened();
    const publish = vi.fn<Publish>().mockResolvedValue(undefined);
    const enqueue = vi.fn<EnqueueMarketMaker>().mockResolvedValue(undefined);
    await refreshMarketMaker(t.db, market.id, publish, enqueue, logger);
    const person = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    const humanOrder = await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: person,
      outcome: 'YES',
      side: 'buy',
      limitPriceCoin: 1,
      qty: 1,
    });
    if (humanOrder.kind !== 'placed') throw new Error('Human order fixture was not placed');
    await t.db.transaction((tx) => requestMarketMakerRefresh(tx, market.id));
    const before = (await readMarketMakerRuntime(t.db, market.id))!;
    publish.mockClear();
    for (const attempt of [1, 2, 3]) {
      await expect(
        refreshMarketMaker(failOneTransaction(), market.id, publish, enqueue, logger, {
          attempt,
          maxAttempts: 3,
        }),
      ).rejects.toThrow('rolled-back fixture failure');
      expect((await readMarketMakerRuntime(t.db, market.id))?.desiredEnabled).toBe(attempt < 3);
    }
    expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
      desiredEnabled: false,
      state: 'stopped',
      reason: 'retry_exhausted',
      controlGeneration: 2n,
      generation: before.generation + 1n,
      completedGeneration: before.generation + 1n,
      consecutiveFailures: 3,
    });
    const rows = await t.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.marketId, market.id));
    expect(rows.filter((row) => row.status === 'open').map((row) => row.id)).toEqual([
      humanOrder.order.id,
    ]);
    expect(publish.mock.calls.map(([, event]) => event.type)).toEqual(['market:book']);
    expect(await readMarketMakerRuntime(t.db, other.id)).toMatchObject({
      desiredEnabled: true,
      controlGeneration: 1n,
    });
    enqueue.mockClear();
    await scanMarketMakers(t.db, enqueue);
    expect(enqueue.mock.calls.map(([id]) => id)).toEqual([other.id]);
    const counterparty = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    const humanTrade = await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: counterparty,
      outcome: 'NO',
      side: 'buy',
      limitPriceCoin: 99,
      qty: 1,
    });
    if (humanTrade.kind !== 'placed') throw new Error('Human trade fixture was not placed');
    expect(humanTrade.fills).toHaveLength(1);
    expect(humanTrade.fills[0]!.restingOrderId).toBe(humanOrder.order.id);
    expect(
      (await t.db.select().from(schema.markets).where(eq(schema.markets.id, market.id)))[0]!.status,
    ).toBe('open');
    expect(await refreshMarketMaker(t.db, market.id, publish, enqueue, logger)).toMatchObject({
      outcome: 'skipped',
    });
    await expect(
      t.db
        .update(schema.marketMakerRuntime)
        .set({ desiredEnabled: true })
        .where(eq(schema.marketMakerRuntime.marketId, market.id)),
    ).rejects.toThrow();
  });

  it('a lost success reply on the final attempt records evidence without stopping the committed generation', async () => {
    const market = await opened();
    await expect(
      refreshMarketMaker(failOneTransaction(true), market.id, vi.fn(), vi.fn(), logger, {
        attempt: 3,
        maxAttempts: 3,
      }),
    ).rejects.toThrow('lost commit reply');
    expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
      desiredEnabled: true,
      state: 'ready',
      controlGeneration: 1n,
      completedGeneration: 1n,
    });
    expect(await t.db.select().from(schema.marketMakerRuns)).toHaveLength(2);
  });

  it('keeps held locks after stopping, ignores old control failures, and leaves cleanup pending', async () => {
    const market = await opened();
    const publish = vi.fn<Publish>().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    await refreshMarketMaker(t.db, market.id, publish, enqueue, logger);
    await t.db.transaction((tx) => requestMarketMakerRefresh(tx, market.id));
    const current = (await readMarketMakerRuntime(t.db, market.id))!;
    await createMarketPause(t.db, { marketId: market.id, reason: 'ledger_failure', by: adminId });
    const ordersBefore = await t.db.select().from(schema.orders);
    const balancesBefore = await t.db.select().from(schema.balances);
    publish.mockClear();
    await expect(
      refreshMarketMaker(failOneTransaction(), market.id, publish, enqueue, logger, {
        attempt: 3,
        maxAttempts: 3,
      }),
    ).rejects.toThrow('rolled-back fixture failure');
    expect(await t.db.select().from(schema.orders)).toEqual(ordersBefore);
    expect(await t.db.select().from(schema.balances)).toEqual(balancesBefore);
    expect(publish).not.toHaveBeenCalled();
    const stopped = (await readMarketMakerRuntime(t.db, market.id))!;
    expect(stopped).toMatchObject({
      desiredEnabled: false,
      state: 'stopped',
      reason: 'retry_exhausted',
      controlGeneration: 2n,
    });
    expect(stopped.generation).toBeGreaterThan(stopped.completedGeneration);
    const late = await t.db.transaction((tx) =>
      recordMarketMakerRun(tx, {
        marketId: market.id,
        generation: current.generation,
        controlGeneration: current.controlGeneration,
        outcome: 'error',
        retryExhausted: true,
        error: 'late old-control failure',
        startedAt: new Date(),
      }),
    );
    expect(late?.stale).toBe(true);
    expect(await readMarketMakerRuntime(t.db, market.id)).toEqual(stopped);
    await scanMarketMakers(t.db, enqueue);
    expect(enqueue).toHaveBeenLastCalledWith(market.id, stopped.generation);
  });

  it('normal final-attempt waiting never stops the bot or increments failures', async () => {
    const market = await opened();
    await createMarketPause(t.db, { marketId: market.id, reason: 'ledger_failure', by: adminId });
    expect(
      await refreshMarketMaker(t.db, market.id, vi.fn(), vi.fn(), logger, {
        attempt: 3,
        maxAttempts: 3,
      }),
    ).toMatchObject({ outcome: 'waiting', reason: 'ledger_hold' });
    expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
      desiredEnabled: true,
      consecutiveFailures: 0,
      controlGeneration: 1n,
    });
  });

  it.each([0, 2])(
    'a lost waiting reply on the final attempt preserves its committed runtime after %i prior failures',
    async (priorFailures) => {
      const market = await opened();
      await createMarketPause(t.db, { marketId: market.id, reason: 'ledger_failure', by: adminId });
      for (let attempt = 1; attempt <= priorFailures; attempt++) {
        await expect(
          refreshMarketMaker(failOneTransaction(), market.id, vi.fn(), vi.fn(), logger, {
            attempt,
            maxAttempts: 3,
          }),
        ).rejects.toThrow('rolled-back fixture failure');
      }
      const before = (await readMarketMakerRuntime(t.db, market.id))!;
      const publish = vi.fn<Publish>().mockResolvedValue(undefined);
      const enqueue = vi.fn<EnqueueMarketMaker>().mockResolvedValue(undefined);
      await expect(
        refreshMarketMaker(failOneTransaction(true), market.id, publish, enqueue, logger, {
          attempt: 3,
          maxAttempts: 3,
        }),
      ).rejects.toThrow('lost commit reply');
      expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
        desiredEnabled: true,
        state: 'waiting',
        reason: 'ledger_hold',
        generation: before.generation,
        controlGeneration: before.controlGeneration,
        completedGeneration: before.completedGeneration,
        consecutiveFailures: before.consecutiveFailures,
        lastFailureAt: before.lastFailureAt,
        lastError: before.lastError,
      });
      const runs = await t.db.select().from(schema.marketMakerRuns);
      expect(runs.filter((run) => run.outcome === 'waiting')).toHaveLength(1);
      expect(runs.filter((run) => run.outcome === 'error')).toHaveLength(priorFailures + 1);
      expect(publish).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('an older waiting run does not disguise a later real rollback of the same generation', async () => {
    const market = await opened();
    await createMarketPause(t.db, { marketId: market.id, reason: 'ledger_failure', by: adminId });
    await refreshMarketMaker(t.db, market.id, vi.fn(), vi.fn(), logger);
    const [prior] = await t.db.select().from(schema.marketMakerRuns);
    const before = (await readMarketMakerRuntime(t.db, market.id))!;
    expect(prior!.outcome).toBe('waiting');
    await expect(
      refreshMarketMaker(failOneTransaction(), market.id, vi.fn(), vi.fn(), logger, {
        attempt: 3,
        maxAttempts: 3,
      }),
    ).rejects.toThrow('rolled-back fixture failure');
    expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
      desiredEnabled: false,
      state: 'stopped',
      reason: 'retry_exhausted',
      controlGeneration: before.controlGeneration + 1n,
      consecutiveFailures: before.consecutiveFailures + 1,
    });
    const kept = await t.db
      .select()
      .from(schema.marketMakerRuns)
      .where(eq(schema.marketMakerRuns.id, prior!.id));
    expect(kept).toEqual([prior]);
  });

  it('a supplied UUID from another market cannot suppress a real final failure', async () => {
    const other = await opened();
    await createMarketPause(t.db, { marketId: other.id, reason: 'ledger_failure', by: adminId });
    await refreshMarketMaker(t.db, other.id, vi.fn(), vi.fn(), logger);
    const [prior] = await t.db.select().from(schema.marketMakerRuns);
    const market = await opened();
    const current = (await readMarketMakerRuntime(t.db, market.id))!;
    const recorded = await t.db.transaction((tx) =>
      recordMarketMakerRun(tx, {
        marketId: market.id,
        generation: current.generation,
        controlGeneration: current.controlGeneration,
        returnedRunId: prior!.id,
        startedAt: prior!.startedAt,
        outcome: 'error',
        retryExhausted: true,
        error: 'different market attempt',
      }),
    );
    expect(recorded?.stale).toBe(false);
    expect(recorded?.runtime).toMatchObject({ desiredEnabled: false, consecutiveFailures: 1 });
  });

  it('checks the current hold before stale queued work and preserves its locks and public silence', async () => {
    const market = await opened();
    await refreshMarketMaker(
      t.db,
      market.id,
      () => Promise.resolve(),
      () => Promise.resolve(),
      logger,
    );
    await t.db.transaction((tx) => requestMarketMakerRefresh(tx, market.id));
    await createMarketPause(t.db, { marketId: market.id, reason: 'ledger_failure', by: adminId });
    const before = await t.db.select().from(schema.orders);
    const balances = await t.db.select().from(schema.balances);
    const publish = vi.fn<Publish>().mockResolvedValue(undefined);
    expect(
      await refreshMarketMaker(t.db, market.id, publish, () => Promise.resolve(), logger),
    ).toMatchObject({ outcome: 'waiting', generation: '2', reason: 'ledger_hold' });
    expect(await t.db.select().from(schema.orders)).toEqual(before);
    expect(await t.db.select().from(schema.balances)).toEqual(balances);
    expect(publish).not.toHaveBeenCalled();
  });
});
