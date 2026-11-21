import { readFileSync } from 'node:fs';
import { MutationObserver, type QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type InboxNotification,
  type NotificationReadResult,
  type NotificationUnreadCount,
  api,
} from '@/lib/api';
import { isPrivateQueryKey } from '@/lib/market-keys';
import {
  NOTIFICATION_REFRESH_MS,
  type NotificationPages,
  notificationListKey,
  notificationUnreadKey,
} from '@/lib/notifications';
import { getQueryClient } from '@/lib/query-client';
import {
  type ReadAllNotificationsVariables,
  type ReadNotificationVariables,
  myNotificationsInfiniteQueryOptions,
  notificationUnreadCountQueryOptions,
  readAllNotificationsOptions,
  readNotificationOptions,
  storeNotificationRead,
} from './use-notifications';

/**
 * 알림함's member cache (#53, ADR-0157), driven through the REAL QueryClient under node — the
 * options are exported apart from their hooks for this, as use-disputes.test.ts does.
 */

const ACCOUNT = 'user-1';
const OTHER = 'user-2';
const LIST = notificationListKey(ACCOUNT);
const UNREAD = notificationUnreadKey(ACCOUNT);
const READ_AT = '2026-11-21T04:00:00.000Z';

const notification = (id: string, fields: Partial<InboxNotification> = {}): InboxNotification => ({
  id,
  type: 'test_notice',
  category: 'market',
  params: { label: '첫눈' },
  target: { kind: 'market', slug: 'first-snow' },
  eventCount: 1,
  occurredAt: '2026-11-21T03:00:00.000Z',
  readAt: null,
  ...fields,
});

const refused = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);
const forAnotherAccount = () =>
  refused(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'another account' }]);

const invalidated = (queryClient: QueryClient, key: readonly unknown[]) =>
  queryClient.getQueryState(key)?.isInvalidated;

function seed(queryClient: QueryClient, account = ACCOUNT, unread = 2) {
  queryClient.setQueryData<NotificationPages>(notificationListKey(account), {
    pages: [{ items: [notification('n1'), notification('n2')], nextCursor: null }],
    pageParams: [undefined],
  });
  queryClient.setQueryData<number>(notificationUnreadKey(account), unread);
}

const rows = (queryClient: QueryClient, account = ACCOUNT) =>
  queryClient
    .getQueryData<NotificationPages>(notificationListKey(account))
    ?.pages.flatMap((page) => page.items);

