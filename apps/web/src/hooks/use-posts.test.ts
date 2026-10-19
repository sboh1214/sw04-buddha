import { MutationObserver, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Post, type PostSummary, api } from '@/lib/api';
import { communityPostsKey, postKey } from '@/lib/posts';
import { getQueryClient } from '@/lib/query-client';
import { ME_QUERY_KEY } from './use-me';
import {
  communityPostsInfiniteQueryOptions,
  createPostOptions,
  deletePostOptions,
  postQueryOptions,
  updatePostOptions,
  uploadPostImage,
} from './use-posts';

/**
 * The post hooks' wiring (#46, ADR-0073), driven through a real QueryClient (`getQueryClient()`
 * answers a fresh one per call under node) with the API client's methods stubbed: the request each
 * read and write sends, and what each answer does to the cache.
 */

const POST = 'B7C9A1D2-6F34-4E58-9B0A-2D1E5F8C7A46';
const post = POST.toLowerCase();
const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const published: Post = {
  state: 'published',
  id: post,
  title: '제목',
  body: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '본문' }] }],
  },
  author: {
    kind: 'member',
    publicId: 'k7m2p9qx4z',
    nickname: '근거왕',
    imageUrl: null,
    isAdmin: false,
  },
  market: {
    id: MARKET,
    slug: 'rate-cut',
    title: '금리 인하?',
    status: 'open',
    category: { slug: 'economy', nameKo: '경제' },
  },
  createdAt: '2026-10-18T00:00:00.000Z',
  editedAt: null,
};

const summary: PostSummary = {
  id: post,
  title: '제목',
  excerpt: '본문',
  thumbnailUrl: null,
  author: published.author,
  market: published.market,
  createdAt: published.createdAt,
  editedAt: null,
};

/** openapi-fetch's `{ data, response }`, the shape `unwrap` reads. */
const answer = (data: unknown, meta?: unknown) =>
  ({
    data: meta === undefined ? { data } : { data, meta },
    response: new Response(null, { status: 200 }),
  }) as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the community list', () => {
  it('is keyed by its filters and asks with them, a page per cursor', async () => {
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer([summary], { nextCursor: 'c2' }));
    const options = communityPostsInfiniteQueryOptions({ market: MARKET, q: '금리' });
    expect(options.queryKey).toEqual(communityPostsKey({ market: MARKET, q: '금리' }));
    expect(options.initialPageParam).toBeUndefined();
    const page = await options.queryFn({ pageParam: 'c1' });
    expect(page).toEqual({ items: [summary], nextCursor: 'c2' });
    expect(get).toHaveBeenCalledWith('/api/v1/posts', {
      params: { query: { marketId: MARKET, q: '금리', cursor: 'c1' } },
    });
    expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: 'c3' })).toBe('c3');
  });
});

describe('a post page', () => {
  it('is keyed and asked for by the lower-cased id', async () => {
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer(published));
    const options = postQueryOptions(POST);
    expect(options.queryKey).toEqual(['posts', 'post', post]);
    await expect(options.queryFn()).resolves.toEqual(published);
    expect(get).toHaveBeenCalledWith('/api/v1/posts/{postId}', {
      params: { path: { postId: post } },
    });
  });
});

