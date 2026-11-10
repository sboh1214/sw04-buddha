import { randomUUID } from 'node:crypto';
import { hasTestDb } from '@buddha/db/test';
import { JOB_NAMES, type MarketMakerJobData } from '@buddha/shared';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createEnqueueMarketMaker } from './market-maker-jobs.js';
import { DEFAULT_JOB_OPTIONS } from './queues.js';

const hasRedis = hasTestDb() && Boolean(process.env.TEST_REDIS_URL);
const marketId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const logger = pino({ level: 'silent' });

describe('maker producer', () => {
  it('sends the durable bigint without rounding and bounds a silent Redis after commit', async () => {
    const add = vi.fn<Queue<MarketMakerJobData>['add']>().mockResolvedValue({} as never);
    const enqueue = createEnqueueMarketMaker({ add }, logger);
    await enqueue(marketId, 9_007_199_254_740_993n);
    await enqueue(marketId, 9_007_199_254_740_993n);
    expect(add).toHaveBeenCalledWith(
      JOB_NAMES.marketMakerRefresh,
      { marketId, generation: '9007199254740993' },
      expect.objectContaining({ deduplication: { id: marketId }, removeOnComplete: true }),
    );
    expect(add.mock.calls[0]![2]?.jobId).not.toBe(add.mock.calls[1]![2]?.jobId);
    await expect(
      createEnqueueMarketMaker({ add: () => Promise.reject(new Error('READONLY')) }, logger)(
        marketId,
        1n,
      ),
    ).resolves.toBeUndefined();
    await expect(
      createEnqueueMarketMaker(
        { add: () => new Promise<never>(() => undefined) },
        logger,
        10,
      )(marketId, 1n),
    ).resolves.toBeUndefined();
  });

  it.skipIf(!hasRedis)(
    'absorbs active registrations, releases on completion/final failure, and re-registers the same generation',
    async () => {
      const connection = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
      const prefix = `test-maker-${randomUUID()}`;
      const queue = new Queue<MarketMakerJobData>('maker', {
        connection,
        prefix,
        defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, backoff: { type: 'fixed', delay: 10 } },
      });
      const events = new QueueEvents('maker', { connection, prefix });
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
        'maker',
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
        const enqueue = createEnqueueMarketMaker(queue, logger);
        await enqueue(marketId, 1n);
        await started;
        const [first] = await queue.getJobs(['active']);
        expect(first).toBeDefined();
        await enqueue(marketId, 2n);
        expect(await queue.getJobCountByTypes('waiting', 'active', 'delayed')).toBe(1);
        expect((await queue.getJobs(['active']))[0]!.data.generation).toBe('1');
        const completed = first!.waitUntilFinished(events, 5_000);
        release();
        await completed;
        expect(await queue.getDeduplicationJobId(marketId)).toBeNull();

        mode = 'fail';
        // Pause only the consumer so the actual producer's registered job can be inspected.
        await worker.pause();
        await enqueue(marketId, 2n);
        const [failing] = await queue.getJobs(['waiting']);
        const failed = expect(failing!.waitUntilFinished(events, 5_000)).rejects.toThrow(
          'transient fixture failure',
        );
        await worker.resume();
        await failed;
        expect(failures).toBe(3);
        expect(await queue.getDeduplicationJobId(marketId)).toBeNull();
        expect(await failing!.getState()).toBe('failed');

        mode = 'success';
        await worker.pause();
        await enqueue(marketId, 2n);
        const [retry] = await queue.getJobs(['waiting']);
        expect(retry!.id).not.toBe(failing!.id);
        expect(retry!.data).toEqual({ marketId, generation: '2' });
        const retried = retry!.waitUntilFinished(events, 5_000);
        await worker.resume();
        await retried;
        expect(await queue.getDeduplicationJobId(marketId)).toBeNull();
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
