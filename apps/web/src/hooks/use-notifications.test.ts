import { readFileSync } from 'node:fs';
import { MutationObserver, type QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type InboxNotification,
  type NotificationReadResult,
  type NotificationSettings,
  type NotificationUnreadCount,
  api,
} from '@/lib/api';
import { isPrivateQueryKey } from '@/lib/market-keys';
import {
  NOTIFICATION_REFRESH_MS,
  type NotificationPages,
  notificationListKey,
  notificationSettingsKey,
  notificationUnreadKey,
} from '@/lib/notifications';
import { getQueryClient } from '@/lib/query-client';
import {
  type ReadAllNotificationsVariables,
  type ReadNotificationVariables,
  type UpdateNotificationSettingVariables,
  myNotificationsInfiniteQueryOptions,
  notificationSettingsQueryOptions,
  notificationUnreadCountQueryOptions,
  readAllNotificationsOptions,
  readNotificationOptions,
  storeNotificationRead,
  updateNotificationSettingOptions,
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
    expect(source).toContain(
      'return useMutation(updateNotificationSettingOptions(queryClient, () => void refetchSession()));',
    );
    expect(source).not.toMatch(/session(?:\?)?\.user\.id/);
  });
});

// ---- 알림 수신 설정 (#56, ADR-0162; 52-21, 56-1…56-5) ------------------------------------------

const SETTINGS = notificationSettingsKey(ACCOUNT);

const settings = (trade: boolean, market: boolean, community: boolean): NotificationSettings => ({
  categories: [
    { category: 'trade', enabled: trade },
    { category: 'market', enabled: market },
    { category: 'community', enabled: community },
  ],
});

const enabledOf = (queryClient: QueryClient, account = ACCOUNT) =>
  queryClient
    .getQueryData<NotificationSettings>(notificationSettingsKey(account))
    ?.categories.map((entry) => entry.enabled);

/** A write's answer that waits for `release`, for answers that land out of order. */
function held(answer: NotificationSettings) {
  let release: () => void = () => undefined;
  const promise = new Promise<NotificationSettings>((resolve) => {
    release = () => resolve(answer);
  });
  return { promise, release: () => release() };
}

describe('the settings’ read', () => {
  it('is private, waits for a session and the account, and keeps the app’s stale time (no polling)', async () => {
    const options = notificationSettingsQueryOptions(ACCOUNT, { user: {} });
    expect(options.queryKey).toEqual(['notifications', 'settings', ACCOUNT]);
    expect(isPrivateQueryKey(options.queryKey)).toBe(true);
    expect(options.enabled).toBe(true);
    // The default 30 s (query-client.ts): a focus after it reads it again; nothing on a timer.
    expect(options).not.toHaveProperty('staleTime');
    expect(options).not.toHaveProperty('refetchInterval');
    expect(notificationSettingsQueryOptions(ACCOUNT, null).enabled).toBe(false);
    expect(notificationSettingsQueryOptions(ACCOUNT, undefined).enabled).toBe(false);
    expect(notificationSettingsQueryOptions(undefined, { user: {} }).enabled).toBe(false);
    const get = vi.spyOn(api, 'GET').mockResolvedValue({
      data: { data: settings(true, false, true) },
      response: new Response(null, { status: 200 }),
    } as never);
    try {
      expect(await options.queryFn()).toEqual(settings(true, false, true));
      expect(get).toHaveBeenLastCalledWith('/api/v1/me/notifications/settings');
    } finally {
      get.mockRestore();
    }
  });

  it('stays out of the user:notification round, so MY › 알림’s budget is unchanged (ADR-0138)', () => {
    // The realtime provider restarts the count and the list on the signal — never the settings,
    // which no notification changes. A reconnect re-reads the whole private root (a snapshot key),
    // and MY › 알림 draws no settings: its link to them reads nothing.
    const provider = readFileSync(
      new URL('../components/realtime/realtime-provider.tsx', import.meta.url),
      'utf8',
    );
    const round = provider.slice(
      provider.indexOf('const refreshNotifications = '),
      provider.indexOf(
        'const timer = setTimeout(',
        provider.indexOf('const refreshNotifications = '),
      ),
    );
    expect(round.match(/restartQueries\(/g)).toHaveLength(2);
    expect(round).toContain('notificationUnreadKey(identity ?? undefined)');
    expect(round).toContain('notificationListKey(identity ?? undefined)');
    expect(provider).not.toContain('notificationSettingsKey');
    expect(provider).not.toContain('NOTIFICATION_SETTINGS_KEY');
    const myNotifications = readFileSync(
      new URL('../app/my/notifications/my-notifications.tsx', import.meta.url),
      'utf8',
    );
    expect(myNotifications).not.toContain('useNotificationSettings');
  });

  it('costs /my/settings one read on entry and one PUT per press — far below 50 a minute (§7)', async () => {
    // Measured on the real options and QueryClient: the entry's reads, six presses' PUTs and the
    // reads they cause, and a focus while fresh. Focus reads come from the stale time the observer
    // resolved; a reconnect adds 1; a press that cancelled a read on its way (a focus or the
    // reconnect) replaces it with one — so at most one per such read.
    const queryClient = getQueryClient();
    const get = vi.spyOn(api, 'GET').mockResolvedValue({
      data: { data: settings(true, true, true) },
      response: new Response(null, { status: 200 }),
    } as never);
    const put = vi.fn(({ category, enabled }: UpdateNotificationSettingVariables) =>
      Promise.resolve({
        categories: settings(true, true, true).categories.map((row) =>
          row.category === category ? { ...row, enabled } : row,
        ),
      }),
    );
    const observer = new QueryObserver(
      queryClient,
      notificationSettingsQueryOptions(ACCOUNT, { user: {} }),
    );
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
      const entryReads = get.mock.calls.length;
      expect(entryReads).toBe(1);
      const mutation = new MutationObserver(
        queryClient,
        updateNotificationSettingOptions(queryClient, () => undefined, put),
      );
      const categories = ['trade', 'market', 'community'] as const;
      for (const [index, category] of [...categories, ...categories].entries()) {
        await mutation.mutate({ category, enabled: index >= 3, expectedAccountId: ACCOUNT });
      }
      // A focus while the answer is fresh reads nothing.
      queryClient.getQueryCache().onFocus();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const pressReads = get.mock.calls.length - entryReads;
      expect(pressReads).toBe(0);
      expect(put).toHaveBeenCalledTimes(6);
      const { staleTime, refetchInterval } = observer.options;
      expect(refetchInterval).toBeFalsy();
      expect(typeof staleTime).toBe('number');
      const focusReads = Math.ceil(60_000 / (staleTime as number));
      const reconnectReads = 1;
      const replacedReads = focusReads + reconnectReads;
      const minute =
        entryReads +
        focusReads +
        reconnectReads +
        put.mock.calls.length +
        pressReads +
        replacedReads;
      expect(minute).toBeLessThan(50);
    } finally {
      unsubscribe();
      get.mockRestore();
      queryClient.clear();
    }
  });
});

