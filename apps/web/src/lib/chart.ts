import { BP_MAX } from '@buddha/shared';

/**
 * SVG geometry for the probability chart (PLAN 11.4). Presentation only: prices arrive as the
 * stored ticks' `pYesBp` (0..10000) and are never recomputed here (PLAN 11.5).
 *
 * Everything is laid out in a fixed 1000x300 user-space box that the browser stretches
 * (`preserveAspectRatio="none"` + `vector-effect="non-scaling-stroke"`), so nothing measures
 * the DOM: the same markup is correct on the server, at 375px and at 1280px. Two rules keep
 * the server's and the browser's `d` strings byte-identical — which is what stops React from
 * reporting a hydration mismatch and repainting the very page AC 2 measures. First, every
 * instant is a parameter; there is no `Date.now()`, no `new Date()` and no `Math.random()` in
 * this module (the repo's idiom, `isClosingSoon(market, now)`). Second, every emitted
 * coordinate is rounded, so no float tail can differ between two runtimes. For the same
 * reason there is no `Intl`, no date formatting and no locale-dependent conversion here.
 *
 * The output must also never contain `NaN` or `Infinity`: SVG silently discards a whole path
 * that carries one, so the chart would go blank with no error. Every division below is either
 * structurally safe (the y span has a floor) or passes through `clamp01`, which maps `NaN` to
 * 0 rather than letting it reach a path string.
 */

/** The user-space box every path is drawn in; the browser scales it to the rendered size. */
export const CHART_VIEWBOX = { w: 1000, h: 300 } as const;

/**
 * Smallest y span the axis may show, in basis points (10 percentage points). A-M4-1: neither
 * a fixed 0..100% axis (a 61%->66% market would be a flat line at mid-height) nor a free
 * min/max fit (a 0.2%p ripple would fill the frame and read as a crash, against PLAN 11.1-5).
 */
export const CHART_MIN_SPAN_BP = 1000;

/** Fraction of the box height kept clear above and below the curve, so the stroke never clips. */
export const CHART_PAD = 0.06;

/**
 * The two fields geometry needs from a price tick, structurally: both the generated client's
 * `PriceTick` and the shared schema's satisfy it, and neither has to be imported here — the
 * idiom of `isClosingSoon(market, now)` in market-admin.ts.
 */
export interface ChartTick {
  readonly ts: string;
  readonly pYesBp: number;
}

/** One plotted sample: an epoch-millisecond instant and a probability in basis points. */
export interface ChartPoint {
  readonly t: number;
  readonly bp: number;
}

/** The window the axes describe. `hi - lo >= CHART_MIN_SPAN_BP` always. */
export interface ChartDomain {
  readonly t0: number;
  readonly t1: number;
  readonly lo: number;
  readonly hi: number;
}

/** A point's position as fractions of the box (0..1), for HTML overlays. */
export interface ChartFraction {
  readonly x: number;
  readonly y: number;
}

export interface ChartGeometry {
  /**
   * The step-after line through the recorded points, from the first one (not the left edge: the
   * window before the first fill is empty, ADR-0135 결정 1의 6) to the last fill; `''` when it
   * has no length — no fill, one fill, or a last fill older than the window (ADR-0139).
   */
  readonly solid: string;
  /**
   * The last fill's level held from it — or from the window's start when it is older — to the
   * window's end: the 무거래 구간 after the last fill (ADR-0135 C3), drawn faint and dashed;
   * `''` when nothing is left of the window after it.
   */
  readonly dotted: string;
  /** `solid` closed to the baseline, for the flat fill; `''` when `solid` is. */
  readonly area: string;
  /** The last fill's position, or null when it is outside the window (or there is none). */
  readonly dot: ChartFraction | null;
  /**
   * One entry per point, as fractions of the box. The hover dot, the crosshair and the tooltip
   * are HTML positioned with these, never SVG children: `preserveAspectRatio="none"` distorts
   * anything drawn inside the box, so a circle would be an ellipse and text would be sheared.
   */
  readonly at: readonly ChartFraction[];
  readonly domain: ChartDomain;
}

