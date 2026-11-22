import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { APPROVAL_REASON_MAX_LENGTH, approvalReasonSchema } from './approvals.js';
import { MARKET_PAUSE_REASONS } from './market-pause.js';
import { MARKET_RESULTS } from './enums.js';
import { NOTIFICATION_IDENTITY_PARAM } from './guards/notifications.js';
import { decideDisputeBodySchema } from './market-dispute.js';
import { recordJudgementDelayBodySchema } from './market-judgement-delay.js';
import {
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
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DEFINITIONS,
  NOTIFICATION_EVENT_KEY_PATTERN,
  NOTIFICATION_PARAM_STRING_MAX,
  NOTIFICATION_TARGET_KINDS,
  NOTIFICATION_TYPE_PATTERN,
  NOTIFICATION_UNREAD_COUNT_CAP,
  NOTIFIED_CANCEL_REASONS,
  NOTIFIED_DISPUTE_DECISIONS,
  ORDER_EXPIRY_CAUSES,
  ORDER_FILLED_NOTIFICATION,
  ORDERS_CANCELLED_NOTIFICATION,
  ORDERS_EXPIRED_NOTIFICATION,
  defineNotification,
  notificationCategorySchema,
  notificationParamsSchema,
  notificationReadResultSchema,
  notificationSchema,
  notificationTargetSchema,
  notificationUnreadCountSchema,
  type Notification,
  type OrderFilledParams,
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
      { kind: 'post', id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
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

  it('lists every kind of the union, in its order', () => {
    expect(NOTIFICATION_TARGET_KINDS).toEqual(['market', 'order', 'order_history']);
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
      { target: { kind: 'post', id: '1' } },
      { params: { nested: { a: 1 } } },
    ]) {
      expect(
        notificationSchema.safeParse({ ...notification, ...bad }).success,
        JSON.stringify(bad),
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

describe('NOTIFICATION_DEFINITIONS (#53, 52-20; #134; #54; #188)', () => {
  it('holds the 거래 three of #134, then the 시장 five of #54, then the 판정·정산 six of #188', () => {
    // Pinned. Each producer edits this pin as it appends its own: #135 (커뮤니티, 52-19's 제안),
    // #144 (정정·보상). 시작 Coin, a re-grant's result, a review's rejection and a market's
    // opening are no notification (52-20).
    const market = (type: string) => ({
      type,
      category: 'market',
      targets: ['market'],
      merges: false,
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
    ]);
    expect(NOTIFICATION_DEFINITIONS).toHaveLength(14);
    for (const definition of NOTIFICATION_DEFINITIONS) {
      expect(NOTIFICATION_TYPE_PATTERN.test(definition.type), definition.type).toBe(true);
    }
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
