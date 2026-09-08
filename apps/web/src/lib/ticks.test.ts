import { type MarketTickEvent, TICKS_MAX_POINTS } from '@buddha/shared';
import fc from 'fast-check';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { type PriceSeries, type PriceTick } from './api';
import {
  DEFAULT_TICK_RANGE,
  TICK_RANGES,
  appendTickToSeries,
  joinSeries,
  tickRangeFrom,
  ticksQueryFor,
  ticksQueryOptions,
} from './ticks';

const originalTz = process.env.TZ;
afterAll(() => {
  process.env.TZ = originalTz;
});

const ZONES = ['UTC', 'Asia/Seoul', 'America/New_York'];
const MARKET_ID = '3f7d0a4c-2b19-4d5e-8a61-0c9e4b7f2d13';
const NOON = Date.parse('2026-09-07T12:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A `1m` request the server coarsened to an hourly grid — the ordinary answer for a day. */
function series(overrides: Partial<PriceSeries> = {}): PriceSeries {
  return {
    resolution: '1m',
    bucketSeconds: 3600,
    from: '2026-09-07T00:00:00.000Z',
    to: '2026-09-07T01:00:00.000Z',
    truncated: false,
    points: [
      { ts: '2026-09-07T00:00:00.000Z', pYesBp: 4000, trigger: 'open' },
      { ts: '2026-09-07T01:00:00.000Z', pYesBp: 4200, trigger: 'trade' },
    ],
    ...overrides,
  };
}

function tick(ts: string, pYesBp = 5000): MarketTickEvent {
  return {
    type: 'market:tick',
    marketId: MARKET_ID,
    pYesBp,
    lastPrice: Math.round(pYesBp / 100),
    volumeP: '12000',
    tradeCount: 7,
    ts,
  };
}

describe('TICK_RANGES', () => {
  it('opens on a range it actually offers', () => {
    expect(TICK_RANGES).toContain(DEFAULT_TICK_RANGE);
    expect(DEFAULT_TICK_RANGE).toBe('1D');
  });
});

describe('tickRangeFrom', () => {
  it('quantises the bound so two renders inside one stride agree', () => {
    // The regression this pins: an unquantised bound changes every render, so the request
    // (and any cache built on it) never repeats and the query never settles.
    for (const tz of ZONES) {
      process.env.TZ = tz;
      expect(tickRangeFrom('1D', NOON), tz).toBe('2026-09-06T12:00:00.000Z');
      expect(tickRangeFrom('1D', NOON + 30 * 1000), tz).toBe('2026-09-06T12:00:00.000Z');
      expect(tickRangeFrom('1D', NOON + MINUTE), tz).toBe('2026-09-06T12:01:00.000Z');

      expect(tickRangeFrom('1W', NOON), tz).toBe('2026-08-31T12:00:00.000Z');
      expect(tickRangeFrom('1W', NOON + 30 * MINUTE), tz).toBe('2026-08-31T12:00:00.000Z');
      expect(tickRangeFrom('1W', NOON + HOUR), tz).toBe('2026-08-31T13:00:00.000Z');
    }
  });

  it('sends no lower bound for the whole life of the market', () => {
    expect(tickRangeFrom('all', NOON)).toBeUndefined();
  });

  it('lands on the stride grid for every instant in it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MINUTE - 1 }), (offset) => {
        expect(tickRangeFrom('1D', NOON + offset)).toBe(tickRangeFrom('1D', NOON));
        expect(Date.parse(tickRangeFrom('1D', NOON + offset) ?? '') % MINUTE).toBe(0);
      }),
    );
  });
});

