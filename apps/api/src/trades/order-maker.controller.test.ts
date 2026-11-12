import { randomUUID } from 'node:crypto';
import {
  readMarketMakerRuntime,
  requestMarketMakerRefresh,
  runMarketMakerCycle,
  runMarketReconciliation,
  schema,
  type MarketMakerCycleResult,
} from '@buddha/db';
import {
  completeOnboarding,
  createOpenedMarket,
  createStartGrant,
  createUser,
  openOrderIntake,
} from '@buddha/db/test';
import { placeOrderResultSchema, type MarketMakerJobData } from '@buddha/shared';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { OrderService } from './order.service.js';

describe.skipIf(!hasTestInfra)('member fill maker trigger (#129)', () => {
  let t: TestApp;
  let member: TestUser;
  let marketId: string;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    await t.reset();
    const adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
    member = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: member.id });
    await createStartGrant(t.db, { userId: member.id, amountCoin: 1_000n });
    const { market } = await createOpenedMarket(t.db, {
      liquiditySettings: {
        budgetCoin: 10_000n,
        maxLossCoin: 5_000n,
        b: 100_000,
        levels: 3,
        quantity: 10,
        safetyTicks: 1,
      },
    });
    marketId = market.id;
    await t.db.transaction((tx) => runMarketMakerCycle(tx, { marketId }));
  });
  const send = (requestId = randomUUID(), price = 52) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/markets/${marketId}/orders`,
      headers: {
        origin: 'http://localhost:3000',
        cookie: member.cookie,
        'content-type': 'application/json',
        'idempotency-key': requestId,
      },
      payload: JSON.stringify({
        expectedAccountId: member.id,
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        limitPriceCoin: price,
        qty: 1,
      }),
    });

  it('enqueues only the committed MM fill generation; replay and an unfilled intake do not enqueue', async () => {
    const enqueue = vi
      .spyOn(t.app.get(MarketJobs), 'refreshMarketMaker')
      .mockImplementation(async (id, generation) => {
        expect(await readMarketMakerRuntime(t.db, id)).toMatchObject({
          generation,
          completedGeneration: 1n,
        });
        expect(await t.db.select().from(schema.fills)).toHaveLength(1);
      });
    const requestId = randomUUID();
    const response = await send(requestId);
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json<{ data: unknown }>().data;
    expect(data).toEqual(placeOrderResultSchema.parse(data));
    expect(data).toMatchObject({ replayed: false, order: { filledQty: 1 } });
    expect(response.body).not.toMatch(/marketMakerGeneration|desiredEnabled|configVersion/);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(marketId, 2n);
    expect((await send(requestId)).statusCode).toBe(200);
    expect((await send(randomUUID(), 1)).statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('rolls back the fill and generation without any enqueue or event if the response snapshot fails', async () => {
    const service = t.app.get(OrderService);
    const enqueue = vi
      .spyOn(t.app.get(MarketJobs), 'refreshMarketMaker')
      .mockResolvedValue(undefined);
    const publishMarket = vi
      .spyOn(t.app.get(MarketPublisher), 'publishMarket')
      .mockResolvedValue(undefined);
    const publishUser = vi
      .spyOn(t.app.get(MarketPublisher), 'publishUser')
      .mockResolvedValue(undefined);
    const before = await readMarketMakerRuntime(t.db, marketId);
    // This projection is inside the real economic transaction, after placeOrder changed rows.
    vi.spyOn(
      service as unknown as { marketRef: () => Promise<never> },
      'marketRef',
    ).mockRejectedValueOnce(new Error('fixture snapshot failure'));
    expect((await send()).statusCode).toBe(500);
    expect(await t.db.select().from(schema.fills)).toEqual([]);
    expect(await readMarketMakerRuntime(t.db, marketId)).toEqual(before);
    expect(enqueue).not.toHaveBeenCalled();
    expect(publishMarket).not.toHaveBeenCalled();
    expect(publishUser).not.toHaveBeenCalled();
  });

  it('keeps an actual HTTP fill refresh when an active queue job already captured no next generation', async () => {
    const connection = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    const queue = new Queue<MarketMakerJobData>('maker', { connection });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cycles: Array<{ hint: string; result: MarketMakerCycleResult }> = [];
    // Use the real DB cycle in a real BullMQ worker without importing another app's source.
    // The barrier is after COMMIT/captured nextGeneration, before BullMQ marks it completed.
    // No scan or scheduler is installed. The production worker's retry/stop path has its own
    // processor-level regression; this boundary exercises the actual HTTP/API producer.
    let worker: Worker<MarketMakerJobData> | undefined;
    try {
      await queue.obliterate({ force: true });
      const jobs = t.app.get(MarketJobs);
      const initial = await t.db.transaction((tx) => requestMarketMakerRefresh(tx, marketId));
      expect(initial?.generation).toBe(2n);
      worker = new Worker<MarketMakerJobData>(
        'maker',
        async (job) => {
          const result = await t.db.transaction((tx) =>
            runMarketMakerCycle(tx, { marketId: job.data.marketId }),
          );
          cycles.push({ hint: job.data.generation, result });
          if (cycles.length === 1) await held;
        },
        { connection, concurrency: 1 },
      );
      await worker.waitUntilReady();
      await jobs.refreshMarketMaker(marketId, 2n);
      await vi.waitFor(() => expect(cycles).toHaveLength(1));
      expect(cycles[0]!.result).toMatchObject({
        outcome: 'ready',
        generation: 2n,
        nextGeneration: null,
      });
      expect(await queue.getActiveCount()).toBe(1);
      const requestId = randomUUID();
      const filled = await send(requestId);
      expect(filled.statusCode, filled.body).toBe(200);
      expect(filled.json<{ data: unknown }>().data).toMatchObject({
        replayed: false,
        order: { filledQty: 1 },
      });
      expect(await readMarketMakerRuntime(t.db, marketId)).toMatchObject({
        generation: 3n,
        completedGeneration: 2n,
      });
      expect((await send(requestId)).json<{ data: { replayed: boolean } }>().data.replayed).toBe(
        true,
      );
      await jobs.refreshMarketMaker(marketId, 3n);
      await jobs.refreshMarketMaker(marketId, 3n);
      expect(await queue.getJobCountByTypes('active', 'waiting', 'delayed')).toBe(1);
      release();
      await vi.waitFor(
        async () =>
          expect(await readMarketMakerRuntime(t.db, marketId)).toMatchObject({
            generation: 3n,
            completedGeneration: 3n,
          }),
        { timeout: 5_000 },
      );
      await vi.waitFor(async () =>
        expect(await queue.getJobCountByTypes('active', 'waiting', 'delayed')).toBe(0),
      );
      expect(cycles.map((cycle) => cycle.hint)).toEqual(['2', '3']);
      expect(cycles[1]!.result).toMatchObject({ outcome: 'ready', nextGeneration: null });
      expect(await t.db.select().from(schema.fills)).toHaveLength(1);
      expect(
        (
          await t.db.transaction((tx) =>
            runMarketReconciliation(tx, marketId, { source: 'manual' }),
          )
        ).result.passed,
      ).toBe(true);
      await jobs.refreshMarketMaker(marketId, 3n);
      await vi.waitFor(() => expect(cycles).toHaveLength(3));
      expect(cycles[2]!.result).toMatchObject({
        outcome: 'skipped',
        reason: 'already_completed',
      });
      expect(await t.db.select().from(schema.fills)).toHaveLength(1);
    } finally {
      release();
      try {
        await worker?.close();
        await queue.obliterate({ force: true });
      } finally {
        try {
          await queue.close();
        } finally {
          await connection.quit();
        }
      }
    }
  });
});
