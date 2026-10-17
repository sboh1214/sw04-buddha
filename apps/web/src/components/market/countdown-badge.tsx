'use client';

import { Badge, Text } from '@chakra-ui/react';
import { type MarketStatus } from '@buddha/shared';
import { useEffect, useRef, useState } from 'react';
import { copy } from '@/copy';
import { formatKst, formatRemaining, tickingNow } from '@/lib/datetime';
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
 * That instant is then an ANCHOR the browser only adds a duration to (`tickingNow`), never a
 * value it replaces with its own clock. The badge used to tick on a raw `Date.now()`, so a
 * visitor whose clock was wrong counted down wrong by exactly the skew. On the detail screen the
 * anchor is the API's own `clock_timestamp()`, carried as the series' window end — the one
 * value an order panel's close gate must share with this badge (A-M4-23), so the two readings
 * of one close time on one screen never disagree.
 *
 * With no `now` at all the badge still renders something true — the absolute close time in KST
 * — and swaps to the countdown once mounted, ticking on the wall clock because there is nothing
 * to anchor to. That is what lets a caller with no server instant (the home grid, the admin
 * preview) drop the component in unchanged, and it is safe there: the badge is display-only.
 *
 * Colour never carries the state alone (PLAN 11.2): 마감 임박 and 마감됨 are written out beside
 * the orange and the grey.
 *
 * Two looks, one reading. The detail header and the admin screens draw the `badge` — the Chakra
 * `Badge` this component always was — and the home card (ADR-0041's Kalshi tile) draws the
 * same words as a line of muted text under the question, which is `variant="text"`. The
 * anchoring and the ticking above are shared as they stand, and the strings go through one
 * `countdownReading`, so the two variants cannot say different things about one close time;
 * only the paint differs.
 */

/** PLAN 11.4: the countdown moves once a second, so a sub-minute close reads as a stopwatch. */
const TICK_MS = 1000;

/**
 * What the countdown says and how loudly, decided ONCE for both variants. `urgent` is the
 * 마감 임박 state — orange in either look — and everything else is the neutral grey. The badge
 * used to make this decision inline in three `return`s; factoring it out is what keeps the
 * `text` variant from drifting a word away from the badge the detail header shows.
 */
interface CountdownReading {
  text: string;
  urgent: boolean;
}

function countdownReading(
  market: CountdownBadgeProps['market'],
  running: boolean,
  clock: number | undefined,
  remaining: string,
): CountdownReading {
  if (!running) return { text: copy.marketClosed, urgent: false };
  if (clock === undefined) {
    return { text: `${copy.marketCloseAt} ${formatKst(market.closeAt)}`, urgent: false };
  }
  return isClosingSoon(market, clock)
    ? { text: `${copy.marketClosingSoon} ${remaining}`, urgent: true }
    : { text: `${copy.marketCloseAt} ${remaining}`, urgent: false };
}

export interface CountdownBadgeProps {
  /** Both fields `isClosingSoon` needs; `Market` and `MarketSummary` fit. */
  market: { status: MarketStatus; closeAt: string };
  /**
   * The instant the FIRST render measures against, from the caller's payload or its server
   * render. Omit it and the badge shows the absolute close time until it has mounted.
   */
  now?: number;
  /** The `badge` variant's Chakra size; the `text` variant is always `bodyXs`. */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /**
   * `badge` (default) is the Chakra `Badge` the detail header and the admin lists show — every
   * existing caller is unchanged. `text` is the home card's line under the question: the same
   * strings as a `bodyXs` span in `fg.muted`, `orange.fg` while 마감 임박.
   */
  variant?: 'badge' | 'text';
  'data-testid'?: string;
}

export function CountdownBadge({
  market,
  now,
  size = 'sm',
  variant = 'badge',
  'data-testid': testId = 'market-countdown',
}: CountdownBadgeProps) {
  const [anchor] = useState(now);
  const [clock, setClock] = useState(now);
  const remaining = clock === undefined ? '' : formatRemaining(market.closeAt, clock);
  // A market whose close time has passed stays `open` until the close job runs (A-M3-31), so
  // "the countdown ran out" is an ordinary state and the badge, not the status, reports it.
  const running = market.status === 'open' && (clock === undefined || remaining !== '');
  // The monotonic origin the elapsed is measured from. A ref and not state: it is written inside
  // the effect and read only there, so no render touches it (`react-hooks/refs` is an error).
  const originRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!running) return;
    // `setClock` is called from a timer callback, never synchronously in the effect body: the
    // second form is what `react-hooks/set-state-in-effect` refuses. The zero-delay timeout is
    // what fills in a MISSING `now` on the first client frame rather than a second later; with an
    // anchor it answers that anchor unchanged, and the ticking starts from there.
    //
    // `performance.now()` and not `Date.now()`: the browser is asked for a DURATION, which its
    // clock measures correctly, and never for an instant to compare against a server's. The
    // origin is captured ONCE for this badge — `??=`, so an effect re-run (an admin extending
    // `closeAt` on an expired market, which A-M3-31 makes ordinary) cannot restart it and rewind
    // the countdown — and never `performance.now()` BARE: bare is the DOCUMENT's age, which a
    // `next/link` navigation carries over. See `tickingNow` for what that cost.
    originRef.current ??= performance.now();
    const startedAt = originRef.current;
    const tick = () => {
      setClock(tickingNow(anchor, performance.now() - startedAt, Date.now()));
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [running, anchor]);

  const reading = countdownReading(market, running, clock, remaining);

  if (variant === 'text') {
    // A span, not a `<p>`: it sits under the card's `<h2>` inside a flex column, and the caller
    // decides the block. `orange.fg` rather than a solid fill — the tile has no badge to be
    // louder than, and Kalshi's line is text — and the words 마감 임박 are still there, so the
    // colour is an accent and never the message (PLAN 11.2).
    return (
      <Text
        as="span"
        textStyle="bodyXs"
        color={reading.urgent ? 'orange.fg' : 'fg.muted'}
        data-testid={testId}
      >
        {reading.text}
      </Text>
    );
  }

  return reading.urgent ? (
    // `solid` is what makes 마감 임박 louder than the ordinary countdown beside it in the detail
    // header, and it is legible only because theme/system.ts overrides `orange.solid`: Chakra's
    // built-in light pair is white on orange.600 = 3.56:1, and the header renders this badge at
    // 12px. (The card used to draw it at 10px; since ADR-0041 the card is the `text` variant.)
    <Badge colorPalette="orange" variant="solid" size={size} data-testid={testId}>
      {reading.text}
    </Badge>
  ) : (
    <Badge colorPalette="gray" variant="subtle" size={size} data-testid={testId}>
      {reading.text}
    </Badge>
  );
}
