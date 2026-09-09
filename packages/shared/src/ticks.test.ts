import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { TICKS_MAX_POINTS } from './constants.js';
import { TICK_RESOLUTIONS, type TickResolution } from './market.js';
import { TICK_BUCKET_SECONDS, TICK_RESOLUTION_SECONDS, tickBucketSeconds } from './ticks.js';

const RUNS = { numRuns: 1000 };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 604_800_000;

const originalTz = process.env.TZ;
afterAll(() => {
  process.env.TZ = originalTz;
});

describe('TICK_BUCKET_SECONDS / TICK_RESOLUTION_SECONDS', () => {
  it('is strictly ascending, so `find` returns the finest fitting stride', () => {
    const ascending = [...TICK_BUCKET_SECONDS].sort((a, b) => a - b);
    expect(ascending).toEqual([...TICK_BUCKET_SECONDS]);
    expect(new Set(TICK_BUCKET_SECONDS).size).toBe(TICK_BUCKET_SECONDS.length);
  });

  it('gives every bucketed resolution its own ladder entry', () => {
    expect(TICK_RESOLUTION_SECONDS.raw).toBe(0);
    for (const resolution of TICK_RESOLUTIONS) {
      const requested: number = TICK_RESOLUTION_SECONDS[resolution];
      // A request that is not on the ladder could never be served at its own resolution.
      const onLadder = requested === 0 || TICK_BUCKET_SECONDS.some((s) => s === requested);
      expect(onLadder, resolution).toBe(true);
    }
  });
});

describe('tickBucketSeconds', () => {
  it('leaves raw unbucketed whatever the window', () => {
    expect(tickBucketSeconds('raw', HOUR_MS)).toBe(0);
    expect(tickBucketSeconds('raw', 2 * 365 * DAY_MS)).toBe(0);
  });

  it('coarsens a 1m request until its grid fits the window', () => {
    expect(tickBucketSeconds('1m', HOUR_MS)).toBe(60);
    expect(tickBucketSeconds('1m', DAY_MS)).toBe(300);
    expect(tickBucketSeconds('1m', WEEK_MS)).toBe(3_600);
  });

  it('never serves finer than the request', () => {
    // An hour-wide window would fit a minute grid, but 1h asked for the hourly one.
    expect(tickBucketSeconds('1h', HOUR_MS)).toBe(3_600);
    expect(tickBucketSeconds('1h', WEEK_MS)).toBe(3_600);
    expect(tickBucketSeconds('1h', 30 * DAY_MS)).toBe(14_400);
    expect(tickBucketSeconds('1h', 2 * 365 * DAY_MS)).toBe(604_800);
  });

  it('treats an empty or inverted window as the finest entry the request allows', () => {
    expect(tickBucketSeconds('1m', 0)).toBe(60);
    expect(tickBucketSeconds('1m', -DAY_MS)).toBe(60);
    expect(tickBucketSeconds('1h', -1)).toBe(3_600);
  });

  it('falls back to the coarsest entry when even a weekly grid overruns the cap', () => {
    // 500 weekly boundaries are more than the 498-point budget, so `find` misses entirely.
    expect(tickBucketSeconds('1m', 500 * WEEK_MS)).toBe(604_800);
    expect(tickBucketSeconds('1h', 5_000 * WEEK_MS)).toBe(604_800);
  });

  it('honours an explicit point budget, floored at one interior boundary', () => {
    expect(tickBucketSeconds('1m', HOUR_MS, 3)).toBe(3_600);
    // A budget below three would leave nothing after the two window ends are reserved.
    expect(tickBucketSeconds('1m', 0, 1)).toBe(60);
    expect(tickBucketSeconds('1m', HOUR_MS, 1)).toBe(3_600);
  });

  it('is at least the requested stride and fits the cap, in every session time zone', () => {
    const rangeArb = fc.integer({ min: 0, max: 4_000_000_000_000 });
    const resolutionArb: fc.Arbitrary<TickResolution> = fc.constantFrom(...TICK_RESOLUTIONS);
    // Node re-reads process.env.TZ per Date operation: the loop pins that this stays pure
    // millisecond arithmetic and never grows a Date or Intl dependency.
    for (const tz of ['UTC', 'Asia/Seoul', 'America/New_York']) {
      process.env.TZ = tz;
      fc.assert(
        fc.property(rangeArb, resolutionArb, (rangeMs, resolution) => {
          const seconds = tickBucketSeconds(resolution, rangeMs);
          expect(seconds, tz).toBeGreaterThanOrEqual(TICK_RESOLUTION_SECONDS[resolution]);
          if (seconds === 0) {
            expect(resolution, tz).toBe('raw');
            return;
          }
          const points = Math.ceil(rangeMs / 1_000 / seconds);
          expect(points <= TICKS_MAX_POINTS - 2 || seconds === 604_800, tz).toBe(true);
        }),
        RUNS,
      );
    }
  });
});
