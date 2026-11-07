import { describe, expect, it } from 'vitest';
import {
  ORDER_BUDGET_MAX_COIN,
  ORDER_QTY_MAX,
  PRICE_PROTECTION_TICKS_MAX,
  PRICE_PROTECTION_TICKS_MIN,
} from './constants.js';
import { orderIntakeLock, type OrderLockFacts } from './contract.js';
import { MARKET_STATUSES, type MarketStatus } from './enums.js';
import { changePriceProtectionBodySchema } from './market-review.js';
import {
  type BookOrder,
  type IncomingOrder,
  type OrderOwner,
  matchLine,
  matchOrder,
} from './matching.js';
import {
  intakeRemainderRelease,
  marketRejectReason,
  orderEndState,
  ownFillPrice,
  placeOrderBodySchema,
  protectedLimit,
  quoteOrderBodySchema,
  requestTermsEqual,
  restingStateAfterFill,
  type OrderRequestTerms,
} from './orders.js';

// 주문 접수의 순수 규칙 (#119, ADR-0112; ADR-0107 결정 1 #177 2·3·7·8·9항, ADR-0111 결정 6).

const A: OrderOwner = { id: 'A', human: true };
const B: OrderOwner = { id: 'B', human: true };
const M: OrderOwner = { id: 'M', human: false };

const resting = (
  id: string,
  owner: OrderOwner,
  outcome: 'YES' | 'NO',
  side: 'buy' | 'sell',
  priceCoin: number,
  remainingQty: number,
  arrival: number,
): BookOrder => ({ id, owner, outcome, side, priceCoin, remainingQty, arrival });

const qtyOrder = (
  owner: OrderOwner,
  side: 'buy' | 'sell',
  limitPriceCoin: number,
  qty: number,
  timeInForce: 'ioc' | 'gtc',
): IncomingOrder => ({
  owner,
  outcome: 'YES',
  side,
  limitPriceCoin,
  qty,
  timeInForce,
  budgetCoin: null,
});

const budgetOrder = (
  owner: OrderOwner,
  limitPriceCoin: number,
  budgetCoin: bigint,
): IncomingOrder => ({
  owner,
  outcome: 'YES',
  side: 'buy',
  limitPriceCoin,
  qty: null,
  timeInForce: 'ioc',
  budgetCoin,
});

/** The intake's lock facts of an incoming order (its limit as protected, nothing filled). */
const factsOf = (incoming: IncomingOrder): OrderLockFacts => ({
  side: incoming.side,
  outcome: incoming.outcome,
  limitPriceCoin: incoming.budgetCoin === null ? incoming.limitPriceCoin : null,
  qty: incoming.qty,
  filledQty: 0,
  budgetCoin: incoming.budgetCoin,
  live: false,
});

