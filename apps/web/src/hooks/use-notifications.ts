'use client';

import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type NotificationCategory,
  type NotificationReadResult,
  type NotificationSettings,
  type NotificationUnreadCount,
  api,
  isForAnotherAccount,
  unwrap,
} from '@/lib/api';
import {
  type NotificationPage,
  type NotificationPages,
  notificationListKey,
  notificationSettingsKey,
  notificationUnreadKey,
  withNotification,
  withNotificationSetting,
} from '@/lib/notifications';
import { restartQueries } from '@/lib/query-client';
import { useSession } from '@/lib/use-session';

/**
 * 알림함 (#53, ADR-0157): the member's unread count — beside MY in the header and the bottom tabs
 * and on MY's 알림 tab — the inbox (MY › 알림 and its preview on MY 요약), a read and '모두 읽음'.
 *
 * Private — `['notifications']` is in `PRIVATE_QUERY_ROOTS`, so nothing of it is ever dehydrated
 * into a page — and every read waits for the session and the account the screen shows (ADR-0091,
 * `notificationUnreadKey`, `notificationListKey`): the routes need the cookie, and the answers
 * name no owner.
 *
 * Kept by events, never polled (53-1 '폴링 없음'): the count is read on its first mount and then
 * only when something says it moved — a `user:notification` (the realtime provider's
 * `refreshNotifications`, at most once per `NOTIFICATION_REFRESH_MS` after the first), a
 * reconnect's resnapshot (`PRIVATE_SNAPSHOT_KEYS`), and this tab's own writes, whose answers carry
 * the count after them. So its `staleTime` is infinite: a focus or a remount reads nothing.
 *
 * And since #56 (ADR-0162) the member's 알림 수신 설정 on MY › 설정 — a read with the default stale
 * time and a write per switch (below).
 *
 * The query and mutation options are exported apart from the hooks so they can be tested under
 * the node runner (use-notifications.test.ts), as use-disputes.ts does.
 */

/** Just enough of better-auth's session to say whether anybody is signed in (use-portfolio.ts). */
type SessionLike = { user: unknown } | null;

/**
 * `GET /me/notifications/unread-count` of the account the screen shows (`accountId`): 0 to 100,
 * 100 meaning "100 or more" (the screens show '99+'). Read only once signed in and that account is
 * known, and never again on its own (`staleTime: Infinity`, above).
 */
export function notificationUnreadCountQueryOptions(
  accountId: string | undefined,
  session?: SessionLike,
) {
  return {
    queryKey: notificationUnreadKey(accountId),
    queryFn: async (): Promise<number> =>
      unwrap(await api.GET('/api/v1/me/notifications/unread-count')).data.unreadCount,
    staleTime: Number.POSITIVE_INFINITY,
    enabled: session != null && accountId !== undefined,
  };
}

/**
 * The unread count beside MY and on the 알림 tab, for `accountId` — `undefined` while the session
 * or that account is not known, signed out included: nothing account-specific is drawn before
 * hydration (`useSession` is pending then), and a count held in the cache is not drawn without a
 * session (a disabled query still answers what it holds).
 */
export function useNotificationUnreadCount(accountId: string | undefined): number | undefined {
  const { data: session } = useSession();
  const { data } = useQuery(notificationUnreadCountQueryOptions(accountId, session));
  return session == null ? undefined : data;
}

/**
 * `GET /me/notifications`, one page per 더 보기 press (the API's default page, 20), newest first by
 * 발생 시각 (53-3) — a merged notification at its latest event — under the account the screen shows.
 */
export function myNotificationsInfiniteQueryOptions(
  accountId: string | undefined,
  session?: SessionLike,
) {
  return {
    queryKey: notificationListKey(accountId),
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<NotificationPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/me/notifications', {
          params: { query: pageParam === undefined ? {} : { cursor: pageParam } },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: NotificationPage) => last.nextCursor ?? undefined,
    enabled: session != null && accountId !== undefined,
  };
}

/**
 * MY › 알림 and its preview for `accountId`. `isPending` covers the session lookup too, as
 * `useMyDisputes` does — and the account's: the list waits for `GET /me`.
 */
export function useMyNotifications(accountId: string | undefined) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery(myNotificationsInfiniteQueryOptions(accountId, session));
  return {
    ...query,
    isPending: sessionPending || (session != null && query.isPending),
    isLoggedIn: session != null,
  };
}

/**
 * The unread count a write answered with, put in place of `account`'s: a count read already on its
 * way left before the write and would land over it with the notification still unread, so it is
 * cancelled first (the write's own `user:notification` reads it again within the window anyway).
 */
