import { type MarketTickEvent, TICKS_MAX_POINTS } from '@buddha/shared';
import fc from 'fast-check';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { type PriceSeries, type PriceTick } from './api';
import {
  DEFAULT_TICK_RANGE,
  TICK_RANGES,
  appendTickToSeries,
  joinSeries,
  recentDelta,
  recentMove,
  rowSupersedesSeries,
  tickRangeWindowSeconds,
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
    tradeCount: 41,
    points: [
      { ts: '2026-09-07T00:00:00.000Z', pYesBp: 4000, trigger: 'trade' },
      { ts: '2026-09-07T01:00:00.000Z', pYesBp: 4200, trigger: 'trade' },
    ],
    ...overrides,
  };
}

/**
 * `tradeCount` defaults ABOVE the series' 41, because that counter — not `ts` — is what
 * `appendTickToSeries` orders on: the server pins its right edge at its own window end, which
 * is later than the `executedAt` an event carries, so a `ts` rule refuses the very tick the
 * answer could not see.
 *
 * `bp` is the point the tick should draw; the event carries it as the fill's whole-percent
 * `lastPrice`, so every value passed here is a multiple of 100.
 */
function tick(ts: string, bp = 5000, tradeCount = 42): MarketTickEvent {
  if (bp % 100 !== 0) throw new Error(`a fill price is a whole percent, not ${String(bp)}bp`);
  return {
    type: 'market:tick',
    marketId: MARKET_ID,
    lastPrice: bp / 100,
    volumeP: '12000',
    tradeCount,
    traderCount: 5,
    ts,
  };
}

describe('TICK_RANGES', () => {
  it('opens on a range it actually offers', () => {
    expect(TICK_RANGES).toContain(DEFAULT_TICK_RANGE);
    expect(DEFAULT_TICK_RANGE).toBe('1D');
  });
});

describe('tickRangeWindowSeconds', () => {
  it("answers a DURATION, which is the one thing a visitor's clock measures correctly", () => {
    expect(tickRangeWindowSeconds('1D')).toBe(24 * 60 * 60);
    expect(tickRangeWindowSeconds('1W')).toBe(7 * 24 * 60 * 60);
  });

  it('has no window for the whole life of the market — only the server knows the open', () => {
    expect(tickRangeWindowSeconds('all')).toBeUndefined();
  });
});