describe('placeOrderBodySchema (#177 1·2·3·9항)', () => {
  const body = {
    outcome: 'YES',
    side: 'buy',
    timeInForce: 'ioc',
    limitPriceCoin: 60,
    qty: 10,
    expectedAccountId: 'account-a',
  };
  const accepts = (value: Record<string, unknown>) => placeOrderBodySchema.safeParse(value).success;
  const issuePaths = (value: Record<string, unknown>) =>
    placeOrderBodySchema.safeParse(value).error?.issues.map((issue) => issue.path) ?? [];

  it('takes a quantity order, IOC or GTC, buy or sell, of either outcome', () => {
    for (const outcome of ['YES', 'NO']) {
      for (const side of ['buy', 'sell']) {
        for (const timeInForce of ['ioc', 'gtc']) {
          expect(accepts({ ...body, outcome, side, timeInForce })).toBe(true);
        }
      }
    }
    expect(placeOrderBodySchema.parse(body)).toEqual(body);
  });

  it('takes a quantity of 1..ORDER_QTY_MAX whole contracts only', () => {
    expect(ORDER_QTY_MAX).toBe(1_000_000);
    expect(accepts({ ...body, qty: 1 })).toBe(true);
    expect(accepts({ ...body, qty: ORDER_QTY_MAX })).toBe(true);
    for (const qty of [0, -1, ORDER_QTY_MAX + 1, 1.5, '10', null]) {
      expect(accepts({ ...body, qty }), String(qty)).toBe(false);
    }
  });

  it('requires a limit on the tick, 1..99, on every order: no market order', () => {
    for (const limitPriceCoin of [1, 50, 99])
      expect(accepts({ ...body, limitPriceCoin })).toBe(true);
    for (const limitPriceCoin of [0, 100, 50.5, '60', null]) {
      expect(accepts({ ...body, limitPriceCoin }), String(limitPriceCoin)).toBe(false);
    }
    const { limitPriceCoin: _limit, ...noLimit } = body;
    expect(accepts(noLimit)).toBe(false);
    const { limitPriceCoin: _also, qty: _qty, ...budgetNoLimit } = body;
    expect(accepts({ ...budgetNoLimit, budgetCoin: '100' })).toBe(false);
  });

  it('takes a Coin budget for an IOC buy only, an integer 1..ORDER_BUDGET_MAX_COIN, with a limit', () => {
    const { qty: _qty, ...noQty } = body;
    expect(placeOrderBodySchema.parse({ ...noQty, budgetCoin: '100' })).toMatchObject({
      budgetCoin: 100n,
      limitPriceCoin: 60,
    });
    expect(ORDER_BUDGET_MAX_COIN).toBe(1_000_000n);
    expect(accepts({ ...noQty, budgetCoin: ORDER_BUDGET_MAX_COIN.toString() })).toBe(true);
    for (const budgetCoin of ['0', '-1', '1000001', '1.5', 100, '']) {
      expect(accepts({ ...noQty, budgetCoin }), String(budgetCoin)).toBe(false);
    }
    expect(issuePaths({ ...noQty, budgetCoin: '100', side: 'sell' })).toEqual([['budgetCoin']]);
    expect(issuePaths({ ...noQty, budgetCoin: '100', timeInForce: 'gtc' })).toEqual([
      ['budgetCoin'],
    ]);
  });

  it('takes exactly one of a quantity and a budget', () => {
    const { qty: _qty, ...neither } = body;
    expect(issuePaths(neither)).toEqual([['qty']]);
    expect(issuePaths({ ...body, budgetCoin: '100' })).toEqual([['budgetCoin']]);
  });

  it('refuses unknown fields: no amend, no partial cancel, no request id in the body', () => {
    for (const extra of ['orderId', 'cancelQty', 'requestId', 'marketId', 'type']) {
      expect(accepts({ ...body, [extra]: 'x' }), extra).toBe(false);
    }
    const { expectedAccountId: _account, ...anonymous } = body;
    expect(accepts(anonymous)).toBe(false);
  });
});

