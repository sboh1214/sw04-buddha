import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/lib/api';
import {
  ADMIN_ACTIONS_KEY,
  ADMIN_MODERATION_KEY,
  adminCommentModerationKey,
  adminPostModerationKey,
  adminProfileModerationKey,
  adminReportQueueKey,
  adminUserModerationKey,
} from '@/lib/moderation';
import { getQueryClient } from '@/lib/query-client';
import {
  adminActionsInfiniteQueryOptions,
  adminCommentModerationQueryOptions,
  adminPostModerationQueryOptions,
  adminProfileModerationQueryOptions,
  adminReportQueueInfiniteQueryOptions,
  adminUserModerationQueryOptions,
  moderationOptions,
} from './use-admin-moderation';

/**
 * The operators' wiring (#50, ADR-0081), with the API client's methods stubbed: the request each
 * read and each action sends, the keys, and that an answer — or a refusal the API gave — re-reads
 * the whole moderation area. Nothing renders (vitest runs under `environment: 'node'`).
 */

const POST = 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46';
const COMMENT = '9b2e3c1d-4f5a-4b6c-8d7e-0f1a2b3c4d5e';
const ACTION = '33333333-3333-4333-8333-333333333333';
const USER = 'Qz8kL2mN4pR6sT8vX0yA2bC4dE6fG8hJ';

const answer = (data: unknown, meta?: unknown) =>
  ({
    data: meta === undefined ? { data } : { data, meta },
    response: new Response(null, { status: 200 }),
  }) as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the operators’ reads', () => {
  it('ask for each half of the queue, a page per cursor', async () => {
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer([], { nextCursor: null }));
    const pending = adminReportQueueInfiniteQueryOptions('pending');
    expect(pending.queryKey).toEqual(adminReportQueueKey('pending'));
    await pending.queryFn({ pageParam: undefined });
    expect(get).toHaveBeenLastCalledWith('/api/v1/admin/reports', {
      params: { query: { status: 'pending' } },
    });
    await adminReportQueueInfiniteQueryOptions('resolved').queryFn({ pageParam: 'c2' });
    expect(get).toHaveBeenLastCalledWith('/api/v1/admin/reports', {
      params: { query: { status: 'resolved', cursor: 'c2' } },
    });
    const actions = adminActionsInfiniteQueryOptions();
    expect(actions.queryKey).toEqual(ADMIN_ACTIONS_KEY);
    await actions.queryFn({ pageParam: undefined });
    expect(get).toHaveBeenLastCalledWith('/api/v1/admin/moderation/actions', {
      params: { query: {} },
    });
  });

  it('ask for each page by its target, uuids lower-cased', async () => {
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer({}));
    const post = adminPostModerationQueryOptions(POST.toUpperCase());
    expect(post.queryKey).toEqual(adminPostModerationKey(POST));
    await post.queryFn();
    expect(get).toHaveBeenLastCalledWith('/api/v1/admin/moderation/posts/{postId}', {
      params: { path: { postId: POST } },
    });
    const comment = adminCommentModerationQueryOptions(COMMENT);
    expect(comment.queryKey).toEqual(adminCommentModerationKey(COMMENT));
    await comment.queryFn();
    expect(get).toHaveBeenLastCalledWith('/api/v1/admin/moderation/comments/{commentId}', {
      params: { path: { commentId: COMMENT } },
    });
    const user = adminUserModerationQueryOptions(USER);
    expect(user.queryKey).toEqual(adminUserModerationKey(USER));
    await user.queryFn();
    expect(get).toHaveBeenLastCalledWith('/api/v1/admin/moderation/users/{userId}', {
      params: { path: { userId: USER } },
    });
    // A public profile's 운영 link names the public id (owner decision 2026-10-21): lower-cased.
    const profile = adminProfileModerationQueryOptions('K7M2P9QX4Z');
    expect(profile.queryKey).toEqual(adminProfileModerationKey('k7m2p9qx4z'));
    await profile.queryFn();
    expect(get).toHaveBeenLastCalledWith('/api/v1/admin/moderation/profiles/{publicId}', {
      params: { path: { publicId: 'k7m2p9qx4z' } },
    });
    for (const options of [post, comment, user, profile]) {
      expect(options.refetchOnMount).toBe('always');
    }
  });
});

