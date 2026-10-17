'use client';

import { Badge, HStack, Stack, Text, VisuallyHidden } from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { RollingNumber } from '@/components/ui/rolling-number';
import { copy } from '@/copy';
import { deltaLabel, deltaMoveKey, formatYesPrice } from '@/lib/market-admin';
import { complementReading } from '@/lib/market-detail';

/**
 * The detail screen's big reading (PLAN 11.4 ProbabilityDisplay), in two lines: the last fill's
 * price, "YES 63%", with a short-lived 시장가격 변화 badge right after it, and under that its display
 * complement "NO 37%" — or, before the first fill, 체결 없음 once and no second line (N02 §5), where
 * no initial setting stands in for a price.
 *
 * The NO reading is the complement of the same `lastPrice` (ADR-0061 decision 1, item 2: the card
 * and the detail header show YES and NO together), never what a NO contract costs — that is the
 * order book's (N02 §5). So it is drawn as the card draws its readings (owner decision 2026-10-16,
 * ADR-0062): plain text, smaller and muted under the YES figure the 대표 시장가격 is, with no
 * outline, fill or pointer that would make it look like a price to press. It is plain text rather
 * than `RollingNumber` for the card's reason too: one rolling figure is the reading, and a second
 * set of digit stacks would only double the markup.
 *
 * The badge is YES's move — its arrow, sign and palette are YES's — so it stands on the YES line,
 * right after the figure; beside 'NO 37%' it would read as NO's own move, which is the opposite one
 * (a fill that takes YES from 63 to 61 takes NO from 37 to 39). NO has its own line under it
 * (owner decision 2026-10-17, 'NO를 아래 줄로', ADR-0067), so the badge coming and going five
 * seconds later never moves the NO reading: nothing else stands on the YES line after the badge,
 * and the badge is shorter than the YES figure's line box, so that line keeps its height too.
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

/** The NO complement's size under the YES figure: a reading, not a second headline. */
const COMPLEMENT_FONT_SIZE = {
  sm: 'md',
  lg: { base: 'lg', md: 'xl' },
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
  const complement = complementReading(lastPrice);
  return (
    <Stack gap="0.5" align="flex-start" data-testid={testId}>
      {/* Line 1: the YES figure and, while it lives, its move. */}
      <HStack gap="2" align="baseline" flexWrap="wrap">
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
            <RollingNumber
              text={formatYesPrice(lastPrice)}
              data-testid="market-probability-value"
            />
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
      {/* Line 2: NO, under the YES line rather than after the badge — the badge is YES's move, and
          beside 'NO 37%' it would read as NO's own, which went the other way; and on a line of its
          own nothing the badge does can move it. */}
      {complement !== null && (
        <Text
          as="span"
          fontSize={COMPLEMENT_FONT_SIZE[size]}
          fontWeight="medium"
          color="fg.muted"
          whiteSpace="nowrap"
          data-testid="market-probability-no"
        >
          {complement}
        </Text>
      )}
    </Stack>
  );
}
