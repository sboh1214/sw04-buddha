import { BP_MAX } from '@buddha/shared';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CHART_MIN_SPAN_BP,
  CHART_PAD,
  CHART_VIEWBOX,
  type ChartPoint,
  type ChartRow,
  type ChartSeries,
  axisLabels,
  chartDomain,
  chartExtent,
  chartGeometry,
  chartLayout,
  chartSummary,
  formatChartPct,
  lastFill,
  nearestIndex,
  readoutIndex,
  readoutMove,
  recordedPoints,
  sampleForTable,
  toChartPoints,
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

const iso = (minutes: number): string => new Date(BASE + minutes * MINUTE).toISOString();

/** A wire point; `tradeCount` marks one the socket drew. */
const wire = (minutes: number, bp: number, tradeCount?: number) => ({
  ts: iso(minutes),
  pYesBp: bp,
  ...(tradeCount === undefined ? {} : { tradeCount }),
});

/**
 * A 100-minute window as the grid answers it: the value in force at `from` (a fill before it),
 * the step of a fill at 0:37 on the next boundary (0:40), and the window end (`rn = cnt`).
 */
const answer = (patch: Partial<ChartSeries> = {}): ChartSeries => ({
  from: iso(0),
  to: iso(100),
  tradeCount: 3,
  points: [wire(0, 6000), wire(40, 6100), wire(100, 6100)],
  ...patch,
});

