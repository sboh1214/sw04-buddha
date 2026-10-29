'use client';

import { type AccountRestrictionRequestQueue, type AdminReportQueue } from '@buddha/shared';
import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type AccountRestrictionBody,
  type AccountRestrictionDecision,
  type AccountRestrictionRequest,
  type AdminCommentModeration,
  type AdminModerationAction,
  type AdminPostModeration,
  type AdminReportGroup,
  type AdminUserModeration,
  type ApprovalDecisionBody,
  type ApprovalRetractionBody,
  type CancelModerationBody,
  type DismissReportsBody,
  type DismissedReports,
  type LiftRestrictionBody,
  type ModerationActionBody,
  type ShortenRestrictionBody,
  type WarningBody,
  type WritingRestrictionBody,
  api,
  isApiError,
  isForAnotherAccount,
  unwrap,
} from '@/lib/api';
import {
  ADMIN_ACTIONS_KEY,
  ADMIN_MODERATION_KEY,
  type ModerationPage,
  adminAccountRequestQueueKey,
  adminCommentModerationKey,
  adminPostModerationKey,
  adminProfileModerationKey,
  adminReportQueueKey,
  adminUserModerationKey,
} from '@/lib/moderation';
import { useSession } from '@/lib/use-session';

/**
 * 신고·조치 (#50, ADR-0081), the operators' side: the report queue (grouped by target, its two
 * halves), every action, the moderation pages of a post, a comment and a member, and the actions
 * themselves — the writing restriction, its lift and its 감경 among them (#185, ADR-0082) — and the
 * account restriction's requests and their decisions by another admin (#139, ADR-0085). Every
 * admin reads all of it (ADR-0056 1-2). Under the `admin` root (`PRIVATE_QUERY_ROOTS`,
 * `ADMIN_MODERATION_KEY`): an action answered — or refused, since another
 * operator may have acted first — re-reads the whole area, so the queue, the log and every page
 * agree with what was just done.
 *
 * The option factories are exported apart from the hooks so the node test runner reaches them
 * (use-admin-moderation.test.ts).
 */

const cursorQuery = (cursor: string | undefined) => (cursor === undefined ? {} : { cursor });

/** `GET /admin/reports?status=`: one half of the queue, 20 entries a page with 더 보기. */
export function adminReportQueueInfiniteQueryOptions(queue: AdminReportQueue) {
  return {
    queryKey: adminReportQueueKey(queue),
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<ModerationPage<AdminReportGroup>> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/reports', {
          params: { query: { status: queue, ...cursorQuery(pageParam) } },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ModerationPage<AdminReportGroup>) => last.nextCursor ?? undefined,
    refetchOnMount: 'always' as const,
  };
}

export function useAdminReportQueue(queue: AdminReportQueue) {
  return useInfiniteQuery(adminReportQueueInfiniteQueryOptions(queue));
}

/** `GET /admin/moderation/actions`: every action, newest first. */
export function adminActionsInfiniteQueryOptions() {
  return {
    queryKey: ADMIN_ACTIONS_KEY,
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<ModerationPage<AdminModerationAction>> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/moderation/actions', {
          params: { query: cursorQuery(pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ModerationPage<AdminModerationAction>) => last.nextCursor ?? undefined,
    refetchOnMount: 'always' as const,
  };
}

export function useAdminModerationActions() {
  return useInfiniteQuery(adminActionsInfiniteQueryOptions());
}

/**
 * `GET /admin/moderation/account-restriction-requests?status=` (#139): one part of the account
 * restriction requests — `pending`, the one waiting longest first, `decided`, the latest decision
 * first, or `retracted`, the latest retraction first — 20 a page with 더 보기.
 */
export function adminAccountRequestsInfiniteQueryOptions(queue: AccountRestrictionRequestQueue) {
  return {
    queryKey: adminAccountRequestQueueKey(queue),
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<ModerationPage<AccountRestrictionRequest>> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/moderation/account-restriction-requests', {
          params: { query: { status: queue, ...cursorQuery(pageParam) } },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ModerationPage<AccountRestrictionRequest>) =>
      last.nextCursor ?? undefined,
    refetchOnMount: 'always' as const,
  };
}

export function useAdminAccountRequests(queue: AccountRestrictionRequestQueue) {
  return useInfiniteQuery(adminAccountRequestsInfiniteQueryOptions(queue));
}

