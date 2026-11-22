import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { APPROVAL_REASON_MAX_LENGTH, approvalReasonSchema } from './approvals.js';
import { MARKET_PAUSE_REASONS } from './market-pause.js';
import { MARKET_RESULTS, MODERATION_ACTION_TYPES, RESTRICTION_END_CHANGE_KINDS } from './enums.js';
import { NOTIFICATION_IDENTITY_PARAM } from './guards/notifications.js';
import { decideDisputeBodySchema } from './market-dispute.js';
import { recordJudgementDelayBodySchema } from './market-judgement-delay.js';
import { PROPOSAL_QUESTION_MAX, PROPOSAL_TRANSITIONS } from './proposals.js';
import {
  COMMENT_REPLIED_NOTIFICATION,
  MARKET_CANCELLED_NOTIFICATION,
  MARKET_CLOSED_NOTIFICATION,
  MARKET_DISPUTE_CLOSED_BY_CORRECTION_NOTIFICATION,
  MARKET_DISPUTE_DECIDED_NOTIFICATION,
  MARKET_JUDGEMENT_CORRECTED_NOTIFICATION,
  MARKET_JUDGEMENT_DELAYED_NOTIFICATION,
  MARKET_PAUSED_NOTIFICATION,
  MARKET_PROVISIONAL_RESULT_NOTIFICATION,
  MARKET_RESUMED_NOTIFICATION,
  MARKET_RULES_SUPPLEMENTED_NOTIFICATION,
  MARKET_SETTLED_NOTIFICATION,
  MODERATION_ACTION_CANCELLED_NOTIFICATION,
  MODERATION_ACTION_TAKEN_NOTIFICATION,
  MODERATION_RESTRICTION_END_CHANGED_NOTIFICATION,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DEFINITIONS,
  NOTIFICATION_EVENT_KEY_PATTERN,
  NOTIFICATION_PARAM_STRING_MAX,
  NOTIFICATION_TARGET_KINDS,
  NOTIFICATION_TYPE_PATTERN,
  NOTIFICATION_UNREAD_COUNT_CAP,
  NOTIFIED_CANCEL_REASONS,
  NOTIFIED_DISPUTE_DECISIONS,
  NOTIFIED_PROPOSAL_DECISIONS,
  ORDER_EXPIRY_CAUSES,
  ORDER_FILLED_NOTIFICATION,
  ORDERS_CANCELLED_NOTIFICATION,
  ORDERS_EXPIRED_NOTIFICATION,
  POST_REPLIED_NOTIFICATION,
  PROPOSAL_DECIDED_NOTIFICATION,
  RESTRICTION_ACTION_TYPES,
  defineNotification,
  notificationCategorySchema,
  notificationParamsSchema,
  notificationReadResultSchema,
  notificationSchema,
  notificationTargetSchema,
  notificationUnreadCountSchema,
  replyParamsSchema,
  type Notification,
  type OrderFilledParams,
  type ReplyParams,
} from './notifications.js';

const notification: Notification = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  type: 'market_closed',
  category: 'market',
  params: { title: '시장 제목', closeAt: '2026-11-21T03:00:00.000Z', amountCoin: '120' },
  target: { kind: 'market', slug: 'korea-rate-cut-2026' },
  eventCount: 1,
  occurredAt: '2026-11-21T03:00:00.000Z',
  readAt: null,
};

describe('notification categories (N05 §4, 52-21)', () => {
  it('are the three settings units, exactly', () => {
    expect(NOTIFICATION_CATEGORIES).toEqual(['trade', 'market', 'community']);
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(notificationCategorySchema.parse(category)).toBe(category);
    }
    // N05 §4's 가격 변동 (#146) is post-MVP: a fourth category comes with its own migration.
    expect(notificationCategorySchema.safeParse('price').success).toBe(false);
  });
});

