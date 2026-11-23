'use client';

import { useEffect, useRef } from 'react';
import { hashTargetId } from '@/lib/admin-operations';

/**
 * How long a screen waits for the element its address's hash names: the admin detail's panels
 * each read on their own after the market (the market maker panel's 시장 자금 회수 block, #181),
 * so the block may come a moment after the detail.
 */
export const HASH_SCROLL_WAIT_MS = 15_000;

/**
 * Scrolls the element `location.hash` names into view once per mount, as soon as it is drawn after
 * `ready` (#145, ADR-0163): a screen drawn on the client after a skeleton has no element for the
 * browser to scroll to at load — the admin detail, which 운영 대기열's '회수 칸 보기' opens at
 * `#market-maker-recall` (145-8). It waits for the element (a DOM observer, up to
 * HASH_SCROLL_WAIT_MS) and gives up quietly: an address whose element never comes still lands on
 * the screen. No hash, nothing.
 */
export function useHashScrollOnce(ready: boolean): void {
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    const id = hashTargetId(window.location.hash);
    if (id === null) {
      done.current = true;
      return;
    }
    const scroll = (): boolean => {
      const target = document.getElementById(id);
      if (target === null) return false;
      done.current = true;
      target.scrollIntoView({ block: 'start' });
      return true;
    };
    if (scroll()) return;
    const observer = new MutationObserver(() => {
      if (scroll()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const stop = window.setTimeout(() => {
      done.current = true;
      observer.disconnect();
    }, HASH_SCROLL_WAIT_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(stop);
    };
  }, [ready]);
}
