'use client';

import { type AdminReportQueue } from '@buddha/shared';
import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type AdminCommentModeration,
  type AdminModerationAction,
  type AdminPostModeration,
  type AdminReportGroup,
  type AdminUserModeration,
  type CancelModerationBody,
  type DismissReportsBody,
  type DismissedReports,
  type ModerationActionBody,
  type WarningBody,
  api,
  isApiError,
  isForAnotherAccount,
  unwrap,
} from '@/lib/api';
import {
  ADMIN_ACTIONS_KEY,
  ADMIN_MODERATION_KEY,
  type ModerationPage,
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
 * themselves. Every admin reads all of it (ADR-0056 1-2). Under the `admin` root
 * (`PRIVATE_QUERY_ROOTS`, `ADMIN_MODERATION_KEY`): an action answered — or refused, since another
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
 * three profile items (#37-10), a cancellation, a dismissal. Each body names the admin on screen
 * (`expectedAccountId`).
 */
export type ModerationVariables =
  | { kind: 'hide-post'; postId: string; body: ModerationActionBody }
  | { kind: 'hide-comment'; commentId: string; body: ModerationActionBody }
  | { kind: 'warn'; userId: string; body: WarningBody }
  | {
      kind: 'nickname-reset' | 'bio-clear' | 'image-remove';
      userId: string;
      body: ModerationActionBody;
    }
  | { kind: 'cancel'; actionId: string; body: CancelModerationBody }
  | { kind: 'dismiss'; body: DismissReportsBody };

async function moderate(
  variables: ModerationVariables,
): Promise<AdminModerationAction | DismissedReports> {
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
  }
}

/**
 * The mutation options of every operator action. An answer re-reads the whole moderation area
 * (`ADMIN_MODERATION_KEY`) — and so does a refusal the API gave, since another operator may have
 * hidden, cancelled or processed it first and the page should show what is so. The cookie of
 * another account (`isForAnotherAccount`) asks for the session again instead, so SessionCacheGuard
 * empties the cache and the screen shows who is really signed in. Toasts and dialogs are the
 * caller's.
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
