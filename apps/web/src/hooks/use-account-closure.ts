'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_CLOSURE_KEY } from '@/lib/account-closure';
import { api, isApiError, isForAnotherAccount, unwrap, type AccountClosureResult } from '@/lib/api';
import { useSession } from '@/lib/use-session';

/**
 * `GET /me/closure` (탈퇴, #140, ADR-0086): what a closure would do now — the Coin it forfeits and
 * what refuses it (the refusals in the order the closure asks them, and the standing restriction
 * it would name). Read only while the session says somebody is signed in, and fresh every time the
 * screen opens (`staleTime: 0`): the amount on the confirmation is the one the member agrees to
 * lose, and the closure asks everything again in its own transaction anyway.
 */
export function useClosureCheck() {
  const { data: session } = useSession();
  return useQuery({
    queryKey: ACCOUNT_CLOSURE_KEY,
    queryFn: async () => unwrap(await api.GET('/api/v1/me/closure')).data,
    enabled: session !== null && session !== undefined,
    staleTime: 0,
  });
}

/**
 * `POST /me/closure`: closes the account on the typed confirmation. The body names the account
 * the screen shows (`expectedAccountId`, A-PG-24), read from the session as `useSetPassword` reads
 * it: the cookie decides whose account closes, and a tab left open beside a window that signed in
 * as somebody else must not close THAT account — the server refuses the mismatch before it reads
 * anything, and the refusal asks for the session again so SessionCacheGuard shows the account
 * really signed in. `ready` is false until the session is known; the button waits for it.
 *
 * A refusal the check did not foresee — a restriction given, a role granted since the screen
 * read it — reads the check again, so the screen lists what refuses it now (a RESTRICTED one also
 * reads the member's restrictions again, query-client.ts `afterRestricted`). What follows a
 * closure (the cookie, the caches, home) is the screen's: `afterClosureInOrder`.
 */
export function useCloseAccount() {
  const queryClient = useQueryClient();
  const { data: session, refetch: refetchSession } = useSession();
  const accountId = session?.user.id;
  const mutation = useMutation({
    mutationFn: async (confirmation: string): Promise<AccountClosureResult> => {
      // Unreachable while the screen honours `ready`.
      if (!accountId) throw new Error('closure asked before the session was known');
      return unwrap(
        await api.POST('/api/v1/me/closure', {
          body: { confirmation, expectedAccountId: accountId },
        }),
      ).data;
    },
    onError: (error) => {
      if (isForAnotherAccount(error)) void refetchSession();
      if (isApiError(error, 'RESTRICTED') || isApiError(error, 'CLOSURE_NOT_ALLOWED')) {
        void queryClient.invalidateQueries({ queryKey: ACCOUNT_CLOSURE_KEY, exact: true });
      }
    },
  });
  return { ...mutation, ready: accountId !== undefined };
}
