import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { type InboxNotification, type Me } from '@/lib/api';
import { MY_PREVIEW_ROWS } from '@/lib/my';
import { type NotificationPage, notificationListKey } from '@/lib/notifications';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import {
  MyNotifications,
  type Notifications,
  NotificationsBody,
  NotificationsReadAll,
} from './my-notifications';

const ACCOUNT = { id: 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46' } as Me;
const UNREAD_ID = '9b2c8e4a-1f3d-4c6b-8a7e-5d4c3b2a1f01';
const READ_ID = '9b2c8e4a-1f3d-4c6b-8a7e-5d4c3b2a1f02';

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

/** A list as a read leaves it, with the flags a test overrides. */
const list = (pages: NotificationPage[], flags: Partial<Notifications> = {}): Notifications => ({
  data: { pages, pageParams: pages.map(() => undefined) },
  hasNextPage: pages.at(-1)?.nextCursor != null,
  isPending: false,
  isLoadingError: false,
  isRefetchError: false,
  error: null,
  isFetchNextPageError: false,
  isFetchingNextPage: false,
  failureReason: null,
  refetch: () => Promise.reject(new Error('not in a test')),
  fetchNextPage: () => Promise.reject(new Error('not in a test')),
  ...flags,
});

/** The body drawn from `notifications` (`useMyNotifications` waits for a session node lacks). */
const drawn = (notifications: Notifications, limit?: number, testId = 'my-notifications') =>
  renderWithQueries(
    <NotificationsBody
      notifications={notifications}
      accountId={ACCOUNT.id}
      testId={testId}
      {...(limit === undefined ? {} : { limit })}
    />,
  );

/** One row of the drawn HTML, by the notification's id. */
const rowOf = (html: string, id: string) => {
  const at = html.indexOf(`data-notification-id="${id}"`);
  if (at < 0) return undefined;
  const start = html.lastIndexOf('<', at);
  const end = html.indexOf('</li>', at);
  return html.slice(start, end);
};

/**
 * MY › 알림 as drawn (#53, ADR-0157; owner answers 53-1…53-3, 53-11): the member's notifications
 * newest first, unread ones marked by more than colour, '모두 읽음', the ladder and 더 보기.
 */
describe('MyNotifications', () => {
  it('waits for the session before drawing the list, with 모두 읽음 off (MY’s ladder)', () => {
    const html = renderWithQueries(<MyNotifications />, [
      [notificationListKey(ACCOUNT.id), { pages: [], pageParams: [] }],
      [ME_QUERY_KEY, ACCOUNT],
    ]);
    expect(byTestId(html, 'my-notifications')?.text).toContain(copy.myNotifications);
    expect(byTestId(html, 'my-notifications-read-all')?.text).toBe(copy.notificationsReadAll);
    expect(byTestId(html, 'my-notifications-read-all')?.attributes).toHaveProperty('disabled');
    expect(byTestId(html, 'my-notifications-empty')).toBeUndefined();
    expect(byTestId(html, 'my-notifications-read-all-failed')).toBeUndefined();
  });

  it('says there is none — what every member sees until a producer ships its type (52-20)', () => {
    const html = drawn(list([{ items: [], nextCursor: null }]));
    expect(byTestId(html, 'my-notifications-empty')?.text).toBe('알림이 없습니다.');
    expect(byTestId(html, 'my-notifications-list')).toBeUndefined();
    expect(byTestId(html, 'my-notifications-more')).toBeUndefined();
  });

  it('draws a skeleton while reading, and the error with 다시 시도 when the first read failed', () => {
    const pending = drawn(list([], { data: undefined, isPending: true }));
    expect(byTestId(pending, 'my-notifications-empty')).toBeUndefined();
    expect(byTestId(pending, 'my-notifications-list')).toBeUndefined();
    const failed = drawn(
      list([], { data: undefined, isLoadingError: true, error: new Error('down') }),
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(copy.errUnknown);
    expect(failed).toContain(copy.retry);
    expect(byTestId(failed, 'my-notifications-empty')).toBeUndefined();
  });

  it('lists them newest first as served, unread told apart by weight, a dot and 안 읽음 — not colour alone', () => {
    const html = drawn(
      list([
        {
          items: [
            notification(UNREAD_ID, { occurredAt: '2026-11-21T05:00:00.000Z' }),
            notification(READ_ID, {
              category: 'trade',
              target: { kind: 'market', slug: 'closed-market' },
              readAt: '2026-11-21T04:30:00.000Z',
            }),
          ],
          nextCursor: null,
        },
      ]),
    );
    // The server's order (53-3: 발생 시각 최신순), one row each.
    expect([...html.matchAll(/data-notification-id="([^"]+)"/g)].map((match) => match[1])).toEqual([
      UNREAD_ID,
      READ_ID,
    ]);
    const unread = rowOf(html, UNREAD_ID) ?? '';
    const read = rowOf(html, READ_ID) ?? '';
    expect(unread).toContain('data-read="false"');
    expect(read).toContain('data-read="true"');
    // Unread: the dot (hidden from a screen reader) and the words a screen reader reads instead.
    expect(byTestId(unread, 'notification-row-unread-dot')?.attributes['aria-hidden']).toBe('true');
    expect(unread).toContain(copy.notificationUnread);
    expect(byTestId(read, 'notification-row-unread-dot')).toBeUndefined();
    expect(read).not.toContain(copy.notificationUnread);
    // The category, the title — the fallback for a type this web does not know (53-11 ④) — and
    // the time in the member's zone (KST until the profile says otherwise).
    expect(byTestId(unread, 'notification-row-category')?.text).toBe('시장');
    expect(byTestId(unread, 'notification-row-title')?.text).toBe('시장 알림');
    expect(byTestId(read, 'notification-row-title')?.text).toBe('거래 알림');
    expect(byTestId(unread, 'notification-row-time')?.text).toBe('2026. 11. 21. 오후 2:00');
    // A link to its target, the market's detail; a read one goes there too.
    expect(byTestId(unread, 'notification-row')?.attributes.href).toBe('/markets/first-snow');
    expect(byTestId(read, 'notification-row')?.attributes.href).toBe('/markets/closed-market');
    // No raw params or ids on screen: the label is the type's renderer's to word.
    expect(byTestId(unread, 'notification-row')?.text).not.toContain('첫눈');
  });

  it('draws a target this web cannot lead to as a button that only marks it read', () => {
    const html = drawn(
      list([
        {
          items: [notification(UNREAD_ID, { target: { kind: 'post', id: 'p1' } as never })],
          nextCursor: null,
        },
      ]),
    );
    const row = byTestId(html, 'notification-row');
    expect(row?.attributes.type).toBe('button');
    expect(row?.attributes).not.toHaveProperty('href');
    expect(html).toMatch(/<button[^>]*data-testid="notification-row"/);
  });

  it('offers 더 보기 while a page follows, and says a 더 보기 failed above it, keeping the rows', () => {
    const one = [{ items: [notification(UNREAD_ID)], nextCursor: 'c2' }];
    expect(byTestId(drawn(list(one)), 'my-notifications-more')?.text).toBe(copy.loadMore);
    expect(byTestId(drawn(list(one)), 'my-notifications-more-failed')).toBeUndefined();
    const failedMore = drawn(list(one, { isFetchNextPageError: true, error: new Error('x') }));
    expect(byTestId(failedMore, 'my-notifications-more-failed')?.text).toBe(copy.errUnknown);
    expect(byTestId(failedMore, 'my-notifications-more')?.text).toBe(copy.loadMore);
    expect(rowOf(failedMore, UNREAD_ID)).toBeDefined();
  });

  it('keeps the rows under a notice with 다시 시도 when a refresh failed', () => {
    const html = drawn(
      list([{ items: [notification(UNREAD_ID)], nextCursor: null }], {
        isRefetchError: true,
        error: new Error('down'),
      }),
    );
    const stale = byTestId(html, 'my-notifications-stale');
    expect(stale?.attributes.role).toBe('status');
    expect(stale?.text).toContain(copy.marketRefreshFailed);
    expect(stale?.text).toContain(copy.retry);
    expect(rowOf(html, UNREAD_ID)).toBeDefined();
    // Not when the list is empty and nothing failed.
    expect(
      byTestId(drawn(list([{ items: [], nextCursor: null }])), 'my-notifications-stale'),
    ).toBeUndefined();
  });

  it('draws MY 요약’s preview as the first three rows with no 더 보기 (53-11 ②)', () => {
    const items = Array.from({ length: 5 }, (_, n) =>
      notification(`9b2c8e4a-1f3d-4c6b-8a7e-5d4c3b2a1f1${String(n)}`),
    );
    const html = drawn(
      list([{ items, nextCursor: 'c2' }]),
      MY_PREVIEW_ROWS,
      'my-preview-notifications',
    );
    expect(
      testIdsStartingWith(html, 'notification-row').filter((id) => id === 'notification-row'),
    ).toHaveLength(MY_PREVIEW_ROWS);
    expect(byTestId(html, 'my-preview-notifications-list')).toBeDefined();
    expect(byTestId(html, 'my-preview-notifications-more')).toBeUndefined();
    expect(
      byTestId(
        drawn(list([{ items: [], nextCursor: null }]), 3, 'my-preview-notifications'),
        'my-preview-notifications-empty',
      )?.text,
    ).toBe(copy.notificationsEmpty);
  });
});

describe('모두 읽음 (53-2)', () => {
  const button = (props: Parameters<typeof NotificationsReadAll>[0]) =>
    byTestId(renderWithQueries(<NotificationsReadAll {...props} />), 'my-notifications-read-all');

  it('is off while nothing is unread, the count is not read yet or the account is not known', () => {
    const press = () => undefined;
    expect(button({ unreadCount: 0, pending: false, onPress: press })?.attributes).toHaveProperty(
      'disabled',
    );
    expect(
      button({ unreadCount: undefined, pending: false, onPress: press })?.attributes,
    ).toHaveProperty('disabled');
    expect(
      button({ unreadCount: 3, pending: false, onPress: undefined })?.attributes,
    ).toHaveProperty('disabled');
    expect(
      button({ unreadCount: 3, pending: false, onPress: press })?.attributes,
    ).not.toHaveProperty('disabled');
    // While its write is on its way it shows so, and takes no second press.
    expect(button({ unreadCount: 3, pending: true, onPress: press })?.attributes).toHaveProperty(
      'data-loading',
    );
  });
});

describe('the page and its preview', () => {
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

  it('is a MY tab gated on the session, and the summary previews it with 전체 보기', () => {
    expect(source('./page.tsx')).toContain('await requireMySession();');
    expect(source('./page.tsx')).toContain('<MyNotifications />');
    const summary = source('../summary.tsx');
    expect(summary).toContain('<NotificationsPreview />');
    expect(summary).toContain('testId="my-preview-notifications"');
    expect(summary).toContain('href={notificationsTab.href}');
    expect(summary).toContain('limit={MY_PREVIEW_ROWS}');
    // 준비 중 is gone from MY: every tab has its content.
    expect(summary).not.toContain('ComingSoon');
  });

  it('marks a row read on a click and a middle click, not awaited, and names MY’s account', () => {
    const row = source('../../../components/notifications/notification-row.tsx');
    expect(row).toContain('onClick={markRead}');
    expect(row).toMatch(/onAuxClick=\{\(event\) => \{\s*if \(event\.button === 1\) markRead\(\);/);
    expect(row).toContain('if (unread) onRead(notification);');
    const body = source('./my-notifications.tsx');
    expect(body).toContain('read.mutate({ id: item.id, expectedAccountId: accountId });');
    expect(body).toContain('readAll.mutate({ expectedAccountId: accountId });');
    expect(body).not.toMatch(/mutateAsync|await read/);
  });
});
