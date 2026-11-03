import { describe, expect, it } from 'vitest';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  marketCloseJobId,
  marketFinalizeJobId,
  marketJobDataSchema,
  marketOpenJobId,
} from './jobs.js';

const marketId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('jobs (PLAN 9)', () => {
  it('declares the seven queues and the nine job names, the market open first (#21)', () => {
    expect(QUEUE_NAMES).toEqual([
      'markets',
      'audit',
      'stats',
      'wallet',
      'media',
      'community',
      'retention',
    ]);
    expect(Object.values(JOB_NAMES)).toEqual([
      'market.open',
      'market.close',
      'market.finalize',
      'ledger.audit',
      'market.trader_count',
      'start_grant.pay',
      'media.orphan_cleanup',
      'community.records_purge',
      'retention.purge',
    ]);
  });

  it('accepts a job payload with or without a market id, and canonicalises the id', () => {
    expect(marketJobDataSchema.parse({})).toEqual({});
    expect(marketJobDataSchema.parse({ marketId: marketId.toUpperCase() })).toEqual({ marketId });
    // The scan scheduler passes no data at all; a job with `undefined` data must parse too.
    expect(marketJobDataSchema.safeParse(undefined).success).toBe(false);
    expect(marketJobDataSchema.parse(marketJobDataSchema.parse({}))).toEqual({});
    expect(marketJobDataSchema.safeParse({ marketId: 'nope' }).success).toBe(false);
  });

  it('builds job ids that carry the instant and never contain a colon', () => {
    const closeAt = new Date('2026-10-01T00:00:00.000Z');
    const id = marketCloseJobId(marketId, closeAt);
    expect(id).toBe(`market.close.${marketId}.${String(closeAt.getTime())}`);
    expect(id).not.toContain(':'); // BullMQ: "Custom Id cannot contain :"
    // The finalize job runs right after the judgement; its id carries the judgement's instant
    // (`resolved_at`, ADR-0046).
    const resolvedAt = new Date('2026-10-02T09:30:00.123Z');
    expect(marketFinalizeJobId(marketId, resolvedAt)).toBe(
      `market.finalize.${marketId}.${String(resolvedAt.getTime())}`,
    );
    // A moved instant is a different job, so the stale one can be removed and the new one added.
    expect(marketCloseJobId(marketId, new Date(closeAt.getTime() + 1))).not.toBe(id);
  });

  it('builds the open job id from the scheduled open, which a reschedule moves (#21)', () => {
    const scheduledOpenAt = new Date('2026-11-02T01:00:00.000Z');
    const id = marketOpenJobId(marketId, scheduledOpenAt);
    expect(id).toBe(`market.open.${marketId}.${String(scheduledOpenAt.getTime())}`);
    expect(id).not.toContain(':');
    // A rescheduled instant is a new job; the API removes the one under the old instant.
    expect(marketOpenJobId(marketId, new Date(scheduledOpenAt.getTime() - 60_000))).not.toBe(id);
    // The same market and instant never collide with the close's or the finalize's id.
    expect(id).not.toBe(marketCloseJobId(marketId, scheduledOpenAt));
    expect(id).not.toBe(marketFinalizeJobId(marketId, scheduledOpenAt));
  });
});
