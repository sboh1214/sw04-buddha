'use client';

import { Alert, Box, Button, HStack, SegmentGroup, Skeleton, Stack, Text } from '@chakra-ui/react';
import { type MarketStatus, isPreCloseMarketStatus } from '@buddha/shared';
import { useId, useRef, useState } from 'react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { ChartDataTable, LineChart } from '@/components/ui/line-chart';
import { copy } from '@/copy';
import { useMarketTicks } from '@/hooks/use-markets';
import {
  type ChartLayout,
  type ChartPoint,
  type ChartSummaryLabels,
  axisLabels,
  chartGeometry,
  chartLayout,
  chartSummary,
  formatChartPct,
  nearestIndex,
  readoutIndex,
  readoutMove,
  sampleForTable,
} from '@/lib/chart';
import { DEFAULT_TICK_RANGE, TICK_RANGES, type TickRange, isClosedWindow } from '@/lib/ticks';

/**
 * The four words the accessible summary joins its readings with (lib/chart.ts keeps `copy` out).
 * The last is '현재' while trading goes on and '마지막' after it (ADR-0139).
 */
function summaryLabels(status: MarketStatus): ChartSummaryLabels {
  return {
    start: copy.chartSummaryStart,
    high: copy.chartSummaryHigh,
    low: copy.chartSummaryLow,
    current: isPreCloseMarketStatus(status) ? copy.chartSummaryCurrent : copy.chartSummaryLast,
  };
}

/** No series yet: nothing recorded, nothing drawn. */
const EMPTY_LAYOUT: ChartLayout = { points: [], lastFill: null, geometry: chartGeometry([]) };

/**
 * 시장가격 추이 (PLAN 11.4 ProbabilityChart): the price series, a 1일/1주/전체 toggle, and a
 * readout the pointer and the keyboard both drive.
 *
 * Everything that decides a shape is imported. `lib/chart.ts` owns the geometry and the
 * screen-reader sample, `lib/ticks.ts` owns what a range asks the API for, and
 * `components/ui/line-chart.tsx` owns the one `<svg>`. What is left here is the render ladder,
 * the range state and the hover index — and the rule that no clock is read while rendering.
 *
 * The line is the recorded points — the fills, sampled on the server's grid — up to the last
 * fill, which gets a dot; from there a faint dotted hold runs to the window's end (ADR-0135 C3,
 * ADR-0139). That end is `series.to`, the instant the SERVER closed the window on its own
 * `clock_timestamp()` — the end of trading, once trading has ended — never a `Date.now()`, which
 * would move between the server's render and the browser's first one, so the two would emit
 * different `d` strings and React would throw away exactly the first paint AC 2 measures.
 *
 * The interaction layer is HTML around the svg, never inside it: the box is stretched by
 * `preserveAspectRatio="none"`, so an SVG dot would come out an ellipse. `role="application"`
 * is deliberately NOT used on the wrapper — it would suppress a screen reader's browse mode for
 * the whole subtree, which costs more than the arrow keys buy. `role="img"` with a name, a
 * described-by table and a focusable wrapper is the pattern that keeps both.
 */

/** More rows than this in the accessibility tree is worse for a screen reader than a sample. */
const TABLE_ROWS = 12;

/**
 * The strip at the box's right edge the y-axis values sit in, which the plot stops short of.
 * A value ('100%' at `xs`, with its `px="1"`) is under 40px wide, so 48px leaves the last fill's
 * 8px dot — centred on the plot's edge when the fill is seconds old — clear of it. Without the
 * strip the values, positioned and opaque (`bg="bg"`), painted over the dot and hid the dotted
 * hold under them exactly where an open market's 1일 window puts both: at the right edge, at
 * the level of the middle value, which IS the price when the window holds one.
 */
const AXIS_GUTTER = '12';

/**
 * The read point, plus WHICH input put it there. Only the keyboard's moves are announced: a
 * polite live region queues its changes instead of coalescing them, and `onPointerMove` writes a
 * new index for roughly every pixel the pointer crosses (a 1D range on a busy market carries
 * enough points to fill the ~295px plot a 375px viewport draws, one per pixel), so a single sweep
 * of the pointer buys a screen reader half a minute of timestamps it has long left behind. The
 * arrow keys move once per press, which is the rate an announcement is for.
 */
