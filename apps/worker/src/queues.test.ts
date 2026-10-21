import { JOB_NAMES as SHARED_JOB_NAMES, QUEUE_NAMES as SHARED_QUEUE_NAMES } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import {
  BULLMQ_REDIS_OPTIONS,
  DEFAULT_JOB_OPTIONS,
  JOB_NAMES,
  JOB_SCHEDULES,
  QUEUE_JOBS,
  QUEUE_NAMES,
} from './queues.js';

describe('queues', () => {
  it('declares the queues from PLAN 9, the start grant’s wallet queue (#70), the media queue (#46) and the community queue (#187)', () => {
    expect(QUEUE_NAMES).toEqual(['markets', 'audit', 'stats', 'wallet', 'media', 'community']);
  });

  it('takes its names from @buddha/shared, the module the API produces with', () => {
    // Identity, not equality: the API's `market.close` add and the worker's handler map must
    // read the same strings from the same module (jobs.ts), or a rename splits them.
    expect(QUEUE_NAMES).toBe(SHARED_QUEUE_NAMES);
    expect(JOB_NAMES).toBe(SHARED_JOB_NAMES);
  });

  it('assigns every job to exactly one queue', () => {
    const assigned = Object.values(QUEUE_JOBS).flat();
    expect([...assigned].sort()).toEqual([...Object.values(JOB_NAMES)].sort());
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it('keeps the shared connection unbounded, which is why the publisher has its own', () => {
    // `null` is BullMQ's requirement — a blocking read must not fail on a reconnect — and is
    // exactly what makes this connection unusable for a PUBLISH: ioredis flushes its offline
    // queue with an error only when the option is a number, so a command queued here is never
    // rejected. A `commandTimeout` cannot make up for it either, because ioredis arms that timer
    // for blocking commands too and would reject BRPOPLPUSH/BZPOPMIN every bound. The bounds
    // live on `createPublisherRedis` (realtime.ts) instead; this case is here so the next reader
    // does not try the one-line version.
    expect(BULLMQ_REDIS_OPTIONS.maxRetriesPerRequest).toBeNull();
    expect(BULLMQ_REDIS_OPTIONS).not.toHaveProperty('commandTimeout');
    expect(BULLMQ_REDIS_OPTIONS).not.toHaveProperty('socketTimeout');
    // The 1s..20s backoff BullMQ applies to connections it creates itself.
    expect(BULLMQ_REDIS_OPTIONS.retryStrategy(1)).toBeGreaterThanOrEqual(1_000);
    expect(BULLMQ_REDIS_OPTIONS.retryStrategy(20)).toBe(20_000);
  });

  it('retries 3 times with exponential backoff', () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(3);
    expect(DEFAULT_JOB_OPTIONS.backoff).toEqual({ type: 'exponential', delay: 1_000 });
  });

  it('schedules the daily audit, the per-minute scans and payment, and the hourly clean-ups', () => {
    expect(JOB_SCHEDULES.map((schedule) => schedule.id)).toEqual([
      'ledger-audit-daily',
      'market-close-scan',
      'market-finalize-scan',
      'start-grant-pay',
      'media-orphan-cleanup',
      'community-records-purge',
    ]);
    const byId = Object.fromEntries(JOB_SCHEDULES.map((schedule) => [schedule.id, schedule]));
    expect(byId['market-close-scan']).toMatchObject({
      queue: 'markets',
      name: JOB_NAMES.marketClose,
      repeat: { pattern: '* * * * *', tz: 'Asia/Seoul' },
    });
    expect(byId['market-finalize-scan']).toMatchObject({
      queue: 'markets',
      name: JOB_NAMES.marketFinalize,
      repeat: { pattern: '* * * * *', tz: 'Asia/Seoul' },
    });
    // #70 (ADR-0071): the waiting start grants are paid within a minute of an amount being set.
    expect(byId['start-grant-pay']).toMatchObject({
      queue: 'wallet',
      name: JOB_NAMES.startGrantPay,
      repeat: { pattern: '* * * * *', tz: 'Asia/Seoul' },
    });
    // #46 (ADR-0073): the uploads no post took are removed within the hour after their 24 hours.
    expect(byId['media-orphan-cleanup']).toMatchObject({
      queue: 'media',
      name: JOB_NAMES.mediaOrphanCleanup,
      repeat: { pattern: '17 * * * *', tz: 'Asia/Seoul' },
    });
    // #187 (ADR-0083): the write limits' and the link rules' records past their 24-hour windows.
    expect(byId['community-records-purge']).toMatchObject({
      queue: 'community',
      name: JOB_NAMES.communityRecordsPurge,
      repeat: { pattern: '37 * * * *', tz: 'Asia/Seoul' },
    });
    // A scan carries no market id: that is what makes the handler scan (marketJobDataSchema).
    for (const schedule of JOB_SCHEDULES) {
      expect(schedule).not.toHaveProperty('data');
    }
    // Every scheduled job runs on the queue its name belongs to, and ids are unique
    // (`upsertJobScheduler` is keyed by id: a duplicate would silently replace the other).
    for (const schedule of JOB_SCHEDULES) {
      expect(QUEUE_JOBS[schedule.queue]).toContain(schedule.name);
    }
    expect(new Set(JOB_SCHEDULES.map((schedule) => schedule.id)).size).toBe(JOB_SCHEDULES.length);
  });
});
