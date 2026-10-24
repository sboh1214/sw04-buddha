import { MutationObserver, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Me, type Post, type PostSummary, api } from '@/lib/api';
import {
  type DraftStorage,
  type PostDraftKey,
  clearPostDraft,
  keepPostDraft,
  postDraftMoment,
  readPostDraft,
} from '@/lib/post-drafts';
import { communityPostsKey, postGoneAfter, postKey } from '@/lib/posts';
import { getQueryClient } from '@/lib/query-client';
import { ME_QUERY_KEY } from './use-me';
import { type HeldPostDraftAt, keepHeldPostDraft } from './use-post-draft';
import {
  communityPostsInfiniteQueryOptions,
  createPostOptions,
  deletePostOptions,
  postImageUploader,
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
  vi.unstubAllGlobals();
});

/** This tab's `sessionStorage` as the drafts read it, over a Map (the tests run under node). */
function tabStorage(): DraftStorage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

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

  it('read again, NOT_FOUND leaves the post held but says it is gone; a read failing otherwise keeps it (Codex review of #219, round 5, ADR-0073 9-50)', async () => {
    vi.useFakeTimers();
    try {
      const queryClient = getQueryClient();
      queryClient.setQueryData(postKey(post), published);
      const page = new QueryObserver(queryClient, postQueryOptions(POST));
      const unsubscribe = page.subscribe(() => undefined);
      const get = vi.spyOn(api, 'GET');
      /** A read of the page as a window's focus sends it, through the client's retries. */
      const readAgain = async () => {
        const read = page.refetch();
        await vi.runAllTimersAsync();
        await read;
        return page.getCurrentResult();
      };

      // Failing otherwise — the API down (its 5xx, retried), a 429, a request that never left:
      // the post stays, and the page does not hold it gone.
      get.mockRejectedValue(new ApiError(503, { code: 'INTERNAL', message: 'x' }));
      let result = await readAgain();
      expect(get).toHaveBeenCalledTimes(3);
      expect(result.isError).toBe(true);
      expect(result.data).toEqual(published);
      expect(postGoneAfter(false, result)).toBe(false);
      get.mockRejectedValue(new ApiError(429, { code: 'RATE_LIMITED', message: 'x' }));
      result = await readAgain();
      expect(postGoneAfter(false, result)).toBe(false);
      get.mockRejectedValue(new TypeError('fetch failed'));
      result = await readAgain();
      expect(result.data).toEqual(published);
      expect(postGoneAfter(false, result)).toBe(false);

      // Deleted in another tab: NOT_FOUND, not retried. The query still holds the post as it was
      // last read — what the page drew before — and the page holds it gone.
      get.mockClear();
      get.mockRejectedValue(new ApiError(404, { code: 'NOT_FOUND', message: 'x' }));
      result = await readAgain();
      expect(get).toHaveBeenCalledTimes(1);
      expect(result.data).toEqual(published);
      expect(postGoneAfter(false, result)).toBe(true);
      // A later read failing otherwise does not bring it back.
      get.mockRejectedValue(new TypeError('fetch failed'));
      result = await readAgain();
      expect(postGoneAfter(true, result)).toBe(true);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
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

  it('an edit cancels a read of the post still on its way: its earlier answer, coming after the save, never replaces the saved post (Codex review of #219, round 5, ADR-0073 9-49)', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(postKey(post), published);
    // The post page's read, as a window's focus sends it: it left before the edit was saved and
    // answers — the earlier version — only after the save has landed.
    let answerRead: (value: unknown) => void = () => undefined;
    const get = vi.spyOn(api, 'GET').mockReturnValueOnce(
      new Promise((resolve) => {
        answerRead = resolve;
      }) as never,
    );
    const page = new QueryObserver(queryClient, postQueryOptions(POST));
    const unsubscribe = page.subscribe(() => undefined);
    const read = page.refetch();
    expect(get).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(postKey(post))?.fetchStatus).toBe('fetching');

    const edited: Post = { ...published, title: '고친 제목', editedAt: '2026-10-19T00:00:00.000Z' };
    vi.spyOn(api, 'PUT').mockResolvedValueOnce(answer(edited));
    const edit = new MutationObserver(
      queryClient,
      updatePostOptions(queryClient, () => undefined),
    );
    await edit.mutate({ postId: POST, title: '고친 제목', body: {}, expectedAccountId: 'user-1' });
    expect(queryClient.getQueryData(postKey(post))).toEqual(edited);
    expect(queryClient.getQueryState(postKey(post))?.fetchStatus).toBe('idle');

    // The earlier answer comes now: dropped.
    answerRead(answer(published));
    await read;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queryClient.getQueryData(postKey(post))).toEqual(edited);
    expect(page.getCurrentResult().data).toEqual(edited);

    // The next read is one that left after the save, and its answer goes in.
    const later: Post = { ...edited, title: '또 고친 제목' };
    get.mockResolvedValueOnce(answer(later));
    await page.refetch();
    expect(queryClient.getQueryData(postKey(post))).toEqual(later);
    unsubscribe();
  });

  it('an edit refused as NOT_FOUND reads the page again, and that read says the post is gone — the edit screen then shows no form (Codex review of #219, round 5, ADR-0073 9-50)', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(postKey(post), published);
    // The edit screen's read of the post, on screen.
    const screen = new QueryObserver(queryClient, postQueryOptions(POST));
    const unsubscribe = screen.subscribe(() => undefined);
    const get = vi
      .spyOn(api, 'GET')
      .mockRejectedValue(new ApiError(404, { code: 'NOT_FOUND', message: 'x' }));
    vi.spyOn(api, 'PUT').mockRejectedValueOnce(
      new ApiError(404, { code: 'NOT_FOUND', message: 'x' }),
    );
    const edit = new MutationObserver(
      queryClient,
      updatePostOptions(queryClient, () => undefined),
    );
    await expect(
      edit.mutate({ postId: POST, title: '고친 제목', body: {}, expectedAccountId: 'user-1' }),
    ).rejects.toBeInstanceOf(ApiError);
    // The refusal's read of the page has come back by the time the refusal is the screen's.
    expect(get).toHaveBeenCalledTimes(1);
    const result = screen.getCurrentResult();
    expect(result.data).toEqual(published);
    expect(postGoneAfter(false, result)).toBe(true);
    unsubscribe();
  });

  it('a write or an edit that lands removes the draft the onboarding gate kept for its screen — a refusal keeps it (오너 결정 2026-10-20)', async () => {
    const queryClient = getQueryClient();
    const storage = tabStorage();
    vi.stubGlobal('window', { sessionStorage: storage });
    const draft = { title: '쓰던 제목', body: { type: 'doc', content: [] }, previews: {} };
    const now = Date.now();
    const newKey = { kind: 'new', marketId: MARKET } as const;
    const editKey = { kind: 'edit', postId: post } as const;
    keepPostDraft(storage, newKey, 'user-1', draft, now);
    keepPostDraft(storage, editKey, 'user-1', draft, now);

    // Refused: the draft stays for the screen to take back after the onboarding.
    const send = vi
      .spyOn(api, 'POST')
      .mockRejectedValueOnce(new ApiError(409, { code: 'ONBOARDING_REQUIRED', message: 'x' }));
    const write = new MutationObserver(
      queryClient,
      createPostOptions(queryClient, () => undefined),
    );
    const body = { marketId: MARKET, title: null, body: {}, expectedAccountId: 'user-1' };
    await expect(write.mutate(body)).rejects.toBeInstanceOf(ApiError);
    expect(readPostDraft(storage, newKey, 'user-1', now)).toEqual(draft);

    // Landed — the screen may be gone by then: the post holds it now.
    send.mockResolvedValueOnce(answer(published));
    await write.mutate(body);
    expect(readPostDraft(storage, newKey, 'user-1', now)).toBeNull();
    expect(readPostDraft(storage, editKey, 'user-1', now)).toEqual(draft);

    vi.spyOn(api, 'PUT').mockResolvedValueOnce(answer(published));
    const edit = new MutationObserver(
      queryClient,
      updatePostOptions(queryClient, () => undefined),
    );
    await edit.mutate({ postId: POST, title: null, body: {}, expectedAccountId: 'user-1' });
    expect(readPostDraft(storage, editKey, 'user-1', now)).toBeNull();
  });

  it('a form the gate takes away while a landed write is still being handled keeps nothing — the success has not reached it (오너 결정 2026-10-20)', async () => {
    const storage = tabStorage();
    vi.stubGlobal('window', { sessionStorage: storage });
    // `GET /me` as the gate finds it: the account has a step left (a re-consent just shipped).
    const me = { id: 'user-1', onboarding: { nextStep: 'consent' } } as Me;
    const screens: {
      key: PostDraftKey;
      send: (queryClient: ReturnType<typeof getQueryClient>) => Promise<unknown>;
    }[] = [
      {
        key: { kind: 'new', marketId: MARKET },
        send: (queryClient) => {
          vi.spyOn(api, 'POST').mockResolvedValueOnce(answer(published));
          const write = new MutationObserver(
            queryClient,
            createPostOptions(queryClient, () => undefined),
          );
          return write.mutate({
            marketId: MARKET,
            title: '쓰던 제목',
            body: {},
            expectedAccountId: 'user-1',
          });
        },
      },
      {
        key: { kind: 'edit', postId: post },
        send: (queryClient) => {
          vi.spyOn(api, 'PUT').mockResolvedValueOnce(answer(published));
          const edit = new MutationObserver(
            queryClient,
            updatePostOptions(queryClient, () => undefined),
          );
          return edit.mutate({
            postId: POST,
            title: '쓰던 제목',
            body: {},
            expectedAccountId: 'user-1',
          });
        },
      },
    ];
    for (const { key, send } of screens) {
      const queryClient = getQueryClient();
      // The form's last render: sending (locked), not saved yet, with something to keep.
      const last: HeldPostDraftAt = {
        key,
        accountId: 'user-1',
        hasDraft: true,
        saved: false,
        title: '쓰던 제목',
        body: { type: 'doc', content: [] },
        previews: new Map(),
        moment: postDraftMoment(),
      };
      // Before anything landed, the gate taking it away keeps it (a 409 is being handled, say).
      expect(keepHeldPostDraft(last, me)).toBe(true);
      expect(readPostDraft(storage, key, 'user-1', Date.now())).not.toBeNull();
      clearPostDraft(storage, key);

      // The write lands; its success is held in `onSuccess` (the lists being read again).
      let release: (() => void) | undefined;
      vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const sent = send(queryClient);
      await vi.waitFor(() => {
        expect(release).toBeDefined();
      });
      // TanStack has not marked the mutation succeeded: the form still holds `saved: false`.
      expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe('pending');
      // The gate takes the form away now: nothing is kept.
      expect(keepHeldPostDraft(last, me)).toBe(false);
      expect(readPostDraft(storage, key, 'user-1', Date.now())).toBeNull();
      release?.();
      await sent;
      expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe('success');
      expect(readPostDraft(storage, key, 'user-1', Date.now())).toBeNull();

      // A form of the same screen drawn afterwards keeps its own draft again.
      expect(keepHeldPostDraft({ ...last, moment: postDraftMoment() }, me)).toBe(true);
      clearPostDraft(storage, key);
    }
  });

  it('a write that lands for account A leaves what B kept and B’s form: the tab changed from A to B with A’s write in flight (Codex review on PR #220, ADR-0073 9-48)', async () => {
    const storage = tabStorage();
    vi.stubGlobal('window', { sessionStorage: storage });
    const stepLeft = { nextStep: 'consent' } as Me['onboarding'];
    const b = { id: 'user-2', onboarding: stepLeft } as Me;
    const screens: {
      key: PostDraftKey;
      send: (
        queryClient: ReturnType<typeof getQueryClient>,
        expectedAccountId: string,
      ) => Promise<unknown>;
    }[] = [
      {
        key: { kind: 'new', marketId: MARKET },
        send: (queryClient, expectedAccountId) => {
          vi.spyOn(api, 'POST').mockResolvedValueOnce(answer(published));
          const write = new MutationObserver(
            queryClient,
            createPostOptions(queryClient, () => undefined),
          );
          return write.mutate({ marketId: MARKET, title: null, body: {}, expectedAccountId });
        },
      },
      {
        key: { kind: 'edit', postId: post },
        send: (queryClient, expectedAccountId) => {
          vi.spyOn(api, 'PUT').mockResolvedValueOnce(answer(published));
          const edit = new MutationObserver(
            queryClient,
            updatePostOptions(queryClient, () => undefined),
          );
          return edit.mutate({ postId: POST, title: null, body: {}, expectedAccountId });
        },
      },
    ];
    for (const { key, send } of screens) {
      const queryClient = getQueryClient();
      // A sent the write; the tab changed to B, who opened the same screen and was taken to a
      // step, which kept B's draft; B's form of the screen is drawn again (taken back, say).
      const theirs: HeldPostDraftAt = {
        key,
        accountId: 'user-2',
        hasDraft: true,
        saved: false,
        title: 'B가 쓰던 제목',
        body: { type: 'doc', content: [] },
        previews: new Map(),
        moment: postDraftMoment(),
      };
      expect(keepHeldPostDraft(theirs, b)).toBe(true);
      const kept = readPostDraft(storage, key, 'user-2', Date.now());
      expect(kept?.title).toBe('B가 쓰던 제목');

      // A's write lands now. It is A's landing: B's kept draft stays, and B's form — rendered
      // before it — is not counted as saved, so the gate taking it away keeps it again.
      await send(queryClient, 'user-1');
      expect(readPostDraft(storage, key, 'user-2', Date.now())).toEqual(kept);
      expect(keepHeldPostDraft(theirs, b)).toBe(true);
      expect(readPostDraft(storage, key, 'user-2', Date.now())?.title).toBe('B가 쓰던 제목');

      // B's own write of the screen does count, and removes B's draft.
      await send(queryClient, 'user-2');
      expect(readPostDraft(storage, key, 'user-2', Date.now())).toBeNull();
      expect(keepHeldPostDraft(theirs, b)).toBe(false);
      expect(readPostDraft(storage, key, 'user-2', Date.now())).toBeNull();
    }
  });

  it('a form going away keeps nothing for another account, nor with no step left', () => {
    const storage = tabStorage();
    vi.stubGlobal('window', { sessionStorage: storage });
    const key = { kind: 'new', marketId: MARKET } as const;
    const last: HeldPostDraftAt = {
      key,
      accountId: 'user-1',
      hasDraft: true,
      saved: false,
      title: '쓰던 제목',
      body: { type: 'doc', content: [] },
      previews: new Map(),
      moment: postDraftMoment(),
    };
    const stepLeft = { nextStep: 'consent' } as Me['onboarding'];
    expect(keepHeldPostDraft(last, { id: 'user-2', onboarding: stepLeft } as Me)).toBe(false);
    expect(keepHeldPostDraft(last, undefined)).toBe(false);
    expect(keepHeldPostDraft(last, { id: 'user-1', onboarding: { nextStep: null } } as Me)).toBe(
      false,
    );
    expect(keepHeldPostDraft({ ...last, accountId: undefined }, undefined)).toBe(false);
    expect(readPostDraft(storage, key, 'user-1', Date.now())).toBeNull();
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

  it('refused as another account or for the onboarding, does what a refused write does', async () => {
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
    const upload = postImageUploader(queryClient, sessionChanged);
    const file = new Blob([new Uint8Array([1])], { type: 'image/png' });

    // The cookie is another account's now (another tab): the session is asked for again.
    const otherAccount = new ApiError(403, {
      code: 'FORBIDDEN',
      message: 'x',
      details: [{ path: ['expectedAccountId'], message: 'other account' }],
    });
    send.mockRejectedValueOnce(otherAccount);
    await expect(upload(file, 'user-1')).rejects.toBe(otherAccount);
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(ME_QUERY_KEY)?.isInvalidated).toBe(false);

    // A step left (a revision asked for consent again): /me is read again, so the gate moves on.
    send.mockRejectedValueOnce(
      new ApiError(409, { code: 'ONBOARDING_REQUIRED', message: 'x' } as never),
    );
    await expect(upload(file, 'user-1')).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryState(ME_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(sessionChanged).toHaveBeenCalledTimes(1);

    // Any other refusal is the editor's alone to show.
    queryClient.setQueryData(ME_QUERY_KEY, {});
    send.mockRejectedValueOnce(
      new ApiError(422, { code: 'IMAGE_NOT_ALLOWED', message: 'x' } as never),
    );
    await expect(upload(file, 'user-1')).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryState(ME_QUERY_KEY)?.isInvalidated).toBe(false);
    expect(sessionChanged).toHaveBeenCalledTimes(1);

    send.mockResolvedValueOnce(
      answer({ id: MARKET, contentType: 'image/png', width: 1, height: 1, byteSize: 68 }),
    );
    await expect(upload(file, 'user-1')).resolves.toMatchObject({ id: MARKET });
    unsubscribe();
  });
});
