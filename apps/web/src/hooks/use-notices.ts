'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { type NoticeListState } from '@buddha/shared';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import {
  type AdminNotice,
  type AdminNoticeSummary,
  type AdminNoticeUpdateResult,
  type CreateNoticeBody,
  type NoticeSummary,
  type UpdateNoticeBody,
  api,
  isApiError,
  unwrap,
} from '@/lib/api';
import {
  ADMIN_NOTICES_KEY,
  type AdminNoticePage,
  NOTICES_KEY,
  PINNED_NOTICES_KEY,
  adminNoticeKey,
  adminNoticeListKey,
  adminNoticeListQuery,
} from '@/lib/notices';

/**
 * 운영 공지 (#138, ADR-0077): the community list's fixed area, and the admin screens' lists, notice
 * and writes. Keys and requests live in lib/notices.ts — the community page seeds the fixed area
 * under its key on the server, and a server component cannot take a key from a `'use client'`
 * module. The option factories are exported apart from the hooks so the node test runner reaches
 * them (use-notices.test.ts), as use-posts.ts does.
 */

/**
 * The fixed area above the community list: `GET /notices`, every pinned notice (at most
 * NOTICE_PIN_LIMIT), the latest pinned first. The community page seeds it, so the HTML holds the
 * area and the browser picks it up rather than reading it again.
 */
export function pinnedNoticesQueryOptions() {
  return {
    queryKey: PINNED_NOTICES_KEY,
    queryFn: async (): Promise<NoticeSummary[]> => unwrap(await api.GET('/api/v1/notices')).data,
  };
}

export function usePinnedNotices() {
  return useQuery(pinnedNoticesQueryOptions());
}

/**
 * One of the admin screen's lists (`GET /admin/notices?state=`), one page per 더 보기: `pinned` —
 * the fixed area's notices in its order, never more than one page (at most NOTICE_PIN_LIMIT) —
 * and `unpinned`, every other notice, the newest written first.
 */
export function adminNoticesInfiniteQueryOptions(state: NoticeListState) {
  return {
    queryKey: adminNoticeListKey(state),
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<AdminNoticePage<AdminNoticeSummary>> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/notices', {
          params: { query: adminNoticeListQuery(state, pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AdminNoticePage<AdminNoticeSummary>) => last.nextCursor ?? undefined,
  };
}

export function useAdminNotices(state: NoticeListState) {
  return useInfiniteQuery(adminNoticesInfiniteQueryOptions(state));
}

/** One notice as the admin's edit screen loads it (`GET /admin/notices/:noticeId`). */
export function adminNoticeQueryOptions(noticeId: string) {
  const id = noticeId.toLowerCase();
  return {
    queryKey: adminNoticeKey(id),
    queryFn: async (): Promise<AdminNotice> =>
      unwrap(
        await api.GET('/api/v1/admin/notices/{noticeId}', { params: { path: { noticeId: id } } }),
      ).data,
  };
}

export function useAdminNotice(noticeId: string) {
  return useQuery(adminNoticeQueryOptions(noticeId));
}

/**
 * What every admin write does with its answer: the notice it answered with replaces the held one,
 * and both admin lists and every public notice read are marked stale — a write, an edit, a pin and
 * an unpin each move a row between or within the lists, and the fixed area shows the pinned ones'
 * titles. The community list's fixed area in this browser follows on its next read.
 */
async function afterNoticeWrite(queryClient: QueryClient, notice: AdminNotice): Promise<void> {
  queryClient.setQueryData<AdminNotice>(adminNoticeKey(notice.id), notice);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: [...ADMIN_NOTICES_KEY, 'list'] }),
    queryClient.invalidateQueries({ queryKey: NOTICES_KEY }),
  ]);
}

/**
 * A refused admin write's side effects: a refusal for the onboarding reads `['me']` again, so the
 * onboarding gate takes the admin to its step; a full fixed area (NOTICE_PIN_LIMIT_REACHED) reads
 * the lists again, since another admin may have pinned what this screen does not show yet.
 */
