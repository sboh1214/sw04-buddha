import { SPARKLINE_MAX_POINTS } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { SPARKLINE_MIN_SPAN_BP, sparklinePath } from './sparkline';

const WIDTH = 64;
const HEIGHT = 20;
const STEP = WIDTH / (SPARKLINE_MAX_POINTS - 1);

interface Coord {
  x: number;
  y: number;
}

/** `M0.00 10.00 L2.67 9.60 …` back into numbers, so the assertions read as geometry. */
function coords(path: string | null): Coord[] {
  expect(path).not.toBeNull();
  const tokens = (path ?? '').split(' ');
  const parsed: Coord[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const command = tokens[i] ?? '';
    expect(command[0]).toBe(i === 0 ? 'M' : 'L');
    parsed.push({ x: Number(command.slice(1)), y: Number(tokens[i + 1]) });
  }
  return parsed;
}

/** A series of `length` samples rising by `stepBp` from `startBp`. */
function series(length: number, startBp: number, stepBp: number): number[] {
  return Array.from({ length }, (_, i) => startBp + i * stepBp);
}

describe('sparklinePath', () => {
  it('draws nothing for fewer than two points', () => {
    // One sample is a dot, not a trend; the card keeps its box so the row height is stable.
    expect(sparklinePath([], WIDTH, HEIGHT)).toBeNull();
    expect(sparklinePath([5000], WIDTH, HEIGHT)).toBeNull();
  });

  it('spans the whole box for a full 24-hour series', () => {
    const points = coords(sparklinePath(series(SPARKLINE_MAX_POINTS, 4000, 100), WIDTH, HEIGHT));
    expect(points).toHaveLength(SPARKLINE_MAX_POINTS);
    expect(points[0]?.x).toBe(0);
    expect(points.at(-1)?.x).toBe(WIDTH);
  });

  it('right-aligns a young market by the array length', () => {
    // The API drops the buckets before the market existed, so a four-sample array means "the
    // last four hours": it must draw a short line at the live edge, not a stretched one.
    const points = coords(sparklinePath(series(4, 5000, 50), WIDTH, HEIGHT));
    expect(points[0]?.x).toBeCloseTo(21 * STEP, 2);
    expect(points.at(-1)?.x).toBe(WIDTH);
  });

  it('advances x strictly and keeps y inside the box', () => {
    const points = coords(sparklinePath([100, 9900, 5000, 0, 10000, 4200, 4200], WIDTH, HEIGHT));
    for (const [i, point] of points.entries()) {
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(HEIGHT);
      if (i > 0) expect(point.x).toBeGreaterThan(points[i - 1]?.x ?? 0);
    }
  });

  it('draws a flat series down the middle instead of dividing by zero', () => {
    // The divide-by-zero pin: a quiet market's samples are all equal, which is exactly the
    // case a min/max-fitted domain cannot render.
    const points = coords(sparklinePath([6300, 6300, 6300, 6300], WIDTH, HEIGHT));
    for (const point of points) {
      expect(Number.isFinite(point.y)).toBe(true);
      expect(point.y).toBeCloseTo(HEIGHT / 2, 2);
    }
  });

  it('renders a 0.2%p wiggle nearly flat', () => {
    // 20bp against the SPARKLINE_MIN_SPAN_BP floor: noise stays noise (PLAN 11.1-5).
    const points = coords(sparklinePath([5000, 5020, 5000, 5020], WIDTH, HEIGHT));
    const ys = points.map((point) => point.y);
    const spread = Math.max(...ys) - Math.min(...ys);
    expect(spread).toBeCloseTo((20 / SPARKLINE_MIN_SPAN_BP) * HEIGHT, 2);
    // A real move past the floor still uses the whole box, so the flat rendering above is the
    // floor doing its job rather than the geometry being blunt.
    const wide = coords(sparklinePath([5000, 5000 + SPARKLINE_MIN_SPAN_BP * 2], WIDTH, HEIGHT));
    expect(wide[0]?.y).toBe(HEIGHT);
    expect(wide[1]?.y).toBe(0);
  });
});
