import { SPARKLINE_MAX_POINTS } from '@buddha/shared';

/**
 * The geometry behind the card sparkline (PLAN 11.4). Pure and free of `Date.now()`, so a
 * server render and the first client render draw the same path and the SVG is testable under
 * `environment: 'node'`.
 *
 * A market opened through the admin transition or the seed carries an `open` price tick, so
 * its card draws a flat line at the opening probability rather than an empty box; a market
 * with no tick at all sends `[]` and draws nothing.
 */

/** Below this the series renders flat: a 0.2%p wiggle must not look like a mountain (PLAN 11.1-5). */
export const SPARKLINE_MIN_SPAN_BP = 500;

/**
 * The SVG path for a `width` x `height` sparkline box, or `null` for fewer than two points —
 * a single sample is a dot, not a trend, and the card renders an empty box of the same size
 * so its height never shifts.
 *
 * The x grid is the DTO's fixed hourly 24-hour grid, not the array. The buckets before a young
 * market existed are a strict prefix the API drops, so the array's LENGTH encodes its start
 * bucket and the series is right-aligned by `SPARKLINE_MAX_POINTS - points.length`: a
 * three-hour-old market draws a short line at the live edge instead of a four-point line
 * stretched across the whole card, and two cards side by side share one time axis.
 *
 * The domain is centred on the series and floored at SPARKLINE_MIN_SPAN_BP rather than
 * min/max-fitted. Min/max fitting divides by zero on a flat series — the common case for a
 * quiet market here — and it would also blow a one-basis-point wiggle up into a mountain.
 */
export function sparklinePath(points: number[], width: number, height: number): string | null {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(max - min, SPARKLINE_MIN_SPAN_BP);
  const lo = (min + max) / 2 - span / 2;
  const step = width / (SPARKLINE_MAX_POINTS - 1);
  // A longer array than the grid would push x past `width`; the DTO caps the length, and this
  // keeps the path inside the box even so.
  const offset = Math.max(0, SPARKLINE_MAX_POINTS - points.length);
  return points
    .map((bp, i) => {
      const y = height - ((bp - lo) / span) * height;
      // Defensive against float drift only: the centred domain already contains every sample.
      const clamped = Math.min(Math.max(y, 0), height);
      return `${i === 0 ? 'M' : 'L'}${((offset + i) * step).toFixed(2)} ${clamped.toFixed(2)}`;
    })
    .join(' ');
}
