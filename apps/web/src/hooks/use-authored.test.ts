import { InfiniteQueryObserver, MutationObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type AuthoredComment,
  type MyComment,
  type MyPost,
  type PostSummary,
  api,
} from '@/lib/api';
import { myAuthoredKey, profileAuthoredKey } from '@/lib/authored';
import { postCommentsKey } from '@/lib/comments';
import { communityPostsKey, postKey } from '@/lib/posts';
import { getQueryClient } from '@/lib/query-client';
import {
  deleteMyItemOptions,
  myCommentsInfiniteQueryOptions,
  myPostsInfiniteQueryOptions,
  profileCommentsInfiniteQueryOptions,
  profilePostsInfiniteQueryOptions,
} from './use-authored';

/**
 * The lists' wiring (#51, ADR-0080), with the API client's methods stubbed: the request each page
 * sends, the key it lands under, the paging, and that MY's wait for the session. Nothing renders:
 * apps/web runs vitest under `environment: 'node'`, which is why the options are exported apart
 * from their hooks (use-watchlist.test.ts says more).
 */

const POST = 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46';
const COMMENT = '9b2e3c1d-4f5a-4b6c-8d7e-0f1a2b3c4d5e';

const author = {
  kind: 'member' as const,
  publicId: 'k7m2p9qx4z',
  nickname: '근거왕',
  imageUrl: null,
  isAdmin: false,
};
const market = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  slug: 'rate-cut',
  title: '금리 인하?',
  status: 'resolved' as const,
  category: { slug: 'economy', nameKo: '경제' },
};

const summary: PostSummary = {
  id: POST,
  title: '제목',
  excerpt: '본문',
  thumbnailUrl: null,
  author,
  market,
  createdAt: '2026-10-18T00:00:00.000Z',
  editedAt: null,
  commentCount: 1,
  likeCount: 2,
};

const comment: AuthoredComment = {
  id: COMMENT,
  parentId: null,
  body: '댓글',
  author,
  createdAt: '2026-10-18T01:00:00.000Z',
  editedAt: null,
  likeCount: 0,
  post: { state: 'published', id: POST, title: '제목', excerpt: '본문' },
  market,
};

const hiddenPost: MyPost = { ...summary, hidden: { reason: null } };
const shownPost: MyPost = { ...summary, id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f', hidden: null };
const hiddenComment: MyComment = {
  ...comment,
  hidden: { reason: { code: 'harassment', note: '상대를 깎아내리는 말' } },
};

/** openapi-fetch's `{ data, response }`, the shape `unwrap` reads. */
const answer = (data: unknown, meta?: unknown) =>
  ({
    data: meta === undefined ? { data } : { data, meta },
    response: new Response(null, { status: 200 }),
  }) as never;

const signedIn = { user: { id: 'user-1' } };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a profile’s lists', () => {
  it('ask for the 글 tab by the public id lower-cased, a page per cursor', async () => {
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer([summary], { nextCursor: 'c2' }));
    const options = profilePostsInfiniteQueryOptions('K7M2P9QX4Z');
    expect(options.queryKey).toEqual(profileAuthoredKey('k7m2p9qx4z', 'posts'));
    expect(options.initialPageParam).toBeUndefined();
    expect(await options.queryFn({ pageParam: undefined })).toEqual({
      items: [summary],
      nextCursor: 'c2',
    });
    expect(get).toHaveBeenLastCalledWith('/api/v1/profiles/{publicId}/posts', {
      params: { path: { publicId: 'k7m2p9qx4z' }, query: {} },
    });
    await options.queryFn({ pageParam: 'c2' });
    expect(get).toHaveBeenLastCalledWith('/api/v1/profiles/{publicId}/posts', {
      params: { path: { publicId: 'k7m2p9qx4z' }, query: { cursor: 'c2' } },
    });
    expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: 'c3' })).toBe('c3');
  });

  it('ask for the 댓글 tab the same way', async () => {
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer([comment], { nextCursor: null }));
    const options = profileCommentsInfiniteQueryOptions('k7m2p9qx4z');
    expect(options.queryKey).toEqual(profileAuthoredKey('k7m2p9qx4z', 'comments'));
    expect(await options.queryFn({ pageParam: 'c1' })).toEqual({
      items: [comment],
      nextCursor: null,
    });
    expect(get).toHaveBeenCalledWith('/api/v1/profiles/{publicId}/comments', {
      params: { path: { publicId: 'k7m2p9qx4z' }, query: { cursor: 'c1' } },
    });
  });

  it('need no session: anyone reads a profile (#37-1)', () => {
    expect('enabled' in profilePostsInfiniteQueryOptions('k7m2p9qx4z')).toBe(false);
    expect('enabled' in profileCommentsInfiniteQueryOptions('k7m2p9qx4z')).toBe(false);
  });
});

