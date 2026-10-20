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
  type AdminNoticeAction,
  type AdminNoticeRevision,
  type AdminNoticeRevisionSummary,
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
  adminNoticeActionsKey,
  adminNoticeKey,
  adminNoticeListKey,
  adminNoticeListQuery,
  adminNoticePageQuery,
  adminNoticeRevisionKey,
  adminNoticeRevisionsKey,
  noticeEditConflict,
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

/**
 * A notice's operation records (`GET /admin/notices/:noticeId/actions`, owner decision 2026-10-21):
 * who wrote, edited, pinned and unpinned it, and when — newest first, one page per 더 보기.
 */
export function adminNoticeActionsInfiniteQueryOptions(noticeId: string) {
  const id = noticeId.toLowerCase();
  return {
    queryKey: adminNoticeActionsKey(id),
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<AdminNoticePage<AdminNoticeAction>> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/notices/{noticeId}/actions', {
          params: { path: { noticeId: id }, query: adminNoticePageQuery(pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AdminNoticePage<AdminNoticeAction>) => last.nextCursor ?? undefined,
  };
}

export function useAdminNoticeActions(noticeId: string) {
  return useInfiniteQuery(adminNoticeActionsInfiniteQueryOptions(noticeId));
}

/**
 * A notice's earlier versions (`GET /admin/notices/:noticeId/revisions`, owner decision
 * 2026-10-21): each title, who wrote and who replaced it and when — newest first, one page per
 * 더 보기.
 */
export function adminNoticeRevisionsInfiniteQueryOptions(noticeId: string) {
  const id = noticeId.toLowerCase();
  return {
    queryKey: adminNoticeRevisionsKey(id),
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<AdminNoticePage<AdminNoticeRevisionSummary>> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/notices/{noticeId}/revisions', {
          params: { path: { noticeId: id }, query: adminNoticePageQuery(pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AdminNoticePage<AdminNoticeRevisionSummary>) =>
      last.nextCursor ?? undefined,
  };
}

export function useAdminNoticeRevisions(noticeId: string) {
  return useInfiniteQuery(adminNoticeRevisionsInfiniteQueryOptions(noticeId));
}

/**
 * One earlier version, whole and read-only (`GET /admin/notices/:noticeId/revisions/:revisionId`).
 * The path segment goes as it came: the API refuses one that is not a version id (400), which the
 * screen reads as no version, as it reads an unknown one (404). A version never changes (the app
 * role cannot UPDATE `notice_revisions`), so once read it never goes stale on its own: no refocus
 * or return to the screen reads it again. Only a write to that notice, or a refused edit of it,
 * reads it again, since they mark everything under the notice's key stale (`afterNoticeWrite`,
 * `afterNoticeRefusal`) — one needless read, never a different version.
 */
export function adminNoticeRevisionQueryOptions(noticeId: string, revisionId: string) {
  const id = noticeId.toLowerCase();
  return {
    staleTime: Infinity,
    queryKey: adminNoticeRevisionKey(id, revisionId),
    queryFn: async (): Promise<AdminNoticeRevision> =>
      unwrap(
        await api.GET('/api/v1/admin/notices/{noticeId}/revisions/{revisionId}', {
          params: { path: { noticeId: id, revisionId } },
        }),
      ).data,
  };
}

export function useAdminNoticeRevision(noticeId: string, revisionId: string) {
  return useQuery(adminNoticeRevisionQueryOptions(noticeId, revisionId));
}

/**
 * One notice as the admin's edit screen loads it (`GET /admin/notices/:noticeId`) — read again
 * every time the screen opens, however fresh the copy held: the edit form opens only on a read made
 * since the screen opened (`adminNoticeReadView`), since it saves against the version it opens on
 * and a copy from an earlier visit (or a pin's answer on the list) may predate another admin's save.
 */
export function adminNoticeQueryOptions(noticeId: string) {
  const id = noticeId.toLowerCase();
  return {
    refetchOnMount: 'always' as const,
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
 * and both admin lists, that notice's records and earlier versions, and every public notice read
 * are marked stale — a write, an edit, a pin and an unpin each move a row between or within the
 * lists and add a record (an edit a version too), and the fixed area shows the pinned ones'
 * titles. The community list's fixed area in this browser follows on its next read.
 */
async function afterNoticeWrite(queryClient: QueryClient, notice: AdminNotice): Promise<void> {
  queryClient.setQueryData<AdminNotice>(adminNoticeKey(notice.id), notice);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: [...ADMIN_NOTICES_KEY, 'list'] }),
    queryClient.invalidateQueries({ queryKey: adminNoticeActionsKey(notice.id) }),
    queryClient.invalidateQueries({ queryKey: adminNoticeRevisionsKey(notice.id) }),
    queryClient.invalidateQueries({ queryKey: NOTICES_KEY }),
  ]);
}

/**
 * A refused admin write's side effects: a refusal for the onboarding reads `['me']` again, so the
 * onboarding gate takes the admin to its step; a full fixed area (NOTICE_PIN_LIMIT_REACHED) reads
 * the lists again, since another admin may have pinned what this screen does not show yet; an edit
 * another admin's save overtook (NOTICE_EDIT_CONFLICT, `noticeId` given) reads that notice, its
 * records and versions and the lists again, so the screen shows what was saved meanwhile — the
 * form keeps what is typed (it holds its own draft).
 */
async function afterNoticeRefusal(
  queryClient: QueryClient,
  error: Error,
  noticeId?: string,
): Promise<void> {
  if (noticeId !== undefined && noticeEditConflict(error)) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: adminNoticeKey(noticeId) }),
      queryClient.invalidateQueries({ queryKey: [...ADMIN_NOTICES_KEY, 'list'] }),
      queryClient.invalidateQueries({ queryKey: NOTICES_KEY }),
    ]);
  }
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

/**
 * An edit: the notice, the title and body that replace its own, and the version the edit screen
 * was opened from (`expectedEditedAt`, the notice's `editedAt` then — null when never edited).
 */
export interface UpdateNoticeVariables extends UpdateNoticeBody {
  noticeId: string;
}

/**
 * `PUT /admin/notices/:noticeId`, by any admin (#45-8). A change marks the notice edited and keeps
 * the earlier version for operators; the same content changes nothing. The answer says which
 * (`changed`), and the screen's toast reads that. Only the notice goes into the cache. A save from
 * a version another admin has replaced since is refused (NOTICE_EDIT_CONFLICT, owner decision
 * 2026-10-21) and nothing is written: the notice is read again (`afterNoticeRefusal`).
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
    onError: (error: Error, variables: UpdateNoticeVariables) =>
      afterNoticeRefusal(queryClient, error, variables.noticeId),
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
