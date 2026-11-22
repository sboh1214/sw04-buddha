import { readFileSync } from 'node:fs';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DEFINITIONS,
  NOTIFICATION_SETTING_CATEGORIES,
  NOTIFICATION_TYPE_REGISTRY,
  NOTIFICATION_UNREAD_COUNT_CAP,
  type NotificationCategory,
  PUBLIC_MARKET_STATUSES,
  defineNotification,
  findExcludedIdentifier,
  findExcludedText,
} from '@buddha/shared';
import { isValidElement } from 'react';
import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_RENDERERS,
  type NotificationRenderer,
  notificationView,
} from '@/components/notifications/notification-renderers';
import { copy } from '@/copy';
import { ApiError, type InboxNotification, type NotificationSettings } from './api';
import { MY_NOTIFICATIONS_PATH, MY_SETTINGS_PATH, MY_TABS } from './my';
import { historyFiltersFromSearchParams } from './my-history';
import {
  NOTIFICATIONS_KEY,
  NOTIFICATION_LIST_KEY,
  NOTIFICATION_REFRESH_MS,
  NOTIFICATION_SETTINGS_ANCHOR,
  NOTIFICATION_SETTINGS_HISTORY_PATH,
  NOTIFICATION_SETTINGS_KEY,
  NOTIFICATION_SETTINGS_PATH,
  NOTIFICATION_UNREAD_KEY,
  type NotificationPages,
  UNREAD_COUNT_CAP,
  isUnread,
  notificationCategoryLabel,
  notificationFallbackTitle,
  notificationHref,
  notificationListKey,
  notificationSettingFailure,
  notificationSettingHint,
  notificationSettingLabel,
  notificationSettingRows,
  notificationSettingSaved,
  notificationSettingsKey,
  notificationUnreadKey,
  unreadCountLabel,
  unreadNotificationsText,
  withNotification,
  withNotificationSetting,
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
 * The copy of #53, #134's 거래 알림 (ADR-0158), #54's 시장 상태 알림 (ADR-0159), #188's 판정·정산
 * 알림 (ADR-0160) and #135's 커뮤니티 알림 (ADR-0161): what a member reads of the inbox.
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
  copy.notificationJudgementDelayed,
  copy.notificationProvisionalResult,
  copy.notificationJudgementCorrected,
  copy.notificationDisputeDecided,
  copy.notificationDisputeClosedByCorrection,
  copy.notificationMarketSettled,
  copy.notificationMarketSettledWatcher,
  copy.notificationPostReplied,
  copy.notificationPostRepliedMerged,
  copy.notificationPostRepliedNoAuthor,
  copy.notificationPostRepliedMergedNoAuthor,
  copy.notificationCommentReplied,
  copy.notificationCommentRepliedMerged,
  copy.notificationCommentRepliedNoAuthor,
  copy.notificationCommentRepliedMergedNoAuthor,
  copy.notificationReplyAuthorAdmin,
  copy.notificationModerationTaken,
  copy.notificationModerationTakenTerm,
  copy.notificationModerationCancelled,
  copy.notificationRestrictionShortened,
  copy.notificationRestrictionLifted,
  copy.notificationProposalDecided,
];

