import { type MarketTickEvent, TICKS_MAX_POINTS, type TickResolution } from '@buddha/shared';
import { type PriceSeries, type PriceTick, api, unwrap } from './api';
import { ticksKey } from './market-keys';

/**
 * The probability chart's range toggle, in one place (PLAN 11.4-11.5): what a range asks
 * `GET /markets/:id/ticks` for, and how a live `market:tick` is merged into a series already
 * in the cache. The socket already carries the new value, so PLAN 11.5 forbids refetching the
 * series for it — `appendTickToSeries` is what makes that possible.
 *
 * Everything except `ticksQueryOptions`' `queryFn` is pure and takes `nowMs` as a parameter,
 * following `isClosingSoon(market, now)` in market-admin.ts: a clock read during render is a
 * value the server and its hydration disagree about.
 */

export const TICK_RANGES = ['1D', '1W', 'all'] as const;
export type TickRange = (typeof TICK_RANGES)[number];

/** What the detail page opens on, and the only range the server seeds into the cache. */
export const DEFAULT_TICK_RANGE: TickRange = '1D';

/** Window a range covers. `all` has none — it sends no `from` and the server fills in `openAt`. */
const RANGE_MS: Record<Exclude<TickRange, 'all'>, number> = {
  '1D': 24 * 60 * 60 * 1000,
  '1W': 7 * 24 * 60 * 60 * 1000,
};

/**
 * Stride the `from` bound is floored onto, one per range. Without it every render would
 * produce a different millisecond and therefore a different request, so nothing downstream —
 * the browser cache, the API's own plan cache — could ever hit twice.
 */
const RANGE_STRIDE_MS: Record<Exclude<TickRange, 'all'>, number> = {
  '1D': 60 * 1000,
  '1W': 60 * 60 * 1000,
};

/**
 * The resolution a range asks for. It is a floor, not a promise: the server coarsens it to a
 * grid that fits the window (`tickBucketSeconds`) and reports what it actually served as
 * `bucketSeconds`, so a `1m` request over a day comes back on a 5-minute grid.
 */
const RANGE_RESOLUTION: Record<TickRange, TickResolution> = {
  '1D': '1m',
  '1W': '1h',
  all: '1h',
};

/** Query string of `GET /markets/:id/ticks`. `to` is deliberately not a member — see below. */
export interface TicksQuery {
  from?: string;
  resolution: TickResolution;
}

/**
 * ISO `from` for a range, or undefined for 'all' (only the server knows when the market
 * opened). `nowMs` is injected so a server render and its hydration derive the same bound,
 * and the instant is floored onto the range's stride so two renders inside one bucket produce
 * the SAME string — a query whose parameters move every render never settles.
 */
export function tickRangeFrom(range: TickRange, nowMs: number): string | undefined {
  if (range === 'all') return undefined;
  const stride = RANGE_STRIDE_MS[range];
  return new Date(Math.floor((nowMs - RANGE_MS[range]) / stride) * stride).toISOString();
}

/**
 * The whole query for a range. `to` is never sent: the server closes the window on its own
 * clock, so the right edge of the answer is live by construction, while a client-sent `to`
 * would freeze the series at the instant the component happened to render.
 */
export function ticksQueryFor(range: TickRange, nowMs: number): TicksQuery {
  const resolution = RANGE_RESOLUTION[range];
  const from = tickRangeFrom(range, nowMs);
  return from === undefined ? { resolution } : { from, resolution };
}

/**
 * The series behind ProbabilityChart. Exported apart from the hook because the decision is
 * what matters and a component cannot be executed in this app's test runner — the rule
 * `adminMarketQueryOptions` (use-admin-markets.ts) states.
 *
 * `from` is computed INSIDE `queryFn`, never in the key: a `Date.now()`-derived string in the
 * key changes it on every render, so every render misses the cache and the query refetches
 * forever. The key is the range token; the window that token means is re-derived per fetch,
 * which is also what keeps a plain refetch live.
 *
 * `marketId` must be the market's canonical uuid — this route is guarded by `uuidParamSchema`
 * and answers 400 for a slug, so a slug-routed page passes the resolved `market.id` (A-M3-29).
 */
export function ticksQueryOptions(marketId: string, range: TickRange) {
  return {
    queryKey: ticksKey(marketId, range),
    queryFn: async (): Promise<PriceSeries> =>
      unwrap(
        await api.GET('/api/v1/markets/{id}/ticks', {
          params: { path: { id: marketId }, query: ticksQueryFor(range, Date.now()) },
        }),
      ).data,
  };
}

/**
 * Merges a `market:tick` into the right edge of a held series, or returns **undefined meaning
 * "do not write"**: `setQueryData` returns early on an undefined updater result, so a late or
 * duplicate event costs no cache write and does not restart `staleTime`.
 *
 * Ordering is by `ts` because a series carries no counter — the caller has already gated the
 * event on `supersedes(event.tradeCount, …)` against the market row, so a duplicate never gets
 * this far, and the only case a strict comparison loses is a second trade inside the same
 * millisecond: one interior point of five hundred, which the next tick corrects at the edge.
 * The comparison is written `!(a > b)` rather than `a <= b` so an unparseable `ts` (NaN, which
 * fails both) is dropped instead of written into the cache.
 *
 * An event inside the last bucket REPLACES the last point rather than appending, so a busy
 * market does not grow a spike of sub-stride points the next refetch would erase.
 * `bucketSeconds === 0` (raw) makes that test false for every event, so raw always appends.
 * The replacement carries the event's own instant, so the right edge is the live truth rather
 * than a grid boundary — a consumer must not assume every point sits on the absolute grid
 * (the same caveat the server's own left edge already carries).
 *
 * `from` and `truncated` are left alone even when the head is trimmed: they describe the
 * window the SERVER answered, and the next fetch re-derives both. `to` moves forward only.
 */
export function appendTickToSeries(
  held: PriceSeries | undefined,
  event: MarketTickEvent,
): PriceSeries | undefined {
  if (held === undefined) return undefined;

  const eventMs = Date.parse(event.ts);
  const last = held.points.at(-1);
  // An empty series (a market whose first trade is this event) takes it: nothing is newer.
  const lastMs = last === undefined ? Number.NEGATIVE_INFINITY : Date.parse(last.ts);
  if (!(eventMs > lastMs)) return undefined;

  // The event carries no `trigger`, and nothing draws one — the chart is a single step line.
  // 'trade' is the honest label for a live point; a tick published by a status transition is
  // relabelled by the next fetch, which reads the stored row.
  const point: PriceTick = { ts: event.ts, pYesBp: event.pYesBp, trigger: 'trade' };
  const points =
    eventMs - lastMs < held.bucketSeconds * 1000
      ? [...held.points.slice(0, -1), point]
      : [...held.points, point];

  return {
    ...held,
    points: points.length > TICKS_MAX_POINTS ? points.slice(-TICKS_MAX_POINTS) : points,
    to: eventMs > Date.parse(held.to) ? event.ts : held.to,
  };
}

/**
 * The shorter name the hooks may import; both resolve to the one implementation above. The
 * declared name is the long one because `applyTick` in market-live.ts patches a market ROW
 * from the same event, and two functions called `app…Tick` on one screen are one
 * autocomplete away from each other.
 */
export { appendTickToSeries as appendTick };