describe('quoteOrderBodySchema (#179; #177 2·3·9항)', () => {
  const body = { outcome: 'YES', side: 'sell', timeInForce: 'ioc', qty: 10 };
  const accepts = (value: Record<string, unknown>) => quoteOrderBodySchema.safeParse(value).success;
  const issuePaths = (value: Record<string, unknown>) =>
    quoteOrderBodySchema.safeParse(value).error?.issues.map((issue) => issue.path) ?? [];

  it('takes the intake’s terms, an immediate order’s limit optional (즉시 매도는 수량만)', () => {
    expect(quoteOrderBodySchema.parse(body)).toEqual(body);
    for (const outcome of ['YES', 'NO']) {
      for (const side of ['buy', 'sell']) {
        expect(accepts({ ...body, outcome, side })).toBe(true);
        expect(accepts({ ...body, outcome, side, limitPriceCoin: 40 })).toBe(true);
        expect(accepts({ ...body, outcome, side, timeInForce: 'gtc', limitPriceCoin: 40 })).toBe(
          true,
        );
      }
    }
    for (const limitPriceCoin of [0, 100, 50.5, '60', null]) {
      expect(accepts({ ...body, limitPriceCoin }), String(limitPriceCoin)).toBe(false);
    }
    for (const qty of [0, ORDER_QTY_MAX + 1, 1.5, '10']) {
      expect(accepts({ ...body, qty }), String(qty)).toBe(false);
    }
  });

  it('requires a GTC order’s limit: it rests there', () => {
    expect(issuePaths({ ...body, timeInForce: 'gtc' })).toEqual([['limitPriceCoin']]);
  });

  it('takes a budget for an IOC buy only, and exactly one of a quantity and a budget', () => {
    const { qty: _qty, ...noQty } = body;
    expect(quoteOrderBodySchema.parse({ ...noQty, side: 'buy', budgetCoin: '100' })).toEqual({
      ...noQty,
      side: 'buy',
      budgetCoin: 100n,
    });
    expect(issuePaths({ ...noQty, budgetCoin: '100' })).toEqual([['budgetCoin']]);
    expect(
      issuePaths({
        ...noQty,
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 50,
        budgetCoin: '9',
      }),
    ).toEqual([['budgetCoin']]);
    expect(issuePaths(noQty)).toEqual([['qty']]);
    expect(issuePaths({ ...body, side: 'buy', budgetCoin: '100' })).toEqual([['budgetCoin']]);
    for (const budgetCoin of ['0', '1000001', '1.5', 100]) {
      expect(accepts({ ...noQty, side: 'buy', budgetCoin }), String(budgetCoin)).toBe(false);
    }
  });

  it('refuses unknown fields: no account, no request id, no market', () => {
    for (const extra of ['expectedAccountId', 'requestId', 'marketId', 'orderId', 'type']) {
      expect(accepts({ ...body, [extra]: 'x' }), extra).toBe(false);
    }
  });
});

describe('protectedLimit (#177 2항)', () => {
  const ioc = { timeInForce: 'ioc' as const, widthTicks: 5 };

  it('narrows an immediate buy to min(limit, best ask + width, 99), never widening it', () => {
    // An API's 99 is not a market order: ask 40, width 5 → 45.
    expect(
      protectedLimit({ ...ioc, side: 'buy', limitPriceCoin: 99, referencePriceCoin: 40 }),
    ).toBe(45);
    expect(
      protectedLimit({ ...ioc, side: 'buy', limitPriceCoin: 42, referencePriceCoin: 40 }),
    ).toBe(42);
    expect(
      protectedLimit({ ...ioc, side: 'buy', limitPriceCoin: 99, referencePriceCoin: 97 }),
    ).toBe(99);
    // A limit below the reference stays (nothing fills: 가격 한도).
    expect(
      protectedLimit({ ...ioc, side: 'buy', limitPriceCoin: 30, referencePriceCoin: 40 }),
    ).toBe(30);
  });

  it('narrows an immediate sell to max(limit, best bid − width, 1)', () => {
    expect(
      protectedLimit({ ...ioc, side: 'sell', limitPriceCoin: 1, referencePriceCoin: 60 }),
    ).toBe(55);
    expect(
      protectedLimit({ ...ioc, side: 'sell', limitPriceCoin: 58, referencePriceCoin: 60 }),
    ).toBe(58);
    expect(protectedLimit({ ...ioc, side: 'sell', limitPriceCoin: 1, referencePriceCoin: 3 })).toBe(
      1,
    );
  });

  it('holds over the whole grid: only narrows, within one width of the reference', () => {
    for (const width of [PRICE_PROTECTION_TICKS_MIN, 5, PRICE_PROTECTION_TICKS_MAX]) {
      for (let limit = 1; limit <= 99; limit += 7) {
        for (let reference = 1; reference <= 99; reference += 11) {
          const buy = protectedLimit({
            side: 'buy',
            timeInForce: 'ioc',
            limitPriceCoin: limit,
            referencePriceCoin: reference,
            widthTicks: width,
          });
          expect(buy).toBeLessThanOrEqual(limit);
          expect(buy).toBeLessThanOrEqual(Math.max(reference + width, 1));
          expect(buy).toBeGreaterThanOrEqual(1);
          const sell = protectedLimit({
            side: 'sell',
            timeInForce: 'ioc',
            limitPriceCoin: limit,
            referencePriceCoin: reference,
            widthTicks: width,
          });
          expect(sell).toBeGreaterThanOrEqual(limit);
          expect(sell).toBeGreaterThanOrEqual(reference - width);
          expect(sell).toBeLessThanOrEqual(99);
        }
      }
    }
  });

  it('leaves a GTC limit and an immediate order with no opposite quote as sent', () => {
    expect(
      protectedLimit({
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 99,
        referencePriceCoin: 40,
        widthTicks: null,
      }),
    ).toBe(99);
    expect(
      protectedLimit({ ...ioc, side: 'buy', limitPriceCoin: 99, referencePriceCoin: null }),
    ).toBe(99);
  });

  it('refuses malformed prices and an immediate order with no width (a caller bug)', () => {
    const base = { side: 'buy' as const, timeInForce: 'ioc' as const, referencePriceCoin: 40 };
    expect(() => protectedLimit({ ...base, limitPriceCoin: 0, widthTicks: 5 })).toThrow(RangeError);
    expect(() =>
      protectedLimit({ ...base, limitPriceCoin: 50, referencePriceCoin: 100, widthTicks: 5 }),
    ).toThrow(RangeError);
    for (const widthTicks of [null, 0, 99, 1.5]) {
      expect(() => protectedLimit({ ...base, limitPriceCoin: 50, widthTicks })).toThrow(RangeError);
    }
  });
});