/** `GET /admin/moderation/posts/:postId`: the post whatever its state, its reports and actions. */
export function adminPostModerationQueryOptions(postId: string) {
  const id = postId.toLowerCase();
  return {
    queryKey: adminPostModerationKey(id),
    queryFn: async (): Promise<AdminPostModeration> =>
      unwrap(
        await api.GET('/api/v1/admin/moderation/posts/{postId}', {
          params: { path: { postId: id } },
        }),
      ).data,
    refetchOnMount: 'always' as const,
  };
}

export function useAdminPostModeration(postId: string) {
  return useQuery(adminPostModerationQueryOptions(postId));
}

/** `GET /admin/moderation/comments/:commentId`. */
export function adminCommentModerationQueryOptions(commentId: string) {
  const id = commentId.toLowerCase();
  return {
    queryKey: adminCommentModerationKey(id),
    queryFn: async (): Promise<AdminCommentModeration> =>
      unwrap(
        await api.GET('/api/v1/admin/moderation/comments/{commentId}', {
          params: { path: { commentId: id } },
        }),
      ).data,
    refetchOnMount: 'always' as const,
  };
}

export function useAdminCommentModeration(commentId: string) {
  return useQuery(adminCommentModerationQueryOptions(commentId));
}

/** `GET /admin/moderation/users/:userId`: the member's profile now, its reports, every action. */
export function adminUserModerationQueryOptions(userId: string) {
  return {
    queryKey: adminUserModerationKey(userId),
    queryFn: async (): Promise<AdminUserModeration> =>
      unwrap(
        await api.GET('/api/v1/admin/moderation/users/{userId}', {
          params: { path: { userId } },
        }),
      ).data,
    refetchOnMount: 'always' as const,
  };
}

export function useAdminUserModeration(userId: string) {
  return useQuery(adminUserModerationQueryOptions(userId));
}

/**
 * `GET /admin/moderation/profiles/:publicId`: the same page found by a profile's public id — where
 * a public profile's '운영' link lands (owner decision 2026-10-21).
 */
export function adminProfileModerationQueryOptions(publicId: string) {
  const id = publicId.toLowerCase();
  return {
    queryKey: adminProfileModerationKey(id),
    queryFn: async (): Promise<AdminUserModeration> =>
      unwrap(
        await api.GET('/api/v1/admin/moderation/profiles/{publicId}', {
          params: { path: { publicId: id } },
        }),
      ).data,
    refetchOnMount: 'always' as const,
  };
}

export function useAdminProfileModeration(publicId: string) {
  return useQuery(adminProfileModerationQueryOptions(publicId));
}

/**
 * One operator action, as the dialogs send it: hiding a post or a comment, a warning, one of the
 * three profile items (#37-10), a writing restriction and its early lift or 감경 (#185, ADR-0082),
 * a cancellation, a dismissal — and the account restriction's requests (to restrict, to shorten,
 * to lift early, to cancel), the decisions on them (#139, ADR-0085) and their retraction by the
 * one who asked (owner decision 2026-10-23). Each body names the admin on screen
 * (`expectedAccountId`).
 */
export type ModerationVariables =
  | { kind: 'hide-post'; postId: string; body: ModerationActionBody }
  | { kind: 'hide-comment'; commentId: string; body: ModerationActionBody }
  | { kind: 'warn'; userId: string; body: WarningBody }
  | { kind: 'restrict'; userId: string; body: WritingRestrictionBody }
  | { kind: 'shorten'; actionId: string; body: ShortenRestrictionBody }
  | { kind: 'lift'; actionId: string; body: LiftRestrictionBody }
  | {
      kind: 'nickname-reset' | 'bio-clear' | 'image-remove';
      userId: string;
      body: ModerationActionBody;
    }
  | { kind: 'cancel'; actionId: string; body: CancelModerationBody }
  | { kind: 'dismiss'; body: DismissReportsBody }
  | { kind: 'account-restrict'; userId: string; body: AccountRestrictionBody }
  | { kind: 'account-shorten'; actionId: string; body: ShortenRestrictionBody }
  | { kind: 'account-lift'; actionId: string; body: LiftRestrictionBody }
  | { kind: 'account-cancel'; actionId: string; body: CancelModerationBody }
  | { kind: 'approve' | 'reject'; requestId: string; body: ApprovalDecisionBody }
  | { kind: 'retract'; requestId: string; body: ApprovalRetractionBody };

async function moderate(
  variables: ModerationVariables,
): Promise<
  AdminModerationAction | DismissedReports | AccountRestrictionRequest | AccountRestrictionDecision
