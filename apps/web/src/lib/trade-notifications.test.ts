import {
  NOTIFICATION_TYPE_REGISTRY,
  type OrderFilledParams,
  type OrdersCancelledParams,
  type OrdersExpiredParams,
  findExcludedText,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_RENDERERS } from '@/components/notifications/notification-renderers';
import { copy } from '@/copy';
import {
  fillNotificationText,
  notificationTextKeys,
  orderFilledTitle,
  ordersCancelledTitle,
  ordersExpiredTitle,
} from './trade-notifications';

const TITLE = '첫눈이 올까';

/** A resting NO buy of 3 at 40 whose first fill of one this notice holds. */
const filled = (fields: Partial<OrderFilledParams> = {}): OrderFilledParams => ({
  marketTitle: TITLE,
  outcome: 'NO',
  side: 'buy',
  qty: '1',
  amountCoin: '40',
  fullyFilled: false,
  orderQty: '3',
  orderFilledQty: '1',
  ...fields,
});

/** How many times `word` appears in `text`. */
const occurrences = (text: string, word: string) => text.split(word).length - 1;

/**
 * 거래 알림's words (#134, ADR-0158; owner answers 134-1, 134-3 and 134-4 — the copy approved as
 * shown): each type's title from the params its definition stores, filled into copy.ts' templates.
 */
describe('order_filled (52-6, 134-1, 134-3)', () => {
  it('says one fill as its quantity and price, the state 부분 체결 or 전량 체결', () => {
    expect(orderFilledTitle(filled(), 1)).toBe(
      '첫눈이 올까 NO 매수 주문 부분 체결 · 1계약 · 평균 40.00 Coin',
    );
    // A resting YES sell of 2 at 55 that one fill completed.
    expect(
      orderFilledTitle(
        filled({
          outcome: 'YES',
          side: 'sell',
          qty: '2',
          amountCoin: '110',
          fullyFilled: true,
          orderQty: '2',
          orderFilledQty: '2',
        }),
        1,
      ),
    ).toBe('첫눈이 올까 YES 매도 주문 전량 체결 · 2계약 · 평균 55.00 Coin');
  });

  it('says merged fills as 체결 N회 · 누적 — 횟수 is the row’s eventCount, not a param', () => {
    // 134-4's example: three fills of a 3-contract order, every one in this notice.
    expect(
      orderFilledTitle(
        filled({ qty: '3', amountCoin: '120', fullyFilled: true, orderFilledQty: '3' }),
        3,
      ),
    ).toBe('첫눈이 올까 NO 매수 주문 전량 체결 · 체결 3회 · 누적 3계약 · 평균 40.00 Coin');
    // Two fills of two contracts in one event count — eventCount alone decides 체결 N회.
    expect(orderFilledTitle(filled({ qty: '2', amountCoin: '80', orderFilledQty: '2' }), 2)).toBe(
      '첫눈이 올까 NO 매수 주문 부분 체결 · 체결 2회 · 누적 2계약 · 평균 40.00 Coin',
    );
  });

  it('says 이번 and the order’s whole when the notice does not hold every fill of the order (134-3)', () => {
    // After the member read the earlier notice, the completing fill is a new one (52-6).
    expect(orderFilledTitle(filled({ fullyFilled: true, orderFilledQty: '3' }), 1)).toBe(
      '첫눈이 올까 NO 매수 주문 전량 체결 · 이번 1계약 · 평균 40.00 Coin (주문 3계약 중 3계약 체결)',
    );
    // Merged after a read: two fills of a 5-contract order that had two filled before.
    expect(
      orderFilledTitle(
        filled({ qty: '2', amountCoin: '80', orderQty: '5', orderFilledQty: '4' }),
        2,
      ),
    ).toBe(
      '첫눈이 올까 NO 매수 주문 부분 체결 · 체결 2회 · 이번 2계약 · 평균 40.00 Coin (주문 5계약 중 4계약 체결)',
    );
    // A GTC order partly filled at intake: its first resting fill's notice holds less than the
    // order's filled quantity (52-2 "그 뒤 체결부터"), so the whole is shown there too.
    expect(orderFilledTitle(filled({ orderFilledQty: '2' }), 1)).toBe(
      '첫눈이 올까 NO 매수 주문 부분 체결 · 이번 1계약 · 평균 40.00 Coin (주문 3계약 중 2계약 체결)',
    );
    // The usual case — the notice holds every fill so far — keeps the approved sentence (134-4).
    for (const [params, count] of [
      [filled(), 1],
      [filled({ qty: '3', amountCoin: '120', fullyFilled: true, orderFilledQty: '3' }), 3],
    ] as const) {
      expect(orderFilledTitle(params, count)).not.toContain('이번');
      expect(orderFilledTitle(params, count)).not.toContain('주문 3계약 중');
    }
  });

  it('averages the amount over the quantity, half-up to 0.01 Coin (MY’s formatter)', () => {
    // A formatter case only: real resting fills always average the order's own price (N01 §4).
    expect(orderFilledTitle(filled({ qty: '3', amountCoin: '121', orderFilledQty: '3' }), 1)).toBe(
      '첫눈이 올까 NO 매수 주문 부분 체결 · 3계약 · 평균 40.33 Coin',
    );
    expect(
      orderFilledTitle(filled({ qty: '3', amountCoin: '125', orderFilledQty: '3' }), 1),
    ).toContain('평균 41.67 Coin');
  });

  it('groups large numbers and prints 계약 once after each', () => {
    const title = orderFilledTitle(
      filled({ qty: '1234', amountCoin: '49360', orderQty: '12345', orderFilledQty: '5000' }),
      1234,
    );
    expect(title).toBe(
      '첫눈이 올까 NO 매수 주문 부분 체결 · 체결 1,234회 · 이번 1,234계약 · 평균 40.00 Coin (주문 12,345계약 중 5,000계약 체결)',
    );
    expect(title).not.toContain('계약계약');
    expect(occurrences(title, '계약')).toBe(
      occurrences(copy.notificationOrderFilledMergedSince, '계약'),
    );
    for (const params of [filled(), filled({ qty: '1000000', amountCoin: '40000000' })]) {
      const one = orderFilledTitle({ ...params, orderFilledQty: params.qty }, 1);
      expect(one).not.toContain('계약계약');
      expect(occurrences(one, '계약')).toBe(1);
    }
  });

  it('writes the market title as stored, braces and dollar signs included', () => {
    expect(orderFilledTitle(filled({ marketTitle: '{qty} $& 𝕏' }), 1)).toBe(
      '{qty} $& 𝕏 NO 매수 주문 부분 체결 · 1계약 · 평균 40.00 Coin',
    );
  });
});