describe('marketRejectReason (ADR-0107 결정 5 #119 OPEN이 아닌 시장)', () => {
  it('names 개장 전, 일시 중단 and 마감, and lets an OPEN market take orders', () => {
    const reasons = Object.fromEntries(
      MARKET_STATUSES.filter((status) => status !== 'draft' && status !== 'review').map(
        (status) => [status, marketRejectReason(status)],
      ),
    );
    expect(reasons).toEqual({
      scheduled: 'not_open_yet',
      open: null,
      paused: 'paused',
      closed: 'closed',
      provisional: 'closed',
      resolved: 'closed',
      settling: 'closed',
      settled: 'closed',
      cancelled: 'closed',
    });
  });

  it('refuses to name one for a market that is not public (the caller answers NOT_FOUND)', () => {
    for (const status of ['draft', 'review'] satisfies MarketStatus[]) {
      expect(() => marketRejectReason(status)).toThrow(RangeError);
    }
  });
});

describe('orderEndState (ADR-0111 결정 6)', () => {
  const end = (book: BookOrder[], incoming: IncomingOrder) =>
    orderEndState(incoming, matchOrder(book, incoming));
  const asks = [
    resting('s1', B, 'YES', 'sell', 40, 2, 1),
    resting('s2', B, 'YES', 'sell', 50, 2, 2),
  ];

  it('fills a quantity order whole: 전량 체결', () => {
    expect(end(asks, qtyOrder(A, 'buy', 60, 3, 'ioc'))).toEqual({
      status: 'filled',
      rejectReason: null,
      cancelReason: null,
      unspentCoin: null,
    });
  });

  it('ends an immediate order with nothing opposite or beyond its limit: 거절 or 취소 완료', () => {
    expect(end([], qtyOrder(A, 'buy', 60, 3, 'ioc'))).toMatchObject({
      status: 'rejected',
      rejectReason: 'no_quote',
      cancelReason: null,
    });
    expect(end(asks, qtyOrder(A, 'buy', 30, 3, 'ioc'))).toMatchObject({
      status: 'rejected',
      rejectReason: 'price_limit',
    });
    expect(end(asks, qtyOrder(A, 'buy', 45, 3, 'ioc'))).toMatchObject({
      status: 'cancelled',
      rejectReason: null,
      cancelReason: 'ioc_remainder',
    });
    expect(end(asks, qtyOrder(A, 'buy', 60, 9, 'ioc'))).toMatchObject({
      status: 'cancelled',
      cancelReason: 'ioc_remainder',
    });
  });

  it('rests a GTC remainder: 대기 with no fill, 부분 체결 after one', () => {
    expect(end([], qtyOrder(A, 'buy', 60, 3, 'gtc'))).toMatchObject({
      status: 'open',
      rejectReason: null,
      cancelReason: null,
    });
    expect(end(asks, qtyOrder(A, 'buy', 45, 3, 'gtc'))).toMatchObject({
      status: 'partially_filled',
    });
  });

  it('ends every order meeting its own group, a GTC one too: 자기 체결', () => {
    const own = [resting('s0', A, 'YES', 'sell', 40, 1, 0), ...asks];
    expect(end(own, qtyOrder(A, 'buy', 60, 3, 'gtc'))).toMatchObject({
      status: 'rejected',
      rejectReason: 'self_trade',
    });
    const later = [...asks, resting('s3', A, 'YES', 'sell', 55, 1, 3)];
    expect(end(later, qtyOrder(A, 'buy', 60, 9, 'gtc'))).toMatchObject({
      status: 'cancelled',
      cancelReason: 'self_trade',
    });
    // The bot never meets the bot: one bundle.
    const bot = [resting('m1', M, 'NO', 'buy', 60, 1, 1)];
    expect(
      end(bot, { ...qtyOrder(M, 'buy', 60, 1, 'ioc'), owner: { id: 'M2', human: false } }),
    ).toMatchObject({
      status: 'rejected',
      rejectReason: 'self_trade',
    });
  });

  it('ends a budget order 전량 체결 with its unspent Coin, or 금액 부족 with none bought', () => {
    // 100 Coin, limit 60, asks 40 × 2 and 50 × 2: 2 @ 40 = 80, 20 left cannot buy one at 50.
    expect(end(asks, budgetOrder(A, 60, 100n))).toEqual({
      status: 'filled',
      rejectReason: null,
      cancelReason: null,
      unspentCoin: 20n,
    });
    expect(end(asks, budgetOrder(A, 60, 30n))).toEqual({
      status: 'rejected',
      rejectReason: 'budget_too_small',
      cancelReason: null,
      unspentCoin: 30n,
    });
    // Beyond the limit after a fill: 취소 완료 with the unspent Coin (no cancelled quantity).
    expect(end(asks, budgetOrder(A, 45, 500n))).toEqual({
      status: 'cancelled',
      rejectReason: null,
      cancelReason: 'ioc_remainder',
      unspentCoin: 420n,
    });
    expect(end([], budgetOrder(A, 45, 500n))).toMatchObject({
      status: 'rejected',
      rejectReason: 'no_quote',
      unspentCoin: 500n,
    });
  });
});

