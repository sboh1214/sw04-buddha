import { randomUUID } from 'node:crypto';
import {
  readMarketMakerRuntime,
  requestMarketMakerRefresh,
  runMarketReconciliation,
  schema,
  type Db,
} from '@buddha/db';
import {
  connectTestDb,
  createOpenedMarket,
  createUser,
  hasTestDb,
  mintTestPairs,
  openOrderIntake,
  placeTestOrder,
  type TestDb,
} from '@buddha/db/test';
import { MemoryObjectStorage } from '@buddha/storage';
import { type MarketMakerJobData } from '@buddha/shared';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnqueueMarketMaker } from './market-maker-jobs.js';
import { createProcessor } from './jobs/index.js';
import { DEFAULT_JOB_OPTIONS } from './queues.js';
import type { Publish } from './realtime.js';

const hasRedis = hasTestDb() && Boolean(process.env.TEST_REDIS_URL);
const logger = pino({ level: 'silent' });
const settings = {
  budgetCoin: 10_000n,
  maxLossCoin: 5_000n,
  b: 100_000,
  levels: 3,
  quantity: 10,
  safetyTicks: 1,
};
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};

describe.skipIf(!hasRedis)('real maker queue follow-up through the production processor', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    const adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
  });
  function queueParts() {
    const connection = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    const prefix = `test-maker-followup-${randomUUID()}`;
    const queue = new Queue<MarketMakerJobData>('maker', {
      connection,
      prefix,
      defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, backoff: { type: 'fixed', delay: 10 } },
    });
    const events = new QueueEvents('maker', { connection, prefix });
    return { connection, prefix, queue, events, enqueue: createEnqueueMarketMaker(queue, logger) };
  }
  it('handles the immediate-fill generation before any minute scan and absorbs duplicate active registrations', async () => {
    const market = (await createOpenedMarket(t.db, { liquiditySettings: settings })).market;
    const yes = (await createUser(t.db, { balanceCoin: 4_000n })).user.id;
    const no = (await createUser(t.db, { balanceCoin: 4_000n })).user.id;
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: yes, noHolderId: no, qty: 1 });
    await placeTestOrder(t.db, {
      marketId: market.id,
      ownerId: yes,
      outcome: 'YES',
      side: 'sell',
      limitPriceCoin: 1,
      qty: 1,
    });
    const fillsBefore = (await t.db.select().from(schema.fills)).length;
    const q = queueParts(),
      active = deferred(),
      release = deferred();
    let held = false;
    const publish = vi.fn<Publish>().mockImplementation(async (_channel, event) => {
      if (!held && event.type === 'market:book') {
        held = true;
        active.release();
        await release.promise;
      }
    });
    const processed: Array<{ generation: string; result: Record<string, unknown> }> = [];
    const processor = createProcessor({
      db: t.db,
      auditDb: t.db,
      publish,
      enqueueMarketMaker: q.enqueue,
      enqueueMarketMakerRecall: async () => {},
      enqueueFinalize: async () => {},
      storage: new MemoryObjectStorage(),
      logger,
    });
    const worker = new Worker<MarketMakerJobData>(
      'maker',
      async (job, token) => {
        const result = (await processor(job, token)) as Record<string, unknown>;
        processed.push({ generation: job.data.generation, result });
        return result;
      },
      { connection: q.connection, prefix: q.prefix, concurrency: 1 },
    );
    try {
      await Promise.all([worker.waitUntilReady(), q.events.waitUntilReady()]);
      await q.enqueue(market.id, 1n);
      await active.promise;
      expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
        generation: 2n,
        completedGeneration: 1n,
      });
      expect(await q.queue.getActiveCount()).toBe(1);
      // Same-generation producers still collapse; the actual handler's later enqueue of 2
      // must replace this hint while its generation-1 job remains active.
      await q.enqueue(market.id, 1n);
      await q.enqueue(market.id, 1n);
      expect(await q.queue.getJobCountByTypes('waiting', 'active', 'delayed')).toBe(1);
      release.release();
      // No scheduler/scan is installed in this real queue. A five-second bound is much less
      // than the minute fallback and depends only on the active job's direct successor.
      await vi.waitFor(
        async () =>
          expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
            generation: 2n,
            completedGeneration: 2n,
          }),
        { timeout: 5_000 },
      );
      await vi.waitFor(async () =>
        expect(await q.queue.getJobCountByTypes('waiting', 'active', 'delayed')).toBe(0),
      );
      expect(processed.map((x) => x.generation)).toEqual(['1', '2']);
      expect(processed[0]!.result).toMatchObject({ fills: 1, nextGeneration: '2' });
      expect(processed[1]!.result).toMatchObject({ fills: 0, nextGeneration: null });
      expect(await t.db.select().from(schema.fills)).toHaveLength(fillsBefore + 1);
      expect(publish.mock.calls.filter(([, event]) => event.type === 'market:trade')).toHaveLength(
        1,
      );
      expect(
        await t.db
          .select()
          .from(schema.marketMakerRuns)
          .where(eq(schema.marketMakerRuns.marketId, market.id)),
      ).toHaveLength(2);
      const audit = await t.db.transaction((tx) =>
        runMarketReconciliation(tx, market.id, { source: 'manual' }),
      );
      expect(audit.result.passed).toBe(true);
      const calls = publish.mock.calls.length;
      await q.enqueue(market.id, 2n);
      await vi.waitFor(() => expect(processed).toHaveLength(3));
      expect(processed[2]!.result).toMatchObject({
        outcome: 'skipped',
        reason: 'already_completed',
      });
      expect(publish).toHaveBeenCalledTimes(calls);
    } finally {
      release.release();
      await worker.close();
      await q.events.close();
      await q.queue.obliterate({ force: true });
      await q.queue.close();
      await q.connection.quit();
    }
  });

  it('retains one follow-up through real retries without restarting an exhausted bot', async () => {
    const market = (await createOpenedMarket(t.db, { liquiditySettings: settings })).market;
    const q = queueParts(),
      active = deferred(),
      release = deferred();
    let attempts = 0,
      block = true;
    const failing = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop !== 'transaction') return Reflect.get(target, prop, receiver) as unknown;
        return (callback: Parameters<Db['transaction']>[0]) =>
          target.transaction(async (tx) => {
            const value = await callback(tx);
            if (
              value &&
              typeof value === 'object' &&
              'outcome' in value &&
              value.outcome === 'ready'
            ) {
              attempts++;
              throw new Error('rolled-back maker cycle fixture');
            }
            return value;
          });
      },
    });
    const publish = vi.fn<Publish>().mockResolvedValue(undefined);
    const processor = createProcessor({
      db: failing,
      auditDb: t.db,
      publish,
      enqueueMarketMaker: q.enqueue,
      enqueueMarketMakerRecall: async () => {},
      enqueueFinalize: async () => {},
      storage: new MemoryObjectStorage(),
      logger,
    });
    let completed = 0;
    const worker = new Worker<MarketMakerJobData>(
      'maker',
      async (job, token) => {
        if (block) {
          block = false;
          active.release();
          await release.promise;
        }
        return (await processor(job, token)) as Record<string, unknown>;
      },
      { connection: q.connection, prefix: q.prefix, concurrency: 1 },
    );
    worker.on('completed', () => {
      completed++;
    });
    try {
      await Promise.all([worker.waitUntilReady(), q.events.waitUntilReady()]);
      await q.enqueue(market.id, 1n);
      await active.promise;
      const generation = (await t.db.transaction((tx) => requestMarketMakerRefresh(tx, market.id)))!
        .generation;
      expect(generation).toBe(2n);
      await q.enqueue(market.id, generation);
      await q.enqueue(market.id, generation);
      const [first] = await q.queue.getJobs(['active']);
      const failure = expect(first!.waitUntilFinished(q.events, 5_000)).rejects.toThrow(
        'rolled-back maker cycle fixture',
      );
      release.release();
      await failure;
      await vi.waitFor(() => expect(completed).toBe(1), { timeout: 5_000 });
      expect(attempts).toBe(3);
      expect(await q.queue.getFailedCount()).toBe(1);
      expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
        desiredEnabled: false,
        state: 'stopped',
        controlGeneration: 2n,
        generation: 3n,
        completedGeneration: 3n,
      });
      const orders = await t.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.marketId, market.id));
      expect(orders).toEqual([]);
      expect(publish.mock.calls.filter(([, event]) => event.type === 'market:trade')).toEqual([]);
      await vi.waitFor(async () =>
        expect(await q.queue.getDeduplicationJobId(market.id)).toBeNull(),
      );
    } finally {
      release.release();
      await worker.close();
      await q.events.close();
      await q.queue.obliterate({ force: true });
      await q.queue.close();
      await q.connection.quit();
    }
  });
});
