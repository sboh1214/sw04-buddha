import { Box, chakra } from '@chakra-ui/react';
import { sparklinePath } from '@/lib/sparkline';

/**
 * The card's 24-hour probability trace (PLAN 11.1's Polymarket note). No directive: the whole
 * component is a pure function of the numbers `GET /markets` already sent, so it renders inside
 * the server's HTML and a home page of twenty cards costs twenty `<path>` elements and no JS.
 *
 * Silent in the accessibility tree by default — `aria-hidden`, no accessible name. The 예 pill
 * above it carries the reading in words ("예 63%") and the detail page draws the same history as
 * a chart with its own readout, so announcing the shape here would read the same market out
 * twice. A caller that does want the trace named passes `label` (`copy.marketSparkline` is the
 * string) and the box becomes a `role="img"` with that name; the card does not, for the reason
 * just given.
 *
 * Silent is not the same as decorative: the 24-hour trajectory appears nowhere else on the card,
 * so the trace is a graphical object under WCAG 1.4.11 and its stroke is measured rather than
 * assumed — see `SPARKLINE_STROKE`.
 *
 * Neutral rather than `yes`/`no`: a card shows no delta text, so a green or red line would be
 * meaning carried by colour alone (PLAN 11.2).
 *
 * The geometry — including the right-alignment that makes a young market draw a short line at
 * the live edge — belongs to `lib/sparkline.ts`; nothing about the series is decided here.
 */

/**
 * The user-space box, in CSS px at the rendered size, so `sparklinePath` and the `viewBox`
 * agree and `preserveAspectRatio="none"` has nothing to stretch. Kept in step with the Chakra
 * spacing tokens below: `w="16"` is 4rem (64px) and `h="5"` is 1.25rem (20px).
 */
const BOX = { width: 64, height: 20 } as const;

/**
 * The trace's colour, exported because the value is a measured claim and a node test can reach a
 * constant but never a painted stroke. `fg.subtle` — the neutral this looks like, and the first
 * choice — is gray.400 in light mode: 2.56:1 on the page's `bg` and 2.46:1 on `bg.subtle`, both
 * under the 3:1 WCAG 1.4.11 asks of a graphical object. `fg.muted` clears it in both modes on
 * both of those backgrounds (light 7.73/7.41, dark 7.76/7.37) and is the neutral the card's
 * countdown line already uses, so the card's colour language is unchanged. The Kalshi tile
 * (ADR-0041) sits on `surface.card`, a 2% tint over `bg` that no longer swaps on hover; the two
 * measured grounds bracket it, so the figures above still bound what is painted.
 */
export const SPARKLINE_STROKE = 'fg.muted';

export interface MarketSparklineProps {
  /** `MarketListItem.sparkline`: oldest-first hourly pYesBp, at most `SPARKLINE_MAX_POINTS`. */
  points: number[];
  /**
   * An accessible name for the trace (`copy.marketSparkline`). Absent — the card's case — the
   * box stays out of the accessibility tree; see the note at the top.
   */
  label?: string;
  'data-testid'?: string;
}

export function MarketSparkline({
  points,
  label,
  'data-testid': testId = 'market-card-sparkline',
}: MarketSparklineProps) {
  const path = sparklinePath(points, BOX.width, BOX.height);
  // Named only when there is something to name: a labelled "24시간 확률 추이" over an empty box
  // (fewer than two samples) would announce a graphic that is not there.
  const named = label !== undefined && path !== null;
  return (
    // The box is rendered whether or not there is a path: a market with fewer than two samples
    // must not make its card an inch shorter than the one beside it in the grid. It is the right
    // slot of the tile's footer, where Kalshi prints its market count (market-card.tsx).
    <Box
      color={SPARKLINE_STROKE}
      w="16"
      h="5"
      flexShrink="0"
      role={named ? 'img' : undefined}
      aria-label={named ? label : undefined}
      data-testid={testId}
    >
      {path === null ? null : (
        <chakra.svg
          viewBox={`0 0 ${String(BOX.width)} ${String(BOX.height)}`}
          preserveAspectRatio="none"
          width="100%"
          height="100%"
          display="block"
          // The svg root clips at its own edge by default, which would slice the stroke in half
          // at the series maximum, where the path sits exactly on the top of the box.
          overflow="visible"
          aria-hidden="true"
          focusable="false"
        >
          <chakra.path
            d={path}
            fill="none"
            // `currentcolor` resolves the Box's token at paint, so `_dark` (a class on <html>,
            // next-themes) flips the line with no JS and no theme flash on a server render.
            stroke="currentcolor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            // Without it the 20px-tall box stretched to 64px wide would draw a stroke thicker
            // horizontally than vertically.
            vectorEffect="non-scaling-stroke"
          />
        </chakra.svg>
      )}
    </Box>
  );
}
