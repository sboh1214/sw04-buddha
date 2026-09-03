'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { copy } from '@/copy';
import { api, unwrap, type Me } from '@/lib/api';
import { authClient, authErrorMessage, useSession } from '@/lib/auth-client';

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
 * `POST /api/v1/me/password`: the first password of an account that has none (after the
 * sign-up verification, or for a social-only user). Refreshes the linked-account list, which
 * decides whether the settings screen offers "set" or "change".
 */
export function useSetPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (newPassword: string) =>
      unwrap(await api.POST('/api/v1/me/password', { body: { newPassword } })).data,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
  });
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
