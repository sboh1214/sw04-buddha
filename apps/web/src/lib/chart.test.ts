import { BP_MAX } from '@buddha/shared';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CHART_MIN_SPAN_BP,
  CHART_PAD,
  CHART_VIEWBOX,
  type ChartPoint,
  axisLabels,
  chartDomain,
  chartExtent,
  chartGeometry,
  chartSummary,
  extendToNow,
  nearestIndex,
  readoutIndex,
  readoutMove,
  sampleForTable,
  toChartPoints,
  withLiveEdge,
} from './chart';

const originalTz = process.env.TZ;
afterAll(() => {
  process.env.TZ = originalTz;
});

const BASE = Date.parse('2026-09-07T00:00:00.000Z');
const MINUTE = 60_000;

const point = (minutes: number, bp: number): ChartPoint => ({ t: BASE + minutes * MINUTE, bp });

/** `n` points a minute apart, wandering between 50% and 70%. */
const series = (n: number): ChartPoint[] =>
  Array.from({ length: n }, (_, i) => point(i, 5000 + ((i * 37) % 2000)));

/** How many decimals each number in a path string carries. */
const decimals = (path: string): number[] =>
  [...path.matchAll(/-?\d+(?:\.(\d+))?/g)].map((match) => match[1]?.length ?? 0);

const anySeries = fc.array(
  fc.record({ t: fc.integer(), bp: fc.integer({ min: 0, max: BP_MAX }) }),
  { minLength: 1, maxLength: 40 },
);

describe('toChartPoints', () => {
  it('keeps the order the API returned and drops a row it cannot plot', () => {
    expect(
      toChartPoints([
        { ts: '2026-09-07T00:00:00.000Z', pYesBp: 6100 },
        { ts: 'not-an-instant', pYesBp: 6200 },
        { ts: '2026-09-07T01:00:00.000Z', pYesBp: 6300 },
      ]),
    ).toEqual([
      { t: BASE, bp: 6100 },
      { t: BASE + 60 * MINUTE, bp: 6300 },
    ]);
  });
});

describe('chartGeometry', () => {
  it('emits a well-formed step-after path at every series size', () => {
    const flat = Array.from({ length: 20 }, (_, i) => point(i, 6300));
    for (const points of [series(1), series(2), series(500), flat]) {
      const geometry = chartGeometry(points);
      const size = String(points.length);
      // SVG silently discards a whole `d` that carries one, so the chart would go blank.
      expect(geometry.line, size).not.toMatch(/NaN|Infinity/);
      expect(geometry.area, size).not.toMatch(/NaN|Infinity/);
      // The first point is on the left edge; the newest price is held to the right one.
      expect(geometry.line.startsWith('M0,'), size).toBe(true);
      expect(geometry.line.endsWith(`H${String(CHART_VIEWBOX.w)}`), size).toBe(true);
      expect(geometry.area.endsWith(`V${String(CHART_VIEWBOX.h)} H0 Z`), size).toBe(true);
      // Two decimals everywhere, so the server and the browser emit the same bytes.
      expect(Math.max(...decimals(geometry.line)), size).toBeLessThanOrEqual(2);
      expect(Math.max(...decimals(geometry.area)), size).toBeLessThanOrEqual(2);
      expect(geometry.at, size).toHaveLength(points.length);
    }
  });

  it('draws nothing at all for an empty series', () => {
    const geometry = chartGeometry([]);
    expect(geometry.line).toBe('');
    expect(geometry.area).toBe('');
    expect(geometry.at).toEqual([]);
    expect(geometry.domain.hi - geometry.domain.lo).toBe(CHART_MIN_SPAN_BP);
  });

  it('scales x by time, never by index', () => {
    // listTicks anchors its downsample stride at the newest row (A-M3-25), so the points it
    // returns are not evenly spaced; index scaling would put these three at 0, 0.5 and 1.
    const geometry = chartGeometry([point(0, 6000), point(1, 6100), point(100, 6200)]);
    expect(geometry.at.map((cell) => cell.x)).toEqual([0, 0.01, 1]);
  });

  it('holds one price across the full width when the series has no time span', () => {
    // A market opened a moment ago has exactly one `open` tick, and a burst of trades can share
    // a millisecond. Every x is then 0 and the trailing H1000 draws the flat hold — never NaN.
    for (const points of [[point(0, 6300)], [point(0, 6300), point(0, 6400), point(0, 6200)]]) {
      const geometry = chartGeometry(points);
      expect(geometry.at.every((cell) => cell.x === 0)).toBe(true);
      expect(geometry.line).not.toMatch(/NaN|Infinity/);
      expect(geometry.line.endsWith('H1000')).toBe(true);
    }
  });

  it('inverts y and keeps both extremes inside the padded box', () => {
    const ys = chartGeometry([point(0, 0), point(1, 5000), point(2, BP_MAX)]).at.map(
      (cell) => cell.y,
    );
    // A higher probability is a smaller y, so an ascending series descends the box.
    expect([...ys].sort((a, b) => b - a)).toEqual(ys);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(CHART_PAD);
      expect(y).toBeLessThanOrEqual(1 - CHART_PAD);
    }
  });

  it('never writes NaN or Infinity into a path, whatever the series', () => {
    fc.assert(
      fc.property(anySeries, (points) => {
        const geometry = chartGeometry(points);
        return !/NaN|Infinity/.test(geometry.line) && !/NaN|Infinity/.test(geometry.area);
      }),
      { numRuns: 1000 },
    );
  });

  it('emits byte-identical paths whatever zone the machine is in', () => {
    // The SSR/CSR-identity proxy: a locale or zone leak here is a hydration mismatch and a
    // repaint of the page AC 2 measures.
    const ticks = [
      { ts: '2026-09-07T00:00:00.000Z', pYesBp: 6100 },
      { ts: '2026-09-07T04:30:00.000Z', pYesBp: 6633 },
      { ts: '2026-09-07T09:15:30.500Z', pYesBp: 5977 },
    ];
    const paths = new Set<string>();
    for (const tz of ['UTC', 'Asia/Seoul', 'America/New_York']) {
      process.env.TZ = tz;
      const points = extendToNow(toChartPoints(ticks), Date.parse('2026-09-07T12:00:00Z'), 6000);
      const geometry = chartGeometry(points);
      paths.add(`${geometry.line}|${geometry.area}`);
    }
    expect(paths.size).toBe(1);
  });
});

