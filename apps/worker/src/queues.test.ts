import { JOB_NAMES as SHARED_JOB_NAMES, QUEUE_NAMES as SHARED_QUEUE_NAMES } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JOB_OPTIONS,
  JOB_NAMES,
  JOB_SCHEDULES,
  QUEUE_JOBS,
  QUEUE_NAMES,
} from './queues.js';

describe('queues', () => {
  it('declares the queues from PLAN 9', () => {
    expect(QUEUE_NAMES).toEqual(['markets', 'audit', 'stats']);
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

  it('retries 3 times with exponential backoff', () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(3);
    expect(DEFAULT_JOB_OPTIONS.backoff).toEqual({ type: 'exponential', delay: 1_000 });
  });

  it('schedules the daily audit and the two per-minute market scans (PLAN 5.5, 9)', () => {
    expect(JOB_SCHEDULES.map((schedule) => schedule.id)).toEqual([
      'ledger-audit-daily',
      'market-close-scan',
      'market-finalize-scan',
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
