'use client';

import { Alert, Box, Button, HStack, SegmentGroup, Skeleton, Stack, Text } from '@chakra-ui/react';
import { useId, useState } from 'react';
import { ChartDataTable, LineChart } from '@/components/ui/line-chart';
import { copy } from '@/copy';
import { useMarketTicks } from '@/hooks/use-markets';
import {
  type ChartPoint,
  type ChartSummaryLabels,
  axisLabels,
  chartGeometry,
  chartSummary,
  extendToNow,
  nearestIndex,
  sampleForTable,
  toChartPoints,
} from '@/lib/chart';
import { formatKst } from '@/lib/datetime';
import { formatBp } from '@/lib/market-admin';
import { DEFAULT_TICK_RANGE, TICK_RANGES, type TickRange } from '@/lib/ticks';

/** The four words the accessible summary joins its readings with (lib/chart.ts keeps `copy` out). */
const SUMMARY_LABELS: ChartSummaryLabels = {
  start: copy.chartSummaryStart,
  high: copy.chartSummaryHigh,
  low: copy.chartSummaryLow,
  current: copy.chartSummaryCurrent,
};

/**
 * 확률 추이 (PLAN 11.4 ProbabilityChart): the price series, a 1일/1주/전체 toggle, and a
 * readout the pointer and the keyboard both drive.
 *
 * Everything that decides a shape is imported. `lib/chart.ts` owns the geometry and the
 * screen-reader sample, `lib/ticks.ts` owns what a range asks the API for, and
 * `components/ui/line-chart.tsx` owns the one `<svg>`. What is left here is the render ladder,
 * the range state and the hover index — and the rule that no clock is read while rendering.
 *
 * The live edge is drawn at `Date.parse(series.to)`, the window end the SERVER closed on its
 * own `clock_timestamp()` and sent in the payload. A `Date.now()` here would move between the
 * server's render and the browser's first one, so the two would emit different `d` strings and
 * React would throw away exactly the first paint AC 2 measures.
 *
 * The interaction layer is HTML around the svg, never inside it: the box is stretched by
 * `preserveAspectRatio="none"`, so an SVG dot would come out an ellipse. `role="application"`
 * is deliberately NOT used on the wrapper — it would suppress a screen reader's browse mode for
 * the whole subtree, which costs more than the arrow keys buy. `role="img"` with a name, a
 * described-by table and a focusable wrapper is the pattern that keeps both.
 */

/** More rows than this in the accessibility tree is worse for a screen reader than a sample. */
const TABLE_ROWS = 12;

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
  /** Live probability in bp, from the market cache the socket writes to. */
  currentBp: number;
  /** The range the toggle opens on. Defaults to the one the server seeds into the cache. */
  defaultRange?: TickRange;
  'data-testid'?: string;
}

export function ProbabilityChart({
  marketId,
  label,
  currentBp,
  defaultRange = DEFAULT_TICK_RANGE,
  'data-testid': testId = 'probability-chart',
}: ProbabilityChartProps) {
  const [range, setRange] = useState<TickRange>(defaultRange);
  const [hovered, setHovered] = useState<number | null>(null);
  const series = useMarketTicks(marketId, range);
  const tableId = useId();
  const readoutId = useId();

  const held = series.data;
  // `extendToNow` holds the newest fill's price out to the window's right edge, so a quiet
  // market draws the line it actually had rather than stopping at its last trade.
  const points =
    held === undefined
      ? []
      : extendToNow(toChartPoints(held.points), Date.parse(held.to), currentBp);
  const geometry = chartGeometry(points);
  const point: ChartPoint | undefined = hovered === null ? undefined : points[hovered];
  const marker = hovered === null ? undefined : geometry.at[hovered];

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

          {points.length === 0 ? (
            <Text color="fg.muted">{copy.chartEmpty}</Text>
          ) : (
            <Box
              position="relative"
              h={{ base: '32', md: '56' }}
              colorPalette="brand"
              // `colorPalette.fg` is 7.90:1 light / 10.53:1 dark; `solid` would be 4.70:1 in
              // dark mode and fails the moment anything reuses the stroke colour for text.
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
                // path is what makes a chart re-render itself into a loop.
                const rect = event.currentTarget.getBoundingClientRect();
                if (rect.width === 0) return;
                setHovered(nearestIndex(points, (event.clientX - rect.left) / rect.width));
              }}
              onPointerLeave={() => {
                setHovered(null);
              }}
              onPointerCancel={() => {
                setHovered(null);
              }}
              onKeyDown={(event) => {
                const last = points.length - 1;
                // Nothing to read yet — the query is still in flight, or the market has no
                // tick at all. Bailing out here is what keeps the readout alive: without it
                // `last` is -1, every branch below clamps to -1, and `hovered` LATCHES there,
                // so `points[hovered]` stays undefined and the readout is dead for the rest
                // of the mount even once the series arrives. Returning also leaves the arrow
                // keys scrolling the page, which is the right thing when there is no series.
                if (last < 0) return;
                const current = hovered ?? last;
                let next: number | null;
                switch (event.key) {
                  case 'ArrowLeft':
                    next = Math.max(0, current - 1);
                    break;
                  case 'ArrowRight':
                    next = Math.min(last, current + 1);
                    break;
                  case 'Home':
                    next = 0;
                    break;
                  case 'End':
                    next = last;
                    break;
                  case 'Escape':
                    next = null;
                    break;
                  default:
                    return;
                }
                // Only for the keys handled above, so the page still scrolls with the arrows
                // whenever the chart is not the focused element.
                event.preventDefault();
                setHovered(next);
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
                    >
                      {formatBp(row.bp)}
                    </Text>
                  </Box>
                ))}
              </Box>

              <LineChart
                points={points}
                // The summary comes first so a screen reader hears the shape of the series
                // ('시작 61%, 최고 66%, 최저 60%, 현재 63%') before it reaches the sampled table.
                label={`${copy.chartLabel} · ${label} · ${chartSummary(points, SUMMARY_LABELS)}`}
                describedBy={tableId}
                area
                data-testid="probability-chart-line"
              />

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
        role="status"
        aria-live="polite"
        // Reserved so the layout does not jump the first time the pointer enters the chart.
        minH="5"
        fontSize="sm"
        color="fg.muted"
      >
        {point === undefined ? '' : `${formatKst(isoAt(point.t))} · ${formatBp(point.bp)}`}
      </Text>

      <ChartDataTable id={tableId} rows={sampleForTable(points, TABLE_ROWS)} />
    </Stack>
  );
}

/**
 * The plotted instant back as an ISO string for `formatKst`. `toISOString` throws outside the
 * ±8.64e15 ms Date range and a throw in render blanks the screen, so an impossible instant
 * answers `''` — which `formatKst` already renders as an empty cell.
 */
function isoAt(t: number): string {
  const at = new Date(t);
  return Number.isNaN(at.getTime()) ? '' : at.toISOString();
}
