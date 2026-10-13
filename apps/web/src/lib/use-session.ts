'use client';

import { useSyncExternalStore } from 'react';
import { authClient } from './auth-client';

const { useSession: useAuthSession } = authClient;

/**
 * `false` during SSR and during hydration, `true` from the first client render after it.
 *
 * `useSyncExternalStore` rather than a `useEffect` flag: React reads `getServerSnapshot` on
 * the server AND for the hydrating render, so the two agree by construction, and there is no
 * `setState` inside an effect (`react-hooks/set-state-in-effect` is an error in this repo).
 * The store never changes, so `subscribe` has nothing to do.
 */
const noopSubscribe = () => () => undefined;

function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * better-auth's `useSession`, held at `isPending` until the tab has hydrated.
 *
 * The raw hook answers `isPending: true` on the server — there is no session store there —
 * but in the browser it can answer on the FIRST render: a signed-out visitor's atom settles
 * to `null` synchronously. Every screen that branches on the session then drew a skeleton on
 * the server and the real thing during hydration, and React recovers from that mismatch by
 * regenerating the tree FROM THE ROOT. That is not a cosmetic warning: it silently drops what
 * the visitor had already typed (the /login form lost its email whenever it was filled before
 * hydration finished) and it throws away focus, so a keyboard user who had reached the
 * probability chart was dumped back onto `<body>`.
 *
 * Fixed here rather than by wrapping each consumer in `<ClientOnly>` because the branch is
 * not in one component but in every one that asks who is signed in — `AuthButtons`,
 * `MyPosition`, `useMe` and everything built on it — and a consumer
 * added later would reintroduce the bug with nothing to catch it. The cost is one extra
 * render of the pending state, which every consumer already draws.
 */
export function useSession(): ReturnType<typeof useAuthSession> {
  const session = useAuthSession();
  const hydrated = useHydrated();
  if (hydrated) return session;
  return { ...session, data: null, isPending: true, error: null };
}