const ORDER_ID = '7d0f9a2e-4b1c-4e8d-9a3f-1c2b3d4e5f60';
const MARKET_ID = '3e5a7c9b-2d4f-4a6b-8c1d-0e2f4a6b8c0d';
const POST_ID = '5c1e9f3a-7b2d-4e6f-8a0c-2d4f6a8c0e1b';
const COMMENT_ID = '6d2f0a4b-8c3e-4f7a-9b1d-3e5a7b9d1f2c';
const ACTION_ID = '8f4b2c6d-0e5a-4b9c-8d3f-5a7c9e1b3d4e';
const PROPOSAL_ID = '9a5c3d7e-1f6b-4cad-9e4a-6b8dae2c4e5f';
const REPLY_ID = '1b6d4e8f-2a7c-4dbe-8f5b-7c9ebf3d5f60';

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

  it('leads a reply notice to its post’s top, an action to 조치·신고 내역 and a decision to 내 제안 (#135)', () => {
    // ADR-0161, 135-7 '화면 맨 위': the post page — published, its placeholder or 'post-gone'
    // (135-4) — for a 댓글 on the member's post and for a 대댓글 under the member's 댓글 alike; MY
    // 조치·신고 내역 (135-2) and MY 내 제안 at their tops. The ids the targets keep beside are for a
    // later anchor (no path reads them yet).
    expect(notificationHref({ kind: 'post', postId: POST_ID })).toBe(`/community/posts/${POST_ID}`);
    expect(notificationHref({ kind: 'post', postId: POST_ID.toUpperCase() })).toBe(
      `/community/posts/${POST_ID}`,
    );
    expect(notificationHref({ kind: 'comment', postId: POST_ID, commentId: COMMENT_ID })).toBe(
      `/community/posts/${POST_ID}`,
    );
    expect(notificationHref({ kind: 'moderation_action', actionId: ACTION_ID })).toBe(
      '/my/moderation',
    );
    expect(notificationHref({ kind: 'proposal', proposalId: PROPOSAL_ID })).toBe('/my/proposals');
    // A missing or malformed id: nowhere (the schema refuses it).
    expect(notificationHref({ kind: 'post', id: POST_ID })).toBeNull();
    expect(notificationHref({ kind: 'post', postId: '../admin' })).toBeNull();
    expect(notificationHref({ kind: 'comment', postId: POST_ID })).toBeNull();
    expect(notificationHref({ kind: 'moderation_action' })).toBeNull();
    expect(notificationHref({ kind: 'proposal', proposalId: 'first-snow' })).toBeNull();
  });

  it('leads nowhere for a kind it does not know or a target it cannot read (never a URL from data)', () => {
    expect(notificationHref({ kind: 'dispute', id: 'p1' })).toBeNull();
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
    // #53 shipped none (52-20); #134 the 거래 three (ADR-0158), #54 the 시장 five (ADR-0159), #188
    // the 판정·정산 six (ADR-0160), #135 the 커뮤니티 six (ADR-0161). Each producer adds the
    // definition, the guard entry and the renderer.
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
      'market_judgement_delayed',
      'market_provisional_result',
      'market_judgement_corrected',
      'market_dispute_decided',
      'market_dispute_closed_by_correction',
      'market_settled',
      'post_replied',
      'comment_replied',
      'moderation_action_taken',
      'moderation_action_cancelled',
      'moderation_restriction_end_changed',
      'proposal_decided',
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
    expect(NOTIFICATION_RENDERERS.market_judgement_delayed.copy).toHaveLength(2);
    expect(NOTIFICATION_RENDERERS.market_provisional_result.copy).toHaveLength(5);
    expect(NOTIFICATION_RENDERERS.market_judgement_corrected.copy).toHaveLength(5);
    expect(NOTIFICATION_RENDERERS.market_dispute_decided.copy).toHaveLength(3);
    expect(NOTIFICATION_RENDERERS.market_dispute_closed_by_correction.copy).toHaveLength(2);
    expect(NOTIFICATION_RENDERERS.market_settled.copy).toHaveLength(5);
    expect(NOTIFICATION_RENDERERS.post_replied.copy).toHaveLength(6);
    expect(NOTIFICATION_RENDERERS.comment_replied.copy).toHaveLength(6);
    expect(NOTIFICATION_RENDERERS.moderation_action_taken.copy).toHaveLength(11);
    expect(NOTIFICATION_RENDERERS.moderation_action_cancelled.copy).toHaveLength(8);
    expect(NOTIFICATION_RENDERERS.moderation_restriction_end_changed.copy).toHaveLength(5);
    expect(NOTIFICATION_RENDERERS.proposal_decided.copy).toHaveLength(3);
    // Every 시장 type — #54's five and #188's six — is category `market` (52-21) and leads to the
    // market's detail alone (54-4, 188-4).
    for (const definition of NOTIFICATION_DEFINITIONS.filter((each) =>
      each.type.startsWith('market_'),
    )) {
      expect(definition.category, definition.type).toBe('market');
      expect(definition.targets, definition.type).toEqual(['market']);
      expect(definition.merge, definition.type).toBeNull();
    }
    // Every 커뮤니티 type — #135's six — is category `community` (52-16, 52-19, 52-21; N05 §4),
    // and only the two reply types merge (52-7).
    const community = [
      'post_replied',
      'comment_replied',
      'moderation_action_taken',
      'moderation_action_cancelled',
      'moderation_restriction_end_changed',
      'proposal_decided',
    ];
    expect(
      NOTIFICATION_DEFINITIONS.filter((each) => each.category === 'community').map(
        (each) => each.type,
      ),
    ).toEqual(community);
    for (const definition of NOTIFICATION_DEFINITIONS.filter((each) =>
      community.includes(each.type),
    )) {
      const merges = definition.type === 'post_replied' || definition.type === 'comment_replied';
      expect(definition.merge === null, definition.type).toBe(!merges);
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

  it('draws each 판정·정산 type through its renderer, and the fallback for params its definition refuses (#188)', () => {
    const target = { kind: 'market', slug: 'first-snow' } as const;
    const viewOf = (type: string, params: InboxNotification['params']) =>
      notificationView(notification('n1', { type, params, target }));
    const titleOf = (type: string, params: InboxNotification['params']) => {
      const view = viewOf(type, params);
      if (!view.known) throw new Error(`${type} is a type this web renders`);
      return view.Title({ params: view.params, eventCount: view.eventCount });
    };
    // The two with no time are sentences (52-14, 52-15, 188-3).
    expect(
      titleOf('market_dispute_decided', {
        marketTitle: '첫눈이 올까',
        decision: 'accepted',
        reason: '{x} $&',
      }),
    ).toBe('첫눈이 올까 판정 이의 수용 · 사유: {x} $&');
    expect(
      titleOf('market_settled', { marketTitle: '첫눈이 올까', result: 'VOID', payoutCoin: '0' }),
    ).toBe('첫눈이 올까 결과 확정: 무효 · 지급 완료 · 내 지급액 0 Coin');
    expect(
      titleOf('market_settled', { marketTitle: '첫눈이 올까', result: 'NO', payoutCoin: null }),
    ).toBe('첫눈이 올까 결과 확정: NO · 지급 완료');
    // The four with a time draw through a component — the hook for the member's zone lives in
    // it (my-notifications.test.tsx draws them).
    const deadline = '2026-09-07T06:00:00.000Z';
    for (const [type, params] of [
      [
        'market_judgement_delayed',
        {
          marketTitle: '첫눈',
          reason: '사유',
          nextReviewAt: deadline,
          judgementTimeZone: 'America/New_York',
        },
      ],
      [
        'market_provisional_result',
        { marketTitle: '첫눈', result: 'YES', disputeDeadline: deadline, judgementTimeZone: null },
      ],
      [
        'market_judgement_corrected',
        { marketTitle: '첫눈', result: 'NO', disputeDeadline: deadline, judgementTimeZone: '' },
      ],
      [
        'market_dispute_closed_by_correction',
        { marketTitle: '첫눈', disputeDeadline: deadline, judgementTimeZone: 'Asia/Seoul' },
      ],
    ] as const) {
      expect(isValidElement(titleOf(type, params)), type).toBe(true);
    }
    // Each leads to the market's detail, settled included (188-4, AC 12).
    expect(notificationHref({ ...target, status: 'settled' })).toBe('/markets/first-snow');
    // Params the definition refuses — a result not of the three, a decision not told, a payout
    // below 0 or as a number, a time that is no instant, a zone that is no string, an empty
    // reason — draw the category's fallback, never a broken sentence.
    for (const [type, params] of [
      [
        'market_provisional_result',
        { marketTitle: '첫눈', result: 'void', disputeDeadline: deadline, judgementTimeZone: null },
      ],
      [
        'market_judgement_corrected',
        { marketTitle: '첫눈', result: 'NO', disputeDeadline: '내일', judgementTimeZone: null },
      ],
      [
        'market_judgement_delayed',
        { marketTitle: '첫눈', reason: '', nextReviewAt: deadline, judgementTimeZone: null },
      ],
      [
        'market_dispute_closed_by_correction',
        { marketTitle: '첫눈', disputeDeadline: deadline, judgementTimeZone: 5 },
      ],
      ['market_dispute_decided', { marketTitle: '첫눈', decision: 'pending', reason: '사유' }],
      ['market_settled', { marketTitle: '첫눈', result: 'YES', payoutCoin: '-1' }],
      ['market_settled', { marketTitle: '첫눈', result: 'YES', payoutCoin: 200 }],
      ['market_settled', { marketTitle: '첫눈', result: 'YES' }],
    ] as const) {
      expect(viewOf(type, params), type).toEqual({ known: false, title: '시장 알림' });
    }
  });

  it('draws each 커뮤니티 type through its renderer with the row’s count and replyAuthor, and the fallback for params its definition refuses (#135)', () => {
    const replyParams = { replyId: REPLY_ID, replyCreatedAt: '2026-11-21T03:00:00.000Z' };
    const viewOf = (fields: Partial<InboxNotification>) =>
      notificationView(notification('n1', { category: 'community', ...fields }));
    const titleOf = (fields: Partial<InboxNotification>) => {
      const view = viewOf(fields);
      if (!view.known) throw new Error(`${String(fields.type)} is a type this web renders`);
      return view.Title({
        params: view.params,
        eventCount: view.eventCount,
        replyAuthor: view.replyAuthor,
      });
    };
    const author = {
      kind: 'member',
      publicId: 'k7m2p9qx4z',
      nickname: '눈사람',
      imageUrl: null,
      isAdmin: false,
    } as const;
    const postTarget = { kind: 'post', postId: POST_ID } as const;
    const commentTarget = { kind: 'comment', postId: POST_ID, commentId: COMMENT_ID } as const;
    // The view carries the row's replyAuthor to the Title (52-15).
    expect(
      viewOf({
        type: 'post_replied',
        params: replyParams,
        target: postTarget,
        replyAuthor: author,
      }),
    ).toMatchObject({ known: true, replyAuthor: author, eventCount: 1 });
    expect(
      titleOf({
        type: 'post_replied',
        params: replyParams,
        target: postTarget,
        eventCount: 3,
        replyAuthor: author,
      }),
    ).toBe('내 글에 새 댓글 3개 · 마지막: 눈사람');
    expect(
      titleOf({
        type: 'comment_replied',
        params: replyParams,
        target: commentTarget,
        replyAuthor: { ...author, isAdmin: true },
      }),
    ).toBe('내 댓글에 새 답글 · 눈사람(운영자)');
    // The latest reply hidden or deleted (null), and a closed replier.
    expect(
      titleOf({
        type: 'comment_replied',
        params: replyParams,
        target: commentTarget,
        eventCount: 2,
        replyAuthor: null,
      }),
    ).toBe('내 댓글에 새 답글 2개');
    expect(
      titleOf({
        type: 'post_replied',
        params: replyParams,
        target: postTarget,
        replyAuthor: { kind: 'former_member' },
      }),
    ).toBe('내 글에 새 댓글 · 탈퇴한 사용자');
    const actionTarget = { kind: 'moderation_action', actionId: ACTION_ID } as const;
    expect(
      titleOf({
        type: 'moderation_action_taken',
        params: { action: 'hide', endsAt: null },
        target: actionTarget,
      }),
    ).toBe('운영 조치: 숨김');
    // A restriction's end is drawn through a component — the hook for the member's zone lives in
    // it (my-notifications.test.tsx draws it); 무기한 too.
    expect(
      isValidElement(
        titleOf({
          type: 'moderation_action_taken',
          params: { action: 'writing_restriction', endsAt: '2026-09-08T06:00:00.000Z' },
          target: actionTarget,
        }),
      ),
    ).toBe(true);
    expect(
      titleOf({
        type: 'moderation_action_cancelled',
        params: { action: 'account_restriction' },
        target: actionTarget,
      }),
    ).toBe('운영 조치 취소: 계정 제한');
    expect(
      titleOf({
        type: 'moderation_restriction_end_changed',
        params: {
          action: 'writing_restriction',
          change: 'lift',
          endsAt: '2026-09-01T06:00:00.000Z',
        },
        target: actionTarget,
      }),
    ).toBe('운영 조치 조기 해제: 작성 제한');
    expect(
      titleOf({
        type: 'proposal_decided',
        params: { decision: 'rejected', question: '{x} $&' },
        target: { kind: 'proposal', proposalId: PROPOSAL_ID },
      }),
    ).toBe('시장 제안 반려 · {x} $&');
    // Params the definition refuses — a reply id that is no uuid, an end on a hide, a change of a
    // warning, a decision not told — draw the category's fallback, never a broken sentence.
    for (const [type, params] of [
      ['post_replied', { replyId: 'r1', replyCreatedAt: '2026-11-21T03:00:00.000Z' }],
      ['comment_replied', { replyId: REPLY_ID }],
      ['moderation_action_taken', { action: 'hide', endsAt: '2026-09-08T06:00:00.000Z' }],
      ['moderation_action_taken', { action: 'dismiss', endsAt: null }],
      ['moderation_action_cancelled', {}],
      [
        'moderation_restriction_end_changed',
        { action: 'warning', change: 'shorten', endsAt: '2026-09-08T06:00:00.000Z' },
      ],
      ['proposal_decided', { decision: 'reviewing', question: '첫눈' }],
    ] as const) {
      expect(viewOf({ type, params }), type).toEqual({ known: false, title: '커뮤니티 알림' });
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
      './judgement-notifications.ts',
      './community-notifications.ts',
      '../components/notifications/notification-row.tsx',
      '../components/notifications/unread-count.tsx',
      '../app/my/notifications/my-notifications.tsx',
      '../components/layout/nav.tsx',
      '../components/layout/bottom-tabs.tsx',
      '../app/my/my-tabs.tsx',
      '../app/my/settings/notification-settings-section.tsx',
      '../app/my/settings/section.tsx',
    ]) {
      expect(source(file), file).not.toMatch(/badge|배지/i);
    }
  });
});