describe('orders_cancelled (52-3, 52-4)', () => {
  const cancelled = (fields: Partial<OrdersCancelledParams>): OrdersCancelledParams => ({
    reason: 'paused',
    orderCount: 2,
    marketCount: 1,
    marketTitle: TITLE,
    ...fields,
  });

  it('names the market of a 일시 중단 and the reason and markets of an account event', () => {
    expect(ordersCancelledTitle(cancelled({}))).toBe(
      '첫눈이 올까 일시 중단으로 대기 주문 2건 취소',
    );
    expect(
      ordersCancelledTitle(
        cancelled({ reason: 'restricted', orderCount: 3, marketCount: 2, marketTitle: null }),
      ),
    ).toBe('계정 제한으로 대기 주문 3건 취소(시장 2곳)');
    expect(
      ordersCancelledTitle(
        cancelled({ reason: 'admin_role', orderCount: 1, marketCount: 1, marketTitle: null }),
      ),
    ).toBe('관리자 권한으로 대기 주문 1건 취소(시장 1곳)');
    expect(
      ordersCancelledTitle(
        cancelled({ reason: 'admin_role', orderCount: 1200, marketCount: 1100, marketTitle: null }),
      ),
    ).toBe('관리자 권한으로 대기 주문 1,200건 취소(시장 1,100곳)');
  });

  it('refuses a paused notice with no market, which its definition never parses', () => {
    expect(() => ordersCancelledTitle(cancelled({ marketTitle: null }))).toThrow(
      /names its market/,
    );
  });
});

