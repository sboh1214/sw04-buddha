'use client';

import { Badge } from '@chakra-ui/react';
import { type MarketStatus } from '@buddha/shared';
import { useEffect, useState } from 'react';
import { copy } from '@/copy';
import { formatKst, formatRemaining } from '@/lib/datetime';
import { isClosingSoon } from '@/lib/market-admin';

/**
 * 마감까지 남은 시간, on a card and in the detail header (PLAN 11.4 CountdownBadge).
 *
 * The clock is never read during a render. `now` is the instant the caller already holds — a
 * server component's own `Date.now()`, or the market payload's window end — and the ticking
 * clock takes over from the first interval callback, which runs only in the browser. A
 * `Date.now()` in the render body would put a different string in the server's HTML than in
 * the first client render, which is a hydration mismatch on the page AC 2 measures.
 *
 * With no `now` at all the badge still renders something true — the absolute close time in KST
 * — and swaps to the countdown once mounted. That is what lets a caller that has no server
 * instant (the home grid, the admin preview) drop the component in unchanged.
 *
 * Colour never carries the state alone (PLAN 11.2): 마감 임박 and 마감됨 are written out beside
 * the orange and the grey.
 */

/** PLAN 11.4: the countdown moves once a second, so a sub-minute close reads as a stopwatch. */
const TICK_MS = 1000;

export interface CountdownBadgeProps {
  /** Both fields `isClosingSoon` needs; `Market`, `MarketSummary` and `MarketListItem` fit. */
  market: { status: MarketStatus; closeAt: string };
  /**
   * The instant the FIRST render measures against, from the caller's payload or its server
   * render. Omit it and the badge shows the absolute close time until it has mounted.
   */
  now?: number;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  'data-testid'?: string;
}

export function CountdownBadge({
  market,
  now,
  size = 'sm',
  'data-testid': testId = 'market-countdown',
}: CountdownBadgeProps) {
  const [clock, setClock] = useState(now);
  const remaining = clock === undefined ? '' : formatRemaining(market.closeAt, clock);
  // A market whose close time has passed stays `open` until the close job runs (A-M3-31), so
  // "the countdown ran out" is an ordinary state and the badge, not the status, reports it.
  const running = market.status === 'open' && (clock === undefined || remaining !== '');

  useEffect(() => {
    if (!running) return;
    // `setClock` is called from a timer callback, never synchronously in the effect body: the
    // second form is what `react-hooks/set-state-in-effect` refuses. The zero-delay timeout is
    // what fills in a missing `now` on the first client frame rather than a second later.
    const tick = () => {
      setClock(Date.now());
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [running]);

  if (!running) {
    return (
      <Badge colorPalette="gray" variant="subtle" size={size} data-testid={testId}>
        {copy.marketClosed}
      </Badge>
    );
  }

  if (clock === undefined) {
    return (
      <Badge colorPalette="gray" variant="subtle" size={size} data-testid={testId}>
        {copy.marketCloseAt} {formatKst(market.closeAt)}
      </Badge>
    );
  }

  return isClosingSoon(market, clock) ? (
    // `solid` is what makes 마감 임박 louder than the ordinary countdown next to it in the grid,
    // and it is legible only because theme/system.ts overrides `orange.solid`: Chakra's built-in
    // light pair is white on orange.600 = 3.56:1, and a card renders this badge at 10px.
    <Badge colorPalette="orange" variant="solid" size={size} data-testid={testId}>
      {copy.marketClosingSoon} {remaining}
    </Badge>
  ) : (
    <Badge colorPalette="gray" variant="subtle" size={size} data-testid={testId}>
      {copy.marketCloseAt} {remaining}
    </Badge>
  );
}