describe('the database shapes (migration 0078)', () => {
  it('holds a type to lower-case words of 2 to 48 characters', () => {
    for (const type of ['ab', 'order_filled', 'market_closed', `a${'b'.repeat(47)}`]) {
      expect(NOTIFICATION_TYPE_PATTERN.test(type), type).toBe(true);
    }
    for (const type of ['a', 'Order', '1st', 'order-filled', `a${'b'.repeat(48)}`, '']) {
      expect(NOTIFICATION_TYPE_PATTERN.test(type), type).toBe(false);
    }
  });

  it('holds an event key and a merge key to ids and colons, up to 128 characters', () => {
    for (const key of ['1', '3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'market:abc:closed', 'A_b']) {
      expect(NOTIFICATION_EVENT_KEY_PATTERN.test(key), key).toBe(true);
    }
    for (const key of ['', 'a b', 'a/b', 'ㄱ', 'x'.repeat(129)]) {
      expect(NOTIFICATION_EVENT_KEY_PATTERN.test(key), key).toBe(false);
    }
  });
});

describe('notification targets', () => {
  it('lead to a market by its slug, in every status: the target carries none', () => {
    expect(notificationTargetSchema.parse({ kind: 'market', slug: 'korea-rate-cut-2026' })).toEqual(
      { kind: 'market', slug: 'korea-rate-cut-2026' },
    );
    // A Korean slug is NFC-normalised, as the market's own.
    const decomposed = '기준금리'.normalize('NFD');
    expect(notificationTargetSchema.parse({ kind: 'market', slug: decomposed })).toEqual({
      kind: 'market',
      slug: '기준금리',
    });
    // A status or a URL beside it is not kept: the web maps the kind to its own path.
    expect(
      notificationTargetSchema.parse({
        kind: 'market',
        slug: 'abc',
        status: 'settled',
        url: 'https://elsewhere.example',
      }),
    ).toEqual({ kind: 'market', slug: 'abc' });
  });

  it('refuses an unknown kind, a bad slug and a missing one', () => {
    for (const target of [
      // A kind no producer leads to yet (#135 made 'post' one).
      { kind: 'dispute', id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
      { kind: 'url', href: 'https://elsewhere.example' },
      { kind: 'market', slug: 'Not A Slug' },
      { kind: 'market', slug: 'ab' },
      { kind: 'market', slug: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
      { kind: 'market' },
      { slug: 'abc' },
      'market',
    ]) {
      expect(notificationTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(
        false,
      );
    }
  });

  it('lead to one of the recipient’s orders by its id, lower-cased (#134)', () => {
    const orderId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(notificationTargetSchema.parse({ kind: 'order', orderId })).toEqual({
      kind: 'order',
      orderId,
    });
    expect(
      notificationTargetSchema.parse({ kind: 'order', orderId: orderId.toUpperCase() }),
    ).toEqual({ kind: 'order', orderId });
    // Nothing beside the id is kept: no URL, no owner.
    expect(
      notificationTargetSchema.parse({ kind: 'order', orderId, userId: 'u1', url: '/x' }),
    ).toEqual({ kind: 'order', orderId });
    for (const target of [
      { kind: 'order', orderId: 'not-a-uuid' },
      { kind: 'order', orderId: null },
      { kind: 'order', id: orderId },
      { kind: 'order' },
    ]) {
      expect(notificationTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(
        false,
      );
    }
  });

  it('lead to the ended orders of one market or of every market (#134, 52-4)', () => {
    const marketId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(notificationTargetSchema.parse({ kind: 'order_history', marketId })).toEqual({
      kind: 'order_history',
      marketId,
    });
    expect(
      notificationTargetSchema.parse({ kind: 'order_history', marketId: marketId.toUpperCase() }),
    ).toEqual({ kind: 'order_history', marketId });
    // null: every market (an account event).
    expect(notificationTargetSchema.parse({ kind: 'order_history', marketId: null })).toEqual({
      kind: 'order_history',
      marketId: null,
    });
    for (const target of [
      { kind: 'order_history' },
      { kind: 'order_history', marketId: 'korea-rate-cut-2026' },
      { kind: 'order_history', slug: 'korea-rate-cut-2026' },
    ]) {
      expect(notificationTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(
        false,
      );
    }
  });

  it('lead to the recipient’s own post or 댓글, by ids lower-cased (#135, 52-18, 135-7)', () => {
    const postId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const commentId = '6fa459ea-ee8a-3ca4-894e-db77e160355e';
    expect(notificationTargetSchema.parse({ kind: 'post', postId: postId.toUpperCase() })).toEqual({
      kind: 'post',
      postId,
    });
    expect(
      notificationTargetSchema.parse({
        kind: 'comment',
        postId: postId.toUpperCase(),
        commentId: commentId.toUpperCase(),
      }),
    ).toEqual({ kind: 'comment', postId, commentId });
    // Nothing beside the ids is kept: no reply, no author, no URL.
    expect(
      notificationTargetSchema.parse({
        kind: 'comment',
        postId,
        commentId,
        replyId: postId,
        authorId: 'u1',
        url: '/x',
      }),
    ).toEqual({ kind: 'comment', postId, commentId });
    for (const target of [
      { kind: 'post' },
      { kind: 'post', id: postId },
      { kind: 'post', postId: 'not-a-uuid' },
      { kind: 'post', postId: null },
      { kind: 'comment', postId },
      { kind: 'comment', commentId },
      { kind: 'comment', postId, commentId: 'not-a-uuid' },
    ]) {
      expect(notificationTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(
        false,
      );
    }
  });

  it('lead to an action taken on the recipient and to their own proposal (#135, 135-2, 135-7)', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(
      notificationTargetSchema.parse({ kind: 'moderation_action', actionId: id.toUpperCase() }),
    ).toEqual({ kind: 'moderation_action', actionId: id });
    expect(
      notificationTargetSchema.parse({ kind: 'proposal', proposalId: id.toUpperCase() }),
    ).toEqual({ kind: 'proposal', proposalId: id });
    // Nothing of the report, the operator or the member is kept beside the id.
    expect(
      notificationTargetSchema.parse({
        kind: 'moderation_action',
        actionId: id,
        reportId: id,
        createdBy: 'admin-1',
        userId: 'u1',
      }),
    ).toEqual({ kind: 'moderation_action', actionId: id });
    for (const target of [
      { kind: 'moderation_action' },
      { kind: 'moderation_action', id },
      { kind: 'moderation_action', actionId: 'not-a-uuid' },
      { kind: 'proposal' },
      { kind: 'proposal', id },
      { kind: 'proposal', proposalId: null },
    ]) {
      expect(notificationTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(
        false,
      );
    }
  });

  it('lists every kind of the union, in its order', () => {
    expect(NOTIFICATION_TARGET_KINDS).toEqual([
      'market',
      'order',
      'order_history',
      'post',
      'comment',
      'moderation_action',
      'proposal',
    ]);
    expect(notificationTargetSchema.options.map((option) => option.shape.kind.value)).toEqual([
      ...NOTIFICATION_TARGET_KINDS,
    ]);
  });
});

describe('notification parameters', () => {
  it('take flat values only: a string, a number, a boolean or null', () => {
    const params = { title: '제목', count: 3, filled: true, closedAt: null, ratio: 0.5 };
    expect(notificationParamsSchema.parse(params)).toEqual(params);
    expect(notificationParamsSchema.parse({})).toEqual({});
    for (const value of [{ nested: 1 }, [1, 2], undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(notificationParamsSchema.safeParse({ value }).success, JSON.stringify(value)).toBe(
        false,
      );
    }
    expect(
      notificationParamsSchema.safeParse({ text: 'x'.repeat(NOTIFICATION_PARAM_STRING_MAX) })
        .success,
    ).toBe(true);
    expect(
      notificationParamsSchema.safeParse({ text: 'x'.repeat(NOTIFICATION_PARAM_STRING_MAX + 1) })
        .success,
    ).toBe(false);
  });

  it('take camelCase names only', () => {
    for (const key of ['title', 'amountCoin', 'a', `a${'b'.repeat(39)}`]) {
      expect(notificationParamsSchema.safeParse({ [key]: 1 }).success, key).toBe(true);
    }
    for (const key of ['Title', 'amount_coin', '1st', 'a-b', '', `a${'b'.repeat(40)}`]) {
      expect(notificationParamsSchema.safeParse({ [key]: 1 }).success, key).toBe(false);
    }
  });
});

describe('notification DTOs', () => {
  it('answer a notification with its type as a pattern, so the web can fall back on one it does not know', () => {
    expect(notificationSchema.parse(notification)).toEqual(notification);
    const read = { ...notification, eventCount: 3, readAt: '2026-11-21T04:00:00.000Z' };
    expect(notificationSchema.parse(read)).toEqual(read);
    // A type the list does not hold yet still parses (53-11 ④); one of a bad shape does not.
    expect(notificationSchema.parse({ ...notification, type: 'future_type' }).type).toBe(
      'future_type',
    );
    for (const bad of [
      { type: 'Bad-Type' },
      { category: 'price' },
      { eventCount: 0 },
      { eventCount: 1.5 },
      { occurredAt: '2026-11-21 03:00' },
      { readAt: undefined },
      { id: 'not-a-uuid' },
      { target: { kind: 'dispute', id: '1' } },
      { params: { nested: { a: 1 } } },
    ]) {
      expect(
        notificationSchema.safeParse({ ...notification, ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it('answers the latest reply’s author on a reply notice, or none (#135, 52-15, 135-4)', () => {
    const reply: Notification = {
      ...notification,
      type: 'post_replied',
      category: 'community',
      params: {
        replyId: '6fa459ea-ee8a-3ca4-894e-db77e160355e',
        replyCreatedAt: '2026-11-21T03:00:00.000Z',
      },
      target: { kind: 'post', postId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
    };
    const member = {
      kind: 'member' as const,
      publicId: '7k2m9q4xab',
      nickname: '첫눈러버',
      imageUrl: null,
      isAdmin: false,
    };
    for (const replyAuthor of [member, { ...member, isAdmin: true }, { kind: 'former_member' }]) {
      expect(notificationSchema.parse({ ...reply, replyAuthor })).toEqual({
        ...reply,
        replyAuthor,
      });
    }
    // null: the reply hidden, deleted or gone; absent: any other type (its JSON unchanged).
    expect(notificationSchema.parse({ ...reply, replyAuthor: null })).toEqual({
      ...reply,
      replyAuthor: null,
    });
    expect(notificationSchema.parse(notification)).toEqual(notification);
    expect('replyAuthor' in notificationSchema.parse(notification)).toBe(false);
    for (const replyAuthor of [
      '7k2m9q4xab',
      { kind: 'member', nickname: '첫눈러버' },
      { ...member, publicId: 'not-a-public-id' },
      { kind: 'guest' },
    ]) {
      expect(
        notificationSchema.safeParse({ ...reply, replyAuthor }).success,
        JSON.stringify(replyAuthor),
      ).toBe(false);
    }
  });

  it('counts unread up to the cap, the cap meaning that many or more', () => {
    expect(NOTIFICATION_UNREAD_COUNT_CAP).toBe(100);
    for (const unreadCount of [0, 1, 99, NOTIFICATION_UNREAD_COUNT_CAP]) {
      expect(notificationUnreadCountSchema.parse({ unreadCount })).toEqual({ unreadCount });
    }
    for (const unreadCount of [-1, 1.5, NOTIFICATION_UNREAD_COUNT_CAP + 1, '3']) {
      expect(notificationUnreadCountSchema.safeParse({ unreadCount }).success).toBe(false);
    }
    expect(notificationReadResultSchema.parse({ notification, unreadCount: 4 })).toEqual({
      notification,
      unreadCount: 4,
    });
    expect(notificationReadResultSchema.safeParse({ notification, unreadCount: 101 }).success).toBe(
      false,
    );
  });
});

describe('NOTIFICATION_DEFINITIONS (#53, 52-20; #134; #54; #188; #135)', () => {
  it('holds the 거래 three of #134, the 시장 five of #54, the 판정·정산 six of #188, then the 커뮤니티 six of #135', () => {
    // Pinned. Each producer edits this pin as it appends its own: #144 (정정·보상) next. 시작
    // Coin, a re-grant's result, a review's rejection and a market's opening are no notification
    // (52-20); nor is a like or a report's intake (D5, 52-20).
    const market = (type: string) => ({
      type,
      category: 'market',
      targets: ['market'],
      merges: false,
    });
    const community = (type: string, target: string, merges = false) => ({
      type,
      category: 'community',
      targets: [target],
      merges,
    });
    expect(
      NOTIFICATION_DEFINITIONS.map((definition) => ({
        type: definition.type,
        category: definition.category,
        targets: definition.targets,
        merges: definition.merge !== null,
      })),
    ).toEqual([
      { type: 'order_filled', category: 'trade', targets: ['order'], merges: true },
      {
        type: 'orders_cancelled',
        category: 'trade',
        targets: ['order', 'order_history'],
        merges: false,
      },
      {
        type: 'orders_expired',
        category: 'trade',
        targets: ['order', 'order_history'],
        merges: false,
      },
      // #54 (ADR-0159; 52-21: every one a 시장 notification, none merging, 54-4: the detail).
      market('market_closed'),
      market('market_paused'),
      market('market_resumed'),
      market('market_cancelled'),
      market('market_rules_supplemented'),
      // #188 (ADR-0160; 52-21: every one a 시장 notification, none merging; 188-4: the detail).
      market('market_judgement_delayed'),
      market('market_provisional_result'),
      market('market_judgement_corrected'),
      market('market_dispute_decided'),
      market('market_dispute_closed_by_correction'),
      market('market_settled'),
      // #135 (ADR-0161; 52-21: every one a 커뮤니티 notification; only the two reply types merge,
      // 52-7; each leads where 135-7 says).
      community('post_replied', 'post', true),
      community('comment_replied', 'comment', true),
      community('moderation_action_taken', 'moderation_action'),
      community('moderation_action_cancelled', 'moderation_action'),
      community('moderation_restriction_end_changed', 'moderation_action'),
      community('proposal_decided', 'proposal'),
    ]);
    expect(NOTIFICATION_DEFINITIONS).toEqual([
      ORDER_FILLED_NOTIFICATION,
      ORDERS_CANCELLED_NOTIFICATION,
      ORDERS_EXPIRED_NOTIFICATION,
      MARKET_CLOSED_NOTIFICATION,
      MARKET_PAUSED_NOTIFICATION,
      MARKET_RESUMED_NOTIFICATION,
      MARKET_CANCELLED_NOTIFICATION,
      MARKET_RULES_SUPPLEMENTED_NOTIFICATION,
      MARKET_JUDGEMENT_DELAYED_NOTIFICATION,
      MARKET_PROVISIONAL_RESULT_NOTIFICATION,
      MARKET_JUDGEMENT_CORRECTED_NOTIFICATION,
      MARKET_DISPUTE_DECIDED_NOTIFICATION,
      MARKET_DISPUTE_CLOSED_BY_CORRECTION_NOTIFICATION,
      MARKET_SETTLED_NOTIFICATION,
      POST_REPLIED_NOTIFICATION,
      COMMENT_REPLIED_NOTIFICATION,
      MODERATION_ACTION_TAKEN_NOTIFICATION,
      MODERATION_ACTION_CANCELLED_NOTIFICATION,
      MODERATION_RESTRICTION_END_CHANGED_NOTIFICATION,
      PROPOSAL_DECIDED_NOTIFICATION,
    ]);
    expect(NOTIFICATION_DEFINITIONS).toHaveLength(20);
    for (const definition of NOTIFICATION_DEFINITIONS) {
      expect(NOTIFICATION_TYPE_PATTERN.test(definition.type), definition.type).toBe(true);
    }
  });

  it('keeps 시장 for the market_ names and 커뮤니티 for #135’s, the two reply types merging alone', () => {
    // The web holds every `market_*` type to `market` and the market target: no #135 type takes
    // the prefix (`proposal_decided`, not `market_proposal_decided`).
    const COMMUNITY = [
      'post_replied',
      'comment_replied',
      'moderation_action_taken',
      'moderation_action_cancelled',
      'moderation_restriction_end_changed',
      'proposal_decided',
    ];
    for (const definition of NOTIFICATION_DEFINITIONS) {
      if (definition.type.startsWith('market_')) {
        expect(definition.category, definition.type).toBe('market');
        expect(definition.targets, definition.type).toEqual(['market']);
      }
      expect(definition.category === 'community', definition.type).toBe(
        COMMUNITY.includes(definition.type),
      );
    }
    expect(
      NOTIFICATION_DEFINITIONS.filter(
        (definition) => definition.category === 'community' && definition.merge !== null,
      ).map((definition) => definition.type),
    ).toEqual(['post_replied', 'comment_replied']);
  });

  it('types a definition by its own params, its merge included', () => {
    const merged = defineNotification({
      type: 'test_merged',
      category: 'trade',
      targets: ['market'],
      params: z.object({ label: z.string(), total: z.number().int() }),
      merge: (held, next) => ({ label: next.label, total: held.total + next.total }),
    });
    expect(merged.merge?.({ label: 'a', total: 1 }, { label: 'b', total: 2 })).toEqual({
      label: 'b',
      total: 3,
    });
    expect(merged.params.parse({ label: 'x', total: 2 })).toEqual({ label: 'x', total: 2 });
  });
});

/** A fill notice's params as the db builder writes them: one contract, NO 매수 at 40 of 3. */
const filled = (change: Partial<OrderFilledParams> = {}): OrderFilledParams => ({
  marketTitle: '첫눈이 올까',
  outcome: 'NO',
  side: 'buy',
  qty: '1',
  amountCoin: '40',
  fullyFilled: false,
  orderQty: '3',
  orderFilledQty: '1',
  ...change,
});

describe('order_filled (#134, 52-6, 134-1·134-3)', () => {
  const { params, merge } = ORDER_FILLED_NOTIFICATION;

  it('takes the resting order’s contract and direction, quantities and Coin as decimal strings', () => {
    expect(params.parse(filled())).toEqual(filled());
    expect(params.parse(filled({ outcome: 'YES', side: 'sell', fullyFilled: true }))).toEqual(
      filled({ outcome: 'YES', side: 'sell', fullyFilled: true }),
    );
    // A 120-code-point title of astral characters is 240 UTF-16 units: still a title here.
    const astral = '𝔸'.repeat(120);
    expect(params.parse(filled({ marketTitle: astral })).marketTitle).toBe(astral);
  });

  it('refuses numbers, zero, negatives and padded strings for a quantity or an amount', () => {
    for (const key of ['qty', 'amountCoin', 'orderQty', 'orderFilledQty'] as const) {
      for (const value of [1, '0', '-1', '01', '1.5', ' 1', '', '1e3', '12345678901234567']) {
        expect(params.safeParse({ ...filled(), [key]: value }).success, `${key} ${value}`).toBe(
          false,
        );
      }
    }
    for (const bad of [
      { outcome: 'MAYBE' },
      { side: 'hold' },
      { fullyFilled: 'true' },
      { marketTitle: '' },
      { marketTitle: 'x'.repeat(NOTIFICATION_PARAM_STRING_MAX + 1) },
      { marketTitle: null },
    ]) {
      expect(params.safeParse({ ...filled(), ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    const { orderQty: _omitted, ...missing } = filled();
    expect(params.safeParse(missing).success).toBe(false);
  });

  it('sums the held and the new fills as whole numbers, past 2^53', () => {
    const big = merge!(
      filled({ qty: '9007199254740993', amountCoin: '9007199254740993' }),
      filled({ qty: '1', amountCoin: '1' }),
    );
    expect(big).toMatchObject({ qty: '9007199254740994', amountCoin: '9007199254740994' });
    expect(params.safeParse(big).success).toBe(true);
    // Two fills at the order's own 40: the average stays 40 (amount / qty).
    expect(
      merge!(
        filled({ qty: '1', amountCoin: '40' }),
        filled({ qty: '2', amountCoin: '80', orderFilledQty: '3', fullyFilled: true }),
      ),
    ).toEqual(filled({ qty: '3', amountCoin: '120', orderFilledQty: '3', fullyFilled: true }));
  });

  it('keeps 전량 체결 once reached, and the order’s latest filled quantity, in either order', () => {
    const early = filled({ qty: '1', amountCoin: '40', orderFilledQty: '2' });
    const late = filled({ qty: '1', amountCoin: '40', orderFilledQty: '3', fullyFilled: true });
    for (const [held, next] of [
      [early, late],
      [late, early],
    ] as const) {
      expect(merge!(held, next)).toMatchObject({
        qty: '2',
        amountCoin: '80',
        fullyFilled: true,
        orderFilledQty: '3',
        orderQty: '3',
      });
    }
    expect(merge!(filled(), filled()).fullyFilled).toBe(false);
    // Compared as numbers, not as strings ('10' > '9').
    expect(
      merge!(
        filled({ orderQty: '20', orderFilledQty: '9' }),
        filled({ orderQty: '20', orderFilledQty: '10' }),
      ).orderFilledQty,
    ).toBe('10');
  });

  it('takes the title, the contract and the direction from the newer event', () => {
    expect(
      merge!(filled({ marketTitle: '예전 제목' }), filled({ marketTitle: '새 제목' })).marketTitle,
    ).toBe('새 제목');
  });
});

describe('orders_cancelled (#134, 52-3·52-4)', () => {
  const { params } = ORDERS_CANCELLED_NOTIFICATION;

  it('notifies the system batches only: 일시 중단, 관리자 권한, 계정 제한', () => {
    expect(NOTIFIED_CANCEL_REASONS).toEqual(['paused', 'admin_role', 'restricted']);
    for (const reason of ['by_owner', 'ioc_remainder', 'self_trade', 'account_closed']) {
      expect(
        params.safeParse({ reason, orderCount: 1, marketCount: 1, marketTitle: null }).success,
        reason,
      ).toBe(false);
    }
  });

  it('names one market for a pause, and none for an account event', () => {
    const paused = { reason: 'paused', orderCount: 2, marketCount: 1, marketTitle: '첫눈이 올까' };
    expect(params.parse(paused)).toEqual(paused);
    for (const reason of ['admin_role', 'restricted'] as const) {
      const account = { reason, orderCount: 3, marketCount: 2, marketTitle: null };
      expect(params.parse(account)).toEqual(account);
      expect(params.safeParse({ ...account, marketTitle: '첫눈이 올까' }).success, reason).toBe(
        false,
      );
    }
    for (const bad of [
      { ...paused, marketTitle: null },
      { ...paused, marketCount: 2 },
      { ...paused, orderCount: 0 },
      { ...paused, orderCount: 1.5 },
      { ...paused, orderCount: '2' },
      { reason: 'restricted', orderCount: 1, marketCount: 2, marketTitle: null },
      { reason: 'restricted', orderCount: 1, marketCount: 0, marketTitle: null },
    ]) {
      expect(params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('orders_expired (#134, 52-4·52-5)', () => {
  const { params } = ORDERS_EXPIRED_NOTIFICATION;

  it('says whether the market closed or was cancelled', () => {
    expect(ORDER_EXPIRY_CAUSES).toEqual(['closed', 'cancelled']);
    for (const cause of ORDER_EXPIRY_CAUSES) {
      const expired = { marketTitle: '첫눈이 올까', cause, orderCount: 1 };
      expect(params.parse(expired)).toEqual(expired);
    }
    for (const bad of [
      { marketTitle: '첫눈이 올까', cause: 'settled', orderCount: 1 },
      { marketTitle: '첫눈이 올까', cause: 'closed', orderCount: 0 },
      { marketTitle: null, cause: 'closed', orderCount: 1 },
      { marketTitle: '첫눈이 올까', orderCount: 1 },
    ]) {
      expect(params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('시장 상태 알림 (#54, ADR-0159; 52-1·52-5·52-8~52-10, 54-1~54-8)', () => {
  const title = '첫눈이 올까';
  const tooLong = 'x'.repeat(NOTIFICATION_PARAM_STRING_MAX + 1);
  // A 120-code-point title of astral characters is 240 UTF-16 units: still a title here.
  const astral = '𝔸'.repeat(120);

  it('market_closed: the title and whether an approved decision closed it early', () => {
    const { params } = MARKET_CLOSED_NOTIFICATION;
    for (const early of [false, true]) {
      expect(params.parse({ marketTitle: title, early })).toEqual({ marketTitle: title, early });
    }
    expect(params.parse({ marketTitle: astral, early: false }).marketTitle).toBe(astral);
    for (const bad of [
      { marketTitle: title },
      { marketTitle: title, early: 'true' },
      { marketTitle: '', early: false },
      { marketTitle: tooLong, early: false },
      { marketTitle: null, early: false },
    ]) {
      expect(params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('market_paused and market_resumed: the pause’s public label, never its note (52-9, 54-2)', () => {
    for (const { params } of [MARKET_PAUSED_NOTIFICATION, MARKET_RESUMED_NOTIFICATION]) {
      for (const reason of MARKET_PAUSE_REASONS) {
        expect(params.parse({ marketTitle: title, reason })).toEqual({
          marketTitle: title,
          reason,
        });
      }
      for (const bad of [
        { marketTitle: title, reason: 'operator_stopped' },
        { marketTitle: title, reason: '사건 선공개' },
        { marketTitle: title },
        { marketTitle: '', reason: 'basis_change' },
        { marketTitle: tooLong, reason: 'basis_change' },
      ]) {
        expect(params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      }
      // A note beside it is not kept: the detail's 공개 판정 기록 shows it (52-9).
      expect(params.parse({ marketTitle: title, reason: 'early_result', note: '설명' })).toEqual({
        marketTitle: title,
        reason: 'early_result',
      });
    }
  });

  it('market_cancelled: the title only', () => {
    const { params } = MARKET_CANCELLED_NOTIFICATION;
    expect(params.parse({ marketTitle: title })).toEqual({ marketTitle: title });
    expect(params.parse({ marketTitle: title, early: true, count: 3 })).toEqual({
      marketTitle: title,
    });
    for (const bad of [{}, { marketTitle: '' }, { marketTitle: tooLong }]) {
      expect(params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('market_rules_supplemented: the title after it, its version (2 or more) and its public reason', () => {
    const { params } = MARKET_RULES_SUPPLEMENTED_NOTIFICATION;
    const supplemented = { marketTitle: title, ruleVersion: 3, reason: '대체 출처를 더합니다.' };
    expect(params.parse(supplemented)).toEqual(supplemented);
    // The longest reason an approval stores fits, in UTF-16 units as both count them.
    const longest = '가'.repeat(APPROVAL_REASON_MAX_LENGTH);
    expect(params.parse({ ...supplemented, reason: longest }).reason).toBe(longest);
    // A reason that holds braces or a replacement pattern is plain text here.
    expect(params.parse({ ...supplemented, reason: '{market} $& 그대로' }).reason).toBe(
      '{market} $& 그대로',
    );
    for (const bad of [
      { ...supplemented, ruleVersion: 1 },
      { ...supplemented, ruleVersion: 1.5 },
      { ...supplemented, ruleVersion: 0 },
      { ...supplemented, ruleVersion: '3' },
      { ...supplemented, reason: '' },
      { ...supplemented, reason: tooLong },
      { ...supplemented, reason: null },
      { ...supplemented, marketTitle: '' },
      { ...supplemented, marketTitle: tooLong },
      { marketTitle: title, ruleVersion: 2 },
    ]) {
      expect(params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('keeps the approval reason cap within the param cap: a raised one would roll approvals back', () => {
    // The supplement's reason is its request's (`approvalReasonSchema`, UTF-16 units — the unit
    // zod counts here too). Raising APPROVAL_REASON_MAX_LENGTH past the param cap would make an
    // approved supplement's notice refused, and the approval roll back (ADR-0159).
    expect(APPROVAL_REASON_MAX_LENGTH).toBeLessThanOrEqual(NOTIFICATION_PARAM_STRING_MAX);
    const longest = approvalReasonSchema.parse('𝔸'.repeat(APPROVAL_REASON_MAX_LENGTH / 2));
    expect(
      MARKET_RULES_SUPPLEMENTED_NOTIFICATION.params.safeParse({
        marketTitle: title,
        ruleVersion: 2,
        reason: longest,
      }).success,
    ).toBe(true);
  });

  it('stores flat public values only: no time, count, holding or watcher datum (AC 8)', () => {
    const keys = (definition: { params: z.ZodType }) =>
      Object.keys((definition.params as z.ZodObject).shape).sort();
    expect(keys(MARKET_CLOSED_NOTIFICATION)).toEqual(['early', 'marketTitle']);
    expect(keys(MARKET_PAUSED_NOTIFICATION)).toEqual(['marketTitle', 'reason']);
    expect(keys(MARKET_RESUMED_NOTIFICATION)).toEqual(['marketTitle', 'reason']);
    expect(keys(MARKET_CANCELLED_NOTIFICATION)).toEqual(['marketTitle']);
    expect(keys(MARKET_RULES_SUPPLEMENTED_NOTIFICATION)).toEqual([
      'marketTitle',
      'reason',
      'ruleVersion',
    ]);
  });
});

describe('판정·정산 알림 (#188, ADR-0160; 52-1·52-11~52-15, 188-1~188-6)', () => {
  const title = '첫눈이 올까';
  const tooLong = 'x'.repeat(NOTIFICATION_PARAM_STRING_MAX + 1);
  // A 120-code-point title of astral characters is 240 UTF-16 units: still a title here.
  const astral = '𝔸'.repeat(120);
  const at = '2026-09-07T06:00:00.000Z';
  // Instants as `toISOString()` writes them: anything else is refused.
  const notInstants = ['2026-09-07 15:00', '2026-09-07', 'tomorrow', '', 1_788_000_000_000, null];
  // Whatever `markets.judgement_time_zone` may hold, an unknown but well-shaped zone and ''
  // included: no Intl refine, no minimum (an approval or a payout must never roll back on it).
  const zones = ['Asia/Seoul', 'America/New_York', 'Mars/Olympus_Mons', '', null];
  const keys = (definition: { params: z.ZodType }) =>
    Object.keys((definition.params as z.ZodObject).shape).sort();

  it('market_judgement_delayed: the public reason, the next review time and the market’s zone', () => {
    const { params } = MARKET_JUDGEMENT_DELAYED_NOTIFICATION;
    const delayed = {
      marketTitle: title,
      reason: '기상청 발표가 늦어지고 있습니다.',
      nextReviewAt: at,
      judgementTimeZone: 'America/New_York',
    };
    expect(params.parse(delayed)).toEqual(delayed);
    expect(params.parse({ ...delayed, marketTitle: astral }).marketTitle).toBe(astral);
    for (const judgementTimeZone of zones) {
      expect(params.parse({ ...delayed, judgementTimeZone }).judgementTimeZone).toBe(
        judgementTimeZone,
      );
    }
    // The longest reason a record stores fits; braces and replacement patterns are plain text.
    const longest = '가'.repeat(APPROVAL_REASON_MAX_LENGTH);
    expect(params.parse({ ...delayed, reason: longest }).reason).toBe(longest);
    expect(params.parse({ ...delayed, reason: '{market} $& $1 {{x}}' }).reason).toBe(
      '{market} $& $1 {{x}}',
    );
    for (const nextReviewAt of notInstants) {
      expect(params.safeParse({ ...delayed, nextReviewAt }).success, String(nextReviewAt)).toBe(
        false,
      );
    }
    for (const bad of [
      { ...delayed, reason: '' },
      { ...delayed, reason: tooLong },
      { ...delayed, reason: null },
      { ...delayed, marketTitle: '' },
      { ...delayed, marketTitle: tooLong },
      { ...delayed, judgementTimeZone: tooLong },
      { ...delayed, judgementTimeZone: 9 },
      { marketTitle: title, reason: '사유', nextReviewAt: at },
    ]) {
      expect(params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('market_provisional_result and market_judgement_corrected: a result of three, a deadline and the zone', () => {
    expect(MARKET_RESULTS).toEqual(['YES', 'NO', 'VOID']);
    for (const { params } of [
      MARKET_PROVISIONAL_RESULT_NOTIFICATION,
      MARKET_JUDGEMENT_CORRECTED_NOTIFICATION,
    ]) {
      for (const result of MARKET_RESULTS) {
        const judged = {
          marketTitle: title,
          result,
          disputeDeadline: at,
          judgementTimeZone: 'Asia/Seoul',
        };
        expect(params.parse(judged)).toEqual(judged);
      }
      const judged = { marketTitle: astral, result: 'NO', disputeDeadline: at };
      for (const judgementTimeZone of zones) {
        expect(params.parse({ ...judged, judgementTimeZone })).toEqual({
          ...judged,
          judgementTimeZone,
        });
      }
      for (const disputeDeadline of notInstants) {
        expect(
          params.safeParse({ ...judged, judgementTimeZone: null, disputeDeadline }).success,
          String(disputeDeadline),
        ).toBe(false);
      }
      for (const bad of [
        { result: 'void' },
        { result: 'MAYBE' },
        { result: null },
        { judgementTimeZone: tooLong },
        { judgementTimeZone: undefined },
        { marketTitle: '' },
      ]) {
        expect(
          params.safeParse({ ...judged, judgementTimeZone: null, ...bad }).success,
          JSON.stringify(bad),
        ).toBe(false);
      }
      // No expected payout, no previous result: what is beside them is not kept (52-15, 188-1).
      expect(
        params.parse({
          ...judged,
          judgementTimeZone: null,
          previousResult: 'YES',
          expectedPayoutCoin: '100',
          disputeCount: 2,
        }),
      ).toEqual({ ...judged, judgementTimeZone: null });
    }
  });

  it('market_dispute_decided: 기각 or 수용 and the public decision reason (52-14, 188-3)', () => {
    const { params } = MARKET_DISPUTE_DECIDED_NOTIFICATION;
    expect(NOTIFIED_DISPUTE_DECISIONS).toEqual(['dismissed', 'accepted']);
    for (const decision of NOTIFIED_DISPUTE_DECISIONS) {
      const decided = { marketTitle: title, decision, reason: '1차 출처의 발표가 같습니다.' };
      expect(params.parse(decided)).toEqual(decided);
    }
    const decided = { marketTitle: astral, decision: 'accepted', reason: '정정합니다.' };
    const longest = '𝔸'.repeat(APPROVAL_REASON_MAX_LENGTH / 2);
    expect(params.parse({ ...decided, reason: longest }).reason).toBe(longest);
    for (const bad of [
      { decision: 'pending' },
      { decision: 'retracted' },
      { decision: 'closed_by_correction' },
      { decision: 'dismiss' },
      { decision: 'accept' },
      { reason: '' },
      { reason: tooLong },
      { reason: null },
      { marketTitle: '' },
    ]) {
      expect(params.safeParse({ ...decided, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    // Neither the decider nor the submitter is kept (52-15 '운영자와 신고자는 싣지 않는다').
    expect(params.parse({ ...decided, decidedBy: 'admin-1', submitter: 'member-1' })).toEqual(
      decided,
    );
  });

  it('market_dispute_closed_by_correction: the new deadline only, not the corrected result (188-1)', () => {
    const { params } = MARKET_DISPUTE_CLOSED_BY_CORRECTION_NOTIFICATION;
    const closed = { marketTitle: title, disputeDeadline: at, judgementTimeZone: null };
    expect(params.parse(closed)).toEqual(closed);
    expect(params.parse({ ...closed, result: 'NO' })).toEqual(closed);
    for (const judgementTimeZone of zones) {
      expect(params.parse({ ...closed, judgementTimeZone }).judgementTimeZone).toBe(
        judgementTimeZone,
      );
    }
    for (const disputeDeadline of notInstants) {
      expect(
        params.safeParse({ ...closed, disputeDeadline }).success,
        String(disputeDeadline),
      ).toBe(false);
    }
    expect(params.safeParse({ ...closed, marketTitle: tooLong }).success).toBe(false);
  });

  it('market_settled: the confirmed result and the recipient’s own payout, 0 included, or none', () => {
    const { params } = MARKET_SETTLED_NOTIFICATION;
    for (const result of MARKET_RESULTS) {
      // '0' a loser's, '200' a winner's, '100' a VOID holder's of both sides, null a watcher's.
      for (const payoutCoin of ['0', '200', '100', '9007199254740993', null]) {
        const settled = { marketTitle: title, result, payoutCoin };
        expect(params.parse(settled), `${result} ${String(payoutCoin)}`).toEqual(settled);
      }
    }
    expect(params.parse({ marketTitle: astral, result: 'VOID', payoutCoin: '0' }).marketTitle).toBe(
      astral,
    );
    for (const payoutCoin of [
      '-1',
      '01',
      '00',
      '1.5',
      ' 1',
      '1e3',
      '',
      '12345678901234567',
      100,
      0,
      undefined,
    ]) {
      expect(
        params.safeParse({ marketTitle: title, result: 'YES', payoutCoin }).success,
        String(payoutCoin),
      ).toBe(false);
    }
    for (const bad of [
      { marketTitle: title, result: 'void', payoutCoin: '0' },
      { marketTitle: title, result: null, payoutCoin: '0' },
      { marketTitle: '', result: 'YES', payoutCoin: '0' },
    ]) {
      expect(params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    // No P&L, no quantity, nobody else's payout: what is beside them is not kept (52-15, AC 11).
    expect(
      params.parse({
        marketTitle: title,
        result: 'NO',
        payoutCoin: '200',
        settlementPnlCoin: '80',
        qty: '2',
        otherPayoutCoin: '0',
      }),
    ).toEqual({ marketTitle: title, result: 'NO', payoutCoin: '200' });
  });

  it('keeps the delay and decision reasons within the param cap: both are approval reasons', () => {
    // A raised APPROVAL_REASON_MAX_LENGTH past the param cap would make the notice refused and
    // the record or the decision roll back (ADR-0157 결정 4의 7).
    expect(recordJudgementDelayBodySchema.shape.reason).toBe(approvalReasonSchema);
    expect(decideDisputeBodySchema.shape.reason).toBe(approvalReasonSchema);
    expect(APPROVAL_REASON_MAX_LENGTH).toBeLessThanOrEqual(NOTIFICATION_PARAM_STRING_MAX);
    const longest = approvalReasonSchema.parse('가'.repeat(APPROVAL_REASON_MAX_LENGTH));
    expect(
      MARKET_JUDGEMENT_DELAYED_NOTIFICATION.params.safeParse({
        marketTitle: title,
        reason: longest,
        nextReviewAt: at,
        judgementTimeZone: null,
      }).success,
    ).toBe(true);
    expect(
      MARKET_DISPUTE_DECIDED_NOTIFICATION.params.safeParse({
        marketTitle: title,
        decision: 'dismissed',
        reason: longest,
      }).success,
    ).toBe(true);
  });

  it('stores flat public values and the recipient’s own only: no quantity, P&L, expected payout or another member (AC 11)', () => {
    expect(keys(MARKET_JUDGEMENT_DELAYED_NOTIFICATION)).toEqual([
      'judgementTimeZone',
      'marketTitle',
      'nextReviewAt',
      'reason',
    ]);
    for (const definition of [
      MARKET_PROVISIONAL_RESULT_NOTIFICATION,
      MARKET_JUDGEMENT_CORRECTED_NOTIFICATION,
    ]) {
      expect(keys(definition), definition.type).toEqual([
        'disputeDeadline',
        'judgementTimeZone',
        'marketTitle',
        'result',
      ]);
    }
    expect(keys(MARKET_DISPUTE_DECIDED_NOTIFICATION)).toEqual([
      'decision',
      'marketTitle',
      'reason',
    ]);
    expect(keys(MARKET_DISPUTE_CLOSED_BY_CORRECTION_NOTIFICATION)).toEqual([
      'disputeDeadline',
      'judgementTimeZone',
      'marketTitle',
    ]);
    expect(keys(MARKET_SETTLED_NOTIFICATION)).toEqual(['marketTitle', 'payoutCoin', 'result']);
    for (const definition of [
      MARKET_JUDGEMENT_DELAYED_NOTIFICATION,
      MARKET_PROVISIONAL_RESULT_NOTIFICATION,
      MARKET_JUDGEMENT_CORRECTED_NOTIFICATION,
      MARKET_DISPUTE_DECIDED_NOTIFICATION,
      MARKET_DISPUTE_CLOSED_BY_CORRECTION_NOTIFICATION,
      MARKET_SETTLED_NOTIFICATION,
    ]) {
      for (const key of keys(definition)) {
        expect(NOTIFICATION_IDENTITY_PARAM.test(key), `${definition.type}.${key}`).toBe(false);
        expect(
          /qty|quantity|count|pnl|profit|loss|expected|previous|holder|watcher|operator|admin|submitter|decider/i.test(
            key,
          ),
          `${definition.type}.${key}`,
        ).toBe(false);
      }
    }
  });
});

describe('커뮤니티 알림 (#135, ADR-0161; 52-7·52-15~52-19, 135-1~135-7)', () => {
  const tooLong = 'x'.repeat(NOTIFICATION_PARAM_STRING_MAX + 1);
  const at = '2026-09-07T06:00:00.000Z';
  // Instants as `toISOString()` writes them: anything else is refused.
  const notInstants = ['2026-09-07 15:00', '2026-09-07', 'tomorrow', '', 1_788_000_000_000, null];
  const keys = (definition: { params: z.ZodType }) =>
    Object.keys((definition.params as z.ZodObject).shape).sort();
  const ID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const ID_B = '6fa459ea-ee8a-3ca4-894e-db77e160355e';
  const reply = (replyId: string, replyCreatedAt: string): ReplyParams => ({
    replyId,
    replyCreatedAt,
  });

  it('post_replied and comment_replied: the latest reply’s id and time, never its body or author (52-15, 135-4)', () => {
    for (const { params } of [POST_REPLIED_NOTIFICATION, COMMENT_REPLIED_NOTIFICATION]) {
      expect(params).toBe(replyParamsSchema);
      expect(params.parse(reply(ID_A, at))).toEqual(reply(ID_A, at));
      // An id as a request may spell it is lower-cased: the row's id, as the lists answer it.
      expect(params.parse(reply(ID_A.toUpperCase(), at))).toEqual(reply(ID_A, at));
      // What is beside them is not kept: the body, the author, the post (135-4, ADR-0157 결정 3).
      expect(
        params.parse({ ...reply(ID_A, at), body: '답글 본문', authorId: 'u1', nickname: '눈사람' }),
      ).toEqual(reply(ID_A, at));
      for (const replyId of ['not-a-uuid', '', 42, null]) {
        expect(params.safeParse({ replyId, replyCreatedAt: at }).success, String(replyId)).toBe(
          false,
        );
      }
      for (const replyCreatedAt of notInstants) {
        expect(
          params.safeParse({ replyId: ID_A, replyCreatedAt }).success,
          String(replyCreatedAt),
        ).toBe(false);
      }
      expect(params.safeParse({ replyId: ID_A }).success).toBe(false);
    }
  });

  it('merges to the later reply by (created_at, id), whatever the order (52-7, ADR-0158 결정 1)', () => {
    for (const { merge } of [POST_REPLIED_NOTIFICATION, COMMENT_REPLIED_NOTIFICATION]) {
      const earlier = reply(ID_B, '2026-09-07T06:00:00.000Z');
      const later = reply(ID_A, '2026-09-07T06:00:00.001Z');
      // The later instant wins though its id is the smaller.
      expect(merge!(earlier, later)).toEqual(later);
      expect(merge!(later, earlier)).toEqual(later);
      // Equal instants: the larger id, the post page's order.
      const tieLow = reply(ID_A, at);
      const tieHigh = reply(ID_B, at);
      expect(merge!(tieLow, tieHigh)).toEqual(tieHigh);
      expect(merge!(tieHigh, tieLow)).toEqual(tieHigh);
      // The same reply again stays itself.
      expect(merge!(tieLow, tieLow)).toEqual(tieLow);
      // Associative: three replies in every order end on the same one.
      const third = reply('00000000-0000-4000-8000-000000000000', '2026-09-08T00:00:00.000Z');
      const all = [earlier, later, third];
      const orders = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
      ];
      for (const order of orders) {
        const [a, b, c] = order.map((i) => all[i]!);
        expect(merge!(merge!(a!, b!), c!), order.join()).toEqual(third);
        expect(merge!(a!, merge!(b!, c!)), order.join()).toEqual(third);
      }
      // Compared as instants, not as strings: a held row written without milliseconds.
      expect(
        merge!(reply(ID_A, '2026-09-07T06:00:01Z'), reply(ID_B, '2026-09-07T06:00:00.999Z')),
      ).toEqual(reply(ID_A, '2026-09-07T06:00:01Z'));
    }
  });

  it('moderation_action_taken: the action’s kind and, for a restriction only, its own end (52-16, 135-2, 135-6)', () => {
    const { params } = MODERATION_ACTION_TAKEN_NOTIFICATION;
    expect(RESTRICTION_ACTION_TYPES).toEqual(['writing_restriction', 'account_restriction']);
    for (const action of MODERATION_ACTION_TYPES) {
      // null: 무기한 for a restriction, nothing for the five others.
      expect(params.parse({ action, endsAt: null }), action).toEqual({ action, endsAt: null });
    }
    for (const action of RESTRICTION_ACTION_TYPES) {
      expect(params.parse({ action, endsAt: at })).toEqual({ action, endsAt: at });
      for (const endsAt of notInstants.filter((value) => value !== null)) {
        expect(params.safeParse({ action, endsAt }).success, String(endsAt)).toBe(false);
      }
    }
    // Only a restriction has an end.
    for (const action of MODERATION_ACTION_TYPES.filter(
      (type) => !(RESTRICTION_ACTION_TYPES as readonly string[]).includes(type),
    )) {
      expect(params.safeParse({ action, endsAt: at }).success, action).toBe(false);
    }
    for (const bad of [
      { action: 'dismiss', endsAt: null },
      { action: 'report', endsAt: null },
      { action: 'cancel', endsAt: null },
      { action: 'hide' },
      { endsAt: null },
    ]) {
      expect(params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    // Nothing of the reason, the note, the subject, the operator or a report is kept (135-2).
    expect(
      params.parse({
        action: 'hide',
        endsAt: null,
        reason: 'spam',
        note: '설명',
        postId: ID_A,
        createdBy: 'admin-1',
        reportCount: 3,
      }),
    ).toEqual({ action: 'hide', endsAt: null });
  });

  it('moderation_action_cancelled: the cancelled action’s kind only (52-16)', () => {
    const { params } = MODERATION_ACTION_CANCELLED_NOTIFICATION;
    for (const action of MODERATION_ACTION_TYPES) {
      expect(params.parse({ action })).toEqual({ action });
    }
    expect(
      params.parse({ action: 'warning', cancelReason: '이의를 받아들임', cancelledBy: 'admin-1' }),
    ).toEqual({ action: 'warning' });
    for (const bad of [{}, { action: 'dismiss' }, { action: 'report' }, { action: null }]) {
      expect(params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('moderation_restriction_end_changed: a restriction, 감경 or 조기 해제, and the new end (52-16, 135-5 (h))', () => {
    const { params } = MODERATION_RESTRICTION_END_CHANGED_NOTIFICATION;
    expect(RESTRICTION_END_CHANGE_KINDS).toEqual(['shorten', 'lift']);
    for (const action of RESTRICTION_ACTION_TYPES) {
      for (const change of RESTRICTION_END_CHANGE_KINDS) {
        const changed = { action, change, endsAt: at };
        expect(params.parse(changed)).toEqual(changed);
      }
    }
    for (const bad of [
      { action: 'warning', change: 'shorten', endsAt: at },
      { action: 'hide', change: 'lift', endsAt: at },
      { action: 'writing_restriction', change: 'cancel', endsAt: at },
      { action: 'writing_restriction', change: 'extend', endsAt: at },
      { action: 'writing_restriction', change: 'lift', endsAt: null },
      { action: 'writing_restriction', change: 'lift' },
      ...notInstants.map((endsAt) => ({
        action: 'account_restriction',
        change: 'shorten',
        endsAt,
      })),
    ]) {
      expect(params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    // Not the end before, the reason, the operator or the approval (ADR-0082, 135-2).
    expect(
      params.parse({
        action: 'writing_restriction',
        change: 'shorten',
        endsAt: at,
        previousEndsAt: null,
        reason: '감경 사유',
        approvalId: ID_A,
      }),
    ).toEqual({ action: 'writing_restriction', change: 'shorten', endsAt: at });
  });

  it('proposal_decided: 채택 or 반려 and the proposer’s own question, never a reason (52-19)', () => {
    const { params } = PROPOSAL_DECIDED_NOTIFICATION;
    expect(NOTIFIED_PROPOSAL_DECISIONS).toEqual(['adopted', 'rejected']);
    // Both final: a proposal is decided once, so `proposal:<id>` keys it soundly.
    for (const decision of NOTIFIED_PROPOSAL_DECISIONS) {
      expect(PROPOSAL_TRANSITIONS[decision]).toEqual([]);
      const decided = { decision, question: '첫눈이 서울에 올까?' };
      expect(params.parse(decided)).toEqual(decided);
    }
    const question = (text: string) => params.safeParse({ decision: 'adopted', question: text });
    // The generic cap in UTF-16 units; no minimum: a raw value never rolls a decision back.
    expect(question('가'.repeat(NOTIFICATION_PARAM_STRING_MAX)).success).toBe(true);
    expect(question('𝔸'.repeat(NOTIFICATION_PARAM_STRING_MAX / 2)).success).toBe(true);
    expect(question(tooLong).success).toBe(false);
    expect(question('').success).toBe(true);
    expect(question('{question} $& $1 $$ {{x}}').success).toBe(true);
    for (const bad of [
      { decision: 'submitted', question: '질문' },
      { decision: 'reviewing', question: '질문' },
      { decision: 'retracted', question: '질문' },
      { decision: '채택', question: '질문' },
      { decision: 'adopted', question: null },
      { decision: 'adopted' },
    ]) {
      expect(params.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    // Not the rejection's reason or explanation, the memo, the market or the deciding operator.
    expect(
      params.parse({
        decision: 'rejected',
        question: '질문',
        rejectionReason: 'duplicate',
        rejectionExplanation: '설명',
        adoptionMemo: '메모',
        marketId: ID_A,
        decidedBy: 'admin-1',
      }),
    ).toEqual({ decision: 'rejected', question: '질문' });
  });

  it('keeps the proposal question cap within the param cap: a raised one would roll decisions back', () => {
    // The question is the proposer's (varchar(PROPOSAL_QUESTION_MAX) in code points ≤ 2 UTF-16
    // units each): raising the cap past half the param cap would make a 채택 or 반려 refused.
    expect(PROPOSAL_QUESTION_MAX).toBeLessThanOrEqual(NOTIFICATION_PARAM_STRING_MAX);
    expect(2 * PROPOSAL_QUESTION_MAX).toBeLessThanOrEqual(NOTIFICATION_PARAM_STRING_MAX);
    expect(
      PROPOSAL_DECIDED_NOTIFICATION.params.safeParse({
        decision: 'adopted',
        question: '𝔸'.repeat(PROPOSAL_QUESTION_MAX),
      }).success,
    ).toBe(true);
  });

  it('stores flat values only, none naming an author, an operator, a reporter, a reason or a body (#135 AC 4)', () => {
    expect(keys(POST_REPLIED_NOTIFICATION)).toEqual(['replyCreatedAt', 'replyId']);
    expect(keys(COMMENT_REPLIED_NOTIFICATION)).toEqual(['replyCreatedAt', 'replyId']);
    expect(keys(MODERATION_ACTION_TAKEN_NOTIFICATION)).toEqual(['action', 'endsAt']);
    expect(keys(MODERATION_ACTION_CANCELLED_NOTIFICATION)).toEqual(['action']);
    expect(keys(MODERATION_RESTRICTION_END_CHANGED_NOTIFICATION)).toEqual([
      'action',
      'change',
      'endsAt',
    ]);
    expect(keys(PROPOSAL_DECIDED_NOTIFICATION)).toEqual(['decision', 'question']);
    for (const definition of [
      POST_REPLIED_NOTIFICATION,
      COMMENT_REPLIED_NOTIFICATION,
      MODERATION_ACTION_TAKEN_NOTIFICATION,
      MODERATION_ACTION_CANCELLED_NOTIFICATION,
      MODERATION_RESTRICTION_END_CHANGED_NOTIFICATION,
      PROPOSAL_DECIDED_NOTIFICATION,
    ]) {
      for (const key of keys(definition)) {
        expect(NOTIFICATION_IDENTITY_PARAM.test(key), `${definition.type}.${key}`).toBe(false);
        expect(
          /operator|admin|reporter|report|reason|note|memo|explanation|author|body|text|by$|count|subject|post|comment|holding|order|balance/i.test(
            key,
          ),
          `${definition.type}.${key}`,
        ).toBe(false);
      }
    }
  });
});
