'use client';

import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type CreateReportBody,
  type MyModerationAction,
  type MyReport,
  api,
  isApiError,
  unwrap,
} from '@/lib/api';
import { AUTHORED_KEY } from '@/lib/authored';
import { postCommentsKey } from '@/lib/comments';
import { MY_ACTIONS_KEY, MY_REPORTS_KEY, type ModerationPage } from '@/lib/moderation';
import { POST_LIST_KEY, postKey } from '@/lib/posts';
import { useSession } from '@/lib/use-session';
import { afterRefusal } from './use-posts';

/**
 * 신고 (#50, ADR-0081), the member's side: a report of a post, a comment or a profile, and the
 * member's own 조치·신고 내역 — the reports they filed and the actions operators took on them,
 * each a cursor list newest first, one page per 더 보기 (the community list's idiom).
 *
 * Both lists are the member's own (`GET /me/reports`, `/me/moderation/actions`): read with their
 * cookie under the private `my-moderation` root, once the session is known (a signed-out request
 * would take a 401 the retry rule refuses to retry), and read again whenever the page mounts —
 * what changes them happens elsewhere: a report on a post page, an operator's processing on
 * another machine.
 *
 * The option factories are exported apart from the hooks so the node test runner reaches them
 * (use-reports.test.ts), as use-watchlist.ts does.
 */

/** Just enough of better-auth's session to say whether anybody is signed in (use-watchlist.ts). */
type SessionLike = { user: unknown } | null;

const cursorQuery = (cursor: string | undefined) => (cursor === undefined ? {} : { cursor });

function pages<Row>(
  queryKey: readonly unknown[],
  read: (cursor: string | undefined) => Promise<ModerationPage<Row>>,
  session: SessionLike | undefined,
) {
  return {
    queryKey,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => read(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ModerationPage<Row>) => last.nextCursor ?? undefined,
    refetchOnMount: 'always' as const,
    enabled: session != null,
  };
}

/** `GET /me/reports`: the member's reports with 접수·조치함·기각. */
export function myReportsInfiniteQueryOptions(session?: SessionLike) {
  return pages<MyReport>(
    MY_REPORTS_KEY,
    async (cursor) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/me/reports', { params: { query: cursorQuery(cursor) } }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    session,
  );
}

/** `GET /me/moderation/actions`: the actions operators took on the member. */
export function myModerationActionsInfiniteQueryOptions(session?: SessionLike) {
  return pages<MyModerationAction>(
    MY_ACTIONS_KEY,
    async (cursor) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/me/moderation/actions', {
          params: { query: cursorQuery(cursor) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    session,
  );
}

export function useMyReports() {
  const { data: session } = useSession();
  return useInfiniteQuery(myReportsInfiniteQueryOptions(session));
}

export function useMyModerationActions() {
  const { data: session } = useSession();
  return useInfiniteQuery(myModerationActionsInfiniteQueryOptions(session));
}

/**
 * What is reported: a post (with the post page it is on), a comment (with its post) or a profile
 * by its public id. The post's id says which page to read again when the report finds the item a
 * placeholder.
 */
export type ReportSubject =
  | { type: 'post'; postId: string }
  | { type: 'comment'; commentId: string; postId: string }
  | { type: 'profile'; publicId: string };

/** A report: what, and the body (one reason, the description, the account on screen). */
export interface ReportVariables extends CreateReportBody {
  subject: ReportSubject;
}

async function postReport({ subject, ...body }: ReportVariables): Promise<MyReport> {
  switch (subject.type) {
    case 'post':
      return unwrap(
        await api.POST('/api/v1/posts/{postId}/reports', {
          params: { path: { postId: subject.postId.toLowerCase() } },
          body,
        }),
      ).data;
    case 'comment':
      return unwrap(
        await api.POST('/api/v1/comments/{commentId}/reports', {
          params: { path: { commentId: subject.commentId.toLowerCase() } },
          body,
        }),
      ).data;
    case 'profile':
      return unwrap(
        await api.POST('/api/v1/profiles/{publicId}/reports', {
          params: { path: { publicId: subject.publicId.toLowerCase() } },
          body,
        }),
      ).data;
  }
}

/**
 * `POST …/reports` as mutation options. A report taken marks the member's 내가 한 신고 stale (the
 * new one is its newest). A refusal that the target became a placeholder or left every view
 * (`deleted`, `hidden`, NOT_FOUND) reads the post and its comments again — and the lists whose
 * cards carry 신고 (owner decision 2026-10-21), none of which holds a hidden or deleted item: the
 * community list and a market detail's 토론 (#47, ADR-0081 결과 5 — both under `POST_LIST_KEY`, the
 * 토론 as `marketPostsKey`) and a profile's 글·댓글 tabs (`AUTHORED_KEY`, whichever profile is on
 * screen) — so the page shows what it is now and the card leaves its list; the dialog says why. A
 * refusal for the onboarding or of another account's cookie does what every refused write does
 * (`afterRefusal`). Nothing here is optimistic: a report changes nothing on the page.
 */
export function reportOptions(queryClient: QueryClient, onSessionChanged: () => void) {
  return {
    mutationFn: postReport,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MY_REPORTS_KEY }),
    onError: async (error: Error, variables: ReportVariables) => {
      await afterRefusal(queryClient, error, onSessionChanged);
      if (!isStaleReportRefusal(error)) return;
      const { subject } = variables;
      if (subject.type === 'profile') return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: postKey(subject.postId) }),
        queryClient.invalidateQueries({ queryKey: postCommentsKey(subject.postId) }),
        queryClient.invalidateQueries({ queryKey: POST_LIST_KEY }),
        queryClient.invalidateQueries({ queryKey: AUTHORED_KEY }),
      ]);
    },
  };
}

/** Whether a refusal means the page is out of date: the target is a placeholder now, or gone. */
export function isStaleReportRefusal(error: unknown): boolean {
  if (isApiError(error, 'NOT_FOUND')) return true;
  if (!isApiError(error, 'REPORT_NOT_ALLOWED')) return false;
  const details: unknown = error.details;
  return (
    typeof details === 'object' &&
    details !== null &&
    'reason' in details &&
    (details.reason === 'deleted' || details.reason === 'hidden')
  );
}

export function useReport(onSessionChanged: () => void) {
  const queryClient = useQueryClient();
  return useMutation(reportOptions(queryClient, onSessionChanged));
}