describe('orders_expired (52-4, 52-5)', () => {
  const expired = (fields: Partial<OrdersExpiredParams>): OrdersExpiredParams => ({
    marketTitle: TITLE,
    cause: 'closed',
    orderCount: 1,
    ...fields,
  });

  it('says 거래 마감 or 시장 취소 with how many', () => {
    expect(ordersExpiredTitle(expired({}))).toBe('첫눈이 올까 거래 마감으로 대기 주문 1건 만료');
    expect(ordersExpiredTitle(expired({ cause: 'cancelled', orderCount: 2 }))).toBe(
      '첫눈이 올까 시장 취소로 대기 주문 2건 만료',
    );
  });
});

describe('the templates (ADR-0158 구현의 선택: single-brace placeholders)', () => {
  it('fills each placeholder and refuses a missing or an unknown key', () => {
    expect(fillNotificationText('{a}와 {b}, 다시 {a}', { a: 'A', b: 'B' })).toBe('A와 B, 다시 A');
    expect(fillNotificationText('없음', {})).toBe('없음');
    expect(() => fillNotificationText('{a} {b}', { a: 'A' })).toThrow(/no value for \{b\}/);
    expect(() => fillNotificationText('{a}', { a: 'A', c: 'C' })).toThrow(/has no \{c\}/);
    // Inherited keys are no values.
    expect(() => fillNotificationText('{toString}', {})).toThrow(/no value for \{toString\}/);
    // A value is inserted as it is, never read for placeholders.
    expect(fillNotificationText('{a}', { a: '{b}' })).toBe('{b}');
  });

  it('has each template’s placeholders equal to the keys its title passes', () => {
    const filledKeys = ['market', 'contract', 'state', 'qty', 'price'];
    const sinceKeys = [...filledKeys, 'orderQty', 'orderFilledQty'];
    const merged = (keys: string[]) => [...keys, 'count'];
    const expected: readonly (readonly [string, string[]])[] = [
      [copy.notificationOrderFilled, filledKeys],
      [copy.notificationOrderFilledMerged, merged(filledKeys)],
      [copy.notificationOrderFilledSince, sinceKeys],
      [copy.notificationOrderFilledMergedSince, merged(sinceKeys)],
      [copy.notificationOrdersCancelledMarket, ['market', 'count']],
      [copy.notificationOrdersCancelledAccount, ['reason', 'count', 'markets']],
      [copy.notificationOrdersExpiredClosed, ['market', 'count']],
      [copy.notificationOrdersExpiredCancelled, ['market', 'count']],
    ];
    for (const [template, keys] of expected) {
      expect(notificationTextKeys(template).sort(), template).toEqual([...keys].sort());
      // Never the legal pages' {{key}} (legal.test.ts holds those to business facts).
      expect(template, template).not.toContain('{{');
    }
    // Every variant above filled its template through fillNotificationText without a throw, so
    // each title passes exactly these keys; the four order_filled variants are each reached:
    const variants = new Set(
      [
        [filled(), 1],
        [filled({ qty: '2', amountCoin: '80', orderFilledQty: '2' }), 2],
        [filled({ orderFilledQty: '2' }), 1],
        [filled({ qty: '2', amountCoin: '80', orderFilledQty: '3' }), 2],
      ].map(([params, count]) =>
        orderFilledTitle(params as OrderFilledParams, count as number).replace(/[0-9,.]+/g, '#'),
      ),
    );
    expect(variants.size).toBe(4);
  });

  it('are the renderers’ copy and the guard registry’s text, word for word (134-4)', () => {
    expect(NOTIFICATION_RENDERERS.order_filled.copy).toEqual([
      copy.notificationOrderFilled,
      copy.notificationOrderFilledMerged,
      copy.notificationOrderFilledSince,
      copy.notificationOrderFilledMergedSince,
      '부분 체결',
      '전량 체결',
      'YES',
      'NO',
      '매수',
      '매도',
    ]);
    expect(NOTIFICATION_RENDERERS.orders_cancelled.copy).toEqual([
      copy.notificationOrdersCancelledMarket,
      copy.notificationOrdersCancelledAccount,
      '관리자 권한',
      '계정 제한',
    ]);
    for (const type of ['order_filled', 'orders_cancelled', 'orders_expired'] as const) {
      expect(NOTIFICATION_RENDERERS[type].copy, type).toEqual(
        NOTIFICATION_TYPE_REGISTRY[type].text,
      );
      for (const text of NOTIFICATION_RENDERERS[type].copy) {
        expect(findExcludedText(text), text).toEqual([]);
      }
    }
  });
});