describe('ticksQueryFor', () => {
  it('asks for the resolution the range means', () => {
    for (const tz of ZONES) {
      process.env.TZ = tz;
      expect(ticksQueryFor('1D', NOON).resolution, tz).toBe('1m');
      expect(ticksQueryFor('1W', NOON).resolution, tz).toBe('1h');
      expect(ticksQueryFor('all', NOON).resolution, tz).toBe('1h');
    }
  });

  it('never sends `to`, so the server closes the window on its own clock', () => {
    // A client-sent upper bound would freeze the chart at the instant the component rendered.
    expect(Object.keys(ticksQueryFor('1D', NOON)).sort()).toEqual(['from', 'resolution']);
    expect(Object.keys(ticksQueryFor('1W', NOON)).sort()).toEqual(['from', 'resolution']);
    expect(Object.keys(ticksQueryFor('all', NOON))).toEqual(['resolution']);
  });

  it('carries the quantised bound', () => {
    expect(ticksQueryFor('1D', NOON).from).toBe(tickRangeFrom('1D', NOON));
  });
});

describe('ticksQueryOptions', () => {
  it('keys on the range token, never on the window it means', () => {
    // The bug this pins: a Date.now()-derived `from` in the key changes it every render, so
    // every render is a cache miss and the query refetches forever.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-07T12:00:00.000Z'));
      const first = ticksQueryOptions(MARKET_ID, '1D').queryKey;
      vi.setSystemTime(new Date('2026-09-07T12:00:01.000Z'));
      const aSecondLater = ticksQueryOptions(MARKET_ID, '1D').queryKey;
      // Across a stride boundary too, or a quantised `from` in the key would slip through.
      vi.setSystemTime(new Date('2026-09-07T12:01:30.000Z'));
      const aMinuteLater = ticksQueryOptions(MARKET_ID, '1D').queryKey;

      expect(first).toEqual(['ticks', MARKET_ID, '1D']);
      expect(aSecondLater).toEqual(first);
      expect(aMinuteLater).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keys each range apart', () => {
    expect(ticksQueryOptions(MARKET_ID, 'all').queryKey).toEqual(['ticks', MARKET_ID, 'all']);
  });
});

