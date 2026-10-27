'use client';

import { useEffect, useState } from 'react';
import { windowLeaveGuard } from '@/lib/leave-guard-window';

/** What each mounted screen would lose, by the screen: the window's guard asks while any would. */
const asking = new Map<symbol, string>();

function apply(): void {
  const first = asking.values().next();
  windowLeaveGuard().ask(first.done === true ? null : first.value);
}

/**
 * Asks `message` before the screen is left while `dirty` (owner decision 2026-10-19, ADR-0073):
 * the browser's own dialog for closing, reloading and other documents, and `message` for the app's
 * links, its navigating forms and its back and forward (lib/leave-guard.ts says how). The window
 * has one guard, installed before hydration (src/instrumentation-client.ts); this tells it what
 * the screen would lose, and where the screen is, after every render, and that it would lose
 * nothing once the screen is gone.
 */
export function useLeaveGuard(dirty: boolean, message: string): void {
  const [screen] = useState(() => Symbol('leave-guard'));
  useEffect(() => {
    if (dirty) asking.set(screen, message);
    else asking.delete(screen);
    apply();
    // The page as it is now: the write screen's own `router.replace` of its market moves it.
    windowLeaveGuard().sync();
  });
  useEffect(
    () => () => {
      asking.delete(screen);
      apply();
    },
    [screen],
  );
}
