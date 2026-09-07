import { VisuallyHidden } from '@chakra-ui/react';
import { copy } from '@/copy';
import { CHART_VIEWBOX, type ChartPoint, chartGeometry } from '@/lib/chart';
import { formatKst } from '@/lib/datetime';
import { formatBp } from '@/lib/market-admin';

/**
 * The chart primitive behind 확률 추이 and the card sparkline (PLAN 11.4): one `<svg>` built
 * from `lib/chart.ts` geometry, and nothing else. It carries no directive, so a server
 * component renders it straight into the HTML.
 *
 * Three properties are load-bearing here, and each one is why no chart library can take this
 * file's place.
 *
 * **Deterministic output.** Every coordinate comes from `chartGeometry`, which takes each
 * instant as data and rounds what it emits. The server and the browser therefore produce the
 * same `d` string, so the first paint AC 2 measures is never thrown away by a hydration
 * mismatch. Nothing in this file reads a clock, measures the DOM or mints an id.
 *
 * **Colour by `currentColor` only.** The wrapper sets `color="colorPalette.fg"` and Chakra's
 * `_dark` is a class on `<html>` (next-themes `attribute="class"`), so the theme resolves at
 * paint with no JS at all — no `useColorModeValue`, no `<ClientOnly>`, and so no theme flash
 * on a chart that was server-rendered. `fg`, not `solid`: `yes.solid` on white is 3.74:1,
 * while `yes.fg` is 7.73:1 (AC 6).
 *
 * **A fixed 1000x300 user space** stretched by `preserveAspectRatio="none"`, with the stroke
 * width held by `vector-effect="non-scaling-stroke"`: the same markup is correct on the
 * server, at 375px and at 1280px without measuring anything. That stretch is also why a hover
 * dot, a crosshair or a tooltip must be HTML positioned from `ChartGeometry.at` rather than an
 * SVG child — a circle drawn in this box would come out an ellipse.
 *
 * Nothing here transitions or animates, so `prefers-reduced-motion` is satisfied by
 * construction; the animated primitive next door, `RollingNumber`, carries its own
 * `_motionReduce` guard.
 */

/**
 * `overflow: visible` overrides the svg root's default `hidden`, which would slice the top half
 * of the stroke off at the domain maximum, where the curve sits exactly on the padding line.
 * `touch-action: pan-y` keeps a vertical swipe scrolling the page when the caller adds pointer
 * tracking on top; `display: block` removes the inline baseline gap under the box.
 */
const SVG_STYLE: React.CSSProperties = {
  display: 'block',
  overflow: 'visible',
  touchAction: 'pan-y',
};

/** How much of the area fill shows through. Flat, so there is no gradient `id` to keep unique. */
const AREA_OPACITY = 0.12;

export interface LineChartProps {
  points: readonly ChartPoint[];
  /**
   * Accessible name. Omit it to mark the chart decorative — a card sparkline sits beside a
   * written 확률, and announcing the shape as well would read the same market out twice.
   */
  label?: string;
  /** `id` of the description the caller renders, normally a `ChartDataTable`. */
  describedBy?: string;
  /** Fill the area under the curve. Off for sparklines, where it is noise at 20px tall. */
  area?: boolean;
  /** Stroke width in CSS px; non-scaling, so a wide box does not thicken the line. */
  strokeWidth?: number;
  'data-testid'?: string;
}

export function LineChart({
  points,
  label,
  describedBy,
  area = false,
  strokeWidth = 2,
  'data-testid': testId,
}: LineChartProps) {
  const geometry = chartGeometry(points);
  const decorative = label === undefined;
  return (
    <svg
      viewBox={`0 0 ${String(CHART_VIEWBOX.w)} ${String(CHART_VIEWBOX.h)}`}
      preserveAspectRatio="none"
      width="100%"
      height="100%"
      style={SVG_STYLE}
      role={decorative ? undefined : 'img'}
      aria-label={label}
      aria-describedby={decorative ? undefined : describedBy}
      aria-hidden={decorative || undefined}
      // Legacy IE/Edge put the svg root in the tab order; every other browser ignores this.
      focusable="false"
      data-testid={testId}
    >
      {/* An empty `d` is dropped rather than emitted: a lone moveto still paints a dot. */}
      {area && geometry.area !== '' ? (
        <path d={geometry.area} fill="currentColor" fillOpacity={AREA_OPACITY} />
      ) : null}
      {geometry.line !== '' ? (
        <path
          d={geometry.line}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}

export interface ChartDataTableProps {
  /** Wired into the chart's `describedBy`; that pairing is the whole point of the component. */
  id: string;
  /** Already thinned by `sampleForTable` — every row handed in is rendered. */
  rows: readonly ChartPoint[];
}

/**
 * The chart's non-visual equivalent: the same series as a table, off screen but in the
 * accessibility tree, so a `role="img"` name is not the only thing a screen reader gets.
 *
 * The caller thins the series first (`sampleForTable(points, 12)`): several hundred rows read
 * aloud is worse than a summary plus a sample, and the summary the chart's own label carries
 * already names the readings the ends of this table repeat. `asChild` puts the off-screen
 * styles on the `<table>` itself — a `<table>` inside `VisuallyHidden`'s default `<span>`
 * would be a phrasing element wrapping flow content.
 */
export function ChartDataTable({ id, rows }: ChartDataTableProps) {
  return (
    <VisuallyHidden asChild id={id}>
      <table>
        <caption>{copy.chartTableCaption}</caption>
        <thead>
          <tr>
            <th scope="col">{copy.chartTime}</th>
            <th scope="col">{copy.chartValue}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            // Two ticks can share a millisecond, so the instant alone is not a unique key.
            <tr key={`${String(index)}:${String(row.t)}`}>
              <td>{formatKst(isoAt(row.t))}</td>
              <td>{formatBp(row.bp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </VisuallyHidden>
  );
}

/**
 * The epoch instant back as an ISO string for `formatKst`. `toISOString` throws on an instant
 * outside the ±8.64e15 ms Date range, and a throw in render blanks the page, so the invalid
 * case returns `''` — which `formatKst` already answers with an empty cell.
 */
function isoAt(t: number): string {
  const at = new Date(t);
  return Number.isNaN(at.getTime()) ? '' : at.toISOString();
}
