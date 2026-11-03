'use client';

import { useEffect, useRef, useState } from 'react';
import { instantWait, tickingNow } from '@/lib/datetime';

/**
 * Whether `at` (ISO) has come on this screen, by a one-shot timer: the core of the member screens'
 * waits for an instant nothing publishes — a held market's 이의 기한 (#175, `useDisputeOpen`: the
 * worker skips a held market, so its submission link goes by this) and a 판정 지연 기록's 다음 검토
 * 시각 (#142, ADR-0106: '갱신 대기' comes on the detail without a reload, owner answer 2026-11-03
 * (2) — the time passing creates nothing, so nothing is published then either). `null` waits for
 * nothing; another instant (another read, a new record, a correction's new deadline) is waited for
 * afresh, the one seen come before no longer counting.
 *
 * `anchor` is the server's own instant at the read when the screen has one (the detail's `now`,
 * `detailWindowEnd`): the instant is then judged at that anchor plus the time elapsed since, as the
 * countdown measures (`tickingNow`), so a browser clock that runs ahead does not say it came early.
 * Without one, the browser's clock. Never a clock read in render: the first render — the server's
 * HTML — says not come, the caller drawing the API's own flag for it, and the timer runs in an
 * effect. `onReached` runs once `at` comes on screen (the detail reads the market again then).
 */
export function useInstantReached(
  at: string | null,
  anchor?: number,
  onReached?: () => void,
): boolean {
  // The instant the timer saw come; a later one is waited for afresh.
  const [reachedAt, setReachedAt] = useState<string | null>(null);
  // The monotonic origin the anchor's elapsed time counts from, taken once (as CountdownBadge's).
  const originRef = useRef<number | undefined>(undefined);
  const [anchorAt] = useState(anchor);
  const reachedRef = useRef(onReached);
  useEffect(() => {
    reachedRef.current = onReached;
  });
  // At the first commit, whatever the instant: the anchor is the first render's, so an instant that
  // comes later (a market judged, a record made while the screen is open) still counts from it.
  useEffect(() => {
    originRef.current ??= performance.now();
  }, []);
  useEffect(() => {
    if (at === null) return;
    const startedAt = originRef.current ?? performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const now = tickingNow(anchorAt, performance.now() - startedAt, Date.now());
      const wait = instantWait(at, now);
      if (wait === null) {
        setReachedAt(at);
        reachedRef.current?.();
        return;
      }
      timer = setTimeout(check, wait);
    };
    // Never synchronously in the effect body (`react-hooks/set-state-in-effect`).
    timer = setTimeout(check, 0);
    return () => clearTimeout(timer);
  }, [at, anchorAt]);
  return at !== null && reachedAt === at;
}