const row = (minutes: number | null, bp: number | null, tradeCount = 3): ChartRow => ({
  bp,
  lastFillAt: minutes === null ? null : iso(minutes),
  tradeCount,
});

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
  it('emits a well-formed solid line, its fill and the dotted hold at every series size', () => {
    const flat = Array.from({ length: 20 }, (_, i) => point(i, 6300));
    for (const points of [series(2), series(500), flat]) {
      const last = points.at(-1)!;
      // A window wider than the points on both sides: the first fill is not on the left edge.
      const domain = chartDomain(points, { t0: BASE - 10 * MINUTE, t1: last.t + 10 * MINUTE });
      const geometry = chartGeometry(points, { domain, lastFillT: last.t });
      const size = String(points.length);
      // SVG silently discards a whole `d` that carries one, so the chart would go blank.
      for (const d of [geometry.solid, geometry.dotted, geometry.area]) {
        expect(d, size).not.toMatch(/NaN|Infinity/);
        // Two decimals everywhere, so the server and the browser emit the same bytes.
        expect(Math.max(...decimals(d)), size).toBeLessThanOrEqual(2);
      }
      // The solid line starts at the first point, not on the left edge (x0 > 0), and ends at
      // the last fill, where the dot is; the dotted hold runs from there to the window's end.
      const x0 = geometry.at[0]!.x * CHART_VIEWBOX.w;
      const xLast = geometry.at.at(-1)!.x * CHART_VIEWBOX.w;
      expect(x0, size).toBeGreaterThan(0);
      expect(geometry.solid.startsWith(`M${String(Math.round(x0 * 100) / 100)},`), size).toBe(true);
      expect(geometry.dotted.startsWith(`M${String(Math.round(xLast * 100) / 100)},`), size).toBe(
        true,
      );
      expect(geometry.dotted.endsWith(`H${String(CHART_VIEWBOX.w)}`), size).toBe(true);
      // The fill is under the solid line only, closed back at its own start.
      expect(
        geometry.area.endsWith(
          `V${String(CHART_VIEWBOX.h)} H${String(Math.round(x0 * 100) / 100)} Z`,
        ),
        size,
      ).toBe(true);
      expect(geometry.dot, size).toEqual(geometry.at.at(-1));
      expect(geometry.at, size).toHaveLength(points.length);
    }
  });

  it('draws nothing at all for an empty series', () => {
    const geometry = chartGeometry([]);
    expect(geometry.solid).toBe('');
    expect(geometry.dotted).toBe('');
    expect(geometry.area).toBe('');
    expect(geometry.dot).toBeNull();
    expect(geometry.at).toEqual([]);
    expect(geometry.domain.hi - geometry.domain.lo).toBe(CHART_MIN_SPAN_BP);
  });

  it('scales x by time, never by index', () => {
    // listTicks anchors its downsample stride at the newest row (A-M3-25), so the points it
    // returns are not evenly spaced; index scaling would put these three at 0, 0.5 and 1.
    const geometry = chartGeometry([point(0, 6000), point(1, 6100), point(100, 6200)]);
    expect(geometry.at.map((cell) => cell.x)).toEqual([0, 0.01, 1]);
  });

  it('draws one fill as a dot and a dotted hold, with no solid line and no fill', () => {
    // ADR-0135 C3 at one fill: nothing to draw a line between. A burst inside one millisecond
    // has no span either, and stays free of NaN.
    const domain = chartDomain([point(10, 6300)], { t0: BASE, t1: BASE + 100 * MINUTE });
    const one = chartGeometry([point(10, 6300)], { domain });
    expect(one.solid).toBe('');
    expect(one.area).toBe('');
    expect(one.dot?.x).toBe(0.1);
    expect(one.dotted.startsWith('M100,')).toBe(true);
    expect(one.dotted.endsWith('H1000')).toBe(true);
    // A fill 3 seconds before a day's window ends is inside the last x step (1e-4 of a day is
    // 8.64s), so both rounded ends are 1000 — the hold is decided on the unrounded fractions and
    // stays, as a path too short to see; the e2e's dotted count opens 1일 seconds after a fill.
    const day = { t0: BASE, t1: BASE + 24 * 60 * MINUTE };
    const late = [{ t: day.t1 - 3_000, bp: 6300 }];
    const fresh = chartGeometry(late, { domain: chartDomain(late, day) });
    expect(fresh.dotted).not.toBe('');
    expect(fresh.dot).not.toBeNull();
    const burst = chartGeometry([point(0, 6300), point(0, 6400), point(0, 6200)]);
    expect(burst.at.every((cell) => cell.x === 0)).toBe(true);
    expect(`${burst.solid}${burst.dotted}${burst.area}`).not.toMatch(/NaN|Infinity/);
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
      fc.property(anySeries, fc.integer(), fc.integer(), (points, a, b) => {
        const window = { t0: Math.min(a, b), t1: Math.max(a, b) };
        const own = chartGeometry(points);
        const windowed = chartGeometry(points, {
          domain: chartDomain(points, window),
          lastFillT: a,
        });
        return [own, windowed].every(
          (g) => !/NaN|Infinity/.test(`${g.solid}|${g.dotted}|${g.area}`),
        );
      }),
      { numRuns: 1000 },
    );
  });

  it('emits byte-identical paths whatever zone the machine is in', () => {
    // The SSR/CSR-identity proxy: a locale or zone leak here is a hydration mismatch and a
    // repaint of the page AC 2 measures.
    const ticks = {
      from: '2026-09-07T00:00:00.000Z',
      to: '2026-09-07T12:00:00.000Z',
      tradeCount: 3,
      points: [
        { ts: '2026-09-07T00:00:00.000Z', pYesBp: 6100 },
        { ts: '2026-09-07T04:30:00.000Z', pYesBp: 6633 },
        { ts: '2026-09-07T09:15:30.500Z', pYesBp: 5977 },
      ],
    };
    const fill = { bp: 6000, lastFillAt: '2026-09-07T09:15:30.500Z', tradeCount: 3 };
    const paths = new Set<string>();
    for (const tz of ['UTC', 'Asia/Seoul', 'America/New_York']) {
      process.env.TZ = tz;
      const { geometry } = chartLayout(ticks, fill, false);
      paths.add(`${geometry.solid}|${geometry.dotted}|${geometry.area}`);
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

  it('reports the points own time span, or the window it is given', () => {
    expect(chartDomain([point(5, 6000), point(0, 6100)])).toMatchObject({
      t0: BASE,
      t1: BASE + 5 * MINUTE,
    });
    // The series' window (ADR-0139): the x axis is the window, not the fills' span.
    const window = { t0: BASE - MINUTE, t1: BASE + 9 * MINUTE };
    expect(chartDomain([point(5, 6000), point(0, 6100)], window)).toMatchObject(window);
    expect(chartDomain([], window)).toMatchObject(window);
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

describe('chartLayout', () => {
  it('records the steps before the last fill and the last fill, never the dotted end', () => {
    // The grid stepped on 0:40 for a fill at 0:37 and pinned the window end (0:100); both are
    // at or after the fill, so both go, and the fill stands at its own instant (ADR-0139).
    const layout = chartLayout(answer(), row(37, 6100), false);
    expect(layout.lastFill).toEqual(point(37, 6100));
    expect(layout.points).toEqual([point(0, 6000), point(37, 6100)]);
    expect(layout.points.map((p) => p.t)).not.toContain(BASE + 100 * MINUTE);
    const { geometry } = layout;
    expect(geometry.domain).toMatchObject({ t0: BASE, t1: BASE + 100 * MINUTE });
    expect(geometry.dot?.x).toBe(0.37);
    expect(geometry.solid.startsWith('M0,')).toBe(true);
    expect(geometry.dotted.startsWith('M370,')).toBe(true);
    expect(geometry.dotted.endsWith('H1000')).toBe(true);
  });

  it('leaves the window before the first fill empty, and one fill a dot without a line', () => {
    // ADR-0135 결정 1의 6: no point before the first fill; the open's 50% is never one.
    const first = answer({
      tradeCount: 2,
      points: [wire(40, 6100), wire(60, 6200), wire(100, 6200)],
    });
    const two = chartLayout(first, row(57, 6200, 2), false);
    expect(two.points).toEqual([point(40, 6100), point(57, 6200)]);
    expect(two.geometry.solid.startsWith('M400,')).toBe(true);
    const single = answer({ tradeCount: 1, points: [wire(40, 6100), wire(100, 6100)] });
    const one = chartLayout(single, row(37, 6100, 1), false);
    expect(one.points).toEqual([point(37, 6100)]);
    expect(one.geometry.solid).toBe('');
    expect(one.geometry.area).toBe('');
    expect(one.geometry.dot?.x).toBe(0.37);
    expect(one.geometry.dotted).not.toBe('');
    // No fill at all: 체결 없음, nothing drawn.
    const none = chartLayout(answer({ tradeCount: 0, points: [] }), row(null, null, 0), false);
    expect(none.lastFill).toBeNull();
    expect(none.points).toEqual([]);
    expect(none.geometry).toMatchObject({ solid: '', dotted: '', area: '', dot: null });
  });

  it('dots the whole window when the last fill is older than it, with no dot', () => {
    const quiet = answer({ points: [wire(0, 6000), wire(100, 6000)] });
    const layout = chartLayout(quiet, row(-30, 6000), false);
    // The value in force at the window's start, and nothing else.
    expect(layout.points).toEqual([point(0, 6000)]);
    expect(layout.geometry.solid).toBe('');
    expect(layout.geometry.dot).toBeNull();
    expect(layout.geometry.dotted.startsWith('M0,')).toBe(true);
    expect(layout.geometry.dotted.endsWith('H1000')).toBe(true);
  });

  it('ends a closed window at its `to` and ignores anything after it', () => {
    // A market whose trading ended at 0:100 (ADR-0135 C4): neither a live point nor a row past
    // the end moves the window or the dot. The socket's point at 0:120 raised the series' count
    // to 4 (`appendTick`) while the row is a trade behind, so the series is read — and its live
    // point, past the end, is passed over for the last point inside the window.
    const ended = answer({ tradeCount: 4, points: [...answer().points, wire(120, 6500, 4)] });
    const layout = chartLayout(ended, row(37, 6100, 3), true);
    expect(layout.geometry.domain.t1).toBe(BASE + 100 * MINUTE);
    expect(layout.lastFill).toEqual(point(100, 6100));
    const late = chartLayout(answer(), row(120, 6500, 4), true);
    expect(late.geometry.domain.t1).toBe(BASE + 100 * MINUTE);
    // The row is past the end, so the series' last point stands in — here the grid's window
    // end (`rn = cnt`), not a fill's time (ADR-0139 결정 2-6의 한계).
    expect(late.lastFill).toEqual(point(100, 6100));
    // Open, the same row stretches the window to meet the fill.
    expect(chartLayout(answer(), row(120, 6500, 4), false).geometry.domain.t1).toBe(
      BASE + 120 * MINUTE,
    );
  });
});

describe('nearestIndex', () => {
  const points = [point(0, 6000), point(10, 6100), point(20, 6200)];

  it('finds the point under an exact position', () => {
    expect(nearestIndex(points, 0)).toBe(0);
    expect(nearestIndex(points, 0.5)).toBe(1);
    expect(nearestIndex(points, 1)).toBe(2);
    // On the window's axis (ADR-0139): its middle is 0:10 of a window -0:30 … 0:50.
    const domain = chartDomain(points, { t0: BASE - 30 * MINUTE, t1: BASE + 50 * MINUTE });
    expect(nearestIndex(points, 0.5, domain)).toBe(1);
    expect(nearestIndex(points, 0, domain)).toBe(0);
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
  it('names whole percents at the top, middle and bottom of the floating window', () => {
    // Mandatory, not decorative: the window floats, so an unlabelled axis would be a lie. The
    // window is 58.5%~68.5%; the labels are whole percents inside it (ADR-0139), each drawn
    // where its value is.
    const rows = axisLabels(chartDomain([point(0, 6100), point(1, 6600)]));
    expect(rows.map((row) => row.bp)).toEqual([6800, 6400, 5900]);
    expect(rows.map((row) => formatChartPct(row.bp))).toEqual(['68%', '64%', '59%']);
    expect(rows[0]?.y).toBeCloseTo(CHART_PAD + 0.05 * (1 - 2 * CHART_PAD), 4);
    expect(rows[1]?.y).toBeCloseTo(CHART_PAD + 0.45 * (1 - 2 * CHART_PAD), 4);
    expect(rows[2]?.y).toBeCloseTo(CHART_PAD + 0.95 * (1 - 2 * CHART_PAD), 4);
  });
});

describe('chartSummary', () => {
  const labels = { start: '시작', high: '최고', low: '최저', current: '현재' };

  it('reads the whole series as one sentence', () => {
    const points = [point(0, 6100), point(1, 6600), point(2, 6000), point(3, 6300)];
    expect(chartSummary(points, labels)).toBe('시작 61%, 최고 66%, 최저 60%, 현재 63%');
    expect(chartExtent(points)).toEqual({ first: 6100, min: 6000, max: 6600, last: 6300 });
    // An ended market's last word is '마지막' (ADR-0139); every number is a whole percent.
    expect(chartSummary(points, { ...labels, current: '마지막' })).toBe(
      '시작 61%, 최고 66%, 최저 60%, 마지막 63%',
    );
    expect([6300, 6349, 6350].map(formatChartPct)).toEqual(['63%', '63%', '64%']);
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

describe('lastFill', () => {
  it("takes the row's fill when the row knows every trade the series does", () => {
    expect(lastFill(answer(), row(37, 6100), false)).toEqual(point(37, 6100));
    // A row a trade ahead (a tick the series was still on its first fetch for).
    expect(lastFill(answer(), row(105, 6400, 4), false)).toEqual(point(105, 6400));
  });

  it("takes the series' live point when the series is the newer of the two", () => {
    // A tick reached the series while the row's first answer was on its way.
    const live = answer({ tradeCount: 4, points: [...answer().points, wire(103, 6400, 4)] });
    expect(lastFill(live, row(37, 6100), false)).toEqual(point(103, 6400));
    // No live point: the series' last point, which is all that is known — on the grid that is
    // the window end (`rn = cnt`) at the fill's price, not the fill's own time (ADR-0139 결정
    // 2-6의 한계).
    expect(lastFill(answer({ tradeCount: 4 }), row(37, 6100), false)).toEqual(point(100, 6100));
  });

  it('never throws out of a render for a count that is not an integer', () => {
    // The old guard's cases (`rowSupersedesSeries`): no BigInt compare here, and a count that
    // cannot order the two leaves the row's fill.
    expect(() => lastFill(answer(), row(37, 6100, Number.NaN), false)).not.toThrow();
    expect(lastFill(answer(), row(37, 6100, 42.5), false)).toEqual(point(37, 6100));
    expect(lastFill({ ...answer(), tradeCount: 1.5 }, row(37, 6100), false)).toEqual(
      point(37, 6100),
    );
  });

  it('records only what precedes the fill, and the value in force for an older one', () => {
    const points = toChartPoints(answer().points);
    expect(recordedPoints(points, point(37, 6100), BASE)).toEqual([
      point(0, 6000),
      point(37, 6100),
    ]);
    expect(recordedPoints(points, point(-30, 6000), BASE)).toEqual([point(0, 6000)]);
    expect(recordedPoints(points, null, BASE)).toEqual([]);
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