/** Where `chartGeometry` closes the lines; each defaults from the points (`chartLayout`). */
export interface ChartGeometryOptions {
  /** The window the axes describe; the points' own span when absent. */
  readonly domain?: ChartDomain;
  /** The last fill's instant, which may precede the window; the last point's when absent. */
  readonly lastFillT?: number;
  /** The window's end, where the dotted hold stops; `domain.t1` when absent. */
  readonly end?: number;
}

/** One gridline: where it sits in the box, and the probability it names. */
export interface ChartAxisLabel {
  readonly y: number;
  readonly bp: number;
}

/** The four readings a screen-reader summary quotes. */
export interface ChartExtent {
  readonly first: number;
  readonly min: number;
  readonly max: number;
  readonly last: number;
}

/** The four words `chartSummary` joins its numbers with; they come from `copy` at the call site. */
export interface ChartSummaryLabels {
  readonly start: string;
  readonly high: string;
  readonly low: string;
  readonly current: string;
}

/** Two decimals in the 1000x300 box is finer than a device pixel at every width we render at. */
const PATH_DP = 2;
/** Four decimals on a 0..1 fraction is the same precision expressed as a percentage. */
const FRACTION_DP = 4;

function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/** A coordinate as it is written into a path string. `-0` stringifies as `0`, so signs are stable. */
function coord(value: number): string {
  return String(round(value, PATH_DP));
}

/**
 * Clamps into 0..1, and — the part that matters — maps `NaN` to 0 rather than passing it on:
 * `!(n > 0)` is false only for a real positive number, so this is the single guard that makes
 * a `NaN` in a path string structurally impossible.
 */
function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}

/**
 * The wire rows as plottable points. A row whose `ts` this runtime cannot parse, or whose
 * probability is not finite, is dropped rather than carried into the path as a `NaN`.
 * `Date.parse` of an ISO-8601 instant does not depend on the machine's zone, so this is
 * deterministic on both sides of the render.
 */
export function toChartPoints(ticks: readonly ChartTick[]): ChartPoint[] {
  const points: ChartPoint[] = [];
  for (const tick of ticks) {
    const t = Date.parse(tick.ts);
    if (!Number.isFinite(t) || !Number.isFinite(tick.pYesBp)) continue;
    points.push({ t, bp: tick.pYesBp });
  }
  return points;
}

/**
 * The series fields the chart reads, structurally (the cached `PriceSeries`): its window, the
 * trade count it was read at, and its points — a point the socket drew carries its trade count.
 */
export interface ChartSeries {
  readonly from: string;
  readonly to: string;
  readonly tradeCount: number;
  readonly points: readonly (ChartTick & { readonly tradeCount?: number })[];
}

/** The market row's last fill, read ONCE beside its trade count (`ProbabilityChart`). */
export interface ChartRow {
  /** `lastPrice` in basis points, or null before the first fill. */
  readonly bp: number | null;
  readonly lastFillAt: string | null;
  readonly tradeCount: number;
}

/**
 * The last fill as the chart places it (#64, ADR-0139): the row's `(lastFillAt, lastPrice)`
 * when the row knows every trade the series does — `joinMarket` keeps it newest, and the series
 * answer pins its own steps on grid boundaries, not on the fill's instant — and otherwise the
 * series' last point the socket drew (a tick that reached the series before the row's first
 * answer), or its last point at all. Null when there is no fill. An equal count is the same
 * fills: the route reads the counter and the points in one snapshot (`listTicks`).
 *
 * On a closed window (`closed`, `isClosedWindow`) a row fill past `to` is ignored: no fill can
 * join a window that trading has left. It replaces `rowSupersedesSeries`/`withLiveEdge`.
 */
