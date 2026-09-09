/**
 * MarketJobs against the docker `test` profile Redis (TEST_REDIS_URL): what the API registers
 * in the `markets` queue is inspected with a second BullMQ Queue, the way the worker will find
 * it — job id, name, data, delay and options — and the best-effort contract (never throws,
 * bounded on a Redis that never answers) is pinned. Skips when TEST_* are unset.
 */
import { JOB_NAMES, marketCloseJobId, marketFinalizeJobId } from '@buddha/shared';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRedisClient } from '../infra/redis/redis.provider.js';
import { hasTestInfra } from '../test/setup-env.js';
import { MARKETS_QUEUE, MARKET_JOB_TIMEOUT_MS, MarketJobs } from './market-jobs.service.js';

const MARKET_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const HOUR_MS = 60 * 60 * 1000;

describe.skipIf(!hasTestInfra)('MarketJobs (integration)', () => {
  let producer: Redis;
  let inspector: Redis;
  let jobs: MarketJobs;
  /** The worker's view of the queue: a plain Queue on its own client. */
  let queue: Queue;

  beforeAll(() => {
    const url = process.env.TEST_REDIS_URL!;
    producer = createRedisClient(url);
    inspector = new Redis(url, { maxRetriesPerRequest: null });
    queue = new Queue(MARKETS_QUEUE, { connection: inspector });
    jobs = new MarketJobs(producer);
  });
  afterAll(async () => {
    await jobs?.onApplicationShutdown();
    await queue?.close();
    await inspector?.quit();
    await producer?.quit();
  });
  beforeEach(async () => {
    // Every set of the queue, so a job left by an earlier file (or the worker suite, which
    // consumes the same queue name) cannot stand in for one this test registered.
    await queue.obliterate({ force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers market.close for the market at closeAt, delayed from the DB instant given', async () => {
    const now = new Date('2026-09-09T00:00:00.000Z');
    const closeAt = new Date(now.getTime() + 3 * HOUR_MS);
    await jobs.scheduleClose(MARKET_ID, closeAt, now);

    const job = await queue.getJob(marketCloseJobId(MARKET_ID, closeAt));
    expect(job).toBeDefined();
    expect(job!.name).toBe(JOB_NAMES.marketClose);
    expect(job!.data).toEqual({ marketId: MARKET_ID });
    // Exactly `closeAt - now` on the clock the caller passed, not on this machine's: the two
    // instants above are far from Date.now() on purpose, so a delay computed from the wall
    // clock would be nowhere near 3 h.
    expect(job!.delay).toBe(3 * HOUR_MS);
    expect(job!.opts).toMatchObject({
      jobId: marketCloseJobId(MARKET_ID, closeAt),
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: true,
      removeOnFail: { count: 1_000 },
    });
    expect(await queue.getDelayedCount()).toBe(1);
  });

  it('registers market.finalize likewise, and a past instant is due now (delay 0)', async () => {
    const now = new Date();
    const disputeUntil = new Date(now.getTime() + 24 * HOUR_MS);
    await jobs.scheduleFinalize(MARKET_ID, disputeUntil, now);
    const finalize = await queue.getJob(marketFinalizeJobId(MARKET_ID, disputeUntil));
    expect(finalize).toMatchObject({
      name: JOB_NAMES.marketFinalize,
      data: { marketId: MARKET_ID },
      delay: 24 * HOUR_MS,
    });

    // A seed market whose close time already passed, or a close the admin let expire:
    // registered without delay rather than refused, so the worker picks it up at once.
    const past = new Date(now.getTime() - HOUR_MS);
    await jobs.scheduleClose(OTHER_ID, past, now);
    const due = await queue.getJob(marketCloseJobId(OTHER_ID, past));
    expect(due).toBeDefined();
    expect(due!.delay).toBe(0);
    expect(await queue.getWaitingCount()).toBe(1);
  });

  it('keeps one job per (market, instant): a repeat registration neither throws nor duplicates', async () => {
    const now = new Date();
    const closeAt = new Date(now.getTime() + HOUR_MS);
    await jobs.scheduleClose(MARKET_ID, closeAt, now);
    await jobs.scheduleClose(MARKET_ID, closeAt, new Date(now.getTime() + 1_000));
    expect(await queue.getJobCountByTypes('delayed', 'waiting')).toBe(1);
    // The first registration stands (its delay was computed from the earlier `now`).
    expect((await queue.getJob(marketCloseJobId(MARKET_ID, closeAt)))!.delay).toBe(HOUR_MS);

    // A different instant for the same market is a different job: what a PATCHed closeAt
    // and a changed result rely on.
    const later = new Date(closeAt.getTime() + HOUR_MS);
    await jobs.scheduleClose(MARKET_ID, later, now);
    expect(await queue.getJobCountByTypes('delayed', 'waiting')).toBe(2);
  });

  it('cancels the registered job by (market, instant) and tolerates one that is not there', async () => {
    const now = new Date();
    const closeAt = new Date(now.getTime() + HOUR_MS);
    const disputeUntil = new Date(now.getTime() + 2 * HOUR_MS);
    await jobs.scheduleClose(MARKET_ID, closeAt, now);
    await jobs.scheduleFinalize(MARKET_ID, disputeUntil, now);
    await jobs.scheduleClose(OTHER_ID, closeAt, now);

    await jobs.cancelClose(MARKET_ID, closeAt);
    expect(await queue.getJob(marketCloseJobId(MARKET_ID, closeAt))).toBeUndefined();
    // Only that one: the other market's job at the same instant and this market's finalize
    // are untouched.
    expect(await queue.getJob(marketCloseJobId(OTHER_ID, closeAt))).toBeDefined();
    expect(await queue.getJob(marketFinalizeJobId(MARKET_ID, disputeUntil))).toBeDefined();

    await jobs.cancelFinalize(MARKET_ID, disputeUntil);
    expect(await queue.getJob(marketFinalizeJobId(MARKET_ID, disputeUntil))).toBeUndefined();

    // Already gone (the worker ran it, or it was never added): no throw, nothing else removed.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(jobs.cancelClose(MARKET_ID, closeAt)).resolves.toBeUndefined();
    await expect(jobs.cancelFinalize(OTHER_ID, disputeUntil)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(await queue.getJobCountByTypes('delayed', 'waiting')).toBe(1);
  });

  it('never throws and never parks the caller when Redis is unreachable', async () => {
    // Port 1 refuses every connect; ioredis keeps retrying and BullMQ waits for a `ready` that
    // never comes, so without the bound a transition's HTTP response would hang here after
    // its COMMIT. Both calls must come back on the bound, warning, with nothing thrown.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const dead = createRedisClient('redis://127.0.0.1:1');
    const isolated = new MarketJobs(dead);
    try {
      const now = new Date();
      const closeAt = new Date(now.getTime() + HOUR_MS);
      const started = Date.now();
      await expect(isolated.scheduleClose(MARKET_ID, closeAt, now)).resolves.toBeUndefined();
      await expect(isolated.cancelClose(MARKET_ID, closeAt)).resolves.toBeUndefined();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(2 * MARKET_JOB_TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(2 * MARKET_JOB_TIMEOUT_MS + 2_000);
      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages.some((m) => m.startsWith('could not schedule market.close.'))).toBe(true);
      expect(messages.some((m) => m.startsWith('could not cancel market.close.'))).toBe(true);
      // Nothing reached the real queue.
      expect(await queue.getJobCountByTypes('delayed', 'waiting')).toBe(0);
    } finally {
      await isolated.onApplicationShutdown();
      dead.disconnect();
    }
  });
});