describe('updateNotificationSettingOptions (52-21: one category on or off)', () => {
  it('sends the category, the value and the account the card shows; writes that category only', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(SETTINGS, settings(true, true, true));
    queryClient.setQueryData(notificationSettingsKey(OTHER), settings(true, true, true));
    const put = vi.fn((_: UpdateNotificationSettingVariables) =>
      // The server's whole list after the write: here it also says trade off (another tab).
      Promise.resolve(settings(false, false, true)),
    );
    const variables: UpdateNotificationSettingVariables = {
      category: 'market',
      enabled: false,
      expectedAccountId: ACCOUNT,
    };
    await new MutationObserver(
      queryClient,
      updateNotificationSettingOptions(queryClient, () => undefined, put),
    ).mutate(variables);
    expect(put.mock.calls[0]?.[0]).toEqual(variables);
    // Only the market entry was taken from the answer; nothing is read again.
    expect(enabledOf(queryClient)).toEqual([true, false, true]);
    expect(invalidated(queryClient, SETTINGS)).toBe(false);
    // Another account's entry stays as it was.
    expect(enabledOf(queryClient, OTHER)).toEqual([true, true, true]);
    queryClient.clear();
  });

  it('keeps each row’s own answer when two rows’ answers land out of order', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(SETTINGS, settings(true, true, true));
    // Trade off first (its answer: trade off), then community off (its answer: both off). The
    // community answer lands first, the trade answer — older, saying community on — after it.
    const tradeAnswer = held(settings(false, true, true));
    const communityAnswer = held(settings(false, true, false));
    const put = vi.fn(({ category }: UpdateNotificationSettingVariables) =>
      category === 'trade' ? tradeAnswer.promise : communityAnswer.promise,
    );
    const options = () => updateNotificationSettingOptions(queryClient, () => undefined, put);
    const trade = new MutationObserver(queryClient, options()).mutate({
      category: 'trade',
      enabled: false,
      expectedAccountId: ACCOUNT,
    });
    const community = new MutationObserver(queryClient, options()).mutate({
      category: 'community',
      enabled: false,
      expectedAccountId: ACCOUNT,
    });
    communityAnswer.release();
    await community;
    expect(enabledOf(queryClient)).toEqual([true, true, false]);
    tradeAnswer.release();
    await trade;
    // Neither undid the other.
    expect(enabledOf(queryClient)).toEqual([false, true, false]);
    queryClient.clear();
  });

  it('cancels a settings read on its way, which left before the write and would switch the row back', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(SETTINGS, settings(true, true, true));
    let answer: (value: unknown) => void = () => undefined;
    const get = vi.spyOn(api, 'GET').mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }) as never,
    );
    try {
      // A focus after 30 s, or a reconnect's restart: a read in flight.
      const read = notificationSettingsQueryOptions(ACCOUNT, { user: {} });
      void queryClient.fetchQuery({ ...read, staleTime: 0 }).catch(() => undefined);
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      await new MutationObserver(
        queryClient,
        updateNotificationSettingOptions(
          queryClient,
          () => undefined,
          () => Promise.resolve(settings(true, false, true)),
        ),
      ).mutate({ category: 'market', enabled: false, expectedAccountId: ACCOUNT });
      expect(enabledOf(queryClient)).toEqual([true, false, true]);
      // The read that left before lands with market on: it is not taken.
      answer({ data: { data: settings(true, true, true) }, response: new Response(null) });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(enabledOf(queryClient)).toEqual([true, false, true]);
    } finally {
      get.mockRestore();
      queryClient.clear();
    }
  });

  it('reads again after cancelling a read on its way, so another tab’s change it carried still shows', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(SETTINGS, settings(true, true, true));
    // The card on screen: an active observer of the account's settings.
    const observer = new QueryObserver(
      queryClient,
      notificationSettingsQueryOptions(ACCOUNT, { user: {} }),
    );
    const unsubscribe = observer.subscribe(() => undefined);
    const get = vi
      .spyOn(api, 'GET')
      // A focus read that left before the write (it would say community off — another tab's
      // change), cancelled by the write's answer…
      .mockImplementationOnce(() => new Promise(() => undefined) as never)
      // …and the read after it: the server's state after the write.
      .mockResolvedValue({
        data: { data: settings(true, false, false) },
        response: new Response(null),
      } as never);
    try {
      void observer.refetch().catch(() => undefined);
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      await new MutationObserver(
        queryClient,
        updateNotificationSettingOptions(
          queryClient,
          () => undefined,
          () => Promise.resolve(settings(true, false, false)),
        ),
      ).mutate({ category: 'market', enabled: false, expectedAccountId: ACCOUNT });
      // Community comes from the read after the write; it is not left on, marked fresh.
      await vi.waitFor(() => expect(enabledOf(queryClient)).toEqual([true, false, false]));
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      get.mockRestore();
      queryClient.clear();
    }
  });

  it('reads nothing after a write when no read was on its way', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(SETTINGS, settings(true, true, true));
    const observer = new QueryObserver(
      queryClient,
      notificationSettingsQueryOptions(ACCOUNT, { user: {} }),
    );
    const unsubscribe = observer.subscribe(() => undefined);
    const get = vi.spyOn(api, 'GET');
    try {
      await new MutationObserver(
        queryClient,
        updateNotificationSettingOptions(
          queryClient,
          () => undefined,
          () => Promise.resolve(settings(true, false, true)),
        ),
      ).mutate({ category: 'market', enabled: false, expectedAccountId: ACCOUNT });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(enabledOf(queryClient)).toEqual([true, false, true]);
      expect(get).not.toHaveBeenCalled();
      expect(invalidated(queryClient, SETTINGS)).toBe(false);
    } finally {
      unsubscribe();
      get.mockRestore();
      queryClient.clear();
    }
  });

  it('asks for the session on a refusal as another account; any other refusal leaves the cache', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(SETTINGS, settings(true, true, true));
    const sessionChanged = vi.fn();
    const failWith = (error: Error) =>
      new MutationObserver(
        queryClient,
        updateNotificationSettingOptions(queryClient, sessionChanged, () => Promise.reject(error)),
      );
    const variables: UpdateNotificationSettingVariables = {
      category: 'trade',
      enabled: false,
      expectedAccountId: ACCOUNT,
    };
    await expect(failWith(forAnotherAccount()).mutate(variables)).rejects.toThrow();
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    expect(enabledOf(queryClient)).toEqual([true, true, true]);
    expect(invalidated(queryClient, SETTINGS)).toBe(false);
    for (const error of [refused(400, 'VALIDATION_ERROR'), refused(404, 'NOT_FOUND')]) {
      await expect(failWith(error).mutate(variables)).rejects.toThrow();
    }
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    expect(enabledOf(queryClient)).toEqual([true, true, true]);
    expect(invalidated(queryClient, SETTINGS)).toBe(false);
    queryClient.clear();
  });

  it('sends the body the API takes: the category in the path, the value and the account in the body', async () => {
    const put = vi.spyOn(api, 'PUT').mockResolvedValue({
      data: { data: settings(true, false, true) },
      response: new Response(null, { status: 200 }),
    });
    const queryClient = getQueryClient();
    try {
      await new MutationObserver(
        queryClient,
        updateNotificationSettingOptions(queryClient, () => undefined),
      ).mutate({ category: 'market', enabled: false, expectedAccountId: ACCOUNT });
      expect(put).toHaveBeenLastCalledWith('/api/v1/me/notifications/settings/{category}', {
        params: { path: { category: 'market' } },
        body: { enabled: false, expectedAccountId: ACCOUNT },
      });
      // Nothing held (the card not drawn yet): the answer whole.
      expect(enabledOf(queryClient)).toEqual([true, false, true]);
    } finally {
      put.mockRestore();
      queryClient.clear();
    }
  });
});
