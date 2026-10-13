import { Box, VisuallyHidden } from '@chakra-ui/react';
import { ROLL_DIGITS, rollCells } from '@/lib/roll';

/**
 * A number that rolls to its new value instead of blinking (PLAN 11.1-5, 실시간은 조용하게).
 *
 * The component is a pure function of `text`: each digit is a clipped window over one column of
 * the ten glyphs, translated to the digit it must show, and the roll is a CSS `transition`
 * between two static renders. So there is no state, no ref, no effect and no
 * `requestAnimationFrame` — which buys three things at once. The server and the browser emit
 * identical markup, so a rolling number costs no hydration mismatch on the very page AC 2
 * measures. A page load does not roll every number up from zero, because the transform is
 * already final on mount and a transition needs a change to fire. And `_motionReduce` — Chakra
 * for `@media (prefers-reduced-motion: reduce)` — turns the whole thing off in one prop, with
 * no `matchMedia` and no effect to race the first paint.
 *
 * Cell keys are anchored to the end of the string by `rollCells`, so 'YES 9%' -> 'YES 63%' keeps
 * the units digit and the '%' rather than animating the wrong glyphs (see `lib/roll.ts`). The
 * width is stable across a roll for free: `tabular-nums` is set on body (theme/system.ts), so
 * every digit has the same advance and a 9 -> 10 moves nothing around the number.
 */

/**
 * Every cell is exactly one line box tall, and `lineHeight` is locked to the same figure, so
 * the digit columns and the literal characters line up by geometry rather than by baseline.
 * That matters: `overflow: hidden` makes a flex item's baseline synthesise from its bottom
 * edge, so baseline alignment would drop the digits about a fifth of an em below the '%'.
 */
const CELL_HEIGHT = '1.15em';
const CELL_LINE_HEIGHT = '1.15';

export interface RollingNumberProps {
  /** Already formatted by `@buddha/shared` or `market-admin.ts` — nothing is formatted here. */
  text: string;
  /** Read aloud in place of the digit stacks. Defaults to `text`. */
  label?: string;
  'data-testid'?: string;
}

export function RollingNumber({ text, label, 'data-testid': testId }: RollingNumberProps) {
  return (
    <Box as="span" display="inline-flex" lineHeight={CELL_LINE_HEIGHT} data-testid={testId}>
      {/*
        The one copy that is selectable and readable: the stacks below are ten glyphs per cell,
        which a screen reader would spell out and a copy would paste as '0123456789'. A live
        region never goes on the animating node — it would announce on every tick.
      */}
      <VisuallyHidden>{label ?? text}</VisuallyHidden>
      <Box
        as="span"
        aria-hidden="true"
        display="inline-flex"
        userSelect="none"
        // A flex item collapses the leading and trailing space of its own text, which would
        // eat the gap in 'YES 63%'. `pre` keeps it, and stops the number wrapping mid-value.
        whiteSpace="pre"
      >
        {rollCells(text).map((cell) =>
          cell.offsetPct === null ? (
            <Box as="span" key={cell.key} display="inline-block" height={CELL_HEIGHT}>
              {cell.char}
            </Box>
          ) : (
            <Box
              as="span"
              key={cell.key}
              display="inline-block"
              overflow="hidden"
              height={CELL_HEIGHT}
            >
              <Box
                as="span"
                display="block"
                transform={`translateY(-${String(cell.offsetPct)}%)`}
                transitionProperty="transform"
                // 300ms, the slow end of PLAN 11.1-5's 200~300ms.
                transitionDuration="slow"
                transitionTimingFunction="ease-out"
                _motionReduce={{ transitionDuration: '0ms' }}
              >
                {ROLL_DIGITS.map((digit) => (
                  <Box as="span" key={digit} display="block" height={CELL_HEIGHT}>
                    {digit}
                  </Box>
                ))}
              </Box>
            </Box>
          ),
        )}
      </Box>
    </Box>
  );
}
