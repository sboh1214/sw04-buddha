import { MutationObserver, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type AdminNotice, type AdminNoticeSummary, type Me, api } from '@/lib/api';
import { PRIVATE_QUERY_ROOTS, dehydratePublic } from '@/lib/market-keys';
import {
  ADMIN_NOTICES_KEY,
  PINNED_NOTICES_KEY,
  adminNoticeActionsKey,
  adminNoticeKey,
  adminNoticeListKey,
  adminNoticeRevisionKey,
  adminNoticeRevisionsKey,
  adminNoticeReadView,
  pinnedNoticesView,
} from '@/lib/notices';
import {
  type DraftStorage,
  type PostDraftKey,
  clearPostDraft,
  keepPostDraft,
  postDraftMoment,
  readPostDraft,
} from '@/lib/post-drafts';
import { getQueryClient } from '@/lib/query-client';
import { ME_QUERY_KEY } from './use-me';
import {
  adminNoticeActionsInfiniteQueryOptions,
  adminNoticeQueryOptions,
  adminNoticeRevisionQueryOptions,
  adminNoticeRevisionsInfiniteQueryOptions,
  adminNoticesInfiniteQueryOptions,
  createNoticeOptions,
  pinNoticeOptions,
  pinnedNoticesQueryOptions,
  updateNoticeOptions,
} from './use-notices';
import {
  type HeldPostDraft,
  type HeldPostDraftAt,
  heldPostDraftAt,
  keepHeldPostDraft,
} from './use-post-draft';

/**
 * The notice hooks' wiring (#138, ADR-0077), driven through a real QueryClient with the API
 * client's methods stubbed: the request each read and write sends, and what each answer does to
 * the cache — the admin's lists and the public fixed area, which every write marks stale.
 */

const NOTICE = 'C1D2E3F4-A5B6-4C7D-8E9F-0A1B2C3D4E5F';
const notice = NOTICE.toLowerCase();

const summary: AdminNoticeSummary = {
  id: notice,
  title: '점검 안내',
  createdAt: '2026-10-20T00:00:00.000Z',
  editedAt: null,
  pinnedAt: null,
};

const adminNotice: AdminNotice = {
  ...summary,
  body: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '본문' }] }],
  },
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

/** This tab's `sessionStorage` as the drafts read it, over a Map (use-posts.test.ts's). */
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

/** A write's `onSessionChanged` where the cookie stays the screen's (ADR-0092). */
const sessionUnchanged = () => undefined;