describe('appendTickToSeries', () => {
  it('replaces the last point when the event falls inside the last bucket', () => {
    const held = series();
    const merged = appendTickToSeries(held, tick('2026-09-07T01:30:00.000Z', 4600));

    expect(merged?.points).toEqual([
      held.points[0],
      { ts: '2026-09-07T01:30:00.000Z', pYesBp: 4600, trigger: 'trade' },
    ]);
  });

  it('appends once the event crosses the bucket boundary', () => {
    const merged = appendTickToSeries(series(), tick('2026-09-07T02:00:00.000Z', 4600));

    expect(merged?.points).toHaveLength(3);
    expect(merged?.points.at(-1)).toEqual({
      ts: '2026-09-07T02:00:00.000Z',
      pYesBp: 4600,
      trigger: 'trade',
    });
  });

  it('keeps the point a first live tick wrote when a second one crosses the boundary', () => {
    // The regression this pins: measuring the bucket as `eventMs - lastMs` re-anchors on the
    // instant of the point that was just replaced, so the second tick reads as "inside the
    // bucket" again and deletes the first. While trades keep arriving less than one bucket
    // apart the series would never gain a point at all — the tail just slides right.
    const first = appendTickToSeries(series(), tick('2026-09-07T01:30:00.000Z', 4600));
    const second = appendTickToSeries(first, tick('2026-09-07T02:15:00.000Z', 5100));

    expect(second?.points).toEqual([
      series().points[0],
      { ts: '2026-09-07T01:30:00.000Z', pYesBp: 4600, trigger: 'trade' },
      { ts: '2026-09-07T02:15:00.000Z', pYesBp: 5100, trigger: 'trade' },
    ]);
  });

  it('bins on the absolute grid, not on the mid-bucket instant the answer closed at', () => {
    // The server closes its window at `to` — its own clock — so the last point of a pristine
    // answer usually sits INSIDE a bucket rather than on a boundary, exactly as the server's
    // own left edge does. A tick twenty seconds later has crossed onto the next boundary of
    // the grid `date_bin` bins on and must open a new point.
    const held = series({
      to: '2026-09-07T01:59:50.000Z',
      points: [
        { ts: '2026-09-07T00:00:00.000Z', pYesBp: 4000, trigger: 'open' },
        { ts: '2026-09-07T01:59:50.000Z', pYesBp: 4200, trigger: 'trade' },
      ],
    });

    expect(appendTickToSeries(held, tick('2026-09-07T02:00:10.000Z', 4600))?.points).toHaveLength(
      3,
    );
    // A tick still inside that same grid bucket replaces, as it did before.
    expect(appendTickToSeries(held, tick('2026-09-07T01:59:59.000Z', 4300))?.points).toHaveLength(
      2,
    );
  });

  it('always appends at raw resolution', () => {
    // bucketSeconds 0 makes the "inside the bucket" test false for every event.
    const held = series({ resolution: 'raw', bucketSeconds: 0 });
    const merged = appendTickToSeries(held, tick('2026-09-07T01:00:00.001Z'));

    expect(merged?.points).toHaveLength(3);
  });

  it('takes the first tick of a series that has no points yet', () => {
    const merged = appendTickToSeries(series({ points: [] }), tick('2026-09-07T01:00:00.000Z'));

    expect(merged?.points).toHaveLength(1);
  });

  it('does not write for an event that is not strictly newer', () => {
    // undefined is the "do not write" contract: setQueryData returns early on it, so a late
    // event costs no cache write and does not restart staleTime.
    expect(appendTickToSeries(series(), tick('2026-09-07T01:00:00.000Z'))).toBeUndefined();
    expect(appendTickToSeries(series(), tick('2026-09-07T00:30:00.000Z'))).toBeUndefined();
    expect(appendTickToSeries(undefined, tick('2026-09-07T02:00:00.000Z'))).toBeUndefined();
  });

  it('trims the oldest points rather than growing past the documented cap', () => {
    const base = Date.parse('2026-09-07T00:00:00.000Z');
    const points = Array.from({ length: TICKS_MAX_POINTS }, (_, i): PriceTick => ({
      ts: new Date(base + i * MINUTE).toISOString(),
      pYesBp: 4000 + i,
      trigger: 'trade',
    }));
    const held = series({ resolution: 'raw', bucketSeconds: 0, points });
    const liveTs = new Date(base + TICKS_MAX_POINTS * MINUTE).toISOString();
    const merged = appendTickToSeries(held, tick(liveTs));

    expect(merged?.points).toHaveLength(TICKS_MAX_POINTS);
    expect(merged?.points[0]).toEqual(points[1]);
    expect(merged?.points.at(-1)?.ts).toBe(liveTs);
  });

  it('moves the window end forward and never backward', () => {
    const ahead = series({ to: '2026-09-07T05:00:00.000Z' });
    expect(appendTickToSeries(ahead, tick('2026-09-07T02:00:00.000Z'))?.to).toBe(
      '2026-09-07T05:00:00.000Z',
    );
    expect(appendTickToSeries(ahead, tick('2026-09-07T06:00:00.000Z'))?.to).toBe(
      '2026-09-07T06:00:00.000Z',
    );
  });

  it('leaves the window the server described otherwise alone', () => {
    const held = series({ truncated: true });
    const merged = appendTickToSeries(held, tick('2026-09-07T02:00:00.000Z'));

    expect(merged?.from).toBe(held.from);
    expect(merged?.truncated).toBe(true);
    expect(merged?.resolution).toBe(held.resolution);
    expect(merged?.bucketSeconds).toBe(held.bucketSeconds);
  });

  it('never mutates the series it was given', () => {
    const held = series();
    const before = structuredClone(held);
    appendTickToSeries(held, tick('2026-09-07T02:00:00.000Z'));
    appendTickToSeries(held, tick('2026-09-07T01:30:00.000Z'));

    expect(held).toEqual(before);
  });
});