describe('chartDomain', () => {
  it('widens a narrow span to exactly the floor, centred on the data', () => {
    // 61% -> 66% must not read as a flat line, and a 0.2%p ripple must not read as a crash.
    expect(chartDomain([point(0, 6100), point(1, 6600)])).toMatchObject({ lo: 5850, hi: 6850 });
    expect(chartDomain([point(0, 6290), point(1, 6310)])).toMatchObject({ lo: 5800, hi: 6800 });
  });

  it('leaves a span wider than the floor alone', () => {
    expect(chartDomain([point(0, 0), point(1, BP_MAX)])).toMatchObject({ lo: 0, hi: BP_MAX });
  });

  it('slides the window back inside the axis rather than squashing it', () => {
    expect(chartDomain([point(0, 0), point(1, 100)])).toMatchObject({ lo: 0, hi: 1000 });
    expect(chartDomain([point(0, 9950), point(1, BP_MAX)])).toMatchObject({
      lo: 9000,
      hi: BP_MAX,
    });
  });

  it('reports the points own time span', () => {
    expect(chartDomain([point(5, 6000), point(0, 6100)])).toMatchObject({
      t0: BASE,
      t1: BASE + 5 * MINUTE,
    });
  });

  it('never leaves the axis and never collapses, for any series', () => {
    fc.assert(
      fc.property(anySeries, (points) => {
        const domain = chartDomain(points);
        // The floor is what makes the y divide-by-zero structurally impossible.
        return domain.lo >= 0 && domain.hi <= BP_MAX && domain.hi - domain.lo >= CHART_MIN_SPAN_BP;
      }),
      { numRuns: 1000 },
    );
  });
});