describe('MY ‘내 글’', () => {
  it('asks for the member’s own posts and comments, with no account in the request', async () => {
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer([hiddenPost], { nextCursor: null }));
    const posts = myPostsInfiniteQueryOptions(signedIn);
    expect(posts.queryKey).toEqual(myAuthoredKey('posts'));
    expect(await posts.queryFn({ pageParam: undefined })).toEqual({
      items: [hiddenPost],
      nextCursor: null,
    });
    expect(get).toHaveBeenLastCalledWith('/api/v1/me/posts', { params: { query: {} } });

    const comments = myCommentsInfiniteQueryOptions(signedIn);
    expect(comments.queryKey).toEqual(myAuthoredKey('comments'));
    await comments.queryFn({ pageParam: 'c4' });
    expect(get).toHaveBeenLastCalledWith('/api/v1/me/comments', {
      params: { query: { cursor: 'c4' } },
    });
  });

  it('waits for the session: a signed-out request would only be refused', () => {
    expect(myPostsInfiniteQueryOptions(undefined).enabled).toBe(false);
    expect(myPostsInfiniteQueryOptions(null).enabled).toBe(false);
    expect(myCommentsInfiniteQueryOptions(null).enabled).toBe(false);
    expect(myPostsInfiniteQueryOptions(signedIn).enabled).toBe(true);
    expect(myCommentsInfiniteQueryOptions(signedIn).enabled).toBe(true);
  });
});

describe('every list here', () => {
  it('is read again whenever a screen that shows it mounts, however fresh it is', async () => {
    // The writes that change these lists happen on a post page, which marks the community list
    // stale and not these; a list held from a minute ago must not show a post deleted since.
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer([summary], { nextCursor: null }));
    const queryClient = getQueryClient();
    const options = profilePostsInfiniteQueryOptions('k7m2p9qx4z');
    expect(options.refetchOnMount).toBe('always');
    for (const other of [
      profileCommentsInfiniteQueryOptions('k7m2p9qx4z'),
      myPostsInfiniteQueryOptions(signedIn),
      myCommentsInfiniteQueryOptions(signedIn),
    ]) {
      expect(other.refetchOnMount).toBe('always');
    }

    const first = new InfiniteQueryObserver(queryClient, options);
    const unsubscribe = first.subscribe(() => undefined);
    await vi.waitFor(() => {
      expect(first.getCurrentResult().isSuccess).toBe(true);
    });
    unsubscribe();
    expect(get).toHaveBeenCalledTimes(1);

    // Mounted again within the client's 30-second staleTime: read again all the same.
    const second = new InfiniteQueryObserver(queryClient, options);
    const unsubscribeSecond = second.subscribe(() => undefined);
    await vi.waitFor(() => {
      expect(get).toHaveBeenCalledTimes(2);
    });
    unsubscribeSecond();
    queryClient.clear();
  });
});