describe('restingStateAfterFill', () => {
  it('is 전량 체결 with nothing left and 부분 체결 otherwise', () => {
    expect(restingStateAfterFill(0)).toBe('filled');
    expect(restingStateAfterFill(3)).toBe('partially_filled');
    expect(() => restingStateAfterFill(-1)).toThrow(RangeError);
    expect(() => restingStateAfterFill(1.5)).toThrow(RangeError);
  });
});

describe('intakeRemainderRelease (ADR-0110 결과 5)', () => {
  const asks = [resting('s1', B, 'YES', 'sell', 40, 2, 1)];

  it('gives back an immediate remainder and a budget’s unspent Coin, and nothing of a resting GTC', () => {
    const ioc = qtyOrder(A, 'buy', 60, 5, 'ioc');
    // Locked 60 × 5; 2 filled (their better price released at the fills): 60 × 3 back.
    expect(intakeRemainderRelease(factsOf(ioc), matchOrder(asks, ioc))).toEqual({
      kind: 'coin',
      amountCoin: 180n,
    });
    const gtc = qtyOrder(A, 'buy', 60, 5, 'gtc');
    expect(intakeRemainderRelease(factsOf(gtc), matchOrder(asks, gtc))).toEqual({
      kind: 'coin',
      amountCoin: 0n,
    });
    const budget = budgetOrder(A, 60, 100n);
    expect(intakeRemainderRelease(factsOf(budget), matchOrder(asks, budget))).toEqual({
      kind: 'coin',
      amountCoin: 20n,
    });
    expect(orderIntakeLock(factsOf(budget))).toEqual({ kind: 'coin', amountCoin: 100n });
  });

  it('gives back a sell’s unfilled contracts, and every one of a GTC stopped by its own order', () => {
    const bids = [
      resting('b1', B, 'YES', 'buy', 60, 2, 1),
      resting('b2', A, 'YES', 'buy', 55, 9, 2),
    ];
    const sell = qtyOrder(A, 'sell', 50, 5, 'gtc');
    const result = matchOrder(bids, sell);
    expect(result).toMatchObject({ stop: 'self_trade', remainder: 'cancel', filledQty: 2 });
    expect(intakeRemainderRelease(factsOf(sell), result)).toEqual({
      kind: 'contracts',
      outcome: 'YES',
      qty: 3,
    });
    const filled = qtyOrder(A, 'sell', 50, 2, 'ioc');
    expect(intakeRemainderRelease(factsOf(filled), matchOrder(bids, filled))).toEqual({
      kind: 'contracts',
      outcome: 'YES',
      qty: 0,
    });
  });

  it('refuses a budget order whose result carries no unspent Coin (a caller bug)', () => {
    const budget = budgetOrder(A, 60, 100n);
    const quantityResult = matchOrder(asks, qtyOrder(A, 'buy', 60, 1, 'ioc'));
    expect(() => intakeRemainderRelease(factsOf(budget), quantityResult)).toThrow(RangeError);
  });
});