> {
  switch (variables.kind) {
    case 'hide-post':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/posts/{postId}/hide', {
          params: { path: { postId: variables.postId.toLowerCase() } },
          body: variables.body,
        }),
      ).data;
    case 'hide-comment':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/comments/{commentId}/hide', {
          params: { path: { commentId: variables.commentId.toLowerCase() } },
          body: variables.body,
        }),
      ).data;
    case 'warn':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/users/{userId}/warn', {
          params: { path: { userId: variables.userId } },
          body: variables.body,
        }),
      ).data;
    case 'restrict':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/users/{userId}/writing-restriction', {
          params: { path: { userId: variables.userId } },
          body: variables.body,
        }),
      ).data;
    case 'shorten':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/actions/{actionId}/shorten', {
          params: { path: { actionId: variables.actionId.toLowerCase() } },
          body: variables.body,
        }),
      ).data;
    case 'lift':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/actions/{actionId}/lift', {
          params: { path: { actionId: variables.actionId.toLowerCase() } },
          body: variables.body,
        }),
      ).data;
    case 'nickname-reset':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/users/{userId}/nickname-reset', {
          params: { path: { userId: variables.userId } },
          body: variables.body,
        }),
      ).data;
    case 'bio-clear':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/users/{userId}/bio-clear', {
          params: { path: { userId: variables.userId } },
          body: variables.body,
        }),
      ).data;
    case 'image-remove':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/users/{userId}/image-remove', {
          params: { path: { userId: variables.userId } },
          body: variables.body,
        }),
      ).data;
    case 'cancel':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/actions/{actionId}/cancel', {
          params: { path: { actionId: variables.actionId.toLowerCase() } },
          body: variables.body,
        }),
      ).data;
    case 'dismiss':
      return unwrap(await api.POST('/api/v1/admin/reports/dismiss', { body: variables.body })).data;
    case 'account-restrict':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/users/{userId}/account-restriction', {
          params: { path: { userId: variables.userId } },
          body: variables.body,
        }),
      ).data;
    case 'account-shorten':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/actions/{actionId}/account-restriction/shorten', {
          params: { path: { actionId: variables.actionId.toLowerCase() } },
          body: variables.body,
        }),
      ).data;
    case 'account-lift':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/actions/{actionId}/account-restriction/lift', {
          params: { path: { actionId: variables.actionId.toLowerCase() } },
          body: variables.body,
        }),
      ).data;
    case 'account-cancel':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/actions/{actionId}/account-restriction/cancel', {
          params: { path: { actionId: variables.actionId.toLowerCase() } },
          body: variables.body,
        }),
      ).data;
    case 'approve':
      return unwrap(
        await api.POST(
          '/api/v1/admin/moderation/account-restriction-requests/{requestId}/approve',
          {
            params: { path: { requestId: variables.requestId.toLowerCase() } },
            body: variables.body,
          },
        ),
      ).data;
    case 'reject':
      return unwrap(
        await api.POST('/api/v1/admin/moderation/account-restriction-requests/{requestId}/reject', {
          params: { path: { requestId: variables.requestId.toLowerCase() } },
          body: variables.body,
        }),
      ).data;
    case 'retract':
      return unwrap(
        await api.POST(
          '/api/v1/admin/moderation/account-restriction-requests/{requestId}/retract',
          {
            params: { path: { requestId: variables.requestId.toLowerCase() } },
            body: variables.body,
          },
        ),
      ).data;
  }
}

/**
 * The mutation options of every operator action. An answer re-reads the whole moderation area
 * (`ADMIN_MODERATION_KEY`, the account restriction requests among it) — and so does a refusal the
 * API gave, since another operator may have hidden, cancelled, processed or decided it first and
 * the page should show what is so. The cookie of another account (`isForAnotherAccount`) asks for
 * the session again instead, so SessionCacheGuard empties the cache and the screen shows who is
 * really signed in. Toasts and dialogs are the caller's.
 */
export function moderationOptions(queryClient: QueryClient, onSessionChanged: () => void) {
  const refresh = () => queryClient.invalidateQueries({ queryKey: ADMIN_MODERATION_KEY });
  return {
    mutationFn: moderate,
    onSuccess: refresh,
    onError: async (error: Error) => {
      if (isForAnotherAccount(error)) {
        onSessionChanged();
        return;
      }
      if (isApiError(error)) await refresh();
    },
  };
}

export function useModerate() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(moderationOptions(queryClient, () => void refetchSession()));
}
