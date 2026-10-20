import { MutationObserver, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type AdminNotice, type AdminNoticeSummary, api } from '@/lib/api';
import { PRIVATE_QUERY_ROOTS, dehydratePublic } from '@/lib/market-keys';
import {
  ADMIN_NOTICES_KEY,
  PINNED_NOTICES_KEY,
  adminNoticeKey,
  adminNoticeListKey,
  pinnedNoticesView,
} from '@/lib/notices';
import { getQueryClient } from '@/lib/query-client';
import { ME_QUERY_KEY } from './use-me';
import {
  adminNoticeQueryOptions,
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

  it('reads one notice by its lower-cased id', async () => {
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer(adminNotice));
    const options = adminNoticeQueryOptions(NOTICE);
    expect(options.queryKey).toEqual(['admin', 'notices', 'notice', notice]);
    await expect(options.queryFn()).resolves.toEqual(adminNotice);
    expect(get).toHaveBeenCalledWith('/api/v1/admin/notices/{noticeId}', {
      params: { path: { noticeId: notice } },
    });
  });
});

describe('the writes', () => {
  /** Holds both admin lists and the fixed area, and says which of them a write marked stale. */
  function held(queryClient: ReturnType<typeof getQueryClient>) {
    queryClient.setQueryData(adminNoticeListKey('pinned'), { pages: [], pageParams: [] });
    queryClient.setQueryData(adminNoticeListKey('unpinned'), { pages: [], pageParams: [] });
    queryClient.setQueryData(PINNED_NOTICES_KEY, []);
    return () =>
      [adminNoticeListKey('pinned'), adminNoticeListKey('unpinned'), PINNED_NOTICES_KEY].map(
        (key) => queryClient.getQueryState(key)?.isInvalidated,
      );
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
    expect(stale()).toEqual([true, true, true]);
  });

  it('an edit replaces the held notice, by the lower-cased id, and every list is stale', async () => {
    const queryClient = getQueryClient();
    const stale = held(queryClient);
    const edited = { ...adminNotice, title: '고친 안내', editedAt: '2026-10-20T01:00:00.000Z' };
    const put = vi.spyOn(api, 'PUT').mockResolvedValue(answer({ notice: edited, changed: true }));
    const result = await new MutationObserver(queryClient, updateNoticeOptions(queryClient)).mutate(
      { noticeId: NOTICE, title: '고친 안내', body: {} },
    );
    expect(put).toHaveBeenCalledWith('/api/v1/admin/notices/{noticeId}', {
      params: { path: { noticeId: notice } },
      body: { title: '고친 안내', body: {} },
    });
    // The answer, whether this save changed it, is the screen's; the cache holds the notice alone.
    expect(result).toEqual({ notice: edited, changed: true });
    expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(edited);
    expect(stale()).toEqual([true, true, true]);
  });

  it('a save the server found unchanged says so, even when another admin’s edit moved `editedAt`', async () => {
    // Review on #138: the screen held `editedAt: null`, another admin had edited since, and this
    // save sent what that edit says. The server wrote nothing and answers `changed: false` with
    // the other admin's `editedAt`, which the cache now holds.
    const queryClient = getQueryClient();
    queryClient.setQueryData(adminNoticeKey(notice), adminNotice);
    const theirs = { ...adminNotice, title: '다른 운영자', editedAt: '2026-10-20T01:00:00.000Z' };
    vi.spyOn(api, 'PUT').mockResolvedValue(answer({ notice: theirs, changed: false }));
    const result = await new MutationObserver(queryClient, updateNoticeOptions(queryClient)).mutate(
      { noticeId: NOTICE, title: '다른 운영자', body: {} },
    );
    expect(result.changed).toBe(false);
    expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(theirs);
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
    expect(stale()).toEqual([true, true, true]);

    stale = held(queryClient);
    await new MutationObserver(queryClient, pinNoticeOptions(queryClient, 'unpin')).mutate(NOTICE);
    expect(queryClient.getQueryData(adminNoticeKey(notice))).toEqual(adminNotice);
    expect(stale()).toEqual([true, true, true]);
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
      expect(stale()).toEqual([true, true, true]);
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