/** 알림 수신 설정's words (#56, ADR-0162; 56-5 — the §6 table approved as written). */
const SETTINGS_COPY = [
  copy.settingsNotifications,
  copy.settingsNotificationsHint,
  copy.notificationSettingTrade,
  copy.notificationSettingTradeHint,
  copy.notificationSettingMarket,
  copy.notificationSettingMarketHint,
  copy.notificationSettingCommunity,
  copy.notificationSettingCommunityHint,
  copy.notificationSettingsHistoryNote,
  copy.notificationSettingsHistoryLink,
  copy.notificationSettingOn,
  copy.notificationSettingOff,
  copy.errNotificationSetting,
  copy.notificationsSettingsLink,
];

const settings = (...entries: [NotificationCategory, boolean][]): NotificationSettings => ({
  categories: entries.map(([category, enabled]) => ({ category, enabled })),
});

describe('알림 수신 설정 (#56, ADR-0162)', () => {
  it('keys the settings under the private root, the account last, apart from the count and the list', () => {
    expect(NOTIFICATION_SETTINGS_KEY).toEqual(['notifications', 'settings']);
    expect(notificationSettingsKey(ACCOUNT)).toEqual(['notifications', 'settings', ACCOUNT]);
    expect(notificationSettingsKey(undefined)).toEqual(['notifications', 'settings', undefined]);
    expect(notificationSettingsKey(ACCOUNT).slice(0, 1)).toEqual([...NOTIFICATIONS_KEY]);
    // Not under the keys a `user:notification` round restarts (realtime-provider.tsx).
    for (const restarted of [NOTIFICATION_LIST_KEY, NOTIFICATION_UNREAD_KEY]) {
      expect(notificationSettingsKey(ACCOUNT).slice(0, restarted.length)).not.toEqual([
        ...restarted,
      ]);
    }
  });

  it('opens the card on MY › 설정 at its anchor, and its line the 정산 list (56-3, 56-4, 52-23)', () => {
    expect(NOTIFICATION_SETTINGS_ANCHOR).toBe('settings-notifications');
    expect(NOTIFICATION_SETTINGS_PATH).toBe(`${MY_SETTINGS_PATH}#settings-notifications`);
    expect(NOTIFICATION_SETTINGS_HISTORY_PATH).toBe('/my/history?kind=settlements');
    expect(historyFiltersFromSearchParams({ kind: 'settlements' }).kind).toBe('settlements');
  });

  it('names a switch and what it covers for every category, and for every type’s category', () => {
    expect(NOTIFICATION_CATEGORIES.map((category) => notificationSettingLabel(category))).toEqual([
      '거래 알림',
      '시장 알림',
      '커뮤니티 알림',
    ]);
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(notificationSettingHint(category)?.trim(), category).toBeTruthy();
    }
    for (const definition of NOTIFICATION_DEFINITIONS) {
      expect(notificationSettingLabel(definition.category), definition.type).toBeDefined();
      expect(notificationSettingHint(definition.category), definition.type).toBeDefined();
    }
    // A category a newer server sends: no words, so no switch.
    expect(notificationSettingLabel('price' as NotificationCategory)).toBeUndefined();
    expect(notificationSettingHint('price' as NotificationCategory)).toBeUndefined();
  });

  it('draws one switch per category the answer lists, in the shared order (56-2)', () => {
    expect(NOTIFICATION_SETTING_CATEGORIES).toEqual(['trade', 'market', 'community']);
    // The answer's order is not the drawing's; the shared list is.
    const rows = notificationSettingRows(
      settings(['community', true], ['trade', true], ['market', false]),
    );
    expect(rows.map(({ category, enabled }) => [category, enabled])).toEqual([
      ['trade', true],
      ['market', false],
      ['community', true],
    ]);
    expect(rows[1]).toEqual({
      category: 'market',
      enabled: false,
      label: copy.notificationSettingMarket,
      hint: copy.notificationSettingMarketHint,
    });
    // A category the answer does not list is not drawn; nor one this web has no words for.
    expect(notificationSettingRows(settings(['market', true])).map((row) => row.category)).toEqual([
      'market',
    ]);
    expect(
      notificationSettingRows(settings(['trade', true], ['price' as NotificationCategory, true]), [
        'trade',
        'price' as NotificationCategory,
      ]).map((row) => row.category),
    ).toEqual(['trade']);
    // Before a category has a type it has no switch, even if an answer listed it (56-2).
    expect(
      notificationSettingRows(settings(['trade', true], ['market', true]), ['market']).map(
        (row) => row.category,
      ),
    ).toEqual(['market']);
    expect(notificationSettingRows(settings())).toEqual([]);
  });

  it('takes a write’s answer for its own category only, the same object when nothing changed', () => {
    const held = settings(['trade', true], ['market', true], ['community', true]);
    // The answer of the market write, which an earlier trade write's answer had not reached yet.
    const answer = settings(['trade', false], ['market', false], ['community', true]);
    const after = withNotificationSetting(held, answer, 'market');
    expect(after).toEqual(settings(['trade', true], ['market', false], ['community', true]));
    expect(held.categories[1]?.enabled).toBe(true);
    expect(withNotificationSetting(after, answer, 'market')).toBe(after);
    // Nothing held: the answer whole.
    expect(withNotificationSetting(undefined, answer, 'market')).toBe(answer);
    // A category the answer or the held list does not name: as held.
    expect(withNotificationSetting(held, settings(['trade', false]), 'market')).toBe(held);
    expect(withNotificationSetting(settings(['trade', true]), answer, 'market')).toEqual(
      settings(['trade', true]),
    );
  });

  it('says what a press did, and why one was refused', () => {
    expect(notificationSettingSaved('거래 알림', false)).toBe('거래 알림을 껐습니다.');
    expect(notificationSettingSaved('커뮤니티 알림', true)).toBe('커뮤니티 알림을 켰습니다.');
    for (const label of NOTIFICATION_CATEGORIES.map(notificationSettingLabel)) {
      expect(notificationSettingSaved(label ?? '', true)).not.toContain('{');
    }
    const another = new ApiError(403, {
      code: 'FORBIDDEN',
      message: 'x',
      details: [{ path: ['expectedAccountId'], message: 'another account' }],
    } as never);
    expect(notificationSettingFailure(another)).toBe(copy.sessionChanged);
    expect(
      notificationSettingFailure(new ApiError(400, { code: 'VALIDATION_ERROR', message: 'x' })),
    ).toBe(copy.errNotificationSetting);
    expect(notificationSettingFailure(new Error('down'))).toBe(
      '알림 수신 설정을 저장하지 못했습니다. 다시 시도해 주세요.',
    );
  });

  it('words it with no excluded item, no channel or price, nothing locked and no reward (AC 9)', () => {
    for (const text of SETTINGS_COPY) {
      expect(text.trim(), text).not.toBe('');
      expect(findExcludedText(text), text).toEqual([]);
      expect(text, text).not.toMatch(/배지|badge/i);
      // #56 AC 9, N05 §4, N04 §7, N06: no price item, no channel, no score or rank, no paid Coin.
      expect(text, text).not.toMatch(
        /가격|이메일|푸시|채널|점수|순위|랭킹|Forecast|구매|충전|결제|유료/i,
      );
      // 52-20/52-23 leave 지급 후 보상 to #144; 52-21 locks nothing; 52-23 needs no '필수'.
      expect(text, text).not.toMatch(/보상|필수|잠금|잠그|끌 수 없/);
      // 예측 only inside 예측시장, which no line here names.
      expect(text.replaceAll('예측시장', ''), text).not.toMatch(/예측/);
    }
    for (const name of [
      'notificationSettingsKey',
      'notificationSettingRows',
      'withNotificationSetting',
      'useNotificationSettings',
      'useUpdateNotificationSetting',
      'settings-notifications',
      'categoriesOff',
    ]) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
    }
  });
});
