'use client';

import { Badge, HStack, Stack, Text, VisuallyHidden } from '@chakra-ui/react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { RollingNumber } from '@/components/ui/rolling-number';
import { copy } from '@/copy';
import { deltaLabel, formatYesPrice } from '@/lib/market-admin';
import { complementReading } from '@/lib/market-detail';

/**
 * The detail screen's big reading (PLAN 11.4 ProbabilityDisplay), in three lines: the last fill's
 * price, "YES 63%", with its 24시간 badge right after it on a market 거래 중; under that its display
 * complement "NO 37%"; and under that what the number is and when it was set — '시장가격 · 최근 체결
 * <절대 시각>' (#64, ADR-0139). Before the first fill, 체결 없음 once, no NO line and '시장가격' alone
 * (N02 §5), where no initial setting stands in for a price.
 *
 * The NO reading is the complement of the same `lastPrice` (ADR-0061 decision 1, item 2: the card
 * and the detail header show YES and NO together), never what a NO contract costs — that is the
 * order book's (N02 §5). So it is drawn as the card draws its readings (owner decision 2026-10-16,
 * ADR-0062): plain text, smaller and muted under the YES figure the 대표 시장가격 is, with no
 * outline, fill or pointer that would make it look like a price to press. It is plain text rather
 * than `RollingNumber` for the card's reason too: one rolling figure is the reading, and a second
 * set of digit stacks would only double the markup.
 *
 * The badge is YES's move over 24 hours — 시장가격 now minus 시장가격 24 hours before the row was
 * read (`delta24h`, ADR-0135 결정 1의 5) — so it stands on the YES line, right after the figure;
 * beside 'NO 37%' it would read as NO's own move, which is the opposite one. It stays as long as
 * the row says so: the five-second badge of PLAN 11.4 is gone (ADR-0139).
 *
 * The time is the card's one line (`marketLastFillAt`, ADR-0136): the reader's zone, with no
 * second line in the 판정 기준 시간대 — a fill's time is not a judging time (owner answer 64-Q1).
 * The server's HTML and the first client render write it in KST (ADR-0063).
 *
 * Rolling lives here and nowhere else. A card renders `formatYesPrice` as plain text: AC 1 asks
 * a card to UPDATE within a second, not to animate, PLAN 11.1-1 says a card shows "63%" only,
 * and ten digit stacks per card would be paid for in the home page's HTML twenty times over.
 * The roll itself is `RollingNumber`'s CSS transition, so this component holds no state.
 *
 * The number itself stays on `fg` (~21:1). The semantic colour rides on the YES label the format
 * carries and on the badge, and the badge writes its direction out as `+2%p` / `−2%p`, so
 * nothing means anything by colour alone (PLAN 11.2, AC 6).
 */

/**
 * Decorative glyphs, `aria-hidden`, and deliberately not in `copy.ts`: they are not words, and
 * the badge's own text already carries the sign for a screen reader.
 */
const ARROW_UP = '▲';
const ARROW_DOWN = '▼';

/** Between '시장가격' and '최근 체결 <시각>' on the third line: punctuation, not a word. */
const PRICE_META_SEPARATOR = ' · ';

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
  /**
   * The 24-hour move in percentage points (`delta24h`, lib/market-detail.ts), or `null` for "no
   * move to report" — not 거래 중, no baseline, no move — and the badge then stays away.
   */
  delta24hPp?: number | null;
  /** `Market.lastFillAt`, the server time of the fill `lastPrice` is; null before the first. */
  lastFillAt: string | null;
  size?: 'sm' | 'lg';
  'data-testid'?: string;
}

export function ProbabilityDisplay({
  lastPrice,
  delta24hPp = null,
  lastFillAt,
  size = 'lg',
  'data-testid': testId = 'market-probability',
}: ProbabilityDisplayProps) {
  const label = deltaLabel(delta24hPp);
  const formatDateTime = useFormatDateTime();
  const up = (delta24hPp ?? 0) > 0;
  const complement = complementReading(lastPrice);
  return (
    <Stack gap="0.5" align="flex-start" data-testid={testId}>
      {/* Line 1: the YES figure and, on a market 거래 중, its 24-hour move. */}
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
        {label === '' ? null : (
          <Badge
            colorPalette={up ? 'yes' : 'no'}
            variant="subtle"
            data-testid="market-probability-delta"
          >
            {/* '24시간 ▲+2%p': the period, then the arrow on the number. The hidden name is the
                only thing that says what the number is. No live region: the value beside it
                changes on every tick, and a region here would announce the market's history. */}
            <VisuallyHidden>{`${copy.probabilityChange} `}</VisuallyHidden>
            {copy.marketDelta24h}{' '}
            <Text as="span">
              <Text as="span" aria-hidden="true">
                {up ? ARROW_UP : ARROW_DOWN}
              </Text>
              {label}
            </Text>
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
      {/* Line 3: what the figure is and the time it was set (ADR-0135 결과 4). It wraps inside
          this box at 375px rather than pushing the box wider. */}
      <Text as="span" fontSize="sm" color="fg.muted" data-testid="market-detail-price-meta">
        {copy.marketPriceName}
        {lastFillAt !== null && (
          <>
            {PRICE_META_SEPARATOR}
            <Text as="span" whiteSpace="nowrap" data-testid="market-detail-last-fill">
              {`${copy.marketLastFillAt} ${formatDateTime(lastFillAt)}`}
            </Text>
          </>
        )}
      </Text>
    </Stack>
  );
}
