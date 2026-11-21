'use client';

import { Alert, Button, Skeleton, Stack } from '@chakra-ui/react';
import { NotificationRow } from '@/components/notifications/notification-row';
import { ProfileUnavailable } from '@/components/my/profile-unavailable';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import {
  useMyNotifications,
  useNotificationUnreadCount,
  useReadAllNotifications,
  useReadNotification,
} from '@/hooks/use-notifications';
import { listSection } from '@/lib/query-client';
import { watchlistRows } from '@/lib/watchlist';
import { LoadFailed, Section, SessionEnded, useSessionEnded } from '../portfolio';

/** What the list's body reads of `useMyNotifications` (a test draws it from a list of its own). */
export type Notifications = Pick<
  ReturnType<typeof useMyNotifications>,
  | 'data'
  | 'hasNextPage'
  | 'isPending'
  | 'isLoadingError'
  | 'isRefetchError'
  | 'error'
  | 'isFetchNextPageError'
  | 'isFetchingNextPage'
  | 'failureReason'
  | 'refetch'
  | 'fetchNextPage'
>;

/**
 * `/my/notifications`: MY › 알림 (#16's tab; #53, ADR-0157; owner answers 53-1…53-3, 53-11). The
 * member's notifications, newest first by 발생 시각 with 더 보기 as every MY list (53-3), unread
 * ones marked by more than colour; pressing one marks it read and opens its target (53-2), and
 * '모두 읽음' at the heading's right marks every unread one read. Opening the list marks nothing.
 * Until a producer ships its type (52-20) every member sees '알림이 없습니다.'. Personal and
 * client-only like every MY list.
 */
export function MyNotifications() {
  const ended = useSessionEnded();
  const accountId = useMe().data?.id;
  // The list and the count of the account MY shows (ADR-0091): they wait for `GET /me`.
  const notifications = useMyNotifications(accountId);
  const unreadCount = useNotificationUnreadCount(accountId);
  const readAll = useReadAllNotifications();
  if (ended) return <SessionEnded />;
  return (
    <Section
      title={copy.myNotifications}
      testId="my-notifications"
      action={
        <NotificationsReadAll
          unreadCount={unreadCount}
          pending={readAll.isPending}
          onPress={
            accountId === undefined
              ? undefined
              : () => {
                  // The account the list was drawn for rides along (`expectedAccountId`, ADR-0091).
                  readAll.mutate({ expectedAccountId: accountId });
                }
          }
        />
      }
    >
      <Stack gap="4">
        {readAll.isError && (
          <Alert.Root status="error" role="alert" data-testid="my-notifications-read-all-failed">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}
        {/* Keyed by MY's account (`NotificationsBody`); the list waits for it, and a failed
            `GET /me` says so with 다시 시도 rather than a skeleton that never ends. */}
        {accountId === undefined ? (
          <ProfileUnavailable height="24" />
        ) : (
          <NotificationsBody
            key={accountId}
            notifications={notifications}
            accountId={accountId}
            testId="my-notifications"
          />
        )}
      </Stack>
    </Section>
  );
}

/**
 * '모두 읽음' (53-2): off while nothing is unread — or the count is not read yet, or the account
 * not known (`onPress` absent) — and while its write is on its way.
 */
export function NotificationsReadAll({
  unreadCount,
  pending,
  onPress,
}: {
  unreadCount: number | undefined;
  pending: boolean;
  onPress: (() => void) | undefined;
}) {
  return (
    <Button
      size="xs"
      variant="outline"
      flexShrink="0"
      ms="auto"
      disabled={onPress === undefined || unreadCount === undefined || unreadCount === 0}
      loading={pending}
      onClick={onPress}
      data-testid="my-notifications-read-all"
    >
      {copy.notificationsReadAll}
    </Button>
  );
}

/**
 * The list's body: the other MY lists' ladder (`listSection`) — skeleton, error and 다시 시도,
 * empty ('알림이 없습니다.'), rows, and a refresh that failed after the rows exist keeps them under a
 * notice — and 더 보기 while there is a next page, a 더 보기 that failed keeping the rows read so
 * far and saying so above its button (`LoadMoreFailed`). MY 요약's preview draws the same body with
 * its first `limit` rows and no 더 보기 (its way to the rest is 전체 보기, 53-11 ②); pressing a row
 * there marks it read too.
 *
 * A read names the account of MY's `Me` (`accountId`, the screen's), never the session's
 * (ADR-0091), and the body is keyed by it: `['me']` can turn from A to B in place (ADR-0090 결정
 * 4-2), and a row drawn from A's list is not B's to mark.
 */
export function NotificationsBody({
  notifications,
  accountId,
  limit,
  testId,
}: {
  notifications: Notifications;
  /** MY's account, once `GET /me` has answered. */
  accountId: string;
  /** The preview's row count (MY_PREVIEW_ROWS): that many rows, no 더 보기. */
  limit?: number;
  /** The section's test id, which the body's parts extend. */
  testId: string;
}) {
  const { rows, more } = watchlistRows(notifications.data?.pages, notifications.hasNextPage, limit);
  const section = listSection(notifications, rows.length);
  const read = useReadNotification();

  return (
    <>
      {section.stale && (
        <Alert.Root status="warning" role="status" data-testid={`${testId}-stale`} mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button
            size="xs"
            variant="outline"
            ml="auto"
            onClick={() => void notifications.refetch()}
          >
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {section.body === 'pending' ? (
        <Skeleton height="24" />
      ) : section.body === 'failed' ? (
        <LoadFailed message={copy.errUnknown} onRetry={() => void notifications.refetch()} />
      ) : section.body === 'empty' ? (
        <EmptyState message={copy.notificationsEmpty} data-testid={`${testId}-empty`} />
      ) : (
        <Stack gap="3">
          <Stack
            as="ul"
            listStyleType="none"
            m="0"
            p="0"
            gap="1"
            divideY="1px"
            data-testid={`${testId}-list`}
          >
            {rows.map((notification) => (
              <li key={notification.id}>
                <NotificationRow
                  notification={notification}
                  onRead={(item) => {
                    read.mutate({ id: item.id, expectedAccountId: accountId });
                  }}
                />
              </li>
            ))}
          </Stack>
          {more && (
            <>
              <LoadMoreFailed
                list={notifications}
                message={copy.errUnknown}
                data-testid={`${testId}-more-failed`}
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={notifications.isFetchingNextPage}
                onClick={() => void notifications.fetchNextPage()}
                data-testid={`${testId}-more`}
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </Stack>
      )}
    </>
  );
}
