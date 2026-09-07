import { TICKS_MAX_POINTS } from './constants.js';
import { type TickResolution } from './market.js';

/**
 * Strides `GET /markets/:id/ticks` may serve (seconds, coarsest last). A requested resolution
 * is coarsened to the first entry whose grid fits the window inside TICKS_MAX_POINTS points,
 * so the answer is always an evenly spaced grid: striding a 1-minute series down to 500 points
 * would label points "1m" that are 40 minutes apart, unevenly where buckets are missing.
 *
 * Every entry is a pure time span (hours, never calendar days): the grid is generated with
 * make_interval(secs => …), and a calendar `day`/`week` stride would drift with the session
 * TimeZone GUC, which createDb never sets (packages/db/src/client.ts).
 */
export const TICK_BUCKET_SECONDS = [60, 300, 900, 3_600, 14_400, 86_400, 604_800] as const;
export type TickBucketSeconds = (typeof TICK_BUCKET_SECONDS)[number];

/** Seconds a resolution asks for; 0 = no bucketing. */
export const TICK_RESOLUTION_SECONDS = {
  raw: 0,
  '1m': 60,
  '1h': 3_600,
} as const satisfies Record<TickResolution, number>;

/**
 * The stride to serve for `resolution` over a window of `rangeMs`: the finest ladder entry at
 * least as coarse as the request whose grid fits the window. 0 for raw.
 *
 * The budget is TICKS_MAX_POINTS - 2 because the response also pins both ends of the window
 * (`from` and `to` are always boundaries), and that is exactly what keeps the answer at or
 * below the documented cap: with ceil(span/s) <= 498 the grid contributes at most 498 interior
 * values, so boundaries <= 500 before the union collapses the aligned ends.
 *
 * Pure millisecond arithmetic — no `Date` parsing and no `Intl`, so the answer is the same in
 * every session time zone by construction, which is what lets the API compute the stride in
 * JS and hand it to SQL as a bound `make_interval(secs => …)` parameter.
 */
export function tickBucketSeconds(
  resolution: TickResolution,
  rangeMs: number,
  maxPoints: number = TICKS_MAX_POINTS,
): TickBucketSeconds | 0 {
  const requested = TICK_RESOLUTION_SECONDS[resolution];
  if (requested === 0) return 0;
  const budget = Math.max(1, maxPoints - 2);
  const span = Math.max(0, rangeMs) / 1_000;
  const ladder = TICK_BUCKET_SECONDS.filter((seconds) => seconds >= requested);
  // A window even a week-wide grid cannot cover (about ten years) falls back to the coarsest
  // entry; the caller trims the old end of the window rather than overrunning the cap.
  return ladder.find((seconds) => Math.ceil(span / seconds) <= budget) ?? 604_800;
}
