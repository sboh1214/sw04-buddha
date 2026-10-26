'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  isApiError,
  isForAnotherAccount,
  type ReleaseSetting,
  type ReleaseSettingChange,
  type ReleaseSettingChangeBody,
  unwrap,
} from '@/lib/api';
import { replaceReleaseSetting } from '@/lib/release-settings';
import { useSession } from '@/lib/use-session';

/**
 * 출시 설정 (#170). Under the `admin` root (`PRIVATE_QUERY_ROOTS`); the list and the change log
 * share this prefix, so one invalidation refreshes both.
 */
export const ADMIN_RELEASE_SETTINGS_KEY = ['admin', 'release-settings'] as const;
const LIST_KEY = [...ADMIN_RELEASE_SETTINGS_KEY, 'list'] as const;
const CHANGES_KEY = [...ADMIN_RELEASE_SETTINGS_KEY, 'changes'] as const;

/**
 * Every registered item in registry order (`GET /admin/release-settings`, unpaginated). The
 * undecided-only view filters this list rather than asking `?status=undecided`, so the screen
 * still knows whether the registry is empty and how many items it holds.
 */
export function useReleaseSettings() {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async (): Promise<readonly ReleaseSetting[]> =>
      unwrap(await api.GET('/api/v1/admin/release-settings')).data,
  });
}

interface ReleaseSettingChangePage {
  items: ReleaseSettingChange[];
  nextCursor: string | null;
}

/** The change records of every item, newest first, 20 per page with 더 보기 (A-M2-5). */
export function useReleaseSettingChanges() {
  return useInfiniteQuery({
    queryKey: CHANGES_KEY,
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<ReleaseSettingChangePage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/release-settings/changes', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ReleaseSettingChangePage) => last.nextCursor ?? undefined,
  });
}

export interface ChangeReleaseSettingVariables {
  key: string;
  body: ReleaseSettingChangeBody;
}

/**
 * `PATCH /admin/release-settings/:key`: a new status and value with a reason. The answer is the
 * item as it now is: it is written over its copy first, then the list and the change log are
 * re-read in one go (the new record is the log's first row). A refusal from the API refreshes
 * too — another admin may have changed the item, or a release dropped it — and a request that
 * never came back refreshes nothing. The cookie of another account (`isForAnotherAccount` — the
 * body names the admin on screen, ADR-0092) asks for the session again instead, so
 * SessionCacheGuard empties the cache and the screen shows who is really signed in. The toast and
 * the dialog are the caller's, per `mutate`.
 */
export function useChangeReleaseSetting() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ADMIN_RELEASE_SETTINGS_KEY });
  return useMutation({
    mutationFn: async ({ key, body }: ChangeReleaseSettingVariables) =>
      unwrap(
        await api.PATCH('/api/v1/admin/release-settings/{key}', {
          params: { path: { key } },
          body,
        }),
      ).data,
    onSuccess: (fresh: ReleaseSetting) => {
      queryClient.setQueryData<readonly ReleaseSetting[]>(LIST_KEY, (list) =>
        replaceReleaseSetting(list, fresh),
      );
      return refresh();
    },
    onError: async (error: unknown) => {
      if (isForAnotherAccount(error)) {
        void refetchSession();
        return;
      }
      if (isApiError(error)) await refresh();
    },
  });
}
