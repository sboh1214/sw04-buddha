import {
  type MarketStatus,
  type MarketTickEvent,
  TICKS_MAX_POINTS,
  type TickResolution,
  isPreCloseMarketStatus,
  supersedes,
} from '@buddha/shared';
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

/** The range a chart opens on when its caller names none (`useMarketTicks`' default). */
export const DEFAULT_TICK_RANGE: TickRange = '1D';

/**
 * The range the detail opens on, and the one the server seeds into the cache (ADR-0135 C1·C4,
 * ADR-0139): 1일 while trading has not ended (개장 예정, 거래 중, 거래 일시 중단) and 전체 — 개장부터
 * 실제 거래 종료까지 — after. Read off the row's status when the page opens only; a status that
 * changes under the reader leaves the range they are on.
 */
export function initialTickRange(status: MarketStatus): TickRange {
  return isPreCloseMarketStatus(status) ? '1D' : 'all';
}

/**
 * How often the detail re-reads an open market's row (ADR-0139): `lastPrice24hAgo`, the 24시간
 * badge's baseline, moves with time and no event carries it. Five minutes, the 1일 grid's stride.
 */
export const LIVE_REFRESH_MS = 5 * 60_000;

/**
 * Whether the server closed this answer's window before it read it (`asOf > to`, ADR-0139):
 * trading had ended, so no fill can join the window and the answer is whole. An open window ends
 * where it was read (`asOf === to`); a series without `asOf` (an older API) reads as open.
 */
export function isClosedWindow(series: Pick<PriceSeries, 'to'> & { asOf?: string }): boolean {
  if (series.asOf === undefined) return false;
  return Date.parse(series.asOf) > Date.parse(series.to);
}

/** Window a range covers. `all` has none — it sends no `from` and the server fills in `openAt`. */
const RANGE_MS: Record<Exclude<TickRange, 'all'>, number> = {
  '1D': 24 * 60 * 60 * 1000,
  '1W': 7 * 24 * 60 * 60 * 1000,
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
  windowSeconds?: number;
  resolution: TickResolution;
}

/** How far back a range reaches, in seconds; `undefined` for 'all', which reaches to the open. */
export function tickRangeWindowSeconds(range: TickRange): number | undefined {
  return range === 'all' ? undefined : RANGE_MS[range] / 1_000;
}

/**
 * The whole query for a range: a DURATION and nothing else.
 *
 * Neither end is an instant this client names, and that is the fix rather than a simplification.
 * `to` is not sent so the server closes the window on its own clock and the right edge is live by
 * construction. `from` is not sent either — it used to be `Date.now()` minus the range, which
 * measured one end of the window on the visitor's machine and the other on the database's, so a
 * skewed clock got a span wrong by the skew: measured, 25 hours at an hour slow, 23 at an hour
 * fast, and past a full day fast the request inverted and the server clamped it to a single
 * instant. That last case was not merely a short chart — the accessible summary then asserted
 * `시작 61%, 최고 61%, 최저 61%` on a day that opened at 41%, a false reading delivered silently.
 *
 * `windowSeconds` is the same principle A-M4-23 settled for the close gate: the browser is asked
 * only for a DURATION, which its clock measures correctly. It needs no `nowMs`, so it also cannot
 * differ between a server render and its hydration — the reason the old bound was floored onto a
 * stride, now unnecessary.
 */
export function ticksQueryFor(range: TickRange): TicksQuery {
  const resolution = RANGE_RESOLUTION[range];
  const windowSeconds = tickRangeWindowSeconds(range);
  return windowSeconds === undefined ? { resolution } : { windowSeconds, resolution };
}

/**
 * What the CACHE holds under `['ticks', id, range]`: a server answer, plus the points this
 * tab's own socket drew onto it. The tag is the only difference — a point the socket appended
 * names the trade it came from, and a server point never does, because the wire `PriceTick`
 * carries no counter (its points are fills since #121, ADR-0116) and the DTO is not widened
 * for one.
 *
 * The tag answers what a window cannot: could this answer have held this point? `PriceSeries`'
 * own `tradeCount` asks the same question about the right edge, and both are compared with
 * `supersedes` — the ordering `joinMarket` already gives the market row.
 */
