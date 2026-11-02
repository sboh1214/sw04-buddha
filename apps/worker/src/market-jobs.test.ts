/**
 * The confirmation's follow-up producer (#152, market-jobs.ts): what it adds, and that it never
 * throws and never parks — the confirmation has committed when it runs, and the `markets` queue
 * is `concurrency: 1`. The bound and the swallow need no infrastructure (stub queues); the add
 * itself runs against TEST_REDIS_URL on a queue prefix of its own, skipped when that is unset.
 */
import { randomUUID } from 'node:crypto';
import { hasTestDb } from '@buddha/db/test';
import { JOB_NAMES, marketFinalizeJobId, type MarketJobData } from '@buddha/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { pino, type Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { ENQUEUE_TIMEOUT_MS, createEnqueueFinalize } from './market-jobs.js';

// hasTestDb() loads the root .env first, so TEST_REDIS_URL is visible after it.
const hasRedis = hasTestDb() && Boolean(process.env.TEST_REDIS_URL);

const MARKET_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const RESOLVED_AT = new Date('2026-11-02T03:04:05.678Z');

/** Collects the producer's warn lines, so "logged and swallowed" is checkable. */
function recording(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'warn' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { logger, lines };
}

describe('createEnqueueFinalize', () => {
  it('adds market.finalize for the market at once, under the confirmation’s id', async () => {
    const calls: unknown[][] = [];
    const queue = {
      add: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({} as never);
      },
    };
    const { logger, lines } = recording();
    await createEnqueueFinalize(queue, logger)(MARKET_ID, RESOLVED_AT);
    expect(calls).toEqual([
      [
        JOB_NAMES.marketFinalize,
        { marketId: MARKET_ID },
        { removeOnComplete: true, jobId: marketFinalizeJobId(MARKET_ID, RESOLVED_AT) },
      ],
    ]);
    expect(lines).toEqual([]);
  });

  it('logs and swallows a refused add: the finalize scan settles the market', async () => {
    const queue = { add: () => Promise.reject(new Error('READONLY')) };
    const { logger, lines } = recording();
    await expect(
      createEnqueueFinalize(queue, logger)(MARKET_ID, RESOLVED_AT),
    ).resolves.toBeUndefined();
    expect(lines).toEqual([
      expect.objectContaining({
        level: 40,
        msg: 'market finalize not enqueued; the finalize scan settles it',
        jobId: marketFinalizeJobId(MARKET_ID, RESOLVED_AT),
        err: expect.objectContaining({ message: 'READONLY' }) as unknown,
      }),
    ]);
  });

  it('bounds an add that never settles (a Redis gone silent), and logs it', async () => {
    const queue = { add: () => new Promise<never>(() => undefined) };
    const { logger, lines } = recording();
    const started = Date.now();
    await createEnqueueFinalize(queue, logger, 50)(MARKET_ID, RESOLVED_AT);
    expect(Date.now() - started).toBeLessThan(ENQUEUE_TIMEOUT_MS);
    expect(lines).toEqual([
      expect.objectContaining({
        msg: 'market finalize not enqueued; the finalize scan settles it',
        err: expect.objectContaining({
          message: `add ${marketFinalizeJobId(MARKET_ID, RESOLVED_AT)} timed out after 50 ms`,
        }) as unknown,
      }),
    ]);
  });

  it.skipIf(!hasRedis)('adds the job on a real queue, once per confirmation', async () => {
    const connection = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    const queue = new Queue<MarketJobData>('markets', {
      connection,
      prefix: `test-${randomUUID()}`,
    });
    try {
      const { logger, lines } = recording();
      const enqueue = createEnqueueFinalize(queue, logger);
      await enqueue(MARKET_ID, RESOLVED_AT);
      // A duplicate (the job's retry after a lost reply) is answered with the existing job.
      await enqueue(MARKET_ID, RESOLVED_AT);
      const jobId = marketFinalizeJobId(MARKET_ID, RESOLVED_AT);
      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs.map((job) => ({ id: job.id, name: job.name, data: job.data }))).toEqual([
        { id: jobId, name: JOB_NAMES.marketFinalize, data: { marketId: MARKET_ID } },
      ]);
      expect(jobs[0]!.opts).toMatchObject({ jobId, removeOnComplete: true });
      expect(jobs[0]!.opts.delay ?? 0).toBe(0);
      expect(lines).toEqual([]);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
    }
  });
});