describe('joinSeries', () => {
  /** The live edge the socket drew while a refetch was in flight. */
  const live = (): PriceSeries =>
    appendTickToSeries(series(), tick('2026-09-07T01:30:00.000Z', 6000)) as PriceSeries;

  it('keeps a tick the answer left before, which is the whole race', () => {
    // THE BUG: the refetch was served at 01:00, the trade committed at 01:30, the socket drew
    // it, and then the older answer landed and pulled the chart back to 42% while the header —
    // which has `joinMarket` — still read 60%.
    const held = live();
    expect(held.points.at(-1)?.pYesBp).toBe(6000);

    const joined = joinSeries(held, series());

    expect(joined.points.at(-1)).toEqual({
      ts: '2026-09-07T01:30:00.000Z',
      pYesBp: 6000,
      trigger: 'trade',
    });
    expect(joined.to).toBe('2026-09-07T01:30:00.000Z');
    // Everything the SERVER owns still comes from the answer.
    expect(joined.from).toBe(series().from);
    expect(joined.resolution).toBe(series().resolution);
    expect(joined.bucketSeconds).toBe(series().bucketSeconds);
  });

  it('is a no-op once the answer carries the tick itself', () => {
    // The ordinary case: the server was served after the trade, so its window already ends
    // there and nothing is newer than its `to`.
    const answered = series({
      to: '2026-09-07T02:00:00.000Z',
      points: [
        ...series().points,
        { ts: '2026-09-07T01:30:00.000Z', pYesBp: 6000, trigger: 'trade' },
      ],
    });
    expect(joinSeries(live(), answered)).toBe(answered);
    expect(joinSeries(undefined, answered)).toBe(answered);
  });

  it('resurrects nothing the server left out of its window', () => {
    // The cutoff is the answer's `to`, not its last POINT. Read off the last point, an empty
    // window — a range whose span now holds no trade — would drag the whole stale series back.
    const slid = series({
      from: '2026-09-08T00:00:00.000Z',
      to: '2026-09-08T01:00:00.000Z',
      points: [],
    });
    expect(joinSeries(live(), slid)).toBe(slid);
  });

  it('replaces rather than doubles a live point inside the last bucket', () => {
    // `pushPoint`'s rule, reached through the join: the answer's 01:00 point and the live
    // 01:30 one share the hourly bucket, so the series keeps ONE point there — the live one.
    const held = live();
    const joined = joinSeries(held, series());
    expect(joined.points).toHaveLength(2);
    expect(joined.points.at(-1)?.ts).toBe('2026-09-07T01:30:00.000Z');
  });

  it('never lets the right edge move backwards, even with nothing to carry it', () => {
    // Two refetches in flight can land newest-first; the older answer then names an earlier
    // `to` with no point past it for the loop to advance on. `appendTickToSeries` forbids a
    // backwards `to` for its own writes, and `extendToNow` draws the live probability out to
    // exactly this instant.
    const ahead = series({ to: '2026-09-07T05:00:00.000Z' });
    expect(joinSeries(ahead, series()).to).toBe('2026-09-07T05:00:00.000Z');
    // …and it does not run FORWARD on its own: a newer answer's own `to` stands.
    expect(joinSeries(series(), ahead).to).toBe('2026-09-07T05:00:00.000Z');
  });

  it('is idempotent, so a second answer cannot double the tail', () => {
    const once = joinSeries(live(), series());
    expect(joinSeries(once, series())).toEqual(once);
  });

  it('never grows past the cap the socket path also honours', () => {
    const many = Array.from({ length: TICKS_MAX_POINTS }, (_, i) => ({
      ts: new Date(NOON + i * MINUTE).toISOString(),
      pYesBp: 5000,
      trigger: 'trade' as const,
    }));
    const held = series({
      bucketSeconds: 0,
      resolution: 'raw',
      to: new Date(NOON + 10 * HOUR).toISOString(),
      points: many,
    });
    const joined = joinSeries(
      held,
      series({ bucketSeconds: 0, resolution: 'raw', points: [], to: '2026-09-07T00:00:00.000Z' }),
    );
    expect(joined.points.length).toBeLessThanOrEqual(TICKS_MAX_POINTS);
  });
});