export function lastFill(series: ChartSeries, row: ChartRow, closed: boolean): ChartPoint | null {
  const toMs = Date.parse(series.to);
  const rowT = row.lastFillAt === null ? Number.NaN : Date.parse(row.lastFillAt);
  const rowUsable =
    row.bp !== null && Number.isFinite(row.bp) && Number.isFinite(rowT) && !(closed && rowT > toMs);
  // A count that is not an integer (an older API's series) cannot order the two; the row wins.
  const rowCurrent =
    !(Number.isInteger(row.tradeCount) && Number.isInteger(series.tradeCount)) ||
    row.tradeCount >= series.tradeCount;
  if (rowCurrent && rowUsable && row.bp !== null) return { t: rowT, bp: row.bp };
  // The socket's last point, else the last point at all.
  let live: ChartPoint | undefined;
  let any: ChartPoint | undefined;
  for (const tick of series.points) {
    const [point] = toChartPoints([tick]);
    if (point === undefined || (closed && point.t > toMs)) continue;
    any = point;
    if (tick.tradeCount !== undefined) live = point;
  }
  return live ?? any ?? null;
}

/**
 * The points the chart RECORDS — what its readout, its table and its summary read (ADR-0139):
 * the series' points before the last fill, then the last fill. The answer's grid places a step
 * on the next boundary (up to one stride late) and on its own window end (`rn = cnt`), so every
 * point at or after the last fill is dropped, as `pushPoint` trims. A last fill older than the
 * window's start leaves the value in force there, at `fromMs`, and nothing else. The dotted end
 * of the line is no point: nothing was recorded there.
 */
export function recordedPoints(
  points: readonly ChartPoint[],
  fill: ChartPoint | null,
  fromMs: number,
): ChartPoint[] {
  if (fill === null) return [];
  if (fill.t < fromMs) return [{ t: fromMs, bp: fill.bp }];
  return [...points.filter((point) => point.t < fill.t), fill];
}

/** What `ProbabilityChart` draws: the recorded points, the last fill and the geometry. */
export interface ChartLayout {
  readonly points: readonly ChartPoint[];
  readonly lastFill: ChartPoint | null;
  readonly geometry: ChartGeometry;
}

/**
 * One series and one row as the chart lays them out (#64, ADR-0139). The x axis is the window,
 * `[from, end]`: before the first fill it is empty (ADR-0135 결정 1의 6). `end` is the series'
 * `to` on a closed window — the end of trading, and nothing after it is drawn — and on an open
 * one the latest of `to`, the socket's last point and the last fill, so a live trade never
 * lands past the right edge. Both instants are the server's: no clock is read here.
 */
export function chartLayout(series: ChartSeries, row: ChartRow, closed: boolean): ChartLayout {
  const toMs = Date.parse(series.to);
  const all = toChartPoints(series.points);
  const kept = closed ? all.filter((point) => !(point.t > toMs)) : all;
  const fill = lastFill(series, row, closed);
  const fromMs = Date.parse(series.from);
  const points = recordedPoints(kept, fill, fromMs);
  let end = toMs;
  if (!closed) {
    for (const t of [kept.at(-1)?.t, fill?.t]) {
      if (t !== undefined && !(t <= end)) end = t;
    }
  }
  const window =
    Number.isFinite(fromMs) && Number.isFinite(end) && fromMs <= end
      ? { t0: fromMs, t1: end }
      : undefined;
  const domain = chartDomain(points, window);
  const geometry = chartGeometry(points, { domain, lastFillT: fill?.t, end: domain.t1 });
  return { points, lastFill: fill, geometry };
}

/**
 * The window the axes describe: the given time window — the series' own, `chartLayout` — or else
 * the points' own time span, and their probability span widened to at least `CHART_MIN_SPAN_BP`
 * (A-M4-1).
 *
 * At the 0 and 10000 edges the widened window slides back inside rather than being squashed,
 * so `hi - lo` stays at the floor whatever the data. That is why `yFraction` cannot divide by
 * zero, and why the flat-series special case both designs needed does not exist here. Because
 * the window floats, the text labels from `axisLabels` are mandatory, not decorative.
 */