describe('the inbox’s reads', () => {
  it('are private, wait for a session and the account, and never poll (53-1)', async () => {
    const count = notificationUnreadCountQueryOptions(ACCOUNT, { user: {} });
    expect(count.queryKey).toEqual(['notifications', 'unread', ACCOUNT]);
    expect(isPrivateQueryKey(count.queryKey)).toBe(true);
    expect(count.enabled).toBe(true);
    // Kept by events alone: no focus, remount or interval reads it again.
    expect(count.staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(count).not.toHaveProperty('refetchInterval');
    expect(notificationUnreadCountQueryOptions(ACCOUNT, null).enabled).toBe(false);
    expect(notificationUnreadCountQueryOptions(ACCOUNT, undefined).enabled).toBe(false);
    expect(notificationUnreadCountQueryOptions(undefined, { user: {} }).enabled).toBe(false);

    const list = myNotificationsInfiniteQueryOptions(ACCOUNT, { user: {} });
    expect(list.queryKey).toEqual(['notifications', 'list', ACCOUNT]);
    expect(isPrivateQueryKey(list.queryKey)).toBe(true);
    expect(list.enabled).toBe(true);
    expect(myNotificationsInfiniteQueryOptions(ACCOUNT, null).enabled).toBe(false);
    expect(myNotificationsInfiniteQueryOptions(undefined, { user: {} }).enabled).toBe(false);
    expect(list.getNextPageParam({ items: [], nextCursor: 'c2' })).toBe('c2');
    expect(list.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();

    const get = vi.spyOn(api, 'GET');
    try {
      get.mockResolvedValueOnce({
        data: { data: { unreadCount: 7 } },
        response: new Response(null, { status: 200 }),
      } as never);
      expect(await count.queryFn()).toBe(7);
      expect(get).toHaveBeenLastCalledWith('/api/v1/me/notifications/unread-count');
      get.mockResolvedValue({
        data: { data: [notification('n1')], meta: { nextCursor: 'c3' } },
        response: new Response(null, { status: 200 }),
      } as never);
      expect(await list.queryFn({ pageParam: undefined })).toEqual({
        items: [notification('n1')],
        nextCursor: 'c3',
      });
      expect(get).toHaveBeenLastCalledWith('/api/v1/me/notifications', {
        params: { query: {} },
      });
      await list.queryFn({ pageParam: 'c2' });
      expect(get).toHaveBeenLastCalledWith('/api/v1/me/notifications', {
        params: { query: { cursor: 'c2' } },
      });
    } finally {
      get.mockRestore();
    }
  });

  it('reads the count once on mount and not again on a remount (staleTime)', async () => {
    const queryClient = getQueryClient();
    const get = vi.spyOn(api, 'GET').mockResolvedValue({
      data: { data: { unreadCount: 3 } },
      response: new Response(null, { status: 200 }),
    } as never);
    try {
      const options = notificationUnreadCountQueryOptions(ACCOUNT, { user: {} });
      const first = new QueryObserver(queryClient, options);
      const leave = first.subscribe(() => undefined);
      await vi.waitFor(() => expect(first.getCurrentResult().data).toBe(3));
      leave();
      const again = new QueryObserver(queryClient, options);
      const leaveAgain = again.subscribe(() => undefined);
      expect(again.getCurrentResult().data).toBe(3);
      leaveAgain();
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      get.mockRestore();
      queryClient.clear();
    }
  });

  it('keep /my/notifications at 50 up to 15 loaded pages — the documented limit (ADR-0157 결과 4)', () => {
    // One tab at most 50 a minute (ADR-0138). The provider's `refreshNotifications` round, whose
    // wiring use-wallet-budget.test.ts pins, restarts the count and the list, and on MY › 알림
    // both are on screen: the count once, the list every page it has loaded (20 rows a page, the
    // server's default). Nothing else on the screen reads in the steady state — the session and
    // `GET /me` are read on entry, a reconnect and a focus.
    const minute = 60_000;
    const rounds = Math.floor(minute / NOTIFICATION_REFRESH_MS) + 1;
    expect(NOTIFICATION_REFRESH_MS).toBe(30_000);
    expect(rounds).toBe(3);
    const steady = (pages: number) => rounds * (1 + pages);
    expect(steady(15)).toBe(48);
    // Past it a very long list (301 rows or more) can pass 50, as /my/history's (ADR-0148).
    expect(steady(16)).toBe(51);
  });
});

describe('readNotificationOptions (53-2)', () => {
  it('sends the account the screen shows, and puts the answer in that account’s caches', async () => {
    const queryClient = getQueryClient();
    seed(queryClient);
    const answered: NotificationReadResult = {
      notification: notification('n2', { readAt: READ_AT }),
      unreadCount: 1,
    };
    const post = vi.fn((_: ReadNotificationVariables) => Promise.resolve(answered));
    const read: ReadNotificationVariables = { id: 'n2', expectedAccountId: ACCOUNT };
    await new MutationObserver(
      queryClient,
      readNotificationOptions(queryClient, () => undefined, post),
    ).mutate(read);
    expect(post.mock.calls[0]?.[0]).toEqual(read);
    expect(rows(queryClient)?.map((row) => row.readAt)).toEqual([null, READ_AT]);
    expect(queryClient.getQueryData(UNREAD)).toBe(1);
    // Nothing is read again: the answer is the state after the write.
    expect(invalidated(queryClient, LIST)).toBe(false);
    expect(invalidated(queryClient, UNREAD)).toBe(false);
    queryClient.clear();
  });

  it('cancels a count read on its way, which left before the write', async () => {
    const queryClient = getQueryClient();
    seed(queryClient);
    let answer: (value: unknown) => void = () => undefined;
    const get = vi.spyOn(api, 'GET').mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }) as never,
    );
    try {
      const options = notificationUnreadCountQueryOptions(ACCOUNT, { user: {} });
      void queryClient.fetchQuery({ ...options, staleTime: 0 }).catch(() => undefined);
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      await storeNotificationRead(
        queryClient,
        { notification: notification('n1', { readAt: READ_AT }), unreadCount: 1 },
        ACCOUNT,
      );
      // The read that left before lands with the count before the write: it is not taken.
      answer({ data: { data: { unreadCount: 2 } }, response: new Response(null) });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(queryClient.getQueryData(UNREAD)).toBe(1);
    } finally {
      get.mockRestore();
      queryClient.clear();
    }
  });

  it('writes nothing into another account’s cache (an answer landing after the tab turned)', async () => {
    const queryClient = getQueryClient();
    seed(queryClient, ACCOUNT, 2);
    seed(queryClient, OTHER, 5);
    await storeNotificationRead(
      queryClient,
      { notification: notification('n1', { readAt: READ_AT }), unreadCount: 1 },
      ACCOUNT,
    );
    expect(rows(queryClient, OTHER)?.every((row) => row.readAt === null)).toBe(true);
    expect(queryClient.getQueryData(notificationUnreadKey(OTHER))).toBe(5);
    expect(rows(queryClient)?.[0]?.readAt).toBe(READ_AT);
    queryClient.clear();
  });

  it('asks for the session on a refusal as another account, and reads the inbox again on any other', async () => {
    const queryClient = getQueryClient();
    seed(queryClient);
    const sessionChanged = vi.fn();
    const failWith = (error: Error) =>
      new MutationObserver(
        queryClient,
        readNotificationOptions(queryClient, sessionChanged, () => Promise.reject(error)),
      );
    const read: ReadNotificationVariables = { id: 'n1', expectedAccountId: ACCOUNT };

    await expect(failWith(forAnotherAccount()).mutate(read)).rejects.toThrow();
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    // Nothing of this account's is touched: the screen is about to be another account's.
    expect(invalidated(queryClient, LIST)).toBe(false);
    expect(invalidated(queryClient, UNREAD)).toBe(false);

    // Gone (a retention purge answers 404) or unreachable: the count and the list are asked again.
    await expect(failWith(refused(404, 'NOT_FOUND')).mutate(read)).rejects.toThrow();
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    expect(invalidated(queryClient, LIST)).toBe(true);
    expect(invalidated(queryClient, UNREAD)).toBe(true);
    queryClient.clear();
  });
});

