'use client';

import { useEffect, useState } from 'react';

/**
 * PLAN 11.4: one quote 300ms after the last keystroke. Only the typed AMOUNT goes through it —
 * 매수/매도, 예/아니오 and the input mode are discrete taps and reach the quote key undebounced,
 * so a tap re-prices instantly while typing does not mint a request per digit.
 */
export const QUOTE_DEBOUNCE_MS = 300;

/**
 * `value` once it has stopped changing for `delayMs`.
 *
 * The first render answers the current value rather than an empty one, so a panel that opens
 * with an amount already in the field does not wait a beat before it quotes, and the server
 * render and its hydration agree (the timer only ever runs in the browser).
 *
 * The pending timer is cleared by the effect's own cleanup, so a value that changes again
 * inside the window replaces the previous timer instead of racing it; unmounting mid-window
 * drops it entirely. The state is set from the timer callback and never during the effect, so
 * the settled value is always one commit behind a keystroke and never a re-render of it.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);
  return settled;
}