describe('the fixed area', () => {
  it('asks for the pinned notices under its public key, which the community page dehydrates', async () => {
    const get = vi
      .spyOn(api, 'GET')
      .mockResolvedValue(
        answer([{ id: notice, title: '점검 안내', createdAt: summary.createdAt, editedAt: null }]),
      );
    const options = pinnedNoticesQueryOptions();
    expect(options.queryKey).toEqual(PINNED_NOTICES_KEY);
    await expect(options.queryFn()).resolves.toEqual([
      { id: notice, title: '점검 안내', createdAt: summary.createdAt, editedAt: null },
    ]);
    expect(get).toHaveBeenCalledWith('/api/v1/notices');

    // Public: the server's seed of it reaches the HTML; the admin's reads never do.
    expect(PRIVATE_QUERY_ROOTS.has(PINNED_NOTICES_KEY[0])).toBe(false);
    expect(PRIVATE_QUERY_ROOTS.has(ADMIN_NOTICES_KEY[0])).toBe(true);
    const queryClient = getQueryClient();
    queryClient.setQueryData(PINNED_NOTICES_KEY, []);
    queryClient.setQueryData(adminNoticeKey(notice), adminNotice);
    const keys = dehydratePublic(queryClient).queries.map((query) => query.queryKey);
    expect(keys).toEqual([PINNED_NOTICES_KEY]);
  });

  it('shows a first read that failed, and keeps the rows read when a later refresh fails', async () => {
    // The states `PinnedNotices` draws from (`pinnedNoticesView`), as TanStack Query itself
    // reports them: a failure before any row is a loading error; one after is a refetch error
    // over the rows held. Retries off, so each read is one request.
    const rows = [{ id: notice, title: '점검 안내', createdAt: summary.createdAt, editedAt: null }];
    const get = vi
      .spyOn(api, 'GET')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(answer(rows))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const queryClient = getQueryClient();
    const observer = new QueryObserver(queryClient, {
      ...pinnedNoticesQueryOptions(),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
      expect(pinnedNoticesView(observer.getCurrentResult())).toEqual({ kind: 'error' });
      await observer.refetch(); // 다시 시도
      expect(pinnedNoticesView(observer.getCurrentResult())).toEqual({
        kind: 'rows',
        rows,
        refreshFailed: false,
      });
      await observer.refetch(); // a later refresh, refused
      expect(observer.getCurrentResult().isError).toBe(true);
      expect(pinnedNoticesView(observer.getCurrentResult())).toEqual({
        kind: 'rows',
        rows,
        refreshFailed: true,
      });
      expect(get).toHaveBeenCalledTimes(3);
    } finally {
      unsubscribe();
    }
  });
});

describe('the admin screen', () => {
  it('reads each list by its state, a page per cursor', async () => {
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer([summary], { nextCursor: 'c2' }));
    const options = adminNoticesInfiniteQueryOptions('unpinned');
    expect(options.queryKey).toEqual(adminNoticeListKey('unpinned'));
    expect(options.initialPageParam).toBeUndefined();
    await expect(options.queryFn({ pageParam: undefined })).resolves.toEqual({
      items: [summary],
      nextCursor: 'c2',
    });
    await options.queryFn({ pageParam: 'c2' });
    await adminNoticesInfiniteQueryOptions('pinned').queryFn({ pageParam: undefined });
    expect(get.mock.calls).toEqual([
      ['/api/v1/admin/notices', { params: { query: { state: 'unpinned' } } }],
      ['/api/v1/admin/notices', { params: { query: { state: 'unpinned', cursor: 'c2' } } }],
      ['/api/v1/admin/notices', { params: { query: { state: 'pinned' } } }],
    ]);
    expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: 'c3' })).toBe('c3');
  });

  it('reads a notice’s records and earlier versions under its own key, a page per cursor', async () => {
    // Owner decision 2026-10-21: the admin's notice screen shows its records and earlier versions.
    const record = {
      id: notice,
      type: 'notice_pin',
      actor: { id: 'admin-1', nickname: '운영자' },
      createdAt: summary.createdAt,
      revisionId: null,
    };
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer([record], { nextCursor: 'c2' }));
    const actions = adminNoticeActionsInfiniteQueryOptions(NOTICE);
    expect(actions.queryKey).toEqual(['admin', 'notices', 'notice', notice, 'actions']);
    await expect(actions.queryFn({ pageParam: undefined })).resolves.toEqual({
      items: [record],
      nextCursor: 'c2',
    });
    await actions.queryFn({ pageParam: 'c2' });
    const revisions = adminNoticeRevisionsInfiniteQueryOptions(NOTICE);
    expect(revisions.queryKey).toEqual(['admin', 'notices', 'notice', notice, 'revisions']);
    await revisions.queryFn({ pageParam: undefined });
    expect(get.mock.calls).toEqual([
      [
        '/api/v1/admin/notices/{noticeId}/actions',
        { params: { path: { noticeId: notice }, query: {} } },
      ],
      [
        '/api/v1/admin/notices/{noticeId}/actions',
        { params: { path: { noticeId: notice }, query: { cursor: 'c2' } } },
      ],
      [
        '/api/v1/admin/notices/{noticeId}/revisions',
        { params: { path: { noticeId: notice }, query: {} } },
      ],
    ]);
    expect(actions.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
    expect(revisions.getNextPageParam({ items: [], nextCursor: '7' })).toBe('7');
    // Both under the private admin root: never fetched on the server, never dehydrated.
    expect(PRIVATE_QUERY_ROOTS.has(actions.queryKey[0])).toBe(true);
  });

  it('reads one earlier version by the id its address names', async () => {
    const version = {
      id: 7,
      title: '이전 제목',
      writtenAt: summary.createdAt,
      writtenBy: null,
      replacedAt: summary.createdAt,
      replacedBy: null,
      body: adminNotice.body,
    };
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer(version));
    const options = adminNoticeRevisionQueryOptions(NOTICE, '7');
    expect(options.queryKey).toEqual(adminNoticeRevisionKey(notice, 7));
    await expect(options.queryFn()).resolves.toEqual(version);
    expect(get).toHaveBeenCalledWith('/api/v1/admin/notices/{noticeId}/revisions/{revisionId}', {
      params: { path: { noticeId: notice, revisionId: '7' } },
    });
    // A version never changes: once read, nothing reads it again on its own.
    expect(options.staleTime).toBe(Infinity);
  });

  it('keeps an earlier version on screen once read, though a later read of it fails', async () => {
    // The states the version's screen draws from (`adminNoticeReadView`), as TanStack Query
    // reports them: a refetch that fails over a version read is `isError` too, and must not swap
    // the version for the error. Retries off, so each read is one request.
    const version = {
      id: 7,
      title: '이전 제목',
      writtenAt: summary.createdAt,
      writtenBy: null,
      replacedAt: summary.createdAt,
      replacedBy: null,
      body: adminNotice.body,
    };
    vi.spyOn(api, 'GET')
      .mockResolvedValueOnce(answer(version))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const observer = new QueryObserver(getQueryClient(), {
      ...adminNoticeRevisionQueryOptions(NOTICE, '7'),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      expect(adminNoticeReadView(observer.getCurrentResult())).toBe('pending');
      await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
      expect(adminNoticeReadView(observer.getCurrentResult())).toBe('ready');
      await observer.refetch(); // an invalidation's read, refused
      expect(observer.getCurrentResult().isError).toBe(true);
      expect(adminNoticeReadView(observer.getCurrentResult())).toBe('ready');
      expect(observer.getCurrentResult().data).toEqual(version);
    } finally {
      unsubscribe();
    }
  });

  it('says an earlier version that is not there is missing, and any other first failure failed', async () => {
    vi.spyOn(api, 'GET')
      .mockRejectedValueOnce(new ApiError(404, { code: 'NOT_FOUND', message: 'Not found' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const queryClient = getQueryClient();
    for (const [revisionId, expected] of [
      ['8', 'missing'],
      ['9', 'failed'],
    ] as const) {
      const observer = new QueryObserver(queryClient, {
        ...adminNoticeRevisionQueryOptions(NOTICE, revisionId),
        retry: false,
      });
      const unsubscribe = observer.subscribe(() => undefined);
      try {
        await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
        expect(adminNoticeReadView(observer.getCurrentResult())).toBe(expected);
      } finally {
        unsubscribe();
      }
    }
  });

  it('reads one notice by its lower-cased id, and again each time the edit screen opens', async () => {
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer(adminNotice));
    const options = adminNoticeQueryOptions(NOTICE);
    expect(options.queryKey).toEqual(['admin', 'notices', 'notice', notice]);
    await expect(options.queryFn()).resolves.toEqual(adminNotice);
    expect(get).toHaveBeenCalledWith('/api/v1/admin/notices/{noticeId}', {
      params: { path: { noticeId: notice } },
    });
    expect(options.refetchOnMount).toBe('always');
  });

  it('opens the edit form on a read made after the screen opened, never on a copy held from before', async () => {
    // Owner decisions 2026-10-21 7 and (2차) 1: a save is refused when the notice was saved after
    // the screen opened, whoever saved it. The form saves against the version it opens on, so a
    // copy the cache held from an earlier visit — fresh by the client's 30 s, and older than a save
    // since — must not be what it opens on (ADR-0077 decision 8-19).
    const theirs: AdminNotice = {
      ...adminNotice,
      title: '다른 운영자가 고친 제목',
      editedAt: '2026-10-20T01:00:00.000Z',
    };
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer(theirs));
    const queryClient = getQueryClient();
    // The copy an earlier visit left, or a pin's answer on the list (`afterNoticeWrite`), seconds
    // before the screen opens.
    const openedAt = Date.now();
    queryClient.setQueryData(adminNoticeKey(notice), adminNotice, { updatedAt: openedAt - 5_000 });
    const options = queryClient.defaultQueryOptions({
      ...adminNoticeQueryOptions(NOTICE),
      retry: false,
    });
    const observer = new QueryObserver(queryClient, options);
    // The screen's first render, as `useQuery` draws it: the old copy is there, being read again,
    // and the form does not open on it.
    const firstRender = observer.getOptimisticResult({
      ...options,
      _optimisticResults: 'optimistic',
    });
    expect(firstRender.data).toEqual(adminNotice);
    expect(firstRender.fetchStatus).toBe('fetching');
    expect(adminNoticeReadView(firstRender, openedAt)).toBe('pending');
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      // Opening reads the notice again, however fresh the copy, and the form opens on that read.
      await vi.waitFor(() =>
        expect(adminNoticeReadView(observer.getCurrentResult(), openedAt)).toBe('ready'),
      );
      expect(observer.getCurrentResult().data).toEqual(theirs);
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('does not open the edit form on the copy held from before when the read on opening fails', async () => {
    vi.spyOn(api, 'GET')
      .mockRejectedValueOnce(new ApiError(500, { code: 'INTERNAL', message: 'Internal error' }))
      .mockResolvedValueOnce(answer(adminNotice))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const queryClient = getQueryClient();
    const openedAt = Date.now();
    queryClient.setQueryData(adminNoticeKey(notice), adminNotice, { updatedAt: openedAt - 5_000 });
    const observer = new QueryObserver(queryClient, {
      ...adminNoticeQueryOptions(NOTICE),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      // The read on opening is refused: the screen fails as a first read does — no form on the
      // copy it may have to refuse a save from.
      await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
      expect(observer.getCurrentResult().isLoadingError).toBe(false);
      expect(adminNoticeReadView(observer.getCurrentResult(), openedAt)).toBe('failed');
      // Read again (a refocus), it opens; a later refresh that fails keeps it open.
      await observer.refetch();
      expect(adminNoticeReadView(observer.getCurrentResult(), openedAt)).toBe('ready');
      await observer.refetch();
      expect(observer.getCurrentResult().isRefetchError).toBe(true);
      expect(adminNoticeReadView(observer.getCurrentResult(), openedAt)).toBe('ready');
    } finally {
      unsubscribe();
    }
  });
});

describe('the writes', () => {
  /**
   * Holds both admin lists, the fixed area and the notice's records and earlier versions, and says
   * which of them a write marked stale.
   */
  function held(queryClient: ReturnType<typeof getQueryClient>) {
    const keys = [
      adminNoticeListKey('pinned'),
      adminNoticeListKey('unpinned'),
      PINNED_NOTICES_KEY,
      adminNoticeActionsKey(notice),
      adminNoticeRevisionsKey(notice),
    ];
    for (const key of keys) {
      queryClient.setQueryData(
        key,
        key === PINNED_NOTICES_KEY ? [] : { pages: [], pageParams: [] },
      );
    }
    return () => keys.map((key) => queryClient.getQueryState(key)?.isInvalidated);
  }

  it('a new notice is sent with its title and body and the admin whose form sent it, held under its key, and every list is stale', async () => {
    const queryClient = getQueryClient();
    const stale = held(queryClient);
    const send = vi.spyOn(api, 'POST').mockResolvedValue(answer(adminNotice));
    await new MutationObserver(
      queryClient,
      createNoticeOptions(queryClient, sessionUnchanged),
    ).mutate({
      title: '점검 안내',
      body: { type: 'doc', content: [] },
      accountId: 'admin-1',
    });
    // The admin whose form sent it is the admin on screen the write names (ADR-0092), and its
    // landing's (ADR-0073 9-48).
    expect(send).toHaveBeenCalledWith('/api/v1/admin/notices', {
      body: {
        title: '점검 안내',
        body: { type: 'doc', content: [] },
        expectedAccountId: 'admin-1',
      },
    });
    expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(adminNotice);
    expect(stale()).toEqual([true, true, true, true, true]);
  });

  it('an edit sends the version it was opened from, replaces the held notice, and every list is stale', async () => {
    const queryClient = getQueryClient();
    const stale = held(queryClient);
    const edited = { ...adminNotice, title: '고친 안내', editedAt: '2026-10-20T01:00:00.000Z' };
    const put = vi.spyOn(api, 'PUT').mockResolvedValue(answer({ notice: edited, changed: true }));
    const result = await new MutationObserver(
      queryClient,
      updateNoticeOptions(queryClient, sessionUnchanged),
    ).mutate({
      noticeId: NOTICE,
      title: '고친 안내',
      body: {},
      expectedEditedAt: null,
      accountId: 'admin-1',
    });
    // An edit names it too.
    expect(put).toHaveBeenCalledWith('/api/v1/admin/notices/{noticeId}', {
      params: { path: { noticeId: notice } },
      body: { title: '고친 안내', body: {}, expectedEditedAt: null, expectedAccountId: 'admin-1' },
    });
    // The answer, whether this save changed it, is the screen's; the cache holds the notice alone,
    // and the notice's records and versions are read again (the edit added one of each).
    expect(result).toEqual({ notice: edited, changed: true });
    expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(edited);
    expect(stale()).toEqual([true, true, true, true, true]);
  });

  it('an edit cancels a read of the notice still on its way: its earlier answer, coming after the save, never replaces the saved notice (ADR-0077 8-27, as ADR-0073 9-49)', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(adminNoticeKey(notice), adminNotice);
    // The edit screen's read, as a window's focus sends it: it left before the edit was saved and
    // answers — the earlier version — only after the save has landed.
    let answerRead: (value: unknown) => void = () => undefined;
    const get = vi.spyOn(api, 'GET').mockReturnValueOnce(
      new Promise((resolve) => {
        answerRead = resolve;
      }) as never,
    );
    const screen = new QueryObserver(queryClient, adminNoticeQueryOptions(NOTICE));
    const unsubscribe = screen.subscribe(() => undefined);
    try {
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      expect(queryClient.getQueryState(adminNoticeKey(notice))?.fetchStatus).toBe('fetching');

      const edited = { ...adminNotice, title: '고친 안내', editedAt: '2026-10-20T01:00:00.000Z' };
      vi.spyOn(api, 'PUT').mockResolvedValueOnce(answer({ notice: edited, changed: true }));
      await new MutationObserver(
        queryClient,
        updateNoticeOptions(queryClient, sessionUnchanged),
      ).mutate({
        noticeId: NOTICE,
        title: '고친 안내',
        body: {},
        expectedEditedAt: null,
        accountId: 'admin-1',
      });
      expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(edited);

      // The earlier answer comes now: dropped — the screen keeps the saved version, whose
      // `editedAt` its next save sends.
      answerRead(answer(adminNotice));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(edited);
      expect(screen.getCurrentResult().data).toEqual(edited);
    } finally {
      unsubscribe();
    }
  });

  it('a save the server found unchanged says so, and holds the notice it answered', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(adminNoticeKey(notice), adminNotice);
    vi.spyOn(api, 'PUT').mockResolvedValue(answer({ notice: adminNotice, changed: false }));
    const result = await new MutationObserver(
      queryClient,
      updateNoticeOptions(queryClient, sessionUnchanged),
    ).mutate({
      noticeId: NOTICE,
      title: adminNotice.title,
      body: {},
      expectedEditedAt: null,
      accountId: 'admin-1',
    });
    expect(result.changed).toBe(false);
    expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(adminNotice);
  });

  it('an edit another admin’s save overtook reads the notice again and keeps no answer', async () => {
    // Owner decision 2026-10-21: the save is refused (NOTICE_EDIT_CONFLICT) and nothing is
    // written; the screen reads the notice, its records and versions and the lists again, so what
    // was saved meanwhile shows — the form keeps what is typed (it holds its own draft).
    const queryClient = getQueryClient();
    const stale = held(queryClient);
    queryClient.setQueryData(adminNoticeKey(notice), adminNotice);
    vi.spyOn(api, 'PUT').mockRejectedValue(
      new ApiError(409, {
        code: 'NOTICE_EDIT_CONFLICT',
        message: 'x',
        details: { editedAt: '2026-10-20T01:00:00.000Z' },
      }),
    );
    await expect(
      new MutationObserver(queryClient, updateNoticeOptions(queryClient, sessionUnchanged)).mutate({
        noticeId: NOTICE,
        title: '내 수정',
        body: {},
        expectedEditedAt: null,
        accountId: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryState(adminNoticeKey(notice))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(adminNotice);
    expect(stale()).toEqual([true, true, true, true, true]);
  });

  it('a pin and an unpin go to their own routes and move the notice between the lists', async () => {
    const queryClient = getQueryClient();
    const pinned = { ...adminNotice, pinnedAt: '2026-10-20T02:00:00.000Z' };
    const send = vi
      .spyOn(api, 'POST')
      .mockResolvedValueOnce(answer(pinned))
      .mockResolvedValueOnce(answer(adminNotice));

    let stale = held(queryClient);
    await new MutationObserver(
      queryClient,
      pinNoticeOptions(queryClient, 'pin', sessionUnchanged),
    ).mutate({ noticeId: NOTICE, expectedAccountId: 'admin-1' });
    expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(pinned);
    expect(stale()).toEqual([true, true, true, true, true]);

    stale = held(queryClient);
    await new MutationObserver(
      queryClient,
      pinNoticeOptions(queryClient, 'unpin', sessionUnchanged),
    ).mutate({ noticeId: NOTICE, expectedAccountId: 'admin-1' });
    expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(adminNotice);
    expect(stale()).toEqual([true, true, true, true, true]);
    // Each names the admin on screen (ADR-0092).
    const request = {
      params: { path: { noticeId: notice } },
      body: { expectedAccountId: 'admin-1' },
    };
    expect(send.mock.calls).toEqual([
      ['/api/v1/admin/notices/{noticeId}/pin', request],
      ['/api/v1/admin/notices/{noticeId}/unpin', request],
    ]);
  });

  it('a pin refused at the limit reads the lists again; a refusal for the onboarding reads /me again', async () => {
    const queryClient = getQueryClient();
    const me = new QueryObserver(queryClient, {
      queryKey: ME_QUERY_KEY,
      queryFn: () => Promise.resolve({}),
      enabled: false,
    });
    queryClient.setQueryData(ME_QUERY_KEY, {});
    const unsubscribe = me.subscribe(() => undefined);
    const send = vi.spyOn(api, 'POST');
    const pin = new MutationObserver(
      queryClient,
      pinNoticeOptions(queryClient, 'pin', sessionUnchanged),
    );
    try {
      const stale = held(queryClient);
      send.mockRejectedValueOnce(
        new ApiError(409, {
          code: 'NOTICE_PIN_LIMIT_REACHED',
          message: 'x',
          details: { limit: 3 },
        }),
      );
      await expect(
        pin.mutate({ noticeId: NOTICE, expectedAccountId: 'admin-1' }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(stale().slice(0, 3)).toEqual([true, true, true]);
      // Nothing was answered, so nothing is held under the notice's key.
      expect(queryClient.getQueryData(adminNoticeKey(notice))).toBeUndefined();
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.isInvalidated).toBe(false);

      send.mockRejectedValueOnce(
        new ApiError(409, { code: 'ONBOARDING_REQUIRED', message: 'x' } as never),
      );
      await expect(
        pin.mutate({ noticeId: NOTICE, expectedAccountId: 'admin-1' }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.isInvalidated).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('the cookie of another account asks for the session again and reads nothing else (ADR-0092)', async () => {
    const queryClient = getQueryClient();
    const refused = () =>
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'This session belongs to a different account than the one on screen',
        details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
      });
    vi.spyOn(api, 'POST').mockRejectedValue(refused());
    vi.spyOn(api, 'PUT').mockRejectedValue(refused());
    const writes = [
      (changed: () => void) =>
        new MutationObserver(queryClient, createNoticeOptions(queryClient, changed)).mutate({
          title: '점검 안내',
          body: {},
          accountId: 'admin-1',
        }),
      (changed: () => void) =>
        new MutationObserver(queryClient, updateNoticeOptions(queryClient, changed)).mutate({
          noticeId: NOTICE,
          title: '고친 안내',
          body: {},
          expectedEditedAt: null,
          accountId: 'admin-1',
        }),
      (changed: () => void) =>
        new MutationObserver(queryClient, pinNoticeOptions(queryClient, 'pin', changed)).mutate({
          noticeId: NOTICE,
          expectedAccountId: 'admin-1',
        }),
      (changed: () => void) =>
        new MutationObserver(queryClient, pinNoticeOptions(queryClient, 'unpin', changed)).mutate({
          noticeId: NOTICE,
          expectedAccountId: 'admin-1',
        }),
    ];
    for (const write of writes) {
      const stale = held(queryClient);
      const changed = vi.fn();
      await expect(write(changed)).rejects.toBeInstanceOf(ApiError);
      expect(changed).toHaveBeenCalledTimes(1);
      // The session's reset reads everything: nothing is invalidated here.
      expect(stale()).toEqual([false, false, false, false, false]);
    }
  });
});

describe('a notice’s draft across the onboarding (#138, 오너 결정 2026-10-21 (3차), ADR-0077 decision 8-20)', () => {
  const newKey = { kind: 'notice-new' } as const;
  const editKey = { kind: 'notice-edit', noticeId: notice } as const;
  const draft = { title: '쓰던 공지', body: { type: 'doc', content: [] }, previews: {} };
  const EDITED_AT = '2026-10-20T01:00:00.000Z';

  it('a write or an edit that lands removes the draft the gate kept for its screen — a refusal keeps it', async () => {
    const queryClient = getQueryClient();
    const storage = tabStorage();
    vi.stubGlobal('window', { sessionStorage: storage });
    const now = Date.now();
    keepPostDraft(storage, newKey, 'admin-1', draft, now);
    keepPostDraft(storage, editKey, 'admin-1', { ...draft, version: null }, now);

    // Refused for the onboarding: the draft stays for the screen to take back after the step.
    const send = vi
      .spyOn(api, 'POST')
      .mockRejectedValueOnce(new ApiError(409, { code: 'ONBOARDING_REQUIRED', message: 'x' }));
    const write = new MutationObserver(
      queryClient,
      createNoticeOptions(queryClient, sessionUnchanged),
    );
    const body = { title: '쓰던 공지', body: {}, accountId: 'admin-1' };
    await expect(write.mutate(body)).rejects.toBeInstanceOf(ApiError);
    expect(readPostDraft(storage, newKey, 'admin-1', now)).toEqual(draft);

    // Landed — the screen may be gone by then: the notice holds it now; the edit's stays.
    send.mockResolvedValueOnce(answer(adminNotice));
    await write.mutate(body);
    expect(readPostDraft(storage, newKey, 'admin-1', now)).toBeNull();
    expect(readPostDraft(storage, editKey, 'admin-1', now)).toEqual({ ...draft, version: null });

    // An edit refused because another save overtook it keeps the draft too; one that lands clears
    // it — the id however it is spelled.
    const put = vi.spyOn(api, 'PUT').mockRejectedValueOnce(
      new ApiError(409, {
        code: 'NOTICE_EDIT_CONFLICT',
        message: 'x',
        details: { editedAt: EDITED_AT },
      }),
    );
    const edit = new MutationObserver(
      queryClient,
      updateNoticeOptions(queryClient, sessionUnchanged),
    );
    const variables = {
      noticeId: NOTICE,
      title: '쓰던 공지',
      body: {},
      expectedEditedAt: null,
      accountId: 'admin-1',
    };
    await expect(edit.mutate(variables)).rejects.toBeInstanceOf(ApiError);
    expect(readPostDraft(storage, editKey, 'admin-1', now)).not.toBeNull();
    put.mockResolvedValueOnce(
      answer({ notice: { ...adminNotice, editedAt: EDITED_AT }, changed: true }),
    );
    await edit.mutate(variables);
    expect(readPostDraft(storage, editKey, 'admin-1', now)).toBeNull();
  });

  it('a form the gate takes away keeps its draft — an edit’s with the version it was typed on — but not while a landed write is being handled, though the success renders the form again', async () => {
    const storage = tabStorage();
    vi.stubGlobal('window', { sessionStorage: storage });
    // `GET /me` as the gate finds it: the admin has a step left (a re-consent just shipped).
    const me = { id: 'admin-1', onboarding: { nextStep: 'consent' } } as Me;
    const SAVED_AT = '2026-10-20T02:00:00.000Z';
    const screens: {
      key: PostDraftKey;
      version?: string | null;
      /** The version the form holds once the save landed (the edit screen moves to its answer). */
      savedVersion?: string | null;
      /** The screen stays on the form after the write (the edit screen); else it leaves. */
      stays: boolean;
      send: (queryClient: ReturnType<typeof getQueryClient>) => Promise<unknown>;
    }[] = [
      {
        key: newKey,
        stays: false,
        send: (queryClient) => {
          vi.spyOn(api, 'POST').mockResolvedValueOnce(answer(adminNotice));
          return new MutationObserver(
            queryClient,
            createNoticeOptions(queryClient, sessionUnchanged),
          ).mutate({
            title: '쓰던 공지',
            body: {},
            accountId: 'admin-1',
          });
        },
      },
      {
        key: editKey,
        version: EDITED_AT,
        savedVersion: SAVED_AT,
        stays: true,
        send: (queryClient) => {
          vi.spyOn(api, 'PUT').mockResolvedValueOnce(
            answer({ notice: { ...adminNotice, editedAt: SAVED_AT }, changed: true }),
          );
          return new MutationObserver(
            queryClient,
            updateNoticeOptions(queryClient, sessionUnchanged),
          ).mutate({
            noticeId: NOTICE,
            title: '쓰던 공지',
            body: {},
            expectedEditedAt: EDITED_AT,
            accountId: 'admin-1',
          });
        },
      },
    ];
    for (const { key, version, savedVersion, stays, send } of screens) {
      const queryClient = getQueryClient();
      // The form's renders as the hook holds them (`heldPostDraftAt`): typed, then locked to send.
      const typed: HeldPostDraft = {
        key,
        accountId: 'admin-1',
        hasDraft: true,
        title: '쓰던 공지',
        body: { type: 'doc', content: [] },
        previews: new Map(),
        ...(version === undefined ? {} : { version }),
      };
      let last: HeldPostDraftAt = heldPostDraftAt(undefined, typed, false);
      // Before anything landed, the gate taking it away keeps it — an edit's with its version.
      expect(keepHeldPostDraft(last, me)).toBe(true);
      expect(readPostDraft(storage, key, 'admin-1', Date.now())).toEqual(
        version === undefined
          ? { title: '쓰던 공지', body: typed.body, previews: {} }
          : { title: '쓰던 공지', body: typed.body, previews: {}, version },
      );
      clearPostDraft(storage, key);
      last = heldPostDraftAt(last, typed, true);

      // The write lands; its success is held in `onSuccess` (the lists being read again — each
      // read held until released). Before that, it puts the notice in the cache, which renders the
      // form again — the edit screen reads the notice — still locked, and not shown saved.
      const releases: (() => void)[] = [];
      vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          }),
      );
      let renders = 0;
      const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'success') return;
        renders += 1;
        last = heldPostDraftAt(last, typed, true);
      });
      const sent = send(queryClient);
      await vi.waitFor(() => {
        expect(releases.length).toBeGreaterThan(0);
      });
      unsubscribe();
      expect(renders).toBeGreaterThan(0);
      expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe('pending');
      // The gate takes the form away now: nothing is kept — that render kept the moment of the one
      // that sent, which the landing came after.
      expect(keepHeldPostDraft(last, me)).toBe(false);
      expect(readPostDraft(storage, key, 'admin-1', Date.now())).toBeNull();
      // A moment of its own would have come after the landing, and kept — with the version before
      // the save — what was just saved.
      expect(keepHeldPostDraft({ ...last, moment: postDraftMoment() }, me)).toBe(true);
      clearPostDraft(storage, key);
      for (const release of releases) release();
      await sent;
      expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe('success');
      expect(readPostDraft(storage, key, 'admin-1', Date.now())).toBeNull();

      if (stays) {
        // The edit screen stays on the form after a save, shown saved and unlocked: what it holds
        // is what was sent (the start moved to it), with the save's version — nothing to keep.
        const shown = {
          ...typed,
          hasDraft: false,
          ...(savedVersion === undefined ? {} : { version: savedVersion }),
        };
        last = heldPostDraftAt(last, shown, false);
        expect(keepHeldPostDraft(last, me)).toBe(false);
        // Changed after it, it is a draft again, kept with the version the save moved it to.
        last = heldPostDraftAt(last, { ...shown, title: '다시 고친 공지', hasDraft: true }, false);
        expect(keepHeldPostDraft(last, me)).toBe(true);
        expect(readPostDraft(storage, key, 'admin-1', Date.now())).toMatchObject({
          title: '다시 고친 공지',
          version: SAVED_AT,
        });
      } else {
        // The write screen leaves for the list; a form of it made afterwards keeps its own draft.
        expect(keepHeldPostDraft(heldPostDraftAt(undefined, typed, false), me)).toBe(true);
      }
      clearPostDraft(storage, key);
    }
  });

  it('a write or an edit that lands for admin A leaves what B kept and B’s form: the tab changed from A to B with A’s write in flight (ADR-0073 9-48, 결과 5)', async () => {
    const storage = tabStorage();
    vi.stubGlobal('window', { sessionStorage: storage });
    // `GET /me` as the tab holds it now: B, with a step left (a re-consent just shipped).
    const b = { id: 'admin-2', onboarding: { nextStep: 'consent' } } as Me;
    const screens: {
      key: PostDraftKey;
      version?: string | null;
      send: (queryClient: ReturnType<typeof getQueryClient>, accountId: string) => Promise<unknown>;
    }[] = [
      {
        key: newKey,
        send: (queryClient, accountId) => {
          vi.spyOn(api, 'POST').mockResolvedValueOnce(answer(adminNotice));
          return new MutationObserver(
            queryClient,
            createNoticeOptions(queryClient, sessionUnchanged),
          ).mutate({
            title: '쓰던 공지',
            body: {},
            accountId,
          });
        },
      },
      {
        key: editKey,
        version: EDITED_AT,
        send: (queryClient, accountId) => {
          vi.spyOn(api, 'PUT').mockResolvedValueOnce(
            answer({ notice: { ...adminNotice, editedAt: EDITED_AT }, changed: true }),
          );
          return new MutationObserver(
            queryClient,
            updateNoticeOptions(queryClient, sessionUnchanged),
          ).mutate({
            noticeId: NOTICE,
            title: '쓰던 공지',
            body: {},
            expectedEditedAt: null,
            accountId,
          });
        },
      },
    ];
    for (const { key, version, send } of screens) {
      const queryClient = getQueryClient();
      // A sent the write; the tab changed to B (its `GET /me` in the cache), who opened the same
      // screen and was taken to a step, which kept B's draft; B's form of the screen is drawn again
      // (taken back, say).
      queryClient.setQueryData(ME_QUERY_KEY, b);
      const theirs: HeldPostDraftAt = heldPostDraftAt(
        undefined,
        {
          key,
          accountId: 'admin-2',
          hasDraft: true,
          title: 'B가 쓰던 공지',
          body: { type: 'doc', content: [] },
          previews: new Map(),
          ...(version === undefined ? {} : { version }),
        },
        false,
      );
      expect(keepHeldPostDraft(theirs, b)).toBe(true);
      const kept = readPostDraft(storage, key, 'admin-2', Date.now());
      expect(kept?.title).toBe('B가 쓰던 공지');

      // A's write lands now — the form's account, not the tab's as it lands: B's kept draft stays,
      // and B's form, rendered before it, is not counted as saved — the gate taking it away keeps
      // it again.
      await send(queryClient, 'admin-1');
      expect(readPostDraft(storage, key, 'admin-2', Date.now())).toEqual(kept);
      expect(keepHeldPostDraft(theirs, b)).toBe(true);
      expect(readPostDraft(storage, key, 'admin-2', Date.now())?.title).toBe('B가 쓰던 공지');

      // B's own write of the screen does count, and removes B's draft.
      await send(queryClient, 'admin-2');
      expect(readPostDraft(storage, key, 'admin-2', Date.now())).toBeNull();
      expect(keepHeldPostDraft(theirs, b)).toBe(false);
      expect(readPostDraft(storage, key, 'admin-2', Date.now())).toBeNull();
    }
  });
});
