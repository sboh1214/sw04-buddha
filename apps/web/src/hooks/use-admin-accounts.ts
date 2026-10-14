'use client';

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { type GrantCandidatePage, revokedOwnRole } from '@/lib/admin-accounts';
import {
  api,
  isApiError,
  isForAnotherAccount,
  type AdminAccount,
  type AdminGrantBody,
  type AdminRoleChange,
  unwrap,
} from '@/lib/api';
import { useSession } from '@/lib/use-session';

/**
 * 운영자 계정 (#171). Under the `admin` root (`PRIVATE_QUERY_ROOTS`); the list, the record and
 * the grant search share this prefix, so one invalidation refreshes all three.
 */
export const ADMIN_ACCOUNTS_KEY = ['admin', 'admins'] as const;
const LIST_KEY = [...ADMIN_ACCOUNTS_KEY, 'list'] as const;
const CHANGES_KEY = [...ADMIN_ACCOUNTS_KEY, 'changes'] as const;
const CANDIDATES_KEY = [...ADMIN_ACCOUNTS_KEY, 'candidates'] as const;
/** The 사용자 screen's search (admin-users.tsx), whose 관리자 badges a role change makes stale. */
const ADMIN_USERS_KEY = ['admin', 'users'] as const;

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Every account that holds the admin role now, oldest first (`GET /admin/admins`). */
export function useAdmins() {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async (): Promise<readonly AdminAccount[]> =>
      unwrap(await api.GET('/api/v1/admin/admins')).data,
  });
}

/** Grants and revokes, newest first, 20 per page with 더 보기 (`GET /admin/admins/changes`). */
export function useAdminRoleChanges() {
  return useInfiniteQuery({
    queryKey: CHANGES_KEY,
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<Page<AdminRoleChange>> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/admins/changes', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page<AdminRoleChange>) => last.nextCursor ?? undefined,
  });
}

/**
 * The accounts a grant can be aimed at: the 사용자 search (`GET /admin/users?q=`, email or
 * nickname), asked only once a term is given. Each row carries its role, so an admin already is
 * marked rather than offered. Each page carries its term: the previous term's pages stay on
 * screen while a new one loads (`keepPreviousData`), and `grantSearchRows` offers no 부여 on them.
 */
export function useAdminGrantCandidates(term: string) {
  return useInfiniteQuery({
    queryKey: [...CANDIDATES_KEY, term],
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<GrantCandidatePage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/users', {
          params: { query: { q: term, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      );
      return { term, items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: GrantCandidatePage) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: term !== '',
  });
}

/**
 * A grant or a revoke changes the admin list, the record and the role every search shows, so
 * an answer re-reads all of them — a refusal too: another admin may have changed the role first.
 * A request that never came back refreshes nothing. The refusal that the cookie is another
 * account's (`isForAnotherAccount`: another tab signed in, and both bodies name the admin on
 * screen) refetches the session instead, so SessionCacheGuard empties the cache and the screen
 * shows the account that is really signed in. Toasts and dialogs are the caller's.
 */
function useRefreshAdminAccounts() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ADMIN_ACCOUNTS_KEY }),
      queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY }),
    ]);
  return {
    refresh,
    onError: async (error: unknown) => {
      if (isForAnotherAccount(error)) {
        void refetchSession();
        return;
      }
      if (isApiError(error)) await refresh();
    },
  };
}

/**
 * `POST /admin/admins`: make an account an admin, with a reason, as the admin on screen
 * (`expectedAccountId`, `screenAccountId` when submitted).
 */
export function useGrantAdmin() {
  const { refresh, onError } = useRefreshAdminAccounts();
  return useMutation({
    mutationFn: async (body: AdminGrantBody) =>
      unwrap(await api.POST('/api/v1/admin/admins', { body })).data,
    onSuccess: () => refresh(),
    onError,
  });
}

export interface RevokeAdminVariables {
  userId: string;
  reason: string;
  /** The admin the screen shows (`screenAccountId` when submitted); the server checks it. */
  expectedAccountId: string;
}

export interface RevokeAdminResult {
  change: AdminRoleChange;
  /**
   * The answer revoked the role of the account that sent it (`revokedOwnRole`): its sessions are
   * gone, so nothing is re-read and the caller signs the tab out. Taken from the answer, never
   * from what the screen believed when sending.
   */
  self: boolean;
}

/** `POST /admin/admins/:userId/revoke`: take the role away, with a reason, as the admin on screen. */
export function useRevokeAdmin() {
  const { refresh, onError } = useRefreshAdminAccounts();
  return useMutation({
    mutationFn: async ({
      userId,
      reason,
      expectedAccountId,
    }: RevokeAdminVariables): Promise<RevokeAdminResult> => {
      const change = unwrap(
        await api.POST('/api/v1/admin/admins/{userId}/revoke', {
          params: { path: { userId } },
          body: { reason, expectedAccountId },
        }),
      ).data;
      return { change, self: revokedOwnRole(change, expectedAccountId) };
    },
    onSuccess: async ({ self }: RevokeAdminResult) => {
      if (!self) await refresh();
    },
    onError,
  });
}