describe('the operators’ actions', () => {
  const reason = { reason: 'spam' as const, note: null, expectedAccountId: 'admin-1' };

  it('go to the route of each action', async () => {
    const post = vi.spyOn(api, 'POST').mockResolvedValue(answer({}));
    const { mutationFn } = moderationOptions(getQueryClient(), () => undefined);
    await mutationFn({ kind: 'hide-post', postId: POST.toUpperCase(), body: reason });
    expect(post).toHaveBeenLastCalledWith('/api/v1/admin/moderation/posts/{postId}/hide', {
      params: { path: { postId: POST } },
      body: reason,
    });
    await mutationFn({ kind: 'hide-comment', commentId: COMMENT, body: reason });
    expect(post).toHaveBeenLastCalledWith('/api/v1/admin/moderation/comments/{commentId}/hide', {
      params: { path: { commentId: COMMENT } },
      body: reason,
    });
    const warning = { ...reason, subject: { type: 'profile' as const } };
    await mutationFn({ kind: 'warn', userId: USER, body: warning });
    expect(post).toHaveBeenLastCalledWith('/api/v1/admin/moderation/users/{userId}/warn', {
      params: { path: { userId: USER } },
      body: warning,
    });
    for (const kind of ['nickname-reset', 'bio-clear', 'image-remove'] as const) {
      await mutationFn({ kind, userId: USER, body: reason });
      expect(post).toHaveBeenLastCalledWith(`/api/v1/admin/moderation/users/{userId}/${kind}`, {
        params: { path: { userId: USER } },
        body: reason,
      });
    }
    const record = { reason: '이의 받아들임', expectedAccountId: 'admin-1' };
    await mutationFn({ kind: 'cancel', actionId: ACTION, body: record });
    expect(post).toHaveBeenLastCalledWith('/api/v1/admin/moderation/actions/{actionId}/cancel', {
      params: { path: { actionId: ACTION } },
      body: record,
    });
    const dismissal = { ...record, reportIds: [ACTION] };
    await mutationFn({ kind: 'dismiss', body: dismissal });
    expect(post).toHaveBeenLastCalledWith('/api/v1/admin/reports/dismiss', { body: dismissal });
  });

  it('re-read the whole area on an answer and on a refusal, never on a lost request', async () => {
    const queryClient = getQueryClient();
    const keys = [adminReportQueueKey('pending'), ADMIN_ACTIONS_KEY, adminPostModerationKey(POST)];
    const seed = () => {
      for (const key of keys) queryClient.setQueryData(key, {});
    };
    const stale = () => keys.map((key) => queryClient.getQueryState(key)?.isInvalidated);
    const options = moderationOptions(queryClient, () => undefined);

    seed();
    await options.onSuccess();
    expect(stale()).toEqual([true, true, true]);

    queryClient.clear();
    seed();
    await options.onError(new TypeError('Failed to fetch'));
    expect(stale()).toEqual([false, false, false]);

    await options.onError(
      new ApiError(409, {
        code: 'MODERATION_NOT_ALLOWED',
        message: 'hidden',
        details: { reason: 'hidden' },
      }),
    );
    expect(stale()).toEqual([true, true, true]);
    expect(queryClient.getQueryCache().findAll({ queryKey: ADMIN_MODERATION_KEY })).toHaveLength(3);
    queryClient.clear();
  });

  it('asks for the session again when the cookie is another account’s', async () => {
    const onSessionChanged = vi.fn();
    await moderationOptions(getQueryClient(), onSessionChanged).onError(
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'forbidden',
        details: [{ path: ['expectedAccountId'], message: 'not the signed-in account' }],
      }),
    );
    expect(onSessionChanged).toHaveBeenCalledTimes(1);
  });
});