interface Readout {
  index: number;
  /** True when the last move came from `onKeyDown`; drives `aria-live` on the readout. */
  spoken: boolean;
}

/** The toggle's options. `SegmentGroup.Items` renders the hidden radio inputs the roles need. */
const RANGE_ITEMS: { value: TickRange; label: string }[] = [
  { value: '1D', label: copy.chartRangeDay },
  { value: '1W', label: copy.chartRangeWeek },
  { value: 'all', label: copy.chartRangeAll },
];

export interface ProbabilityChartProps {
  /**
   * The market's canonical lower-cased uuid. `GET /markets/:id/ticks` is guarded by
   * `uuidParamSchema` and answers 400 for a slug, so a slug-routed page passes `market.id`.
   */
  marketId: string;
  /** The market question; the chart's accessible name is built from it. */
  label: string;
  /**
   * The live last-fill price in bp, from the market cache the socket writes to, or `null` before
   * the first fill — when the series is empty too and there is no level to hold.
   */
  currentBp: number | null;
  /**
   * The trade count of the SAME row `currentBp` was read from — the two must come from one
   * read, or the chart could draw one trade's price under another's claim.
   *
   * It is what decides whether that price may overrule the series' own right edge: the row is
   * kept newest by `joinMarket`, the answer carries its own count, and a series can be a trade
   * behind for reasons no refetch closes — a range still on its first fetch when the tick
   * arrived, for one.
   */
  currentTradeCount: number;
  /** The same row's `lastFillAt`: where the last fill's dot goes (`lastFill`, chart.ts). */
  lastFillAt: string | null;
  /** The same row's status: whether the summary ends on '현재' or '마지막'. */
  status: MarketStatus;
  /**
   * The range the toggle opens on (`initialTickRange`), read once at mount: a status that
   * changes under the reader leaves the range they chose.
   */
  defaultRange?: TickRange;
  'data-testid'?: string;
}

