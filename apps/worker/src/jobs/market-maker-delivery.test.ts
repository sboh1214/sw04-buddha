import { randomUUID } from 'node:crypto';
import { readMarketMakerRuntime, runMarketMakerCycle, schema, type Db } from '@buddha/db';
import {
  checkOrderInvariants,
  connectTestDb,
  createOpenedMarket,
  createUser,
  hasTestDb,
  ledgerSupply,
  openOrderIntake,
  placeTestOrder,
  type TestDb,
} from '@buddha/db/test';
import { type MarketMakerJobData } from '@buddha/shared';
import { MemoryObjectStorage } from '@buddha/storage';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProcessor } from './index.js';
import { createEnqueueMarketMaker } from '../market-maker-jobs.js';
import { DEFAULT_JOB_OPTIONS } from '../queues.js';

const hasInfra = hasTestDb() && Boolean(process.env.TEST_REDIS_URL);
const logger = pino({ level: 'silent' });
const settings = {
  budgetCoin: 10_000n,
  maxLossCoin: 5_000n,
  b: 100_000,
  levels: 3,
  quantity: 10,
  safetyTicks: 1,
};

describe.skipIf(!hasInfra)('real BullMQ → dispatcher → economic rollback → stop (#131)', () => {
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

  it('uses three actual attempts, stops only that bot, and leaves human trading available', async () => {
    const adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
    const a = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    const b = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    const market = (
      await createOpenedMarket(t.db, { liquiditySettings: settings, priceProtectionTicks: 98 })
    ).market;
    const other = (await createOpenedMarket(t.db, { liquiditySettings: settings })).market;
    await t.db.transaction((tx) => runMarketMakerCycle(tx, { marketId: other.id }));
    const otherBefore = await readMarketMakerRuntime(t.db, other.id);
    const supply = await ledgerSupply(t.db);
    const before = await t.db.select().from(schema.balances).orderBy(schema.balances.accountId);
    let failedTransactions = 0;
    const failing = new Proxy(t.db, {
      get(target, key, receiver) {
        if (key !== 'transaction') return Reflect.get(target, key, receiver) as unknown;
        return (callback: Parameters<Db['transaction']>[0]) =>
          target.transaction(async (tx) => {
            const result: unknown = await callback(tx);
            if (
              result !== null &&
              typeof result === 'object' &&
              'outcome' in result &&
              result.outcome === 'ready'
            ) {
              failedTransactions++;
              throw new Error('injected before maker COMMIT');
            }
            return result;
          });
      },
    });
    const connection = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    const prefix = `test-service-maker-${randomUUID()}`;
    const queue = new Queue<MarketMakerJobData>('maker', {
      connection,
      prefix,
      defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, backoff: { type: 'fixed', delay: 10 } },
    });
    const events = new QueueEvents('maker', { connection, prefix });
    const enqueue = createEnqueueMarketMaker(queue, logger);
    const publish = vi.fn().mockResolvedValue(undefined);
    const processor = createProcessor({
      db: failing,
      auditDb: t.db,
      publish,
      enqueueMarketMaker: enqueue,
      enqueueFinalize: vi.fn().mockResolvedValue(undefined),
      enqueueMarketMakerRecall: vi.fn().mockResolvedValue(undefined),
      storage: new MemoryObjectStorage(),
      logger,
    });
    const worker = new Worker('maker', processor, { connection, prefix, concurrency: 1 });
    try {
      await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
      // Use the production producer as well as the real dispatcher. Redis retries provide
      // attemptsMade/opts; the test never supplies a fabricated final-attempt counter.
      await enqueue(market.id, 1n);
      await vi.waitFor(
        async () => {
          expect(await queue.getJobCountByTypes('failed')).toBe(1);
        },
        { timeout: 10_000, interval: 20 },
      );
      const [job] = await queue.getJobs(['failed']);
      expect(job!.attemptsMade).toBe(3);
      expect(failedTransactions).toBe(3);
      expect(await readMarketMakerRuntime(t.db, market.id)).toMatchObject({
        desiredEnabled: false,
        state: 'stopped',
        reason: 'retry_exhausted',
        controlGeneration: 2n,
      });
      expect(await readMarketMakerRuntime(t.db, other.id)).toEqual(otherBefore);
      expect(
        await t.db.select().from(schema.orders).where(eq(schema.orders.marketId, market.id)),
      ).toEqual([]);
      expect(await t.db.select().from(schema.balances).orderBy(schema.balances.accountId)).toEqual(
        before,
      );
      expect(
        (
          await t.db
            .select()
            .from(schema.marketMakerRuns)
            .where(eq(schema.marketMakerRuns.marketId, market.id))
        ).filter((row) => row.outcome === 'error'),
      ).toHaveLength(3);
      const first = await placeTestOrder(t.db, {
        marketId: market.id,
        ownerId: a,
        outcome: 'NO',
        limitPriceCoin: 40,
        qty: 2,
      });
      const second = await placeTestOrder(t.db, {
        marketId: market.id,
        ownerId: b,
        outcome: 'YES',
        limitPriceCoin: 60,
        qty: 2,
      });
      expect(first).toMatchObject({ kind: 'placed', order: { filledQty: 0 } });
      expect(second).toMatchObject({ kind: 'placed', order: { filledQty: 2 } });
      expect(await checkOrderInvariants(t.db)).toEqual([]);
      expect(await ledgerSupply(t.db)).toEqual(supply);
    } finally {
      await worker.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
    }
  }, 20_000);
});