describe('the writes', () => {
  it('a new post goes under its key, and every list is marked stale', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(communityPostsKey({}), { pages: [], pageParams: [] });
    const send = vi.spyOn(api, 'POST').mockResolvedValue(answer(published));
    const write = new MutationObserver(
      queryClient,
      createPostOptions(queryClient, () => undefined),
    );
    await write.mutate({ marketId: MARKET, title: null, body: {}, expectedAccountId: 'user-1' });
    expect(send).toHaveBeenCalledWith('/api/v1/posts', {
      body: { marketId: MARKET, title: null, body: {}, expectedAccountId: 'user-1' },
    });
    expect(queryClient.getQueryData(postKey(post))).toEqual(published);
    expect(queryClient.getQueryState(communityPostsKey({}))?.isInvalidated).toBe(true);
  });

  it('an edit replaces the held post; a refusal for a hidden one reads the page again', async () => {
    const queryClient = getQueryClient();
    const edited: Post = { ...published, title: '고친 제목', editedAt: '2026-10-19T00:00:00.000Z' };
    const put = vi.spyOn(api, 'PUT').mockResolvedValueOnce(answer(edited));
    const edit = new MutationObserver(
      queryClient,
      updatePostOptions(queryClient, () => undefined),
    );
    await edit.mutate({ postId: POST, title: '고친 제목', body: {}, expectedAccountId: 'user-1' });
    expect(put).toHaveBeenCalledWith('/api/v1/posts/{postId}', {
      params: { path: { postId: post } },
      body: { title: '고친 제목', body: {}, expectedAccountId: 'user-1' },
    });
    expect(queryClient.getQueryData(postKey(post))).toEqual(edited);

    put.mockRejectedValueOnce(
      new ApiError(409, { code: 'POST_NOT_EDITABLE', message: 'x', details: { reason: 'hidden' } }),
    );
    await expect(
      edit.mutate({ postId: POST, title: null, body: {}, expectedAccountId: 'user-1' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryState(postKey(post))?.isInvalidated).toBe(true);
  });

  it('a deletion drops the held page and marks the lists stale', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(postKey(post), published);
    queryClient.setQueryData(communityPostsKey({ q: 'a' }), { pages: [], pageParams: [] });
    const send = vi.spyOn(api, 'POST').mockResolvedValue(answer({ id: post, placeholder: false }));
    const remove = new MutationObserver(
      queryClient,
      deletePostOptions(queryClient, () => undefined),
    );
    await remove.mutate({ postId: POST, expectedAccountId: 'user-1' });
    expect(send).toHaveBeenCalledWith('/api/v1/posts/{postId}/delete', {
      params: { path: { postId: post } },
      body: { expectedAccountId: 'user-1' },
    });
    expect(queryClient.getQueryData(postKey(post))).toBeUndefined();
    expect(queryClient.getQueryState(communityPostsKey({ q: 'a' }))?.isInvalidated).toBe(true);
  });

  it('a refusal as another account asks for the session; one for the onboarding reads /me again', async () => {
    const queryClient = getQueryClient();
    const me = new QueryObserver(queryClient, {
      queryKey: ME_QUERY_KEY,
      queryFn: () => Promise.resolve({}),
      enabled: false,
    });
    queryClient.setQueryData(ME_QUERY_KEY, {});
    const unsubscribe = me.subscribe(() => undefined);
    const sessionChanged = vi.fn();
    const send = vi.spyOn(api, 'POST');
    const write = new MutationObserver(queryClient, createPostOptions(queryClient, sessionChanged));
    const body = { marketId: MARKET, title: null, body: {}, expectedAccountId: 'user-1' };

    send.mockRejectedValueOnce(
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'x',
        details: [{ path: ['expectedAccountId'], message: 'other account' }],
      }),
    );
    await expect(write.mutate(body)).rejects.toBeInstanceOf(ApiError);
    expect(sessionChanged).toHaveBeenCalledTimes(1);

    send.mockRejectedValueOnce(
      new ApiError(409, { code: 'ONBOARDING_REQUIRED', message: 'x' } as never),
    );
    await expect(write.mutate(body)).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryState(ME_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe('an image upload', () => {
  it('sends the file itself, under its type, with the account in the query', async () => {
    const send = vi
      .spyOn(api, 'POST')
      .mockResolvedValue(
        answer({ id: MARKET, contentType: 'image/png', width: 1, height: 1, byteSize: 68 }),
      );
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await expect(uploadPostImage(file, 'user-1')).resolves.toMatchObject({ id: MARKET });
    const [path, init] = send.mock.calls[0] as unknown as [
      string,
      {
        params: unknown;
        body: unknown;
        headers: Record<string, string>;
        bodySerializer: (body: unknown) => unknown;
      },
    ];
    expect(path).toBe('/api/v1/media/images');
    expect(init.params).toEqual({ query: { expectedAccountId: 'user-1' } });
    expect(init.body).toBe(file);
    // Not JSON: the serializer hands the file on untouched.
    expect(init.bodySerializer(file)).toBe(file);
    expect(init.headers).toEqual({ 'Content-Type': 'image/png' });
  });
});