export interface CachedTick extends PriceTick {
  tradeCount?: number;
}

export interface CachedSeries extends Omit<PriceSeries, 'points'> {
  points: CachedTick[];
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
    queryFn: async (): Promise<CachedSeries> =>
      unwrap(
        await api.GET('/api/v1/markets/{id}/ticks', {
          params: { path: { id: marketId }, query: ticksQueryFor(range) },
        }),
      ).data,
  };
}

/**
 * Merges a `market:tick` into the right edge of a held series, or returns **undefined meaning
 * "do not write"**: `setQueryData` returns early on an undefined updater result, so a late or
 * duplicate event costs no cache write and does not restart `staleTime`.
 *
 * Ordering is by `tradeCount`, the same key `applyTick` gives the market row. It cannot be by
 * `ts`: the server pins a point at its own window END (`rn = cnt`, market.service.ts) and that
 * instant is LATER than the `executedAt` this event carries, so a `ts` test refuses exactly
 * the tick an answer could not see — the series kept the answer's synthetic right edge and the
 * trade never reached the chart at all, with no cache write to show for it. A duplicate or a
 * late event still costs nothing, `supersedes` being strict.
 *
 * A held series with no counter is one an API older than that field answered; it falls back to
 * the `ts` rule, because `supersedes` takes anything over an absent key and would admit every
 * event. An unparseable `ts` is dropped explicitly, where `!(a > b)` used to drop it by
 * accident.
 *
 * An EMPTY cache is a deliberate discard, not "nothing to merge into". The event really is
 * offered — `setQueriesData` matches on the key alone, so it reaches a range that exists and is
 * still on its first fetch (the first press of 1주 or 전체; only 1D is seeded) — and it is
 * refused because this event cannot BUILD a series: it carries no window, resolution or stride,
 * and inventing one would flip a pending query to `success` over its own skeleton and outlive a
 * fetch that then failed. What covers the gap instead is the chart reading the row it is a
 * trade behind (`lastFill`, chart.ts), and the NEXT event, which supersedes the answer's own
 * `tradeCount` and appends normally.
 *
 * An event in the last point's bucket REPLACES that point rather than appending, so a busy
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
  held: CachedSeries | undefined,
  event: MarketTickEvent,
): CachedSeries | undefined {
  if (held === undefined) return undefined;
  // No fill price, nothing to draw: the chart records fills only (N02 §5).
  if (event.lastPrice === null) return undefined;

  const eventMs = Date.parse(event.ts);
  if (!Number.isFinite(eventMs)) return undefined;
  const last = held.points.at(-1);
  // An empty series (a market whose first trade is this event) takes it: nothing is newer.
  const lastMs = last === undefined ? Number.NEGATIVE_INFINITY : Date.parse(last.ts);
  const ordered =
    typeof held.tradeCount === 'number'
      ? supersedes(event.tradeCount, held.tradeCount)
      : eventMs > lastMs;
  if (!ordered) return undefined;

  // The event carries no `trigger`, and nothing draws one — the chart is a single step line.
  // Only an order intake that filled publishes a tick (#121, ADR-0116), and every server point
  // is a fill labelled 'trade', so the live point carries what the next fetch returns. The
  // fill's price is a whole percent and the series is in basis points, hence the ×100.
  const point: CachedTick = {
    ts: event.ts,
    pYesBp: event.lastPrice * 100,
    trigger: 'trade',
    tradeCount: event.tradeCount,
  };
  return pushPoint(held, point, eventMs);
}

/**
 * One point onto the right edge of a series, replacing the last when the two share a bucket.
 * Factored out because the socket and `joinSeries` both put a live point onto a series and the
 * bucket rule must not be stated twice; the caller has already established that `point` is the
 * newer of the two BY COUNTER, and the trim below is what that means for an array ordered by
 * `ts`.
 *
 * The trim comes first. Every held point at or after `point`'s instant was sampled from a
 * snapshot that could not see the trade `point` names — the boundary the server pins at its own
 * window end above all — so each carries the PRE-trade price forward across that trade's own
 * moment. Dropping them is what lets a point be pushed at all when it sits BEHIND that
 * boundary, and it keeps the ascending order `chartGeometry` assumes. In the ordinary case, a
 * live tick newer than everything held, nothing matches and the whole series is kept.
 *
 * Bucket membership is read off the SAME absolute grid the server bins on (`date_bin(stride,
 * …, '1970-01-01 00:00:00+00')` in market.service.ts), never as the gap `pointMs - lastMs`:
 * neither instant a gap would measure from is a boundary — the server closes its answer at
 * `to`, which is its own clock, and a point this function has already replaced carries the
 * event's instant — so a gap test slides its origin forward with every tick and keeps
 * replacing, and a market trading more often than one bucket would never gain a point again.
 * `bucketMs > 0` keeps raw appending (and never divides by zero); an empty series has
 * `lastMs === -Infinity`, whose floor equals no real bucket, so its first point appends.
 */
