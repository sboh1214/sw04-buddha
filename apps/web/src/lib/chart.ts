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
  /** Step-after outline for `<path d>`; `''` when there are no points. */
  readonly line: string;
  /** The same outline closed to the baseline, for the flat fill; `''` when empty. */
  readonly area: string;
  /**
   * One entry per point, as fractions of the box. The hover dot, the crosshair and the tooltip
   * are HTML positioned with these, never SVG children: `preserveAspectRatio="none"` distorts
   * anything drawn inside the box, so a circle would be an ellipse and text would be sheared.
   */
  readonly at: readonly ChartFraction[];
  readonly domain: ChartDomain;
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
 * Appends the live probability at `nowMs`, so the last fill's price visibly holds until now
 * instead of the line stopping at the newest tick.
 *
 * An empty series stays empty: the caller renders 체결 없음 on length 0 (N02 §5), and a
 * synthesised point would replace that empty state with a line drawn from nothing. An instant
 * at or before the newest point is dropped for the same reason a clock is never trusted here —
 * the server's window end can lag a tick that has just arrived over the socket, and a segment
 * running backwards would draw a fold in the curve.
 */
export function extendToNow(
  points: readonly ChartPoint[],
  nowMs: number,
  bp: number,
): ChartPoint[] {
  const last = points[points.length - 1];
  if (last === undefined) return [];
  if (!Number.isFinite(nowMs) || !Number.isFinite(bp) || nowMs <= last.t) return [...points];
  return [...points, { t: nowMs, bp }];
}

/**
 * The newest known probability AS the newest reading: the last point keeps its instant and
 * takes `bp`. Only the level moves, never the time, so the drawn shape and every hover readout
 * keep the instants the server sent.
 *
 * This is what `extendToNow` above cannot do. Its `nowMs <= last.t` test is a GEOMETRY guard —
 * a segment running backwards would draw a fold — and every bucketed answer makes it a tie,
 * because the server pins a point at its own window end (`rn = cnt`, market.service.ts). So a
 * series that is a trade behind keeps drawing the old level while the header, which reads the
 * market row, has moved. The caller decides WHETHER the row is newer, by counter
 * (`rowSupersedesSeries`, ticks.ts); this only carries out the decision.
 *
 * `withLatestSample` (market-live.ts) does the same thing to a card's sparkline and `joinMarket`
 * to the row itself — the detail chart was the one live line on the site without the treatment.
 * An empty series stays empty for the reason `extendToNow` gives, and a level that cannot be
 * plotted is refused rather than written into the path as a NaN.
 */
export function withLiveEdge(points: readonly ChartPoint[], bp: number): ChartPoint[] {
  const last = points[points.length - 1];
  if (last === undefined) return [];
  if (!Number.isFinite(bp)) return [...points];
  return [...points.slice(0, -1), { t: last.t, bp }];
}

/**
 * The window the axes describe: the points' own time span, and their probability span widened
 * to at least `CHART_MIN_SPAN_BP` (A-M4-1).
 *
 * At the 0 and 10000 edges the widened window slides back inside rather than being squashed,
 * so `hi - lo` stays at the floor whatever the data. That is why `yFraction` cannot divide by
 * zero, and why the flat-series special case both designs needed does not exist here. Because
 * the window floats, the text labels from `axisLabels` are mandatory, not decorative.
 */
export function chartDomain(points: readonly ChartPoint[]): ChartDomain {
  const first = points[0];
  if (first === undefined) return { t0: 0, t1: 0, lo: 0, hi: CHART_MIN_SPAN_BP };
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
  return { t0, t1, lo: lo < 0 ? 0 : lo, hi };
}

/**
 * x is time-scaled, never index-scaled: `listTicks` anchors its downsample stride at the newest
 * row (A-M3-25), so the points it returns are not evenly spaced in time and index spacing would
 * misrepresent the history for free. A market with one `open` tick, or a burst of trades inside
 * one millisecond, has no span at all — every x is then 0 and step-after's trailing `H1000`
 * draws a full-width flat hold, which is the honest picture of one price held across the window.
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
 * The outline, the fill and the overlay positions for one series.
 *
 * Step-after, not linear: a price does not move between fills, so a diagonal would draw a price
 * nobody traded at. The path is `M0,y0` — the first point always sits on the left
 * edge — then `H<x> V<y>` per later point, then `H<w>` to hold the newest level to the right
 * edge, which is the same segment `extendToNow` makes explicit when a live probability is known.
 */
export function chartGeometry(points: readonly ChartPoint[]): ChartGeometry {
  const domain = chartDomain(points);
  const at: ChartFraction[] = points.map((point) => ({
    x: round(xFraction(point.t, domain), FRACTION_DP),
    y: round(yFraction(point.bp, domain), FRACTION_DP),
  }));
  const first = at[0];
  // Empty `d` strings rather than a lone moveto, which some renderers still paint as a dot.
  if (first === undefined) return { line: '', area: '', at, domain };
  const { w, h } = CHART_VIEWBOX;
  let line = `M0,${coord(first.y * h)}`;
  for (const cell of at.slice(1)) {
    line += ` H${coord(cell.x * w)} V${coord(cell.y * h)}`;
  }
  line += ` H${String(w)}`;
  // The outline closed down to the baseline and back, so the fill is one path with no seam.
  const area = `${line} V${String(h)} H0 Z`;
  return { line, area, at, domain };
}

/**
 * Index of the point nearest `xFraction` (0..1) — what a pointer position or an arrow key
 * resolves to. Binary search over the instants, which the API returns ascending; `-1` when
 * there is nothing to point at. A tie goes to the earlier point, so crossing a gap left and
 * right lands on the same pair of points either way.
 */
export function nearestIndex(points: readonly ChartPoint[], xFraction: number): number {
  if (points.length === 0) return -1;
  const domain = chartDomain(points);
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
 * the y window floats, so an unlabelled axis would be a lie. The label rounds to whole basis
 * points while the line stays where the unrounded value puts it.
 */
export function axisLabels(domain: ChartDomain): readonly ChartAxisLabel[] {
  const mid = (domain.lo + domain.hi) / 2;
  return [domain.hi, mid, domain.lo].map((bp) => ({
    y: round(yFraction(bp, domain), FRACTION_DP),
    bp: Math.round(bp),
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

/** Whole percent: a screen reader reading '63.00%' four times in one sentence is worse. */
function percent(bp: number): string {
  return `${String(Math.round(bp / 100))}%`;
}

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