async function afterNoticeRefusal(queryClient: QueryClient, error: Error): Promise<void> {
  if (isApiError(error, 'ONBOARDING_REQUIRED')) {
    await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });
  }
  if (isApiError(error, 'NOTICE_PIN_LIMIT_REACHED')) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [...ADMIN_NOTICES_KEY, 'list'] }),
      queryClient.invalidateQueries({ queryKey: NOTICES_KEY }),
    ]);
  }
}

/** `POST /admin/notices`: a new notice, not pinned (pinning is its own action and record). */
export function createNoticeOptions(queryClient: QueryClient) {
  return {
    mutationFn: async (body: CreateNoticeBody): Promise<AdminNotice> =>
      unwrap(await api.POST('/api/v1/admin/notices', { body })).data,
    onSuccess: (notice: AdminNotice) => afterNoticeWrite(queryClient, notice),
    onError: (error: Error) => afterNoticeRefusal(queryClient, error),
  };
}

/** An edit: the notice, and the title and body that replace its own. */
export interface UpdateNoticeVariables extends UpdateNoticeBody {
  noticeId: string;
}

/**
 * `PUT /admin/notices/:noticeId`, by any admin (#45-8). A change marks the notice edited and keeps
 * the earlier version for operators; the same content changes nothing. The answer says which
 * (`changed`), and the screen's toast reads that rather than comparing `editedAt` with the one it
 * holds: another admin's edit this screen has not read yet moves `editedAt` too, so a save of
 * what that edit already says would read as a change. Only the notice goes into the cache.
 */
export function updateNoticeOptions(queryClient: QueryClient) {
  return {
    mutationFn: async ({
      noticeId,
      ...body
    }: UpdateNoticeVariables): Promise<AdminNoticeUpdateResult> =>
      unwrap(
        await api.PUT('/api/v1/admin/notices/{noticeId}', {
          params: { path: { noticeId: noticeId.toLowerCase() } },
          body,
        }),
      ).data,
    onSuccess: (result: AdminNoticeUpdateResult) => afterNoticeWrite(queryClient, result.notice),
    onError: (error: Error) => afterNoticeRefusal(queryClient, error),
  };
}

/**
 * `POST /admin/notices/:noticeId/pin` or `/unpin`. The server holds the limit, race-safe: a pin
 * while NOTICE_PIN_LIMIT are pinned is refused (NOTICE_PIN_LIMIT_REACHED) and none is unpinned to
 * make room. Pinning a pinned notice, or unpinning one that is not, changes nothing.
 */
export function pinNoticeOptions(queryClient: QueryClient, action: 'pin' | 'unpin') {
  return {
    mutationFn: async (noticeId: string): Promise<AdminNotice> => {
      const params = { params: { path: { noticeId: noticeId.toLowerCase() } } };
      return unwrap(
        action === 'pin'
          ? await api.POST('/api/v1/admin/notices/{noticeId}/pin', params)
          : await api.POST('/api/v1/admin/notices/{noticeId}/unpin', params),
      ).data;
    },
    onSuccess: (notice: AdminNotice) => afterNoticeWrite(queryClient, notice),
    onError: (error: Error) => afterNoticeRefusal(queryClient, error),
  };
}

export function useCreateNotice() {
  const queryClient = useQueryClient();
  return useMutation(createNoticeOptions(queryClient));
}

export function useUpdateNotice() {
  const queryClient = useQueryClient();
  return useMutation(updateNoticeOptions(queryClient));
}

export function usePinNotice() {
  const queryClient = useQueryClient();
  return useMutation(pinNoticeOptions(queryClient, 'pin'));
}

export function useUnpinNotice() {
  const queryClient = useQueryClient();
  return useMutation(pinNoticeOptions(queryClient, 'unpin'));
}