function pushPoint(held: CachedSeries, point: CachedTick, pointMs: number): CachedSeries {
  const kept: CachedTick[] = [];
  for (const candidate of held.points) {
    if (!(Date.parse(candidate.ts) < pointMs)) break;
    kept.push(candidate);
  }
  const previous = kept.at(-1);
  const lastMs = previous === undefined ? Number.NEGATIVE_INFINITY : Date.parse(previous.ts);
  const bucketMs = held.bucketSeconds * 1000;
  const sameBucket =
    bucketMs > 0 && Math.floor(pointMs / bucketMs) === Math.floor(lastMs / bucketMs);
  const points = sameBucket ? [...kept.slice(0, -1), point] : [...kept, point];

  return {
    ...held,
    points: points.length > TICKS_MAX_POINTS ? points.slice(-TICKS_MAX_POINTS) : points,
    to: pointMs > Date.parse(held.to) ? point.ts : held.to,
    // The newest trade this series' RIGHT EDGE reflects — the meaning `joinMarket` gives the
    // same field on the market row, and what the next event is admitted against.
    tradeCount:
      point.tradeCount !== undefined && supersedes(point.tradeCount, held.tradeCount)
        ? point.tradeCount
        : held.tradeCount,
  };
}

/**
 * The series join — `joinMarket`'s counterpart for `['ticks', id, range]`, registered as that
 * key's `structuralSharing` in query-client.ts.
 *
 * Without it the `ts` order held only between EVENTS. `appendTickToSeries` refuses a tick that
 * is not newer than the right edge, but an HTTP answer went into the cache raw, so a refetch
 * that left before a trade — the invalidation a `market:status` fires, a `resnapshot`, a
 * window-focus refetch past the 30s staleTime — landed after the socket had already drawn that
 * trade and pulled the chart's right edge back to the old probability. The header could not
 * follow it there: `['market', id]` has `joinMarket` and keeps the new one, so the two readings
 * of the same trade sat on screen disagreeing until the next tick or fetch.
 *
 * The WINDOW is the incoming answer's, always: `from`, `resolution`, `bucketSeconds` and
 * `truncated` describe what the server chose. Which held points SURVIVE is two tests OR-ed, and
 * it has to be both — neither subsumes the other:
 *
 *  - past `incoming.to`: the answer's WINDOW does not reach the point. (Reading this cutoff off
 *    the last incoming POINT instead would resurrect a whole stale series whenever the server
 *    answered an empty window.)
 *  - newer than `incoming.tradeCount`: the answer's SNAPSHOT does not reach the trade the point
 *    names. `to` cannot decide this. A tick's `ts` is fixed before its row commits, so an
 *    answer can close its window PAST that instant and still omit the tick, and this loop then
 *    dropped the socket's point as already covered — while the header, which has `joinMarket`,
 *    kept it. That is the very divergence this function exists to remove, re-entered through
 *    its own cutoff.
 *
 * The route reads the counter and the points in one snapshot (ADR-0139). A trade whose
 * `executedAt` lands after the route's clock read is outside the window: the first test keeps
 * it. A trade stamped before `to` but committed after the snapshot is in neither the counter
 * nor the points: only the second test keeps that one.
 *
 * Each survivor goes back through `pushPoint`, so a live point sharing the last bucket replaces
 * rather than doubles it, and `TICKS_MAX_POINTS` still bounds the result. Idempotent (a second
 * join against the same answer keeps the same tail) and a no-op in the ordinary case, where the
 * answer already contains the tick and nothing is newer than its `to`.
 *
 * A CLOSED answer (`isClosedWindow`, ADR-0139) is taken whole: trading had ended before it was
 * read, so it holds every fill its window will ever have, and neither test applies — a held
 * point past its `to` and a later `to` would be the open window a `market:status` just closed.
 */
