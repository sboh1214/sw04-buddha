import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type MyModerationAction, type MyReport, api } from '@/lib/api';
import { myAuthoredKey, profileAuthoredKey } from '@/lib/authored';
import { postCommentsKey } from '@/lib/comments';
import { MY_ACTIONS_KEY, MY_REPORTS_KEY } from '@/lib/moderation';
import { POST_LIST_KEY, marketPostsKey, postKey } from '@/lib/posts';
import { getQueryClient } from '@/lib/query-client';
import {
  isStaleReportRefusal,
  myModerationActionsInfiniteQueryOptions,
  myReportsInfiniteQueryOptions,
  reportOptions,
} from './use-reports';

/**
 * 신고's wiring on the web (#50, ADR-0081), with the API client's methods stubbed: the request each
 * report and each list sends, the keys they land under, that the lists wait for the session and
 * are read again on every mount, and what a refusal makes the page read again. Nothing renders
 * (vitest runs under `environment: 'node'`, use-watchlist.test.ts says more).
 */

const POST = 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46';
const COMMENT = '9b2e3c1d-4f5a-4b6c-8d7e-0f1a2b3c4d5e';
const MARKET = '5d3f1a2b-7c8e-4d9f-a0b1-c2d3e4f5a6b7';

const report: MyReport = {
  id: '22222222-2222-4222-8222-222222222222',
  target: { type: 'post', post: { state: 'published', id: POST, title: '제목', excerpt: '본문' } },
  reason: 'spam',
  description: null,
  createdAt: '2026-10-21T00:00:00.000Z',
  status: 'pending',
  resolvedAt: null,
};

const action: MyModerationAction = {
  id: '33333333-3333-4333-8333-333333333333',
  type: 'hide',
  reason: { code: 'spam', note: '광고' },
  subject: { type: 'post', id: POST, title: '제목', excerpt: '본문' },
  createdAt: '2026-10-21T00:00:00.000Z',
  endsAt: null,
  cancelledAt: null,
};

/** openapi-fetch's `{ data, response }`, the shape `unwrap` reads. */
const answer = (data: unknown, meta?: unknown, status = 200) =>
  ({
    data: meta === undefined ? { data } : { data, meta },
    response: new Response(null, { status }),
  }) as never;

const refusal = (status: number, code: string, details?: unknown) =>
  ({
    error: { error: { code, message: code, details } },
    response: new Response(null, { status }),
  }) as never;

const signedIn = { user: { id: 'user-1' } };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the member’s lists', () => {
  it('ask for the member’s own reports and actions, a page per cursor, no account named', async () => {
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer([report], { nextCursor: 'c2' }));
    const reports = myReportsInfiniteQueryOptions(signedIn);
    expect(reports.queryKey).toEqual(MY_REPORTS_KEY);
    expect(await reports.queryFn({ pageParam: undefined })).toEqual({
      items: [report],
      nextCursor: 'c2',
    });
    expect(get).toHaveBeenLastCalledWith('/api/v1/me/reports', { params: { query: {} } });
    expect(reports.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();

    get.mockResolvedValue(answer([action], { nextCursor: null }));
    const actions = myModerationActionsInfiniteQueryOptions(signedIn);
    expect(actions.queryKey).toEqual(MY_ACTIONS_KEY);
    expect(await actions.queryFn({ pageParam: 'c3' })).toEqual({
      items: [action],
      nextCursor: null,
    });
    expect(get).toHaveBeenLastCalledWith('/api/v1/me/moderation/actions', {
      params: { query: { cursor: 'c3' } },
    });
  });

  it('wait for the session and are read again on every mount', () => {
    for (const make of [myReportsInfiniteQueryOptions, myModerationActionsInfiniteQueryOptions]) {
      expect(make(undefined).enabled).toBe(false);
      expect(make(null).enabled).toBe(false);
      expect(make(signedIn).enabled).toBe(true);
      expect(make(signedIn).refetchOnMount).toBe('always');
    }
  });
});

