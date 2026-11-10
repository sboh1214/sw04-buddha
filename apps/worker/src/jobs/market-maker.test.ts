import { readMarketMakerRuntime, requestMarketMakerRefresh, schema, type Db } from '@buddha/db';
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