export function joinSeries(held: CachedSeries | undefined, incoming: CachedSeries): CachedSeries {
  if (held === undefined || isClosedWindow(incoming)) return incoming;
  const cutoffMs = Date.parse(incoming.to);
  const fromMs = Date.parse(incoming.from);
  let next = incoming;
  let carried = false;
  for (const point of held.points) {
    const pointMs = Date.parse(point.ts);
    // Explicit, where the old `!(a > b)` dropped a NaN by accident: with two tests OR-ed, an
    // unparseable `ts` could otherwise reach the cache through the counter half.
    if (!Number.isFinite(pointMs)) continue;
    if (pointMs > cutoffMs) {
      const last = next.points.at(-1);
      const lastMs = last === undefined ? Number.NEGATIVE_INFINITY : Date.parse(last.ts);
      // Past the window and not past what is already pushed is a duplicate.
      if (!(pointMs > lastMs)) continue;
      next = pushPoint(next, point, pointMs);
      carried = true;
      continue;
    }
    // Inside the window, so the answer's snapshot decides — and it can only be asked about a
    // point the socket tagged. `pointMs >= fromMs` is what stops a range that has slid forward
    // from dragging yesterday's live edge back into today's window.
    const unseen =
      point.tradeCount !== undefined &&
      supersedes(point.tradeCount, incoming.tradeCount) &&
      pointMs >= fromMs;
    if (!unseen) continue;
    next = pushPoint(next, point, pointMs);
    carried = true;
  }
  // The counter describes the RIGHT EDGE, so it follows whichever side still owns it: `held`
  // when one of its points survived above, the answer otherwise. Conditioning on `carried` is
  // the whole point — taking `held.tradeCount` unconditionally, as a mirror of the `to` rule
  // below, would let the counter claim a trade whose point was just dropped, and every later
  // event for that trade would then be refused as a duplicate. That is this same bug, one
  // layer in.
  if (carried && supersedes(held.tradeCount, next.tradeCount)) {
    next = { ...next, tradeCount: held.tradeCount };
  }
  // `to` takes the LATER of the two, which the loop above cannot always reach: two refetches
  // in flight can land newest-first, and then the older answer names an earlier right edge
  // than one this cache already held with no point past it to carry the difference. Letting it
  // through would move `to` backwards, which `appendTickToSeries` forbids for its own writes —
  // and `to` is where the chart's dotted hold after the last fill ends (`chartLayout`).
  return Date.parse(held.to) > Date.parse(next.to) ? { ...next, to: held.to } : next;
}

/**
 * The shorter name the hooks may import; both resolve to the one implementation above. The
 * declared name is the long one because `applyTick` in market-live.ts patches a market ROW
 * from the same event, and two functions called `app…Tick` on one screen are one
 * autocomplete away from each other.
 */
export { appendTickToSeries as appendTick };
