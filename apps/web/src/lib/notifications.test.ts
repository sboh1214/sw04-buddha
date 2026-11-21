import { readFileSync } from 'node:fs';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DEFINITIONS,
  NOTIFICATION_TYPE_REGISTRY,
  NOTIFICATION_UNREAD_COUNT_CAP,
  type NotificationCategory,
  PUBLIC_MARKET_STATUSES,
  defineNotification,
  findExcludedIdentifier,
  findExcludedText,
} from '@buddha/shared';
import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_RENDERERS,
  type NotificationRenderer,
  notificationView,
} from '@/components/notifications/notification-renderers';
import { copy } from '@/copy';
import type { InboxNotification } from './api';
import { MY_NOTIFICATIONS_PATH, MY_TABS } from './my';
import {
  NOTIFICATIONS_KEY,
  NOTIFICATION_REFRESH_MS,
  type NotificationPages,
  UNREAD_COUNT_CAP,
  isUnread,
  notificationCategoryLabel,
  notificationFallbackTitle,
  notificationHref,
  notificationListKey,
  notificationUnreadKey,
  unreadCountLabel,
  unreadNotificationsText,
  withNotification,
} from './notifications';

const ACCOUNT = 'a1e1c0de-0000-4000-8000-000000000001';

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

/** The new copy of #53: what a member reads of the inbox. */
const NOTIFICATION_COPY = [
  copy.notificationsReadAll,
  copy.notificationsEmpty,
  copy.notificationUnread,
  copy.notificationCategoryTrade,
  copy.notificationCategoryMarket,
  copy.notificationCategoryCommunity,
  copy.notificationFallback,
  copy.unreadNotifications,
  copy.unreadNotificationsCount,
  copy.unreadNotificationsOver,
  copy.adminRetentionKindNotifications,
];

describe('알림함 keys (#53, ADR-0157)', () => {
  it('keys the count and the list under one private root, the account last (ADR-0091)', () => {
    expect(NOTIFICATIONS_KEY).toEqual(['notifications']);
    expect(notificationListKey(ACCOUNT)).toEqual(['notifications', 'list', ACCOUNT]);
    expect(notificationUnreadKey(ACCOUNT)).toEqual(['notifications', 'unread', ACCOUNT]);
    expect(notificationListKey(undefined)).toEqual(['notifications', 'list', undefined]);
  });

  it('re-reads on the signal at most once per 30 s after the first (owner answer 53-9)', () => {
    expect(NOTIFICATION_REFRESH_MS).toBe(30_000);
  });

  it('is MY’s 알림 tab', () => {
    expect(MY_NOTIFICATIONS_PATH).toBe('/my/notifications');
    expect(MY_TABS.find((tab) => tab.key === 'notifications')?.href).toBe(MY_NOTIFICATIONS_PATH);
  });
});

describe('the unread count (53-1, 53-11 ①)', () => {
  it('shows nothing at 0, the number to 99 and 99+ past it', () => {
    expect(unreadCountLabel(0)).toBeNull();
    expect(unreadCountLabel(1)).toBe('1');
    expect(unreadCountLabel(99)).toBe('99');
    expect(unreadCountLabel(100)).toBe('99+');
    expect(unreadCountLabel(1_000)).toBe('99+');
    // The server's cap means "100 or more": it is what the web shows as 99+.
    expect(UNREAD_COUNT_CAP).toBe(NOTIFICATION_UNREAD_COUNT_CAP);
    expect(unreadCountLabel(NOTIFICATION_UNREAD_COUNT_CAP)).toBe('99+');
  });

  it('says it to a screen reader in words, with the same cut', () => {
    expect(unreadNotificationsText(0)).toBeNull();
    expect(unreadNotificationsText(1)).toBe('안 읽은 알림 1개');
    expect(unreadNotificationsText(99)).toBe('안 읽은 알림 99개');
    expect(unreadNotificationsText(100)).toBe('안 읽은 알림 99개 넘게');
  });
});

