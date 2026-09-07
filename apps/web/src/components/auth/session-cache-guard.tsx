'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
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
 * The account this tab's caches currently belong to, readable OUTSIDE React — `undefined`
 * until better-auth has answered once.
 *
 * A module-scoped value rather than a hook, because the readers that need it most are the ones
 * React has stopped talking to. An in-flight mutation keeps running after the component that
 * started it unmounts, and react-query only pushes fresh options into a pending mutation from
 * an effect, so a callback that closes over `useSession()`'s answer keeps naming the account
 * that started the work however long the tab has since belonged to somebody else
 * (`tradeAnswerScope`, use-trade.ts). The query cache cannot stand in for it either: the
 * account is knowable there only while `['me']` holds an answer, and `resetQueries` below is
 * precisely what empties it.
 *
 * The guard is the right publisher because it is mounted for the life of the tab, above every
 * screen (components/ui/provider.tsx), and it already computes this exact value to decide
 * whether to reset. Module state is per tab in the browser, which is the scope wanted. It also
 * evaluates during SSR of client components, where the value stays `undefined` for good: it is
 * only ever written from an effect, and effects do not run on the server — so one request can
 * never read another's account.
 */
let cacheOwner: SessionIdentity | undefined = undefined;

export function rememberCacheOwner(identity: SessionIdentity): void {
  cacheOwner = identity;
}

export function cacheOwnerAccount(): SessionIdentity | undefined {
  return cacheOwner;
}

/**
 * The two steps a settled session answer takes, in the one order that is safe.
 *
 * Exported because both are decisions, and this app runs vitest under `environment: 'node'`
 * where an effect body is unreachable — the same rule that keeps every seed and join in `lib/`.
 * Left inline, either could be undone by moving one line and the suite would stay green.
 *
 * PUBLISH FIRST. `resetQueries` blanks `['me']` on its way past, so an owner read after it could
 * only come from a cache that no longer names anybody. That is exactly the window
 * `tradeAnswerScope` (use-trade.ts) has to refuse in: B's `['positions']` has refetched, B's
 * `['me']` has not, and A's still-running trade answer would otherwise be waved through onto B's
 * 보유 포지션.
 *
 * PUBLISH ALWAYS, the first answer a tab ever sees included — that one resets nothing, but it is
 * the only answer most tabs get. Published only on a CHANGE, `cacheOwnerAccount()` would stay
 * `undefined` for the whole life of a tab that never switched accounts, and the gate would fall
 * back to the cached `Me` it cannot trust.
 */
export function claimCacheOwnership(
  previous: SessionIdentity | undefined,
  current: SessionIdentity,
  resetCaches: () => void,
): void {
  rememberCacheOwner(current);
  if (sessionIdentityChanged(previous, current)) resetCaches();
}

/**
 * Empties the query cache whenever the account behind the session changes.
 *
 * The browser QueryClient lives as long as the tab (lib/query-client.ts) and no key carries a
 * user id (PLAN 11.5), so a cache belongs to "the current account" only by convention. The
 * sign-in and sign-out handlers clear it themselves, but only in the tab where they ran. Any
 * other open tab learns of the switch through better-auth instead: a sign-out is broadcast
 * over localStorage (client/config.mjs -> session-refresh.mjs, a `storage` event in every
 * other tab), and every tab refetches its session on `visibilitychange` (a sign-in is not
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
 * `resetQueries`, not `clear`: clearing removes the queries but leaves mounted observers
 * holding the detached data with nothing to re-render them, so an open /wallet would keep
 * showing the old ledger. A reset puts every query back to its initial state and refetches
 * the active ones: skeleton, then the right account. Two windows side by side never fire
 * `visibilitychange`, so a sign-in there is seen only on the next interaction — the same
 * limit better-auth's own session has.
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
    claimCacheOwnership(previous, identity, () => void queryClient.resetQueries());
  }, [identity, queryClient]);

  return null;
}
