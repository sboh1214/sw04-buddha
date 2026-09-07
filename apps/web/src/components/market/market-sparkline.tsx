import { Box, chakra } from '@chakra-ui/react';
import { sparklinePath } from '@/lib/sparkline';

/**
 * The card's 24-hour probability trace (PLAN 11.1's Polymarket note). No directive: the whole
 * component is a pure function of the numbers `GET /markets` already sent, so it renders inside
 * the server's HTML and a home page of twenty cards costs twenty `<path>` elements and no JS.
 *
 * Decorative on purpose — `aria-hidden`, no accessible name. The probability badge beside it
 * carries the reading in words ("예 63%"), and announcing the shape as well would read the same
 * market out twice. That is also why the stroke sits on a neutral `fg.subtle` rather than
 * `yes`/`no`: a card shows no delta text, so a green or red line would be meaning carried by
 * colour alone (PLAN 11.2).
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

export interface MarketSparklineProps {
  /** `MarketListItem.sparkline`: oldest-first hourly pYesBp, at most `SPARKLINE_MAX_POINTS`. */
  points: number[];
  'data-testid'?: string;
}

export function MarketSparkline({
  points,
  'data-testid': testId = 'market-card-sparkline',
}: MarketSparklineProps) {
  const path = sparklinePath(points, BOX.width, BOX.height);
  return (
    // The box is rendered whether or not there is a path: a market with fewer than two samples
    // must not make its card an inch shorter than the one beside it in the grid.
    <Box color="fg.subtle" w="16" h="5" flexShrink="0" data-testid={testId}>
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
