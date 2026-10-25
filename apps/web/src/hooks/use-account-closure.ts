'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountClosureKey } from '@/lib/account-closure';
import {
  api,
  isApiError,
  isForAnotherAccount,
  unwrap,
  type AccountClosureBody,
  type AccountClosureResult,
} from '@/lib/api';
import { useSession } from '@/lib/use-session';

/**
 * `GET /me/closure` (탈퇴, #140, ADR-0086): what a closure would do now — the Coin it forfeits and
 * what refuses it (the refusals in the order the closure asks them, and the standing restriction
 * it would name). Kept under the account the screen was drawn for (`accountClosureKey`, ADR-0091):
 * the answer names no owner. Fresh every time the screen opens (`staleTime: 0`): the amount on the
 * confirmation is the one the member agrees to lose, and the closure asks everything again in its
 * own transaction anyway. The screen is drawn only once `GET /me` answered, so a session is there.
 */
export function closureCheckQueryOptions(accountId: string) {
  return {
    queryKey: accountClosureKey(accountId),
    queryFn: async () => unwrap(await api.GET('/api/v1/me/closure')).data,
    staleTime: 0,
  };
}

export function useClosureCheck(accountId: string) {
  return useQuery(closureCheckQueryOptions(accountId));
}

/**
 * `POST /me/closure`: closes the account on the typed confirmation. The body names the account
 * the screen shows (`expectedAccountId`, A-PG-24): the cookie decides whose account closes, and a
 * tab left open beside a window that signed in as somebody else must not close THAT account. That
 * account is the one of the `Me` the screen was drawn from (`ClosureScreen`'s `accountId`), which
 * the screen passes in, never the session's: in the render between the session naming another
 * account and SessionCacheGuard's reset the session already says B while the screen is still A's,
 * and a body naming B would be taken with B's cookie — B closed on A's '탈퇴' (ADR-0091). The
 * server refuses the mismatch before it reads anything, and the refusal asks for the session again
 * so SessionCacheGuard shows the account really signed in. So it offers no account of its own,
 * and nothing waits for the session: the screen is drawn only once `GET /me` answered.
 *
 * A refusal the check did not foresee — a restriction given, a role granted since the screen
 * read it — reads the check again, so the screen lists what refuses it now (a RESTRICTED one also
 * reads the member's restrictions again, query-client.ts `afterRestricted`). What follows a
 * closure (the cookie, the caches, home) is the screen's: `afterClosureInOrder`.
 */
export function useCloseAccount() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation({
    mutationFn: async (body: AccountClosureBody): Promise<AccountClosureResult> =>
      unwrap(await api.POST('/api/v1/me/closure', { body })).data,
    onError: (error, body) => {
      if (isForAnotherAccount(error)) void refetchSession();
      if (isApiError(error, 'RESTRICTED') || isApiError(error, 'CLOSURE_NOT_ALLOWED')) {
        void queryClient.invalidateQueries({
          queryKey: accountClosureKey(body.expectedAccountId),
          exact: true,
        });
      }
    },
  });
}
