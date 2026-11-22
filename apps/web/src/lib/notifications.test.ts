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

/**
 * The copy of #53, #134's 거래 알림 (ADR-0158) and #54's 시장 상태 알림 (ADR-0159): what a member
 * reads of the inbox.
 */
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
  copy.notificationOrderFilled,
  copy.notificationOrderFilledMerged,
  copy.notificationOrderFilledSince,
  copy.notificationOrderFilledMergedSince,
  copy.notificationOrdersCancelledMarket,
  copy.notificationOrdersCancelledAccount,
  copy.notificationOrdersExpiredClosed,
  copy.notificationOrdersExpiredCancelled,
  copy.notificationMarketClosed,
  copy.notificationMarketClosedEarly,
  copy.notificationMarketPaused,
  copy.notificationMarketResumed,
  copy.notificationMarketCancelled,
  copy.notificationMarketRulesSupplemented,
];

const ORDER_ID = '7d0f9a2e-4b1c-4e8d-9a3f-1c2b3d4e5f60';
const MARKET_ID = '3e5a7c9b-2d4f-4a6b-8c1d-0e2f4a6b8c0d';

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

  it('leads an order to its 주문 상세 and an order history to 거래·정산 이력, of one market or all (#134)', () => {
    // ADR-0158, 52-4: one ended order → its detail (ADR-0141); several → the ended orders (the
    // history's default list, ADR-0143), filtered to the market for a market event.
    expect(notificationHref({ kind: 'order', orderId: ORDER_ID })).toBe(`/my/orders/${ORDER_ID}`);
    expect(notificationHref({ kind: 'order', orderId: ORDER_ID.toUpperCase() })).toBe(
      `/my/orders/${ORDER_ID}`,
    );
    expect(notificationHref({ kind: 'order_history', marketId: MARKET_ID })).toBe(
      `/my/history?market=${MARKET_ID}`,
    );
    expect(notificationHref({ kind: 'order_history', marketId: MARKET_ID.toUpperCase() })).toBe(
      `/my/history?market=${MARKET_ID}`,
    );
    // An account event's: every market.
    expect(notificationHref({ kind: 'order_history', marketId: null })).toBe('/my/history');
    // Not a uuid, or no market field at all: nowhere (the schema refuses it).
    expect(notificationHref({ kind: 'order', orderId: '../admin' })).toBeNull();
    expect(notificationHref({ kind: 'order', id: ORDER_ID })).toBeNull();
    expect(notificationHref({ kind: 'order_history', marketId: 'first-snow' })).toBeNull();
    expect(notificationHref({ kind: 'order_history' })).toBeNull();
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
    expect(known).toEqual({ known: true, Title, params: { title: '첫눈' }, eventCount: 1 });
    // The row's eventCount goes along: a merged one's 횟수 (52-6, ADR-0158).
    expect(
      notificationView(
        notification('n5', { type: 'market_closed', params: { title: '첫눈' }, eventCount: 3 }),
        renderers,
        [definition],
      ),
    ).toEqual({ known: true, Title, params: { title: '첫눈' }, eventCount: 3 });
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
    // #53 shipped none (52-20); #134 the 거래 three (ADR-0158), #54 the 시장 five (ADR-0159). Each
    // producer adds the definition, the guard entry and the renderer.
    const types = NOTIFICATION_DEFINITIONS.map((definition: { type: string }) => definition.type);
    expect(types).toEqual([
      'order_filled',
      'orders_cancelled',
      'orders_expired',
      'market_closed',
      'market_paused',
      'market_resumed',
      'market_cancelled',
      'market_rules_supplemented',
    ]);
    expect(Object.keys(NOTIFICATION_RENDERERS).sort()).toEqual([...types].sort());
    expect(Object.keys(NOTIFICATION_TYPE_REGISTRY).sort()).toEqual([...types].sort());
    const registry: Readonly<Record<string, { text: readonly string[] }>> =
      NOTIFICATION_TYPE_REGISTRY;
    const renderers: Readonly<Record<string, NotificationRenderer>> = NOTIFICATION_RENDERERS;
    for (const [type, renderer] of Object.entries(renderers)) {
      expect(renderer.copy, type).toEqual(registry[type]?.text);
    }
    // Non-vacuous: every type has words, and each sentence a renderer may draw is among them.
    expect(NOTIFICATION_RENDERERS.order_filled.copy).toHaveLength(10);
    expect(NOTIFICATION_RENDERERS.orders_cancelled.copy).toHaveLength(4);
    expect(NOTIFICATION_RENDERERS.orders_expired.copy).toHaveLength(2);
    expect(NOTIFICATION_RENDERERS.market_closed.copy).toHaveLength(2);
    expect(NOTIFICATION_RENDERERS.market_paused.copy).toHaveLength(4);
    expect(NOTIFICATION_RENDERERS.market_resumed.copy).toHaveLength(4);
    expect(NOTIFICATION_RENDERERS.market_cancelled.copy).toHaveLength(1);
    expect(NOTIFICATION_RENDERERS.market_rules_supplemented.copy).toHaveLength(2);
    // Every 시장 type is category `market` (52-21) and leads to the market's detail alone (54-4).
    for (const definition of NOTIFICATION_DEFINITIONS.filter((each) =>
      each.type.startsWith('market_'),
    )) {
      expect(definition.category, definition.type).toBe('market');
      expect(definition.targets, definition.type).toEqual(['market']);
      expect(definition.merge, definition.type).toBeNull();
    }
  });

  it('draws each 거래 type through its renderer with the row’s eventCount, and the fallback for params its definition refuses (#134)', () => {
    const filled = notificationView(
      notification('n1', {
        type: 'order_filled',
        category: 'trade',
        params: {
          marketTitle: '첫눈이 올까',
          outcome: 'NO',
          side: 'buy',
          qty: '2',
          amountCoin: '80',
          fullyFilled: false,
          orderQty: '3',
          orderFilledQty: '2',
        },
        target: { kind: 'order', orderId: ORDER_ID },
        eventCount: 2,
      }),
    );
    if (!filled.known) throw new Error('order_filled is a type this web renders');
    expect(filled.Title({ params: filled.params, eventCount: filled.eventCount })).toBe(
      '첫눈이 올까 NO 매수 주문 부분 체결 · 체결 2회 · 누적 2계약 · 평균 40.00 Coin',
    );
    const cancelled = notificationView(
      notification('n2', {
        type: 'orders_cancelled',
        category: 'trade',
        params: { reason: 'restricted', orderCount: 3, marketCount: 2, marketTitle: null },
        target: { kind: 'order_history', marketId: null },
      }),
    );
    if (!cancelled.known) throw new Error('orders_cancelled is a type this web renders');
    expect(cancelled.Title({ params: cancelled.params, eventCount: 1 })).toBe(
      '계정 제한으로 대기 주문 3건 취소(시장 2곳)',
    );
    const expired = notificationView(
      notification('n3', {
        type: 'orders_expired',
        category: 'trade',
        params: { marketTitle: '첫눈이 올까', cause: 'closed', orderCount: 1 },
        target: { kind: 'order', orderId: ORDER_ID },
      }),
    );
    if (!expired.known) throw new Error('orders_expired is a type this web renders');
    expect(expired.Title({ params: expired.params, eventCount: 1 })).toBe(
      '첫눈이 올까 거래 마감으로 대기 주문 1건 만료',
    );
    // Params the definition refuses — a quantity as a number, a paused notice with no market (the
    // refine), an unknown cause — draw the category's fallback, never a broken sentence.
    for (const [type, params] of [
      [
        'order_filled',
        {
          marketTitle: '첫눈',
          outcome: 'NO',
          side: 'buy',
          qty: 1,
          amountCoin: '40',
          fullyFilled: false,
          orderQty: '3',
          orderFilledQty: '1',
        },
      ],
      ['orders_cancelled', { reason: 'paused', orderCount: 2, marketCount: 1, marketTitle: null }],
      ['orders_expired', { marketTitle: '첫눈', cause: 'settled', orderCount: 1 }],
    ] as const) {
      expect(
        notificationView(notification('n4', { type, category: 'trade', params })),
        type,
      ).toEqual({ known: false, title: '거래 알림' });
    }
  });

  it('draws each 시장 type through its renderer, and the fallback for params its definition refuses (#54)', () => {
    const target = { kind: 'market', slug: 'first-snow' } as const;
    const titleOf = (type: string, params: InboxNotification['params']) => {
      const view = notificationView(notification('n1', { type, params, target }));
      if (!view.known) throw new Error(`${type} is a type this web renders`);
      return view.Title({ params: view.params, eventCount: view.eventCount });
    };
    expect(titleOf('market_closed', { marketTitle: '첫눈이 올까', early: false })).toBe(
      '첫눈이 올까 거래 마감',
    );
    expect(titleOf('market_closed', { marketTitle: '첫눈이 올까', early: true })).toBe(
      '첫눈이 올까 거래 조기 마감',
    );
    expect(titleOf('market_paused', { marketTitle: '첫눈이 올까', reason: 'ledger_failure' })).toBe(
      '첫눈이 올까 거래 일시 중단 · 사유: 담보·원장 장애',
    );
    expect(titleOf('market_resumed', { marketTitle: '첫눈이 올까', reason: 'early_result' })).toBe(
      '첫눈이 올까 거래 재개 · 중단 사유: 사건 선공개(조기 결과)',
    );
    expect(titleOf('market_cancelled', { marketTitle: '첫눈이 올까' })).toBe(
      '첫눈이 올까 시장 취소',
    );
    expect(
      titleOf('market_rules_supplemented', {
        marketTitle: '첫눈이 올까',
        ruleVersion: 3,
        reason: '{x} $&',
      }),
    ).toBe('첫눈이 올까 규칙 보충 v3 · 사유: {x} $&');
    // Each leads to the market's detail (54-4).
    expect(notificationHref(target)).toBe('/markets/first-snow');
    // Params the definition refuses — an unknown pause reason, v1, an empty reason, no `early` —
    // draw the category's fallback, never a broken sentence.
    for (const [type, params] of [
      ['market_paused', { marketTitle: '첫눈', reason: 'other' }],
      ['market_resumed', { marketTitle: '첫눈' }],
      ['market_rules_supplemented', { marketTitle: '첫눈', ruleVersion: 1, reason: '사유' }],
      ['market_rules_supplemented', { marketTitle: '첫눈', ruleVersion: 2.5, reason: '사유' }],
      ['market_rules_supplemented', { marketTitle: '첫눈', ruleVersion: 3, reason: '' }],
      ['market_closed', { marketTitle: '첫눈' }],
      ['market_cancelled', { marketTitle: '' }],
    ] as const) {
      expect(notificationView(notification('n2', { type, params, target })), type).toEqual({
        known: false,
        title: '시장 알림',
      });
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
      './trade-notifications.ts',
      './market-notifications.ts',
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
