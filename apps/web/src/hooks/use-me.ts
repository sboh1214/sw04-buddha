'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import { api, unwrap, type Me } from '@/lib/api';

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

/** `PATCH /api/v1/me` (nickname). Replaces the `['me']` cache with the server's response. */
export function useUpdateNickname() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (nickname: string) =>
      unwrap(await api.PATCH('/api/v1/me', { body: { nickname } })).data,
    onSuccess: (me) => queryClient.setQueryData(ME_QUERY_KEY, me),
  });
}