async function storeUnreadCount(
  queryClient: QueryClient,
  account: string,
  unreadCount: number,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey: notificationUnreadKey(account), exact: true });
  queryClient.setQueryData<number>(notificationUnreadKey(account), unreadCount);
}

/**
 * A read's answer into the caches that hold it: the notification in place of its row on the list's
 * pages (read now, its first `readAt` kept) and the count after it. Only into `account`'s entries
 * — the `expectedAccountId` the server compared with the cookie: an answer that lands after the
 * tab switched accounts writes nothing into what another account's screen draws.
 */
export async function storeNotificationRead(
  queryClient: QueryClient,
  result: NotificationReadResult,
  account: string,
): Promise<void> {
  queryClient.setQueryData<NotificationPages>(notificationListKey(account), (held) =>
    withNotification(held, result.notification),
  );
  await storeUnreadCount(queryClient, account, result.unreadCount);
}

/** The account's count and its list read again: what a refused write leaves unsure. */
function readAgain(queryClient: QueryClient, account: string): Promise<unknown> {
  return Promise.all([
    restartQueries(queryClient, notificationUnreadKey(account)),
    restartQueries(queryClient, notificationListKey(account)),
  ]);
}

/** What a press on a notification sends: which, and the account the screen shows. */
export interface ReadNotificationVariables {
  id: string;
  expectedAccountId: string;
}

async function postRead({
  id,
  expectedAccountId,
}: ReadNotificationVariables): Promise<NotificationReadResult> {
  return unwrap(
    await api.POST('/api/v1/me/notifications/{id}/read', {
      params: { path: { id } },
      body: { expectedAccountId },
    }),
  ).data;
}

/**
 * `POST /me/notifications/:id/read` as mutation options (53-2: pressing a notification — going to
 * its target — marks it read; opening the list does not). The row fires it without waiting and
 * goes on to the target, so everything after the answer is here, in the mutation's own options,
 * which run whether or not the row is still on screen: the answer goes into the caches
 * (`storeNotificationRead`) and the count beside MY drops. A refusal as another account asks for
 * the session again (`onSessionChanged`), so SessionCacheGuard puts the account really signed in on
 * screen; any other — the notification gone (a retention purge answers 404), the server
 * unreachable — reads the account's count and list again.
 */
export function readNotificationOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (variables: ReadNotificationVariables) => Promise<NotificationReadResult> = postRead,
) {
  return {
    mutationFn: post,
    onSuccess: (result: NotificationReadResult, variables: ReadNotificationVariables) =>
      storeNotificationRead(queryClient, result, variables.expectedAccountId),
    onError: async (error: Error, variables: ReadNotificationVariables) => {
      if (isForAnotherAccount(error)) {
        onSessionChanged();
        return;
      }
      await readAgain(queryClient, variables.expectedAccountId);
    },
  };
}

/**
 * A notification's read. Its body names the account whose screen drew the row — the `Me` it was
 * drawn from — never the session's (ADR-0091), so it offers no account of its own.
 */
export function useReadNotification() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(readNotificationOptions(queryClient, () => void refetchSession()));
}

/** What a press of '모두 읽음' sends: the account the screen shows. */
export interface ReadAllNotificationsVariables {
  expectedAccountId: string;
}

async function postReadAll({
  expectedAccountId,
}: ReadAllNotificationsVariables): Promise<NotificationUnreadCount> {
  return unwrap(
    await api.POST('/api/v1/me/notifications/read-all', { body: { expectedAccountId } }),
  ).data;
}

/**
 * `POST /me/notifications/read-all` as mutation options (53-2 '모두 읽음': every notification
 * unread at that moment): the count it answers takes the count's place, and the list is read again
 * — each row's `readAt` is the server's instant, which the answer does not carry. Awaited, so the
 * button stays pending until the list has landed. A refusal as another account asks for the
 * session again; any other reads the count and the list again (the screen says it failed).
 */
export function readAllNotificationsOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (
    variables: ReadAllNotificationsVariables,
  ) => Promise<NotificationUnreadCount> = postReadAll,
) {
  return {
    mutationFn: post,
    onSuccess: async (
      result: NotificationUnreadCount,
      { expectedAccountId }: ReadAllNotificationsVariables,
    ) => {
      await storeUnreadCount(queryClient, expectedAccountId, result.unreadCount);
      await restartQueries(queryClient, notificationListKey(expectedAccountId));
    },
    onError: async (error: Error, { expectedAccountId }: ReadAllNotificationsVariables) => {
      if (isForAnotherAccount(error)) {
        onSessionChanged();
        return;
      }
      await readAgain(queryClient, expectedAccountId);
    },
  };
}

