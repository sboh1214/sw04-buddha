import { randomUUID } from 'node:crypto';
import { hasTestDb } from '@buddha/db/test';
import { type MarketJobData } from '@buddha/shared';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createEnqueueMarketMakerRecall } from './market-maker-recall-jobs.js';
import { DEFAULT_JOB_OPTIONS } from './queues.js';

const hasRedis = hasTestDb() && Boolean(process.env.TEST_REDIS_URL);
const marketId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const logger = pino({ level: 'silent' });

describe('terminal recall producer', () => {
  it.skipIf(!hasRedis)(
    'absorbs active registrations, releases on completion/final failure, and re-registers recall after a failed job',
    async () => {
      const connection = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
      const prefix = `test-maker-recall-${randomUUID()}`;
      const queue = new Queue<MarketJobData>('markets', {
        connection,
        prefix,
        defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, backoff: { type: 'fixed', delay: 10 } },
      });
      const events = new QueueEvents('markets', { connection, prefix });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let active!: () => void;
      const started = new Promise<void>((resolve) => {
        active = resolve;
      });
      let mode: 'block' | 'fail' | 'success' = 'block';
      let failures = 0;
      const worker = new Worker(
        'markets',
        async () => {
          if (mode === 'block') {
            active();
            await blocked;
          } else if (mode === 'fail') {
            failures++;
            throw new Error('transient fixture failure');
          }
        },
        { connection, prefix, concurrency: 1 },
      );
      try {
        await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
        const enqueue = createEnqueueMarketMakerRecall(queue, logger);
        await enqueue(marketId);
        await started;
        const [first] = await queue.getJobs(['active']);
        expect(first).toBeDefined();
        await enqueue(marketId);
        expect(await queue.getJobCountByTypes('waiting', 'active', 'delayed')).toBe(1);
        expect((await queue.getJobs(['active']))[0]!.data.marketId).toBe(marketId);
        const completed = first!.waitUntilFinished(events, 5_000);
        release();
        await completed;
        expect(await queue.getDeduplicationJobId(`market_maker.recall.${marketId}`)).toBeNull();

        mode = 'fail';
        // Pause only the consumer so the actual producer's registered job can be inspected.
        await worker.pause();
        await enqueue(marketId);
        const [failing] = await queue.getJobs(['waiting']);
        const failed = expect(failing!.waitUntilFinished(events, 5_000)).rejects.toThrow(
          'transient fixture failure',
        );
        await worker.resume();
        await failed;
        expect(failures).toBe(3);
        expect(await queue.getDeduplicationJobId(`market_maker.recall.${marketId}`)).toBeNull();
        expect(await failing!.getState()).toBe('failed');

        mode = 'success';
        await worker.pause();
        await enqueue(marketId);
        const [retry] = await queue.getJobs(['waiting']);
        expect(retry!.id).not.toBe(failing!.id);
        expect(retry!.data).toEqual({ marketId });
        const retried = retry!.waitUntilFinished(events, 5_000);
        await worker.resume();
        await retried;
        expect(await queue.getDeduplicationJobId(`market_maker.recall.${marketId}`)).toBeNull();
        expect(await queue.getFailedCount()).toBe(1);
      } finally {
        release();
        await worker.close();
        await events.close();
        await queue.obliterate({ force: true });
        await queue.close();
        await connection.quit();
      }
    },
  );
});
