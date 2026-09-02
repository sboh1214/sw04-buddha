import { describe, expect, it } from 'vitest';
import { DEFAULT_JOB_OPTIONS, JOB_NAMES, QUEUE_JOBS, QUEUE_NAMES } from './queues.js';

describe('queues', () => {
  it('declares the queues from PLAN 9', () => {
    expect(QUEUE_NAMES).toEqual(['markets', 'audit', 'stats']);
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
});