/** '모두 읽음', naming the account whose list it is (ADR-0091), as `useReadNotification`. */
export function useReadAllNotifications() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(readAllNotificationsOptions(queryClient, () => void refetchSession()));
}

// ---- 알림 수신 설정 (#56, ADR-0162; 52-21·52-22·56-1…56-5) --------------------------------------

/**
 * `GET /me/notifications/settings` of the account the screen shows: each category with a type on
 * or off. Read once signed in and that account known, with the app's default `staleTime` (30 s):
 * a focus after it reads it again — how another tab's change shows here — and a reconnect while
 * it is on screen (the `['notifications']` root is a snapshot key). No signal re-reads it.
 */
export function notificationSettingsQueryOptions(
  accountId: string | undefined,
  session?: SessionLike,
) {
  return {
    queryKey: notificationSettingsKey(accountId),
    queryFn: async (): Promise<NotificationSettings> =>
      unwrap(await api.GET('/api/v1/me/notifications/settings')).data,
    enabled: session != null && accountId !== undefined,
  };
}

/** MY › 설정's '알림 수신' card, for `accountId` (the `Me` it is drawn from). */
export function useNotificationSettings(accountId: string | undefined) {
  const { data: session } = useSession();
  return useQuery(notificationSettingsQueryOptions(accountId, session));
}

/** What a press of one switch sends: its category, on or off, and the account the card shows. */
export interface UpdateNotificationSettingVariables {
  category: NotificationCategory;
  enabled: boolean;
  expectedAccountId: string;
}

async function putNotificationSetting({
  category,
  enabled,
  expectedAccountId,
}: UpdateNotificationSettingVariables): Promise<NotificationSettings> {
  return unwrap(
    await api.PUT('/api/v1/me/notifications/settings/{category}', {
      params: { path: { category } },
      body: { enabled, expectedAccountId },
    }),
  ).data;
}

/**
 * A write's answer into the account's settings — its own category only
 * (`withNotificationSetting`): the answers of two rows' writes may land out of order. A settings
 * read on its way left before the write committed (a focus after 30 s, a reconnect's restart) and
 * would land after it with the old value, switching the row back: it is cancelled first, as
 * `storeMe` does for `['me']`. That read may have been the one carrying another row's newer value
 * (another tab's change), and `setQueryData` marks the entry fresh: when one was cancelled, the
 * entry is read again after the answer is stored — that read leaves after the write committed, so
 * it cannot switch this row back. Only into `account`'s entry — the `expectedAccountId` the server
 * compared with the cookie.
 */
export async function storeNotificationSetting(
  queryClient: QueryClient,
  answer: NotificationSettings,
  {
    category,
    expectedAccountId,
  }: Pick<UpdateNotificationSettingVariables, 'category' | 'expectedAccountId'>,
): Promise<void> {
  const key = notificationSettingsKey(expectedAccountId);
  const readOnItsWay = queryClient.getQueryState(key)?.fetchStatus === 'fetching';
  await queryClient.cancelQueries({ queryKey: key, exact: true });
  queryClient.setQueryData<NotificationSettings>(key, (held) =>
    withNotificationSetting(held, answer, category),
  );
  if (readOnItsWay) void queryClient.invalidateQueries({ queryKey: key, exact: true });
}

/**
 * `PUT /me/notifications/settings/:category` as mutation options (52-21: one category on or off;
 * 56-1: what the inbox holds stays). The answer goes into the cache before `mutateAsync` settles
 * (returned), so the switch never shows the old value for a render in between. A refusal as
 * another account asks for the session again; any other leaves the cache as it was — nothing was
 * written, and the switch shows the held value again.
 */
export function updateNotificationSettingOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  put: (
    variables: UpdateNotificationSettingVariables,
  ) => Promise<NotificationSettings> = putNotificationSetting,
) {
  return {
    mutationFn: put,
    onSuccess: (answer: NotificationSettings, variables: UpdateNotificationSettingVariables) =>
      storeNotificationSetting(queryClient, answer, variables),
    onError: (error: Error) => {
      if (isForAnotherAccount(error)) onSessionChanged();
    },
  };
}

/**
 * One switch's write — one per row, so a pending row disables itself alone. Its body names the
 * account the card was drawn for — the `Me`'s id — never the session's (ADR-0090/0091), so it
 * offers no account of its own.
 */
export function useUpdateNotificationSetting() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(updateNotificationSettingOptions(queryClient, () => void refetchSession()));
}