describe('ticksQueryFor', () => {
  it('asks for the resolution the range means', () => {
    for (const tz of ZONES) {
      process.env.TZ = tz;
      expect(ticksQueryFor('1D').resolution, tz).toBe('1m');
      expect(ticksQueryFor('1W').resolution, tz).toBe('1h');
      expect(ticksQueryFor('all').resolution, tz).toBe('1h');
    }
  });

  it('names NEITHER end of the window as an instant, which is the whole fix', () => {
    // THE HAZARD: `from` used to be `Date.now()` minus the range while the server closed `to` on
    // the DATABASE clock — one end measured on each machine, so the served span was wrong by the
    // visitor's skew (25h an hour slow, 23h an hour fast). Past a full day fast the request
    // inverted, the server clamped it to a single instant, and the chart's accessible summary
    // then asserted `시작 61%, 최고 61%, 최저 61%` on a day that had opened at 41%.
    expect(Object.keys(ticksQueryFor('1D')).sort()).toEqual(['resolution', 'windowSeconds']);
    expect(Object.keys(ticksQueryFor('1W')).sort()).toEqual(['resolution', 'windowSeconds']);
    // 'all' was always immune: it names no lower bound at all.
    expect(Object.keys(ticksQueryFor('all'))).toEqual(['resolution']);
  });

  it('reads the same in every zone and at every instant, so it needs no clock at all', () => {
    // The old bound had to be floored onto a stride so a server render and its hydration agreed;
    // a duration is the same number whenever it is asked for, so that quantisation is gone.
    for (const tz of ZONES) {
      process.env.TZ = tz;
      expect(ticksQueryFor('1D'), tz).toEqual({ windowSeconds: 86_400, resolution: '1m' });
    }
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MINUTE - 1 }), () => {
        expect(ticksQueryFor('1D').windowSeconds).toBe(86_400);
      }),
    );
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
      // The move is measured against the point this one REPLACED, which is the only place it
      // still exists — see `CachedTick.movedFromBp`.
      {
        ts: '2026-09-07T01:30:00.000Z',
        pYesBp: 4600,
        tradeCount: 42,
        trigger: 'trade',
        movedFromBp: 4200,
      },
    ]);
  });

  it('appends once the event crosses the bucket boundary', () => {
    const merged = appendTickToSeries(series(), tick('2026-09-07T02:00:00.000Z', 4600));

    expect(merged?.points).toHaveLength(3);
    expect(merged?.points.at(-1)).toEqual({
      ts: '2026-09-07T02:00:00.000Z',
      pYesBp: 4600,
      tradeCount: 42,
      trigger: 'trade',
      movedFromBp: 4200,
    });
  });

  it('keeps the point a first live tick wrote when a second one crosses the boundary', () => {
    // The regression this pins: measuring the bucket as `eventMs - lastMs` re-anchors on the
    // instant of the point that was just replaced, so the second tick reads as "inside the
    // bucket" again and deletes the first. While trades keep arriving less than one bucket
    // apart the series would never gain a point at all — the tail just slides right.
    const first = appendTickToSeries(series(), tick('2026-09-07T01:30:00.000Z', 4600));
    const second = appendTickToSeries(first, tick('2026-09-07T02:15:00.000Z', 5100, 43));

    expect(second?.points).toEqual([
      series().points[0],
      {
        ts: '2026-09-07T01:30:00.000Z',
        pYesBp: 4600,
        tradeCount: 42,
        trigger: 'trade',
        movedFromBp: 4200,
      },
      // Each live point names the reading IT superseded, so two trades in a row report +5 and
      // then +5 rather than +6 and +11.
      {
        ts: '2026-09-07T02:15:00.000Z',
        pYesBp: 5100,
        tradeCount: 43,
        trigger: 'trade',
        movedFromBp: 4600,
      },
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
        { ts: '2026-09-07T00:00:00.000Z', pYesBp: 4000, trigger: 'trade' },
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

  it('does not write for an event the series already counts', () => {
    // undefined is the "do not write" contract: setQueryData returns early on it, so a late
    // event costs no cache write and does not restart staleTime. The comparison is the
    // COUNTER — a duplicate and a late delivery are both refused however new their `ts` is.
    expect(
      appendTickToSeries(series(), tick('2026-09-07T09:00:00.000Z', 5000, 41)),
    ).toBeUndefined();
    expect(
      appendTickToSeries(series(), tick('2026-09-07T09:00:00.000Z', 5000, 40)),
    ).toBeUndefined();
    expect(appendTickToSeries(undefined, tick('2026-09-07T02:00:00.000Z'))).toBeUndefined();
  });

  it('draws nothing for a tick with no fill price, the chart recording fills only', () => {
    // N02 §5: 체결 없음 has no level to plot, and inventing one is the line drawn from nothing.
    const noFill = { ...tick('2026-09-07T02:00:00.000Z'), lastPrice: null };
    expect(appendTickToSeries(series(), noFill)).toBeUndefined();
  });

  it("draws the fill's whole-percent price in the series' basis points", () => {
    const merged = appendTickToSeries(series(), tick('2026-09-07T02:00:00.000Z', 6300));
    expect(merged?.points.at(-1)?.pYesBp).toBe(6300);
  });

  it('takes a tick the answer pinned its right edge after', () => {
    // THE OTHER ARRIVAL ORDER of the same race, and it used to lose the trade outright. The
    // server pins a point at its own window end, which is LATER than the `executedAt` the
    // event carries, so the old `ts` rule refused exactly the tick that answer could not see —
    // and refusing means no cache write at all, so nothing corrected it either.
    // The answer closed its window 4ms after the trade's own instant and pinned a boundary
    // there carrying the PRE-trade price — the shape every bucketed answer has.
    const answered = series({
      to: '2026-09-07T01:00:00.004Z',
      points: [
        { ts: '2026-09-07T00:00:00.000Z', pYesBp: 4000, trigger: 'trade' },
        { ts: '2026-09-07T01:00:00.004Z', pYesBp: 4200, trigger: 'trade' },
      ],
    });
    const merged = appendTickToSeries(answered, tick('2026-09-07T01:00:00.000Z', 6000, 42));

    expect(merged?.points.at(-1)).toEqual({
      ts: '2026-09-07T01:00:00.000Z',
      pYesBp: 6000,
      tradeCount: 42,
      trigger: 'trade',
      // The stale boundary is trimmed FIRST, so the move is measured against the last point
      // that survives the trim rather than against a price the trade already invalidated.
      movedFromBp: 4000,
    });
    // That stale boundary carried the pre-trade price across the trade's own instant, so it
    // goes rather than sitting after the live point out of order.
    expect(merged?.points.map((point) => point.ts)).toEqual([
      '2026-09-07T00:00:00.000Z',
      '2026-09-07T01:00:00.000Z',
    ]);
  });

  it('falls back to `ts` against a series an older API answered', () => {
    // A rolling deploy: the cached answer predates the counter, and `supersedes` takes anything
    // over an absent key, so without this the series would admit every event.
    const legacy = { ...series(), tradeCount: undefined } as unknown as ReturnType<typeof series>;
    expect(appendTickToSeries(legacy, tick('2026-09-07T02:00:00.000Z'))?.points).toHaveLength(3);
    expect(appendTickToSeries(legacy, tick('2026-09-07T00:30:00.000Z'))).toBeUndefined();
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

describe('recentDelta', () => {
  it('reports the trade, not the bucket, when several land inside one sampled stride', () => {
    // THE HAZARD. A 1D window comes back on a 5-minute grid (`tickBucketSeconds`), and
    // `pushPoint` REPLACES the last point when a tick shares its bucket — so from the second
    // trade onwards `points.at(-2)` is the PREVIOUS bucket's point and the badge measured the
    // whole bucket's movement. It accumulated with every further trade: the three trades below
    // moved the probability +5, +5 and +5%p, and 확률 변화 announced +10, +15 and +20 — a
    // number that is not the move, on the badge PLAN 11.4 shows for five seconds after a trade.
    let live = series({ bucketSeconds: 300, to: '2026-09-07T01:00:00.000Z' });
    live = appendTickToSeries(live, tick('2026-09-07T01:01:00.000Z', 4700, 42)) ?? live;
    expect(recentDelta(live.points)).toBe(5);
    live = appendTickToSeries(live, tick('2026-09-07T01:02:00.000Z', 5200, 43)) ?? live;
    expect(recentDelta(live.points)).toBe(5);
    live = appendTickToSeries(live, tick('2026-09-07T01:03:00.000Z', 5700, 44)) ?? live;
    expect(recentDelta(live.points)).toBe(5);
    // All three replaced one another, so the series never grew the sub-stride spike the next
    // refetch would erase — the rule this fix had to leave alone.
    expect(live.points).toHaveLength(2);
  });

  it('falls back to the last step for a series only the server answered', () => {
    // The first paint, unchanged: the server tags no point, and a market that has been quiet
    // has its last price carried forward onto the window edge, so the final two points are
    // equal, the delta is 0 and `deltaLabel` hides the badge (실시간은 조용하게, PLAN 11.1-5).
    const quiet = series({
      points: [
        { ts: '2026-09-07T00:00:00.000Z', pYesBp: 4200, trigger: 'trade' },
        { ts: '2026-09-07T01:00:00.000Z', pYesBp: 4200, trigger: 'trade' },
      ],
    });
    expect(recentDelta(quiet.points)).toBe(0);
    expect(recentDelta(series().points)).toBe(2);
  });

  it('has nothing to report for a series with no points, and for none at all', () => {
    expect(recentDelta(series({ points: [] }).points)).toBeNull();
    expect(recentDelta(undefined)).toBeNull();
    // One point is a market whose first trade is on screen: there is no earlier reading to
    // measure against, and inventing 0 would claim the probability had not moved.
    expect(recentDelta(series({ points: [series().points[0]!] }).points)).toBeNull();
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
      tradeCount: 42,
      trigger: 'trade',
      // Carried through the re-push unchanged: the move was measured when the socket CREATED
      // this point, against the reading it superseded — not against the answer's right edge.
      movedFromBp: 4200,
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
      tradeCount: 42,
      points: [
        ...series().points,
        { ts: '2026-09-07T01:30:00.000Z', pYesBp: 6000, trigger: 'trade' },
      ],
    });
    expect(joinSeries(live(), answered)).toBe(answered);
    expect(joinSeries(undefined, answered)).toBe(answered);
  });

  it('costs only a rewrite when the answer counts fewer trades than its own points show', () => {
    // The server reads `tradeCount` in the statement BEFORE it samples, so a trade committing
    // between the two is in the points and not in the count. That direction is deliberate and
    // harmless: the join keeps a point the answer already has — same trade, same price — so
    // the content matches even though the object does not.
    const lagging = series({
      to: '2026-09-07T02:00:00.000Z',
      tradeCount: 41,
      points: [
        ...series().points,
        { ts: '2026-09-07T02:00:00.000Z', pYesBp: 6000, trigger: 'trade' },
      ],
    });
    const joined = joinSeries(live(), lagging);
    // The price the chart draws at its right edge is the answer's own, and no pre-trade value
    // survives after the trade's instant. The edge sits at the trade rather than at the window
    // end, which is the whole cost of reading the counter one statement early.
    expect(joined.points.at(-1)?.pYesBp).toBe(6000);
    expect(joined.points.map((point) => point.ts)).toEqual([
      '2026-09-07T00:00:00.000Z',
      '2026-09-07T01:30:00.000Z',
    ]);
    expect(joined.to).toBe('2026-09-07T02:00:00.000Z');
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

describe('rowSupersedesSeries', () => {
  it('answers yes only when the row names a trade the series does not', () => {
    // The chart asks this before it draws the row's probability over the series' right edge.
    // Same trade on both sides — the ordinary path — is provably inert.
    expect(rowSupersedesSeries(series(), 42)).toBe(true);
    expect(rowSupersedesSeries(series(), 41)).toBe(false);
  });

  it('refuses to overrule a series that is the newer of the two', () => {
    // A live tick already appended: the series is ahead, so the row has nothing to add.
    const live = appendTickToSeries(series(), tick('2026-09-07T01:30:00.000Z', 6000));
    expect(rowSupersedesSeries(live, 41)).toBe(false);
    expect(rowSupersedesSeries(undefined, 99)).toBe(false);
  });

  it('refuses a series an older API answered, rather than letting the row always win', () => {
    // `supersedes` takes anything over an absent key, which would turn this into the
    // unconditional override it exists to avoid.
    const legacy = { ...series(), tradeCount: undefined } as unknown as ReturnType<typeof series>;
    expect(rowSupersedesSeries(legacy, 99)).toBe(false);
  });

  it('never throws out of a render for a count that is not an integer', () => {
    // `supersedes` compares as BigInt, which THROWS on a fraction or a NaN — and this is the
    // first caller inside a render, where a throw blanks the page.
    expect(() => rowSupersedesSeries(series(), Number.NaN)).not.toThrow();
    expect(rowSupersedesSeries(series(), Number.NaN)).toBe(false);
    expect(rowSupersedesSeries(series(), 42.5)).toBe(false);
    expect(rowSupersedesSeries({ ...series(), tradeCount: 1.5 }, 42)).toBe(false);
  });
});

describe('recentMove', () => {
  it('gives every move a monotone identity, which no later move can repeat', () => {
    // THE HAZARD: `ProbabilityDisplay` hides a badge whose identity matches the last one it
    // DISMISSED, and `dismissed` holds the last move whose five-second timer actually FIRED — so
    // a move superseded before then leaves an OLDER identity in the slot. A value-based key
    // therefore fails on an oscillation: up, down, up put the third move back on the first
    // move's key (measured [SHOWN, SHOWN, NOT SHOWN]). `tradeCount` only ever increases.
    let live = series({ bucketSeconds: 300, to: '2026-09-07T01:00:00.000Z' });
    const ids: string[] = [];
    for (const [i, bp] of [4700, 4200, 4700].entries()) {
      live =
        appendTickToSeries(live, tick(`2026-09-07T01:0${String(i + 1)}:00.000Z`, bp, 42 + i)) ??
        live;
      const move = recentMove(live.points);
      ids.push(move?.moveId ?? '(none)');
    }
    expect(ids).toEqual(['t42', 't43', 't44']);
    // The probability came back to where it began, and the identities still differ.
    expect(new Set(ids).size).toBe(3);
  });

  it('reads the delta and its identity off the SAME point', () => {
    // Read apart they can drift; `recentMove` is what makes that impossible.
    const live =
      appendTickToSeries(
        series({ bucketSeconds: 300 }),
        tick('2026-09-07T01:30:00.000Z', 4700, 42),
      ) ?? series();
    expect(recentMove(live.points)).toEqual({
      deltaPoints: recentDelta(live.points),
      moveId: 't42',
    });
  });

  it('falls back to the instant for a server point, which carries no counter', () => {
    // A pristine answer has no socket-tagged point; its right edge is pinned at the answer's
    // `to`, which moves with every fetch, so the instant is monotone here too.
    const answered = series();
    expect(recentMove(answered.points)?.moveId).toBe(`s${String(answered.points.at(-1)?.ts)}`);
  });

  it('has nothing to report when the delta does not', () => {
    expect(recentMove(undefined)).toBeNull();
    expect(recentMove(series({ points: [] }).points)).toBeNull();
  });
});