export function chartDomain(
  points: readonly ChartPoint[],
  window?: { readonly t0: number; readonly t1: number },
): ChartDomain {
  const first = points[0];
  if (first === undefined) {
    return { t0: window?.t0 ?? 0, t1: window?.t1 ?? 0, lo: 0, hi: CHART_MIN_SPAN_BP };
  }
  let lo = first.bp;
  let hi = first.bp;
  let t0 = first.t;
  let t1 = first.t;
  for (const point of points) {
    if (point.bp < lo) lo = point.bp;
    if (point.bp > hi) hi = point.bp;
    if (point.t < t0) t0 = point.t;
    if (point.t > t1) t1 = point.t;
  }
  const grow = (CHART_MIN_SPAN_BP - (hi - lo)) / 2;
  if (grow > 0) {
    lo -= grow;
    hi += grow;
  }
  if (lo < 0) {
    hi -= lo;
    lo = 0;
  }
  if (hi > BP_MAX) {
    lo -= hi - BP_MAX;
    hi = BP_MAX;
  }
  return { t0: window?.t0 ?? t0, t1: window?.t1 ?? t1, lo: lo < 0 ? 0 : lo, hi };
}

/**
 * x is time-scaled, never index-scaled: `listTicks` anchors its downsample stride at the newest
 * row (A-M3-25), so the points it returns are not evenly spaced in time and index spacing would
 * misrepresent the history for free. A window with no span (a series' own span of one fill, or
 * a burst of fills inside one millisecond) puts every x at 0 rather than at NaN.
 */
function xFraction(t: number, domain: ChartDomain): number {
  return clamp01((t - domain.t0) / (domain.t1 - domain.t0));
}

/** y grows downwards in SVG, so a higher probability is a smaller y. */
function yFraction(bp: number, domain: ChartDomain): number {
  const value = clamp01((bp - domain.lo) / (domain.hi - domain.lo));
  return CHART_PAD + (1 - value) * (1 - 2 * CHART_PAD);
}

/**
 * The lines, the fill and the overlay positions for one series (ADR-0032, ADR-0139).
 *
 * Step-after, not linear: a price does not move between fills, so a diagonal would draw a price
 * nobody traded at. `solid` starts at the first point — `M<x0>,y0`, not the left edge: the
 * window before the first fill is empty — then `H<x> V<y>` per later point, and ends at the last
 * one, the last fill. From there `dotted` holds that level to the window's end, starting at the
 * window's start when the fill is older than it; the area fills under `solid` only.
 */
export function chartGeometry(
  points: readonly ChartPoint[],
  options: ChartGeometryOptions = {},
): ChartGeometry {
  const domain = options.domain ?? chartDomain(points);
  const at: ChartFraction[] = points.map((point) => ({
    x: round(xFraction(point.t, domain), FRACTION_DP),
    y: round(yFraction(point.bp, domain), FRACTION_DP),
  }));
  const first = at[0];
  const last = at.at(-1);
  const lastPoint = points.at(-1);
  // Empty `d` strings rather than a lone moveto, which some renderers still paint as a dot.
  if (first === undefined || last === undefined || lastPoint === undefined) {
    return { solid: '', dotted: '', area: '', dot: null, at, domain };
  }
  const { w, h } = CHART_VIEWBOX;
  let solid = '';
  if (at.length > 1) {
    solid = `M${coord(first.x * w)},${coord(first.y * h)}`;
    for (const cell of at.slice(1)) {
      solid += ` H${coord(cell.x * w)} V${coord(cell.y * h)}`;
    }
  }
  // The outline closed down to the baseline and back, so the fill is one path with no seam.
  const area = solid === '' ? '' : `${solid} V${String(h)} H${coord(first.x * w)} Z`;
  const lastFillT = options.lastFillT ?? lastPoint.t;
  const end = options.end ?? domain.t1;
  // Decided on the unrounded fractions, so a fill seconds before the window's end still has its
  // hold — a path too short to see — and written rounded, as every other coordinate.
  const holdFrom = xFraction(Math.max(lastFillT, domain.t0), domain);
  const holdTo = xFraction(end, domain);
  const holdX = (fraction: number): string => coord(round(fraction, FRACTION_DP) * w);
  const dotted =
    holdTo > holdFrom ? `M${holdX(holdFrom)},${coord(last.y * h)} H${holdX(holdTo)}` : '';
  const inWindow = lastFillT >= domain.t0 && lastFillT <= domain.t1;
  const dot = inWindow ? { x: round(xFraction(lastFillT, domain), FRACTION_DP), y: last.y } : null;
  return { solid, dotted, area, dot, at, domain };
}