describe('a report', () => {
  const body = { reason: 'spam' as const, description: null, expectedAccountId: 'user-1' };

  it('goes to the route of what it is about, ids lower-cased', async () => {
    const post = vi.spyOn(api, 'POST').mockResolvedValue(answer(report, undefined, 201));
    const options = reportOptions(getQueryClient(), () => undefined);
    await options.mutationFn({ subject: { type: 'post', postId: POST.toUpperCase() }, ...body });
    expect(post).toHaveBeenLastCalledWith('/api/v1/posts/{postId}/reports', {
      params: { path: { postId: POST } },
      body,
    });
    await options.mutationFn({
      subject: { type: 'comment', commentId: COMMENT, postId: POST },
      ...body,
    });
    expect(post).toHaveBeenLastCalledWith('/api/v1/comments/{commentId}/reports', {
      params: { path: { commentId: COMMENT } },
      body,
    });
    await options.mutationFn({ subject: { type: 'profile', publicId: 'K7M2P9QX4Z' }, ...body });
    expect(post).toHaveBeenLastCalledWith('/api/v1/profiles/{publicId}/reports', {
      params: { path: { publicId: 'k7m2p9qx4z' } },
      body,
    });
  });

  it('marks the member’s reports stale once taken', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(MY_REPORTS_KEY, { pages: [], pageParams: [] });
    await reportOptions(queryClient, () => undefined).onSuccess();
    expect(queryClient.getQueryState(MY_REPORTS_KEY)?.isInvalidated).toBe(true);
    queryClient.clear();
  });

  it('reads the post, its comments and every list with a card of it again when the item became a placeholder or left', async () => {
    // The lists whose cards carry 신고 (owner decision 2026-10-21): the community list, a market
    // detail's 토론 (#47, ADR-0081 결과 5 — `marketPostsKey` sits under `POST_LIST_KEY`) and a
    // profile's 글·댓글 tabs — upper-case public id or not, the same member's.
    const stale = [
      postKey(POST),
      postCommentsKey(POST),
      POST_LIST_KEY,
      marketPostsKey(MARKET),
      profileAuthoredKey('K7M2P9QX4Z', 'posts'),
      profileAuthoredKey('k7m2p9qx4z', 'comments'),
    ];
    const subjects = [
      { type: 'post', postId: POST },
      { type: 'comment', commentId: COMMENT, postId: POST },
    ] as const;
    const refusals = [
      new ApiError(409, {
        code: 'REPORT_NOT_ALLOWED',
        message: 'hidden',
        details: { reason: 'hidden' },
      }),
      new ApiError(409, {
        code: 'REPORT_NOT_ALLOWED',
        message: 'deleted',
        details: { reason: 'deleted' },
      }),
      new ApiError(404, { code: 'NOT_FOUND', message: 'gone' }),
    ];
    for (const subject of subjects) {
      for (const refusal of refusals) {
        const queryClient = getQueryClient();
        for (const key of [...stale, myAuthoredKey('posts')]) queryClient.setQueryData(key, {});
        await reportOptions(queryClient, () => undefined).onError(refusal, { subject, ...body });
        for (const key of stale) {
          expect(queryClient.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
        }
        // MY 내 글 is the member's own: no 신고 there, nothing to read again.
        expect(queryClient.getQueryState(myAuthoredKey('posts'))?.isInvalidated).toBe(false);
        queryClient.clear();
      }
    }
  });

  it('reads nothing again for any other refusal', async () => {
    const queryClient = getQueryClient();
    const keys = [
      postKey(POST),
      POST_LIST_KEY,
      marketPostsKey(MARKET),
      profileAuthoredKey('k7m2p9qx4z', 'posts'),
    ];
    for (const key of keys) queryClient.setQueryData(key, {});
    const duplicate = new ApiError(409, {
      code: 'REPORT_NOT_ALLOWED',
      message: 'duplicate',
      details: { reason: 'duplicate' },
    });
    await reportOptions(queryClient, () => undefined).onError(duplicate, {
      subject: { type: 'post', postId: POST },
      ...body,
    });
    for (const key of keys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    queryClient.clear();
  });

  it('tells the stale refusals apart from the rest', async () => {
    vi.spyOn(api, 'POST').mockResolvedValue(refusal(409, 'REPORT_NOT_ALLOWED', { reason: 'own' }));
    const own = await reportOptions(getQueryClient(), () => undefined)
      .mutationFn({ subject: { type: 'post', postId: POST }, ...body })
      .catch((error: unknown) => error);
    expect(own).toBeInstanceOf(ApiError);
    expect(isStaleReportRefusal(own)).toBe(false);
    const make = (code: 'REPORT_NOT_ALLOWED' | 'NOT_FOUND', reason?: string) =>
      new ApiError(409, { code, message: code, details: reason ? { reason } : undefined });
    expect(isStaleReportRefusal(make('REPORT_NOT_ALLOWED', 'deleted'))).toBe(true);
    expect(isStaleReportRefusal(make('REPORT_NOT_ALLOWED', 'hidden'))).toBe(true);
    expect(isStaleReportRefusal(make('REPORT_NOT_ALLOWED', 'duplicate'))).toBe(false);
    expect(isStaleReportRefusal(make('NOT_FOUND'))).toBe(true);
    expect(isStaleReportRefusal(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('asks for the session again when the cookie is another account’s', async () => {
    const onSessionChanged = vi.fn();
    const forbidden = new ApiError(403, {
      code: 'FORBIDDEN',
      message: 'forbidden',
      details: [{ path: ['expectedAccountId'], message: 'not the signed-in account' }],
    });
    await reportOptions(getQueryClient(), onSessionChanged).onError(forbidden, {
      subject: { type: 'profile', publicId: 'k7m2p9qx4z' },
      ...body,
    });
    expect(onSessionChanged).toHaveBeenCalledTimes(1);
  });
});
