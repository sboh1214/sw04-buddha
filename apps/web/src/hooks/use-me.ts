'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { copy } from '@/copy';
import { api, isForAnotherAccount, unwrap, type Me } from '@/lib/api';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { useSession } from '@/lib/use-session';

/** Query key rule from PLAN 11.5. */
export const ME_QUERY_KEY = ['me'] as const;

export async function fetchMe(): Promise<Me> {
  return unwrap(await api.GET('/api/v1/me')).data;
}

/**
 * Profile + balance + linked login methods (`GET /api/v1/me`). Only runs while the
 * better-auth session says we are logged in, so a logged-out visitor never triggers a 401.
 */
export function useMe() {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    enabled: session !== null && session !== undefined,
  });
  return {
    ...query,
    /** True until we know whether there is a session (avoids a logged-out flash). */
    isPending: sessionPending || (session != null && query.isPending),
    isLoggedIn: session != null,
  };
}

/**
 * `POST /api/v1/me/password`: the first password of an account that has none, set from the
 * settings screen (a social-only user). The sign-up's /set-password step uses
 * `useSetPasswordAndContact` (use-contact.ts) instead. Refreshes the linked-account list, which
 * decides whether the settings screen offers "set" or "change".
 *
 * The body names the account the screen shows (`expectedAccountId`, A-PG-24), read from the
 * session as `useCharge` reads it: the cookie decides whose password is set, and a settings tab
 * left open beside a window that signed in as somebody else would otherwise give THAT account a
 * first password typed here — one whoever typed it knows. The server refuses the mismatch
 * before better-auth is asked; the refusal refetches the session so SessionCacheGuard shows
 * the account that is really signed in. `ready` is false until the session is known, and the
 * form keeps its submit disabled until then.
 */
export function useSetPassword() {
  const queryClient = useQueryClient();
  const { data: session, refetch: refetchSession } = useSession();
  const accountId = session?.user.id;
  const mutation = useMutation({
    mutationFn: async (newPassword: string) => {
      // Unreachable while the form honours `ready`.
      if (!accountId) throw new Error('password set before the session was known');
      return unwrap(
        await api.POST('/api/v1/me/password', {
          body: { newPassword, expectedAccountId: accountId },
        }),
      ).data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
    onError: (error: Error) => {
      if (isForAnotherAccount(error)) void refetchSession();
    },
  });
  return { ...mutation, ready: accountId !== undefined };
}

/** `PATCH /api/v1/me` (nickname). Replaces the `['me']` cache with the server's response. */
export function useUpdateNickname() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (nickname: string) =>
      unwrap(await api.PATCH('/api/v1/me', { body: { nickname } })).data,
    onSuccess: (me) => queryClient.setQueryData(ME_QUERY_KEY, me),
  });
}

/** Query key rule from PLAN 11.5. */
export const ACCOUNTS_QUERY_KEY = ['me', 'accounts'] as const;

/**
 * better-auth `listAccounts`: the source of truth for `account` rows (incl. the row id
 * `unlinkAccount` takes) and therefore for "does this user have a password yet".
 *
 * Lives here rather than in either settings section because both of them observe this one
 * key: whichever renders last owns the fetch, so a queryFn written twice would make the
 * error message depend on render order. The catch is belt-and-braces: `fetchOrNetworkError`
 * already turns a transport failure into an ordinary `{ error }`, so nothing should reach
 * it, but a throw from anywhere else must still not surface an English message.
 */
export function useLinkedAccounts() {
  return useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: async () => {
      let result;
      try {
        result = await authClient.listAccounts();
      } catch {
        throw new Error(copy.errNetwork);
      }
      if (result.error) throw new Error(authErrorMessage(result.error));
      return result.data;
    },
  });
}