describe('ownFillPrice (#177 11·15항)', () => {
  it('reads the YES price for YES and the payout minus it for NO', () => {
    expect(ownFillPrice('YES', 60)).toBe(60);
    expect(ownFillPrice('NO', 60)).toBe(40);
  });

  it('agrees with the line a NO buy walks: a resting YES buy at 60 is NO at 40', () => {
    const book = [resting('y', B, 'YES', 'buy', 60, 1, 1)];
    expect(matchLine(book, 'NO', 'buy')[0]?.priceCoin).toBe(ownFillPrice('NO', 60));
  });
});

describe('requestTermsEqual', () => {
  const terms: OrderRequestTerms = {
    marketId: 'm',
    outcome: 'YES',
    side: 'buy',
    timeInForce: 'ioc',
    limitPriceCoin: 60,
    qty: 10,
    budgetCoin: null,
  };

  it('is the same order only with every term the same', () => {
    expect(requestTermsEqual(terms, { ...terms })).toBe(true);
    for (const change of [
      { marketId: 'n' },
      { outcome: 'NO' as const },
      { side: 'sell' as const },
      { timeInForce: 'gtc' as const },
      { limitPriceCoin: 61 },
      { qty: 11 },
      { qty: null, budgetCoin: 600n },
    ]) {
      expect(
        requestTermsEqual(terms, { ...terms, ...change }),
        JSON.stringify(Object.keys(change)),
      ).toBe(false);
    }
    const budget = { ...terms, qty: null, budgetCoin: 600n };
    expect(requestTermsEqual(budget, { ...budget })).toBe(true);
    expect(requestTermsEqual(budget, { ...budget, budgetCoin: 601n })).toBe(false);
  });
});

describe('changePriceProtectionBodySchema', () => {
  it('takes a width of 1..98 ticks with a reason and the admin on screen', () => {
    const body = {
      priceProtectionTicks: 5,
      reason: '변동성이 커서 넓힌다',
      expectedAccountId: 'admin',
    };
    expect(changePriceProtectionBodySchema.safeParse(body).success).toBe(true);
    for (const priceProtectionTicks of [0, 99, 1.5, '5']) {
      expect(
        changePriceProtectionBodySchema.safeParse({ ...body, priceProtectionTicks }).success,
      ).toBe(false);
    }
    expect(changePriceProtectionBodySchema.safeParse({ ...body, reason: ' ' }).success).toBe(false);
  });
});
