'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { sessionAccountHeard, sessionAccountTurned } from '@/lib/session-account';
import { useSession } from '@/lib/use-session';

/** The account a session answer stands for: its user id, or null for "signed out". */
export type SessionIdentity = string | null;

/**
 * Whether a session answer means the cache now belongs to somebody else. The first answer a
 * tab ever sees (`previous` undefined) never does: resetting there would throw away the
 * queries the page had just started to fetch, on every load.
 */
export function sessionIdentityChanged(
  previous: SessionIdentity | undefined,
  current: SessionIdentity,
): boolean {
  return previous !== undefined && previous !== current;
}

/**
 * Empties the query cache whenever the account behind the session changes.
 *
 * The browser QueryClient lives as long as the tab (lib/query-client.ts) and no key carries a
 * user id (PLAN 11.5; the exceptions are below), so a cache belongs to "the current account" only
 * by convention. The sign-in and sign-out handlers clear it themselves, but only in the tab where
 * they ran. Any other open tab learns of the switch through better-auth instead: a sign-out is
 * broadcast over localStorage (client/config.mjs -> session-refresh.mjs, a `storage` event in
 * every other tab), and every tab refetches its session on `visibilitychange` (a sign-in is not
 * broadcast, so that is how the new account arrives). Until now such a tab kept the previous
 * account's `['me']`, ledger and payments and rendered them under the new session's identity:
 * not refetched at all inside the 30s staleTime, and even past it TanStack keeps showing the
 * cached rows while the refetch is in flight.
 *
 * Why one guard rather than the user id in every key: PLAN 11.5's keys stay as written, no
 * hook or `invalidateQueries` call needs the session threaded through it, keys added later
 * are covered, and nothing of another account stays resident in the cache at all (a keyed
 * cache would hold `['me', A]` until gcTime, and a TanStack focus refetch racing the session
 * refetch could file B's rows under A's key).
 *
 * The exceptions (ADR-0091): four entries carry the account of the `Me` the screen was drawn
 * from — the market's watch state (`watchStateKey`), the post page's likes (`myPostLikesKey`),
 * the recent searches (`searchHistoryKey`) and the closure check (`accountClosureKey`). Each
 * answer names no owner, and a press, a delete or the closure acts on what was drawn from it,
 * naming that account; `['me']` can turn from A to B in place before the session does (ADR-0090
 * 결정 4-2), with no reset here, and one entry for both would draw A's under B's name. The guard
 * resets them with every other entry all the same.
 *
 * The reset empties `['me']`, and the screens drawn for the account on screen put placeholders in
 * place of that account's notice and post forms and comment boxes in the very render: what the
 * account had typed there is kept in this tab as its draft for the hour and taken back when it is on
 * screen again (ADR-0092 결정 10, 오너 결정 2026-10-26 21:00 답 1 «정순서에서도 A의 초안으로») — each
 * of them, going, hears from `sessionAccountTurned`, recorded before the reset, that the session now
 * names another account (lib/session-account.ts). So does what was drawn for the account the
 * session turned to, `['me']` having named it first — that account back in the tab, `GET /me`
 * answering before the session: the reset takes away what was just drawn for it, a draft it had
 * just taken back among it, and it is kept for that account and drawn again with it (8-36). The
 * reset counts as under way until its reads settle. A session naming nobody keeps nothing.
 *
 * `resetQueries`, not `clear`: clearing removes the queries but leaves mounted observers
 * holding the detached data with nothing to re-render them, so an open /my/wallet would keep
 * showing the old ledger. A reset puts every query back to its initial state and refetches
 * the active ones: skeleton, then the right account. Two windows side by side never fire
 * `visibilitychange`, so a sign-in there is seen only on the next interaction — the same
 * limit better-auth's own session has. So is its focus refetch's rate limit: a tab brought back
 * within 5 s of its last one (`FOCUS_REFETCH_RATE_LIMIT_SECONDS`) does not refetch, and a quick
 * sign-in in another tab waits for the next refetch too.
 */
export function SessionCacheGuard() {
  const queryClient = useQueryClient();
  const { data: session, isPending } = useSession();
  const seen = useRef<SessionIdentity | undefined>(undefined);
  // Unknown while better-auth is still asking. The atom keeps its last answer during a
  // refetch and drops it only on a 401, so a transient network failure never reads as a
  // sign-out here.
  const identity: SessionIdentity | undefined = isPending ? undefined : (session?.user.id ?? null);

  useEffect(() => {
    if (identity === undefined) return;
    const previous = seen.current;
    seen.current = identity;
    if (!sessionIdentityChanged(previous, identity)) {
      sessionAccountHeard(identity);
      return;
    }
    // Heard before the reset, and the reset recorded until its reads settle: a form, a comment box
    // or the comment section going in the render the reset causes — `['me']` empty — keeps what it
    // holds for the account it was drawn for when the session now names another, or names that
    // account itself, `['me']` having turned to it first (lib/session-account.ts, ADR-0092 결정 10,
    // 8-36).
    const settled = sessionAccountTurned(identity);
    void queryClient.resetQueries().then(settled, settled);
  }, [identity, queryClient]);

  return null;
}