describe('extendToNow', () => {
  it('holds the live probability out to the right edge', () => {
    const points = [point(0, 6000), point(10, 6100)];
    expect(extendToNow(points, BASE + 20 * MINUTE, 6200)).toEqual([
      ...points,
      { t: BASE + 20 * MINUTE, bp: 6200 },
    ]);
  });

  it('ignores an instant at or before the newest point, and never reorders', () => {
    // The server's window end lags a tick that has just arrived over the socket, and a browser
    // clock can simply be wrong; either way a segment running backwards folds the curve.
    const points = [point(0, 6000), point(10, 6100)];
    expect(extendToNow(points, BASE + 5 * MINUTE, 6200)).toEqual(points);
    expect(extendToNow(points, BASE + 10 * MINUTE, 6200)).toEqual(points);
    expect(extendToNow(points, Number.NaN, 6200)).toEqual(points);
    const xs = chartGeometry(extendToNow(points, BASE - MINUTE, 6200)).at.map((cell) => cell.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('leaves an empty series empty, so the empty state still renders', () => {
    expect(extendToNow([], BASE, 6300)).toEqual([]);
  });

  it('never mutates its input', () => {
    const points = [point(0, 6000)];
    extendToNow(points, BASE + MINUTE, 6100);
    expect(points).toEqual([point(0, 6000)]);
  });
});

describe('nearestIndex', () => {
  const points = [point(0, 6000), point(10, 6100), point(20, 6200)];

  it('finds the point under an exact position', () => {
    expect(nearestIndex(points, 0)).toBe(0);
    expect(nearestIndex(points, 0.5)).toBe(1);
    expect(nearestIndex(points, 1)).toBe(2);
  });

  it('clamps a position outside the box to an end', () => {
    expect(nearestIndex(points, -3)).toBe(0);
    expect(nearestIndex(points, 4)).toBe(2);
    expect(nearestIndex(points, Number.NaN)).toBe(0);
  });

  it('resolves a tie to the earlier point', () => {
    expect(nearestIndex(points, 0.25)).toBe(0);
    expect(nearestIndex(points, 0.75)).toBe(1);
  });

  it('has nothing to point at in an empty series', () => {
    expect(nearestIndex([], 0.5)).toBe(-1);
  });
});

describe('axisLabels', () => {
  it('names the top, middle and bottom of the floating window', () => {
    // Mandatory, not decorative: the window floats, so an unlabelled axis would be a lie.
    const rows = axisLabels(chartDomain([point(0, 6100), point(1, 6600)]));
    expect(rows.map((row) => row.bp)).toEqual([6850, 6350, 5850]);
    expect(rows[0]?.y).toBeCloseTo(CHART_PAD, 4);
    expect(rows[1]?.y).toBeCloseTo(0.5, 4);
    expect(rows[2]?.y).toBeCloseTo(1 - CHART_PAD, 4);
  });
});

describe('chartSummary', () => {
  const labels = { start: '시작', high: '최고', low: '최저', current: '현재' };

  it('reads the whole series as one sentence', () => {
    const points = [point(0, 6100), point(1, 6600), point(2, 6000), point(3, 6300)];
    expect(chartSummary(points, labels)).toBe('시작 61%, 최고 66%, 최저 60%, 현재 63%');
    expect(chartExtent(points)).toEqual({ first: 6100, min: 6000, max: 6600, last: 6300 });
  });

  it('says nothing about an empty series', () => {
    expect(chartSummary([], labels)).toBe('');
    expect(chartExtent([])).toBeUndefined();
  });
});

describe('sampleForTable', () => {
  it('caps the screen-reader table while keeping both ends', () => {
    const points = series(500);
    const rows = sampleForTable(points, 12);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual(points[0]);
    expect(rows[11]).toEqual(points[499]);
    // Evenly spaced through the series, not just the first twelve rows.
    expect(new Set(rows.map((row) => row.t)).size).toBe(12);
  });

  it('returns a short series unchanged, without handing back the caller array', () => {
    const points = series(3);
    const rows = sampleForTable(points, 12);
    expect(rows).toEqual(points);
    expect(rows).not.toBe(points);
  });

  it('keeps the newest reading when there is room for one row', () => {
    const points = series(5);
    expect(sampleForTable(points, 1)).toEqual([points[4]]);
    expect(sampleForTable(points, 0)).toEqual([]);
  });
});

describe('withLiveEdge', () => {
  it('replaces the newest level and moves no instant', () => {
    // The row is a trade ahead of the series, so its probability IS the newest reading — but
    // the instant stays the server's, because only the level is known to be newer.
    const points = [point(0, 6000), point(10, 6100)];
    expect(withLiveEdge(points, 6300)).toEqual([point(0, 6000), point(10, 6300)]);
  });

  it('leaves an empty series empty, so the empty state still renders', () => {
    // The same rule `extendToNow` states: a synthesised point would replace 아직 확률 기록이
    // 없습니다 with a line drawn from nothing.
    expect(withLiveEdge([], 6300)).toEqual([]);
  });

  it('refuses a level it cannot plot rather than writing a NaN into the path', () => {
    const points = [point(0, 6000)];
    expect(withLiveEdge(points, Number.NaN)).toEqual(points);
    expect(withLiveEdge(points, Number.POSITIVE_INFINITY)).toEqual(points);
  });

  it('costs nothing once the line already ends on that level', () => {
    // The ordinary path: the socket wrote the tick, so the edge already carries it and this is
    // a rewrite to the same value.
    const points = [point(0, 6000), point(10, 6300)];
    expect(withLiveEdge(points, 6300)).toEqual(points);
  });

  it('keeps the shape and reports the level as the newest reading', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: BP_MAX - 1 }), { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 1, max: BP_MAX - 1 }),
        (levels, bp) => {
          const series = levels.map((level, index) => point(index, level));
          const edged = withLiveEdge(series, bp);
          expect(edged).toHaveLength(series.length);
          expect(edged.map((p) => p.t)).toEqual(series.map((p) => p.t));
          expect(edged.at(-1)?.bp).toBe(bp);
        },
      ),
    );
  });
});