describe('readAllNotificationsOptions (53-2 모두 읽음)', () => {
  it('takes the answered count, and reads the list again for each row’s readAt', async () => {
    const queryClient = getQueryClient();
    seed(queryClient);
    seed(queryClient, OTHER, 5);
    const post = vi.fn((_: ReadAllNotificationsVariables) =>
      Promise.resolve<NotificationUnreadCount>({ unreadCount: 0 }),
    );
    await new MutationObserver(
      queryClient,
      readAllNotificationsOptions(queryClient, () => undefined, post),
    ).mutate({ expectedAccountId: ACCOUNT });
    expect(post.mock.calls[0]?.[0]).toEqual({ expectedAccountId: ACCOUNT });
    expect(queryClient.getQueryData(UNREAD)).toBe(0);
    expect(invalidated(queryClient, LIST)).toBe(true);
    // Another account's entries stay as they were.
    expect(queryClient.getQueryData(notificationUnreadKey(OTHER))).toBe(5);
    expect(invalidated(queryClient, notificationListKey(OTHER))).toBe(false);
    queryClient.clear();
  });

  it('asks for the session on a refusal as another account, and reads the inbox again on any other', async () => {
    const queryClient = getQueryClient();
    seed(queryClient);
    const sessionChanged = vi.fn();
    const failWith = (error: Error) =>
      new MutationObserver(
        queryClient,
        readAllNotificationsOptions(queryClient, sessionChanged, () => Promise.reject(error)),
      );
    await expect(
      failWith(forAnotherAccount()).mutate({ expectedAccountId: ACCOUNT }),
    ).rejects.toThrow();
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(UNREAD)).toBe(2);
    expect(invalidated(queryClient, UNREAD)).toBe(false);
    await expect(
      failWith(refused(500, 'INTERNAL')).mutate({ expectedAccountId: ACCOUNT }),
    ).rejects.toThrow();
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    expect(invalidated(queryClient, UNREAD)).toBe(true);
    expect(invalidated(queryClient, LIST)).toBe(true);
    queryClient.clear();
  });

  it('sends the bodies the API takes: the id in the path and the account in the body', async () => {
    const post = vi.spyOn(api, 'POST').mockResolvedValue({
      data: { data: { notification: notification('n1', { readAt: READ_AT }), unreadCount: 0 } },
      response: new Response(null, { status: 200 }),
    });
    const queryClient = getQueryClient();
    try {
      await new MutationObserver(
        queryClient,
        readNotificationOptions(queryClient, () => undefined),
      ).mutate({ id: 'n1', expectedAccountId: ACCOUNT });
      expect(post).toHaveBeenLastCalledWith('/api/v1/me/notifications/{id}/read', {
        params: { path: { id: 'n1' } },
        body: { expectedAccountId: ACCOUNT },
      });
      post.mockResolvedValue({
        data: { data: { unreadCount: 0 } },
        response: new Response(null, { status: 200 }),
      });
      await new MutationObserver(
        queryClient,
        readAllNotificationsOptions(queryClient, () => undefined),
      ).mutate({ expectedAccountId: ACCOUNT });
      expect(post).toHaveBeenLastCalledWith('/api/v1/me/notifications/read-all', {
        body: { expectedAccountId: ACCOUNT },
      });
    } finally {
      post.mockRestore();
      queryClient.clear();
    }
  });
});

describe('the hooks’ wiring', () => {
  it('names the session’s refetch as the account refusal’s answer, and no account of their own', () => {
    // No component renders under node with effects: the hooks are pinned in their source. The
    // writes take the account from their caller (the screen's `Me`, ADR-0091), never the session.
    const source = readFileSync(new URL('./use-notifications.ts', import.meta.url), 'utf8');
    expect(source).toContain(
      'return useMutation(readNotificationOptions(queryClient, () => void refetchSession()));',
    );
    expect(source).toContain(
      'return useMutation(readAllNotificationsOptions(queryClient, () => void refetchSession()));',
    );
    expect(source).not.toMatch(/session(?:\?)?\.user\.id/);
  });
});