export function ProbabilityChart({
  marketId,
  label,
  currentBp,
  currentTradeCount,
  lastFillAt,
  status,
  defaultRange = DEFAULT_TICK_RANGE,
  'data-testid': testId = 'probability-chart',
}: ProbabilityChartProps) {
  const [range, setRange] = useState<TickRange>(defaultRange);
  const [hovered, setHovered] = useState<Readout | null>(null);
  const series = useMarketTicks(marketId, range);
  const tableId = useId();
  const readoutId = useId();
  // The plot's own box, read in the pointer handler only: the hover fraction is of the plot, not
  // of the box that also holds the axis values' strip.
  const plotRef = useRef<HTMLDivElement>(null);
  // The readout is an absolute time, so it reads in the member's zone (ADR-0063).
  const formatDateTime = useFormatDateTime();

  const held = series.data;
  // The recorded points, the last fill and the three lines — one layout from the series and ONE
  // read of the row (`currentBp`, `lastFillAt`, `currentTradeCount`), so the dot can never put
  // one fill's price at another's instant.
  const layout =
    held === undefined
      ? EMPTY_LAYOUT
      : chartLayout(
          held,
          { bp: currentBp, lastFillAt, tradeCount: currentTradeCount },
          isClosedWindow(held),
        );
  const { points, geometry } = layout;
  const summary = chartSummary(points, summaryLabels(status));
  // Resolved against the series ON SCREEN NOW, never the one the index was taken from: the
  // window rolls, so the same range answers fewer points as old changes slide off the left edge
  // and a parked readout would otherwise point past the end (`readoutIndex`).
  const index = readoutIndex(hovered?.index ?? null, points.length);
  const point: ChartPoint | undefined = index < 0 ? undefined : points[index];
  const marker = index < 0 ? undefined : geometry.at[index];

  return (
    <Stack gap="2" data-testid={testId}>
      <HStack justify="flex-end">
        <SegmentGroup.Root
          size="sm"
          value={range}
          onValueChange={(details) => {
            const next = TICK_RANGES.find((candidate) => candidate === details.value);
            if (next === undefined) return;
            // The index means nothing in the next range's series; clearing it here rather than
            // in an effect keeps this component free of state that reacts to its own state.
            setHovered(null);
            setRange(next);
          }}
          aria-label={copy.chartRangeLabel}
          data-testid="chart-range"
        >
          <SegmentGroup.Indicator />
          <SegmentGroup.Items items={RANGE_ITEMS} />
        </SegmentGroup.Root>
      </HStack>

      {series.isPending ? (
        // A SIBLING skeleton, never a wrapper: `Skeleton`'s `loading` variant defaults to true,
        // so `<Skeleton>` around the chart would hide it for good.
        <Skeleton height="32" />
      ) : series.isLoadingError ? (
        <Stack gap="2" align="flex-start">
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void series.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : (
        <Stack gap="2">
          {/* A failed REFETCH keeps the series that is already drawn — the numbers on screen are
              simply the last ones that arrived, which is what the notice says. */}
          {series.isRefetchError && (
            <Alert.Root status="warning" role="status">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
          )}

          {/* Only fills are drawn (N02 §5): no open-time setting is plotted, so a market with
              no fill has no line at all. */}
          {points.length === 0 ? (
            <Text color="fg.muted" data-testid="probability-chart-empty">
              {copy.noFills}
            </Text>
          ) : (
            <Box
              position="relative"
              h={{ base: '32', md: '56' }}
              colorPalette="brand"
              // `fg` is the token whose contract is "legible ON the page" — 5.80:1 light and
              // 11.09:1 dark against `bg` — which is what a stroke that is also drawn as the
              // marker dot needs. `solid` is tuned against the label that sits on IT instead
              // (theme/system.ts), so it tracks a different background: it happens to resolve to
              // the same brand.700 in light mode and is 9.48:1 against the page in dark.
              color="colorPalette.fg"
              tabIndex={0}
              aria-describedby={readoutId}
              _focusVisible={{
                outline: '2px solid',
                outlineColor: 'colorPalette.focusRing',
                outlineOffset: '2px',
              }}
              onPointerMove={(event) => {
                // Measured once per event, never during a render: a layout read in the render
                // path is what makes a chart re-render itself into a loop. The plot's box, not
                // the wrapper's: a pointer over the axis strip is past the end and clamps there.
                const rect = (plotRef.current ?? event.currentTarget).getBoundingClientRect();
                if (rect.width === 0) return;
                setHovered({
                  index: nearestIndex(
                    points,
                    (event.clientX - rect.left) / rect.width,
                    geometry.domain,
                  ),
                  spoken: false,
                });
              }}
              onPointerLeave={() => {
                setHovered(null);
              }}
              onPointerCancel={() => {
                setHovered(null);
              }}
              onKeyDown={(event) => {
                // No arithmetic here on purpose: `readoutMove` owns every decision, so the lib
                // test binds what the keyboard actually does. It clamps a held index to the
                // CURRENT series before stepping it — without that, ArrowLeft walked a stale
                // number down one press at a time after the window rolled.
                const move = readoutMove(event.key, hovered?.index ?? null, points.length);
                // A key this chart does not handle, or no series to read: leave it to the page,
                // which is what keeps the arrows scrolling when there is nothing to move
                // through, and what stops `hovered` latching at -1 for the rest of the mount.
                if (move.kind === 'ignore') return;
                event.preventDefault();
                setHovered(move.kind === 'clear' ? null : { index: move.index, spoken: true });
              }}
            >
              {/* Gridlines and their values. The y window floats (`CHART_MIN_SPAN_BP`), so an
                  unlabelled axis would be a lie — these labels are the condition on which the
                  auto-scale is honest. Hidden from the accessibility tree because the same
                  numbers are read from the table below, in order and with their instants. */}
              <Box position="absolute" inset="0" pointerEvents="none" aria-hidden="true">
                {axisLabels(geometry.domain).map((row) => (
                  <Box
                    key={`${String(row.bp)}:${String(row.y)}`}
                    position="absolute"
                    left="0"
                    right="0"
                    top={`${String(row.y * 100)}%`}
                    borderTopWidth="1px"
                    borderColor="border"
                  >
                    <Text
                      as="span"
                      position="absolute"
                      right="0"
                      transform="translateY(-50%)"
                      px="1"
                      bg="bg"
                      fontSize="xs"
                      color="fg.muted"
                      data-testid="probability-chart-axis-label"
                    >
                      {formatChartPct(row.bp)}
                    </Text>
                  </Box>
                ))}
              </Box>

              {/* The plot: the line, the last fill's dot and the hover marker, in one box that
                  ends where the axis strip starts (`AXIS_GUTTER`), so no value covers them. */}
              <Box
                ref={plotRef}
                position="absolute"
                top="0"
                bottom="0"
                left="0"
                right={AXIS_GUTTER}
                data-testid="probability-chart-plot"
              >
                <LineChart
                  geometry={geometry}
                  // The summary comes first so a screen reader hears the shape of the series
                  // ('시작 61%, 최고 66%, 최저 60%, 현재 63%') before it reaches the sampled table.
                  label={`${copy.chartLabel} · ${label} · ${summary}`}
                  describedBy={tableId}
                  area
                  data-testid="probability-chart-svg"
                  lineTestId="probability-chart-line"
                  dottedTestId="probability-chart-dotted"
                />

                {/* The last fill (ADR-0135 C3): HTML, as the hover dot is — inside the
                    stretched box a circle would be an ellipse. None when the fill is older than
                    the window. */}
                {geometry.dot === null ? null : (
                  <Box
                    position="absolute"
                    left={`${String(geometry.dot.x * 100)}%`}
                    top={`${String(geometry.dot.y * 100)}%`}
                    w="2"
                    h="2"
                    borderRadius="full"
                    bg="colorPalette.fg"
                    transform="translate(-50%, -50%)"
                    pointerEvents="none"
                    aria-hidden="true"
                    data-testid="probability-chart-dot"
                  />
                )}

                {marker === undefined ? null : (
                  <Box
                    position="absolute"
                    left={`${String(marker.x * 100)}%`}
                    top="0"
                    bottom="0"
                    borderLeftWidth="1px"
                    borderColor="colorPalette.fg"
                    opacity="0.4"
                    pointerEvents="none"
                    aria-hidden="true"
                  >
                    <Box
                      position="absolute"
                      top={`${String(marker.y * 100)}%`}
                      w="2.5"
                      h="2.5"
                      borderRadius="full"
                      bg="colorPalette.fg"
                      transform="translate(-50%, -50%)"
                    />
                  </Box>
                )}
              </Box>
            </Box>
          )}

          {/* A caption, not a blocking alert: the series IS the newest part of the history, and
              `/ticks` truncates to the newest rows of the range with no way to ask for more. */}
          {held?.truncated === true && (
            <Text fontSize="xs" color="fg.muted">
              {copy.chartTruncated}
            </Text>
          )}
        </Stack>
      )}

      <Text
        id={readoutId}
        data-testid="chart-readout"
        // The chart's `aria-describedby` target, and — for the keyboard alone — its live region.
        // The pointer rewrites this text about once per pixel of travel and a polite region
        // queues every change it sees, so the announcement is gated on the input that wrote it:
        // an explicit `aria-live` rather than `role="status"`, because an author's `off` outranks
        // a role's implicit `polite` while the role itself cannot be silenced. `aria-atomic`
        // restores what `role="status"` implied, so one move reads as one sentence. The single
        // update that can still slip out is the first pointer move after a keypress, which
        // changes the text and the attribute in the same commit.
        aria-live={hovered?.spoken === true ? 'polite' : 'off'}
        aria-atomic="true"
        // Reserved so the layout does not jump the first time the pointer enters the chart.
        minH="5"
        fontSize="sm"
        color="fg.muted"
      >
        {point === undefined
          ? ''
          : `${formatDateTime(isoAt(point.t))} · ${formatChartPct(point.bp)}`}
      </Text>

      <ChartDataTable id={tableId} rows={sampleForTable(points, TABLE_ROWS)} />
    </Stack>
  );
}

/**
 * The plotted instant back as an ISO string for the formatter. `toISOString` throws outside the
 * ±8.64e15 ms Date range and a throw in render blanks the screen, so an impossible instant
 * answers `''` — which `formatInTimeZone` already renders as an empty cell.
 */
function isoAt(t: number): string {
  const at = new Date(t);
  return Number.isNaN(at.getTime()) ? '' : at.toISOString();
}
