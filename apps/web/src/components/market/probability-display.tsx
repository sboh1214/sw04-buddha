'use client';

import { Badge, HStack, Text, VisuallyHidden } from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { RollingNumber } from '@/components/ui/rolling-number';
import { copy } from '@/copy';
import { deltaLabel, deltaMoveKey, formatYesPrice } from '@/lib/market-admin';

/**
 * The detail screen's big reading (PLAN 11.4 ProbabilityDisplay): the last fill's price, "YES 63%",
 * plus a short-lived 시장가격 변화 badge — or 체결 없음 before the first fill (N02 §5), where no initial
 * setting stands in for a price.
 *
 * Rolling lives here and nowhere else. A card renders `formatYesPrice` as plain text: AC 1 asks
 * a card to UPDATE within a second, not to animate, PLAN 11.1-1 says a card shows "63%" only,
 * and ten digit stacks per card would be paid for in the home page's HTML twenty times over.
 *
 * The roll itself is `RollingNumber`'s CSS transition, so this component holds no animation
 * state and `prefers-reduced-motion` is already honoured one level down. What it does hold is
 * the five-second life of the delta badge — and even that is a timer callback, never a
 * `setState` in the body of an effect (`react-hooks/set-state-in-effect` is an error here).
 *
 * The number itself stays on `fg` (~21:1). The semantic colour rides on the YES label the format
 * carries and on the badge, and the badge writes its direction out as `+2%p` / `−2%p`, so
 * nothing means anything by colour alone (PLAN 11.2, AC 6).
 */

/** PLAN 11.4: "방향 화살표 + `+2%p` 배지(5초 후 사라짐)". */
const DELTA_VISIBLE_MS = 5000;

/**
 * Decorative glyphs, `aria-hidden`, and deliberately not in `copy.ts`: they are not words, and
 * the badge's own text already carries the sign for a screen reader.
 */
const ARROW_UP = '▲';
const ARROW_DOWN = '▼';

const VALUE_FONT_SIZE = {
  sm: '2xl',
  lg: { base: '4xl', md: '5xl' },
} as const;

export interface ProbabilityDisplayProps {
  /** `Market.lastPrice`, 1..99, or `null` before the first fill. Never recomputed here. */
  lastPrice: number | null;
  /** Percentage points moved, or `null` for "no move to report" — the badge then stays away. */
  deltaPoints?: number | null;
  /**
   * The MONOTONE identity of that move (`recentMove`, lib/ticks.ts), which is what a dismissal is
   * remembered against. Passed with `deltaPoints` and from the same read, never derived here: a
   * value-based identity cannot tell two moves apart when the market oscillates back onto a
   * probability it already left. Absent only for a caller that shows no badge at all.
   */
  moveId?: string;
  size?: 'sm' | 'lg';
  'data-testid'?: string;
}

export function ProbabilityDisplay({
  lastPrice,
  deltaPoints = null,
  moveId,
  size = 'lg',
  'data-testid': testId = 'market-probability',
}: ProbabilityDisplayProps) {
  const label = deltaLabel(deltaPoints);
  // What "this move" is: the string a dismissal is remembered against, so the NEXT move revives
  // the badge. `moveId` is monotone and therefore cannot repeat — see `recentMove`, and
  // `deltaMoveKey` for why the value-based fallback below is not enough on its own.
  const move = moveId ?? deltaMoveKey(lastPrice, label);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (label === '') return;
    const timer = setTimeout(() => {
      setDismissed(move);
    }, DELTA_VISIBLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [move, label]);

  const up = (deltaPoints ?? 0) > 0;
  return (
    <HStack gap="2" align="baseline" flexWrap="wrap" data-testid={testId}>
      <Text
        as="span"
        fontSize={VALUE_FONT_SIZE[size]}
        fontWeight="bold"
        // Locked to the roll cells' own line box (rolling-number.tsx), so the digit stacks and
        // the YES label share one baseline whatever Pretendard's metrics do at this size.
        lineHeight="1.15"
      >
        {/* 체결 없음 is words, not a number: nothing to roll. */}
        {lastPrice === null ? (
          <Text as="span" color="fg.muted" data-testid="market-probability-value">
            {formatYesPrice(lastPrice)}
          </Text>
        ) : (
          <RollingNumber text={formatYesPrice(lastPrice)} data-testid="market-probability-value" />
        )}
      </Text>
      {label === '' || dismissed === move ? null : (
        <Badge
          colorPalette={up ? 'yes' : 'no'}
          variant="subtle"
          data-testid="market-probability-delta"
        >
          {/* The badge is a number with an arrow; this is the only thing that says what the
              number is. No live region: the value beside it changes on every tick, and a
              region here would announce the market's whole history. */}
          <VisuallyHidden>{copy.probabilityChange}</VisuallyHidden>
          <Text as="span" aria-hidden="true">
            {up ? ARROW_UP : ARROW_DOWN}
          </Text>
          {label}
        </Badge>
      )}
    </HStack>
  );
}
