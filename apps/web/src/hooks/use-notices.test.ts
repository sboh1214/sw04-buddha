import { MutationObserver, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type AdminNotice, type AdminNoticeSummary, api } from '@/lib/api';
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
});

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
    // Owner decision 2026-10-21 7: a save is refused when another admin saved after the screen
    // opened. The form saves against the version it opens on, so a copy the cache held from an
    // earlier visit — fresh by the client's 30 s, and older than another admin's save since —
    // must not be what it opens on (ADR-0077 decision 8-19).
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

  it('a new notice is sent with its title and body only, held under its key, and every list is stale', async () => {
    const queryClient = getQueryClient();
    const stale = held(queryClient);
    const send = vi.spyOn(api, 'POST').mockResolvedValue(answer(adminNotice));
    await new MutationObserver(queryClient, createNoticeOptions(queryClient)).mutate({
      title: '점검 안내',
      body: { type: 'doc', content: [] },
    });
    expect(send).toHaveBeenCalledWith('/api/v1/admin/notices', {
      body: { title: '점검 안내', body: { type: 'doc', content: [] } },
    });
    expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(adminNotice);
    expect(stale()).toEqual([true, true, true, true, true]);
  });

  it('an edit sends the version it was opened from, replaces the held notice, and every list is stale', async () => {
    const queryClient = getQueryClient();
    const stale = held(queryClient);
    const edited = { ...adminNotice, title: '고친 안내', editedAt: '2026-10-20T01:00:00.000Z' };
    const put = vi.spyOn(api, 'PUT').mockResolvedValue(answer({ notice: edited, changed: true }));
    const result = await new MutationObserver(queryClient, updateNoticeOptions(queryClient)).mutate(
      { noticeId: NOTICE, title: '고친 안내', body: {}, expectedEditedAt: null },
    );
    expect(put).toHaveBeenCalledWith('/api/v1/admin/notices/{noticeId}', {
      params: { path: { noticeId: notice } },
      body: { title: '고친 안내', body: {}, expectedEditedAt: null },
    });
    // The answer, whether this save changed it, is the screen's; the cache holds the notice alone,
    // and the notice's records and versions are read again (the edit added one of each).
    expect(result).toEqual({ notice: edited, changed: true });
    expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(edited);
    expect(stale()).toEqual([true, true, true, true, true]);
  });

  it('a save the server found unchanged says so, and holds the notice it answered', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(adminNoticeKey(notice), adminNotice);
    vi.spyOn(api, 'PUT').mockResolvedValue(answer({ notice: adminNotice, changed: false }));
    const result = await new MutationObserver(queryClient, updateNoticeOptions(queryClient)).mutate(
      { noticeId: NOTICE, title: adminNotice.title, body: {}, expectedEditedAt: null },
    );
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
      new MutationObserver(queryClient, updateNoticeOptions(queryClient)).mutate({
        noticeId: NOTICE,
        title: '내 수정',
        body: {},
        expectedEditedAt: null,
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
    await new MutationObserver(queryClient, pinNoticeOptions(queryClient, 'pin')).mutate(NOTICE);
    expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(pinned);
    expect(stale()).toEqual([true, true, true, true, true]);

    stale = held(queryClient);
    await new MutationObserver(queryClient, pinNoticeOptions(queryClient, 'unpin')).mutate(NOTICE);
    expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(adminNotice);
    expect(stale()).toEqual([true, true, true, true, true]);
    expect(send.mock.calls).toEqual([
      ['/api/v1/admin/notices/{noticeId}/pin', { params: { path: { noticeId: notice } } }],
      ['/api/v1/admin/notices/{noticeId}/unpin', { params: { path: { noticeId: notice } } }],
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
    const pin = new MutationObserver(queryClient, pinNoticeOptions(queryClient, 'pin'));
    try {
      const stale = held(queryClient);
      send.mockRejectedValueOnce(
        new ApiError(409, {
          code: 'NOTICE_PIN_LIMIT_REACHED',
          message: 'x',
          details: { limit: 3 },
        }),
      );
      await expect(pin.mutate(NOTICE)).rejects.toBeInstanceOf(ApiError);
      expect(stale().slice(0, 3)).toEqual([true, true, true]);
      // Nothing was answered, so nothing is held under the notice's key.
      expect(queryClient.getQueryData(adminNoticeKey(notice))).toBeUndefined();
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.isInvalidated).toBe(false);

      send.mockRejectedValueOnce(
        new ApiError(409, { code: 'ONBOARDING_REQUIRED', message: 'x' } as never),
      );
      await expect(pin.mutate(NOTICE)).rejects.toBeInstanceOf(ApiError);
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.isInvalidated).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});