/**
 * Index of the point nearest `xFraction` (0..1) — what a pointer position or an arrow key
 * resolves to. Binary search over the instants, which the API returns ascending; `-1` when
 * there is nothing to point at. A tie goes to the earlier point, so crossing a gap left and
 * right lands on the same pair of points either way.
 */
export function nearestIndex(
  points: readonly ChartPoint[],
  xFraction: number,
  domain: ChartDomain = chartDomain(points),
): number {
  if (points.length === 0) return -1;
  const target = domain.t0 + clamp01(xFraction) * (domain.t1 - domain.t0);
  // Every index below is in range; the fallback only satisfies noUncheckedIndexedAccess.
  const timeAt = (index: number): number => points[index]?.t ?? domain.t1;
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (timeAt(mid) < target) low = mid + 1;
    else high = mid;
  }
  if (low === 0) return 0;
  return target - timeAt(low - 1) <= timeAt(low) - target ? low - 1 : low;
}

/**
 * The three gridlines for the current window, top to bottom. They are text, not decoration:
 * the y window floats, so an unlabelled axis would be a lie. Each sits on a whole percent
 * (ADR-0139) — the highest and the lowest inside the window and the one nearest their middle —
 * and the line is drawn where that value is, so the label and its line agree.
 */
export function axisLabels(domain: ChartDomain): readonly ChartAxisLabel[] {
  const top = Math.floor(domain.hi / 100) * 100;
  const bottom = Math.ceil(domain.lo / 100) * 100;
  const mid = Math.round((top + bottom) / 200) * 100;
  return [top, mid, bottom].map((bp) => ({
    y: round(yFraction(bp, domain), FRACTION_DP),
    bp,
  }));
}

/** The four readings a summary quotes; `undefined` when there is nothing to summarise. */
export function chartExtent(points: readonly ChartPoint[]): ChartExtent | undefined {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return undefined;
  let min = first.bp;
  let max = first.bp;
  for (const point of points) {
    if (point.bp < min) min = point.bp;
    if (point.bp > max) max = point.bp;
  }
  return { first: first.bp, min, max, last: last.bp };
}

/**
 * The chart's number: a whole percent, 6300 → '63%' (ADR-0135 결과 4, ADR-0139) — its axis, its
 * readout, its table and its summary. The fills are whole percents.
 */
export function formatChartPct(bp: number): string {
  return `${String(Math.round(bp / 100))}%`;
}

const percent = formatChartPct;

/**
 * One sentence for the chart's accessible name — '시작 61%, 최고 66%, 최저 60%, 현재 63%' — so a
 * screen reader gets the shape of the series before the sampled table. `''` when empty.
 *
 * The four words are passed in rather than read from `copy` here: this module stays free of
 * every import that could differ between the server and the browser, and the labels are the
 * caller's copy keys anyway (`copy.chartSummaryStart` and its three siblings).
 */
export function chartSummary(points: readonly ChartPoint[], labels: ChartSummaryLabels): string {
  const extent = chartExtent(points);
  if (extent === undefined) return '';
  return [
    `${labels.start} ${percent(extent.first)}`,
    `${labels.high} ${percent(extent.max)}`,
    `${labels.low} ${percent(extent.min)}`,
    `${labels.current} ${percent(extent.last)}`,
  ].join(', ');
}