describe('MY’s 삭제 on a hidden item (owner decision 2026-10-22)', () => {
  /** MY's two lists and the other entries a deletion touches, as a screen would hold them. */
  function held() {
    const queryClient = getQueryClient();
    queryClient.setQueryData(myAuthoredKey('posts'), {
      pages: [{ items: [hiddenPost, shownPost], nextCursor: null }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(myAuthoredKey('comments'), {
      pages: [{ items: [hiddenComment], nextCursor: null }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(profileAuthoredKey('k7m2p9qx4z', 'comments'), {
      pages: [],
      pageParams: [],
    });
    queryClient.setQueryData(communityPostsKey({ q: 'a' }), { pages: [], pageParams: [] });
    queryClient.setQueryData(postKey(POST), {});
    queryClient.setQueryData(postCommentsKey(POST), { pages: [], pageParams: [] });
    return queryClient;
  }
  const stale = (queryClient: ReturnType<typeof getQueryClient>, key: readonly unknown[]) =>
    queryClient.getQueryState(key)?.isInvalidated;

  it('deletes a post through the author’s own route, takes it off the list and reads again what it touched', async () => {
    const queryClient = held();
    const send = vi.spyOn(api, 'POST').mockResolvedValue(answer({ id: POST, placeholder: false }));
    const remove = new MutationObserver(
      queryClient,
      deleteMyItemOptions(queryClient, () => undefined),
    );
    await remove.mutate({
      tab: 'posts',
      id: POST.toUpperCase(),
      postId: POST,
      expectedAccountId: 'user-1',
    });
    expect(send).toHaveBeenCalledWith('/api/v1/posts/{postId}/delete', {
      params: { path: { postId: POST } },
      body: { expectedAccountId: 'user-1' },
    });
    // Off the list at once — the tab and the summary's preview share the entry — the rest kept.
    const posts = queryClient.getQueryData<{ pages: { items: MyPost[] }[] }>(
      myAuthoredKey('posts'),
    );
    expect(posts?.pages[0]?.items).toEqual([shownPost]);
    // And read again: both of MY's tabs, the profile's lists, the community list, the post.
    for (const key of [
      myAuthoredKey('posts'),
      myAuthoredKey('comments'),
      profileAuthoredKey('k7m2p9qx4z', 'comments'),
      communityPostsKey({ q: 'a' }),
      postKey(POST),
      postCommentsKey(POST),
    ]) {
      expect(stale(queryClient, key), JSON.stringify(key)).toBe(true);
    }
  });

  it('deletes a 댓글 or 대댓글 through the comment route, off the 댓글 tab', async () => {
    const queryClient = held();
    const send = vi
      .spyOn(api, 'POST')
      .mockResolvedValue(answer({ id: COMMENT, placeholder: true }));
    const remove = new MutationObserver(
      queryClient,
      deleteMyItemOptions(queryClient, () => undefined),
    );
    await remove.mutate({
      tab: 'comments',
      id: COMMENT,
      postId: POST,
      expectedAccountId: 'user-1',
    });
    expect(send).toHaveBeenCalledWith('/api/v1/comments/{commentId}/delete', {
      params: { path: { commentId: COMMENT } },
      body: { expectedAccountId: 'user-1' },
    });
    const comments = queryClient.getQueryData<{ pages: { items: MyComment[] }[] }>(
      myAuthoredKey('comments'),
    );
    expect(comments?.pages[0]?.items).toEqual([]);
    // The 글 tab is untouched but read again with the rest of MY (one prefix, a cheap read): no
    // count moves, since a hidden comment was never counted (ADR-0080 7-21).
    const posts = queryClient.getQueryData<{ pages: { items: MyPost[] }[] }>(
      myAuthoredKey('posts'),
    );
    expect(posts?.pages[0]?.items).toEqual([hiddenPost, shownPost]);
    expect(stale(queryClient, myAuthoredKey('posts'))).toBe(true);
    expect(stale(queryClient, postCommentsKey(POST))).toBe(true);
  });

  it('a refusal keeps the item; NOT_FOUND (deleted meanwhile) reads MY again, another account asks for the session', async () => {
    const queryClient = held();
    const sessionChanged = vi.fn();
    const send = vi.spyOn(api, 'POST');
    const remove = new MutationObserver(
      queryClient,
      deleteMyItemOptions(queryClient, sessionChanged),
    );
    const variables = {
      tab: 'posts',
      id: POST,
      postId: POST,
      expectedAccountId: 'user-1',
    } as const;

    send.mockRejectedValueOnce(new ApiError(404, { code: 'NOT_FOUND', message: 'x' } as never));
    await expect(remove.mutate(variables)).rejects.toBeInstanceOf(ApiError);
    const posts = queryClient.getQueryData<{ pages: { items: MyPost[] }[] }>(
      myAuthoredKey('posts'),
    );
    expect(posts?.pages[0]?.items).toEqual([hiddenPost, shownPost]);
    expect(stale(queryClient, myAuthoredKey('posts'))).toBe(true);
    expect(stale(queryClient, myAuthoredKey('comments'))).toBe(true);
    expect(sessionChanged).not.toHaveBeenCalled();

    const again = held();
    const other = new MutationObserver(again, deleteMyItemOptions(again, sessionChanged));
    send.mockRejectedValueOnce(
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'x',
        details: [{ path: ['expectedAccountId'], message: 'other account' }],
      }),
    );
    await expect(other.mutate(variables)).rejects.toBeInstanceOf(ApiError);
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    expect(stale(again, myAuthoredKey('posts'))).toBeFalsy();
  });
});
