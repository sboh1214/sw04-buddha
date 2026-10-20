import { InfiniteQueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AuthoredComment, type MyPost, type PostSummary, api } from '@/lib/api';
import { myAuthoredKey, profileAuthoredKey } from '@/lib/authored';
import { getQueryClient } from '@/lib/query-client';
import {
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