/**
 * At most `max` evenly spaced rows for the VisuallyHidden table, always including the first and
 * the last. 500 rows in the accessibility tree is worse for a screen reader than a summary plus
 * a sample; the ends are kept because they are the two readings the summary names.
 */
export function sampleForTable(points: readonly ChartPoint[], max: number): ChartPoint[] {
  if (max <= 0) return [];
  if (points.length <= max) return [...points];
  const last = points[points.length - 1];
  // One row cannot hold both ends; the newest reading is the one worth keeping.
  if (max === 1) return last === undefined ? [] : [last];
  const step = (points.length - 1) / (max - 1);
  const rows: ChartPoint[] = [];
  for (let i = 0; i < max; i++) {
    const point = points[Math.round(i * step)];
    if (point !== undefined) rows.push(point);
  }
  return rows;
}

/** What a keypress does to the readout: move it, clear it, or leave the key to the page. */
export type ReadoutMove = { kind: 'move'; index: number } | { kind: 'clear' } | { kind: 'ignore' };

/**
 * The index a held readout resolves to against the series ON SCREEN NOW, or -1 for "nothing to
 * read".
 *
 * THE HAZARD: a hover index points into an array the chart does not own. `['ticks', id, range]`
 * is a ROLLING window — `ticksQueryFor` sends a duration and the server closes it on its own
 * clock — and the sampler keeps only the boundaries whose value CHANGED plus the window's ends,
 * so the SAME range answers FEWER points as old changes slide off the left edge. A focus refetch
 * past the 30s staleTime, a reconnect resnapshot or a `market:status` restart lands it. The
 * keyboard ENTERS at the last index, so a single dropped boundary is enough to put a parked
 * readout past the end, and both the reading and the crosshair vanish with nothing said.
 *
 * Clamped at READ rather than reset in state, twice over: `set-state-in-effect` and
 * `set-state-in-render` are both errors here, and a reset would be worse than the bug — the
 * count changes by one on ordinary refetches, so it would routinely discard a still-valid
 * selection. The last index is exactly where End and ArrowRight already put the readout, so
 * clamping keeps it naming a real point instead of blanking.
 *
 * A NEGATIVE held index stays -1: it means nothing was selected, and lifting it to 0 would
 * invent a selection the reader never made.
 */
export function readoutIndex(held: number | null, length: number): number {
  if (held === null || held < 0 || length <= 0) return -1;
  return Math.min(held, length - 1);
}

/**
 * Where an arrow, Home, End or Escape moves the readout, measured against the CURRENT series.
 *
 * `held === null` enters at the right edge — the newest reading, which is the one a chart is
 * usually asked about. A held index past the end is clamped BEFORE it is stepped, and that
 * ordering is the whole point: ArrowLeft used to decrement a number the series no longer had,
 * one press at a time, so a shrink of a few dozen points left the readout blank for that many
 * dead presses. Every other handled key already recovered in one (ArrowRight and End clamp to
 * the last index, Home to 0, Escape clears), which is why only ArrowLeft showed the symptom.
 *
 * An empty series answers `ignore`, not a clamp to -1: -1 would LATCH in state and kill the
 * readout for the rest of the mount even once the series arrived, and the arrow keys must still
 * scroll the page when there is nothing to read.
 */
export function readoutMove(key: string, held: number | null, length: number): ReadoutMove {
  if (length <= 0) return { kind: 'ignore' };
  const last = length - 1;
  const current = held === null || held < 0 ? last : Math.min(held, last);
  switch (key) {
    case 'ArrowLeft':
      return { kind: 'move', index: Math.max(0, current - 1) };
    case 'ArrowRight':
      return { kind: 'move', index: Math.min(last, current + 1) };
    case 'Home':
      return { kind: 'move', index: 0 };
    case 'End':
      return { kind: 'move', index: last };
    case 'Escape':
      return { kind: 'clear' };
    default:
      return { kind: 'ignore' };
  }
}