describe('readoutIndex', () => {
  it('resolves a held index against the series that is on screen NOW', () => {
    // THE HAZARD: `['ticks', id, range]` is a ROLLING window — the client sends a duration and
    // the server closes it on its own clock — and the sampler keeps only the boundaries whose
    // value changed plus the ends. So the SAME range answers FEWER points as old changes slide
    // off the left edge, on any focus refetch past the 30s staleTime. A readout parked at the
    // right edge (where the keyboard enters) then pointed past the end and both the reading and
    // the crosshair vanished with nothing said.
    expect(readoutIndex(212, 182)).toBe(181);
    expect(readoutIndex(217, 218)).toBe(217);
  });

  it('never invents a selection the reader did not make', () => {
    // `null` is "nothing selected" and must stay that; a negative is the same statement. Lifting
    // either to 0 would draw a crosshair on the oldest point of a chart nobody pointed at.
    expect(readoutIndex(null, 182)).toBe(-1);
    expect(readoutIndex(-1, 182)).toBe(-1);
    expect(readoutIndex(5, 0)).toBe(-1);
  });

  it('always lands inside the series, for any index and any length', () => {
    fc.assert(
      fc.property(fc.nat({ max: 10_000 }), fc.integer({ min: 1, max: 5_000 }), (held, length) => {
        const index = readoutIndex(held, length);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(length);
      }),
    );
  });
});

describe('readoutMove', () => {
  it('clamps a stale index BEFORE stepping it, which is the whole repair', () => {
    // THE REGRESSION: the component computed `current - 1` from the index it was still holding,
    // so after a 218 -> 182 shrink ArrowLeft walked 211, 210, 209 … — 31 presses that each moved
    // a number the series no longer had and left the readout blank. Clamping first means one
    // press moves one point, from the right edge where the readout actually is.
    expect(readoutMove('ArrowLeft', 212, 182)).toEqual({ kind: 'move', index: 180 });
    expect(readoutMove('ArrowLeft', 0, 182)).toEqual({ kind: 'move', index: 0 });
  });

  it('recovers in one press on every other handled key, as it always did', () => {
    // These three already clamped, which is why only ArrowLeft showed the symptom — worth
    // pinning so the repair cannot regress them into the same walk.
    expect(readoutMove('ArrowRight', 212, 182)).toEqual({ kind: 'move', index: 181 });
    expect(readoutMove('End', 212, 182)).toEqual({ kind: 'move', index: 181 });
    expect(readoutMove('Home', 212, 182)).toEqual({ kind: 'move', index: 0 });
    expect(readoutMove('Escape', 212, 182)).toEqual({ kind: 'clear' });
  });

  it('enters at the right edge, and cannot overshoot it', () => {
    expect(readoutMove('ArrowLeft', null, 182)).toEqual({ kind: 'move', index: 180 });
    expect(readoutMove('ArrowRight', null, 182)).toEqual({ kind: 'move', index: 181 });
  });

  it('leaves an unhandled key, and an empty series, to the page', () => {
    // The empty case must answer `ignore` rather than clamp to -1: -1 LATCHES in state and kills
    // the readout for the rest of the mount even once the series arrives, and the arrow keys
    // have to keep scrolling the page while there is nothing to move through.
    expect(readoutMove('a', 5, 182)).toEqual({ kind: 'ignore' });
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape']) {
      expect(readoutMove(key, 3, 0), key).toEqual({ kind: 'ignore' });
    }
  });
});