describe('a notification’s words and its link', () => {
  it('names the three categories (52-21) as 거래·시장·커뮤니티', () => {
    expect(NOTIFICATION_CATEGORIES.map((category) => notificationCategoryLabel(category))).toEqual([
      '거래',
      '시장',
      '커뮤니티',
    ]);
    // One a newer server sends: no name, and the fallback title is '알림' alone.
    expect(notificationCategoryLabel('price' as NotificationCategory)).toBeUndefined();
    expect(notificationFallbackTitle('price' as NotificationCategory)).toBe('알림');
    expect(notificationFallbackTitle('market')).toBe('시장 알림');
  });

  it('leads to the market’s detail whatever its status — 마감, 지급 완료, 취소 alike (AC 4)', () => {
    const target = { kind: 'market', slug: 'first-snow' } as const;
    expect(notificationHref(target)).toBe('/markets/first-snow');
    // The target names no status: one that carries the market's status anyway — a newer server's,
    // say — leads to the same path in every public status (the shared schema strips it).
    expect(PUBLIC_MARKET_STATUSES).toEqual(
      expect.arrayContaining(['closed', 'settled', 'cancelled']),
    );
    for (const status of PUBLIC_MARKET_STATUSES) {
      expect(notificationHref({ ...target, status }), status).toBe('/markets/first-snow');
    }
    expect(notificationHref({ kind: 'market', slug: '첫눈-2026' })).toBe('/markets/첫눈-2026');
  });

  it('leads nowhere for a kind it does not know or a target it cannot read (never a URL from data)', () => {
    expect(notificationHref({ kind: 'post', id: 'p1' })).toBeNull();
    expect(notificationHref({ kind: 'market' })).toBeNull();
    expect(notificationHref({ kind: 'market', slug: '../admin' })).toBeNull();
    expect(notificationHref({ kind: 'market', slug: 'https://example.com' })).toBeNull();
    expect(notificationHref(null)).toBeNull();
    expect(notificationHref('market')).toBeNull();
  });

  it('draws a type it does not render with its category’s fallback title (53-11 ④)', () => {
    expect(notificationView(notification('n1'))).toEqual({ known: false, title: '시장 알림' });
    expect(notificationView(notification('n2', { category: 'trade' }))).toEqual({
      known: false,
      title: '거래 알림',
    });
  });

  it('draws a known type through its renderer once its definition takes the params', () => {
    const definition = defineNotification({
      type: 'market_closed',
      category: 'market',
      targets: ['market'],
      params: z.object({ title: z.string() }),
      merge: null,
    });
    const Title: NotificationRenderer['Title'] = ({ params }) => String(params.title);
    const renderers = { market_closed: { copy: ['{title} 거래가 마감되었습니다.'], Title } };
    const known = notificationView(
      notification('n1', { type: 'market_closed', params: { title: '첫눈' } }),
      renderers,
      [definition],
    );
    expect(known).toEqual({ known: true, Title, params: { title: '첫눈' } });
    // Params the definition refuses, or no definition, or no renderer: the fallback.
    for (const [item, defs, rends] of [
      [
        notification('n2', { type: 'market_closed', params: { title: 1 } }),
        [definition],
        renderers,
      ],
      [notification('n3', { type: 'market_closed', params: { title: '첫눈' } }), [], renderers],
      [notification('n4', { type: 'market_closed', params: { title: '첫눈' } }), [definition], {}],
    ] as const) {
      expect(notificationView(item, rends, defs)).toEqual({ known: false, title: '시장 알림' });
    }
  });

  it('has one renderer per type, its words the guard registry’s text (#113)', () => {
    // Empty in #53 (52-20): each producer adds the definition, the guard entry and the renderer.
    expect(NOTIFICATION_DEFINITIONS).toEqual([]);
    const types = NOTIFICATION_DEFINITIONS.map((definition: { type: string }) => definition.type);
    expect(Object.keys(NOTIFICATION_RENDERERS).sort()).toEqual([...types].sort());
    expect(Object.keys(NOTIFICATION_TYPE_REGISTRY).sort()).toEqual([...types].sort());
    const registry: Readonly<Record<string, { text: readonly string[] }>> =
      NOTIFICATION_TYPE_REGISTRY;
    const renderers: Readonly<Record<string, NotificationRenderer>> = NOTIFICATION_RENDERERS;
    for (const [type, renderer] of Object.entries(renderers)) {
      expect(renderer.copy, type).toEqual(registry[type]?.text);
    }
  });

  it('says unread by readAt alone, and puts a read’s answer in place of its row', () => {
    expect(isUnread(notification('n1'))).toBe(true);
    expect(isUnread(notification('n1', { readAt: '2026-11-21T04:00:00.000Z' }))).toBe(false);
    const held: NotificationPages = {
      pages: [
        { items: [notification('n1'), notification('n2')], nextCursor: 'c2' },
        { items: [notification('n3')], nextCursor: null },
      ],
      pageParams: [undefined, 'c2'],
    };
    const read = notification('n3', { readAt: '2026-11-21T04:00:00.000Z' });
    const after = withNotification(held, read);
    expect(after?.pages[1]?.items[0]).toEqual(read);
    // The other page is the same object: nothing else re-renders.
    expect(after?.pages[0]).toBe(held.pages[0]);
    expect(after?.pageParams).toBe(held.pageParams);
    // A row no page holds (another page not loaded, purged): the pages as they were.
    expect(withNotification(held, notification('n9'))).toBe(held);
    expect(withNotification(undefined, read)).toBeUndefined();
  });
});

describe('the inbox’s words (#113, N05 §4)', () => {
  it('name no excluded feature, and never the word for a count badge', () => {
    for (const text of NOTIFICATION_COPY) {
      expect(text.trim(), text).not.toBe('');
      expect(findExcludedText(text), text).toEqual([]);
      expect(text).not.toMatch(/배지|badge/i);
    }
    for (const name of [
      'notifications',
      'notificationListKey',
      'notificationUnreadKey',
      'unreadCountLabel',
      'useUnreadNotifications',
      'UnreadCount',
    ]) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
    }
  });

  it('names the count beside MY 안 읽은 수 throughout, never a badge, even in the code', () => {
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const file of [
      './notifications.ts',
      '../hooks/use-notifications.ts',
      '../components/notifications/notification-renderers.tsx',
      '../components/notifications/notification-row.tsx',
      '../components/notifications/unread-count.tsx',
      '../app/my/notifications/my-notifications.tsx',
      '../components/layout/nav.tsx',
      '../components/layout/bottom-tabs.tsx',
      '../app/my/my-tabs.tsx',
    ]) {
      expect(source(file), file).not.toMatch(/badge|배지/i);
    }
  });
});
