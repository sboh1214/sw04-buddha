import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type Order, type OrderQuote, type PlaceOrderBody } from './api';
import {
  type ConfirmRow,
  averagePriceText,
  confirmNotes,
  confirmRows,
  formatContractPrice,
  immediateFillNotice,
  neededCoinOf,
  quoteRows,
  requestSummary,
  resultRows,
  voidPayoutLine,
} from './order-confirm';
import { type OrderTerms } from './order-panel';

/**
 * 확인 화면의 숫자 (#66, ADR-0140 결정 2-8): every figure from the quote's fields,
 * `CONTRACT_TERMS`, the average and a plain product — no 100 − a bid, no walk of the book, no
 * budget ÷ price, no fee or balance after the order, no Number of Coin. An immediate buy counts 정답
 * 시 총지급, 순이익 and the VOID total on the expected fill (owner answer 66-Q1); a GTC buy on the whole
 * quantity (D6). The result card is the server's row.
 */

function quote(over: Partial<OrderQuote> = {}): OrderQuote {
  return {
    protectedLimitPriceCoin: 65,
    filledQty: 2,
    filledAmountCoin: '126',
    remainingQty: 0,
    unspentCoin: null,
    maxSpendCoin: '130',
    feeCoin: '0',
    stop: 'filled',
    status: 'filled',
    rejectReason: null,
    cancelReason: null,
    ...over,
  };
}

function terms(over: Partial<OrderTerms> = {}): OrderTerms {
  return { outcome: 'YES', side: 'buy', timeInForce: 'ioc', qty: 2, ...over };
}

/** The rows as `[id, value]`, in order. */
function table(rows: readonly { id: string; value: string }[]): [string, string][] {
  return rows.map((row) => [row.id, row.value]);
}

function labelOf(rows: ConfirmRow[], id: string): string | undefined {
  return rows.find((row) => row.id === id)?.label;
}

describe('formatContractPrice and the average', () => {
  it('writes a whole-Coin price as the book does', () => {
    expect(formatContractPrice(63)).toBe('63.00 Coin');
    expect(formatContractPrice(1)).toBe('1.00 Coin');
    expect(formatContractPrice(99)).toBe('99.00 Coin');
  });

  it('rounds the average to 0.01 Coin, and says — with no fill', () => {
    expect(averagePriceText({ filledQty: 2, filledAmountCoin: '126' })).toBe('63.00 Coin');
    // 125 ÷ 3 = 41.666… → 41.67.
    expect(averagePriceText({ filledQty: 3, filledAmountCoin: '125' })).toBe('41.67 Coin');
    expect(averagePriceText({ filledQty: 0, filledAmountCoin: '0' })).toBe(copy.orderNone);
  });

  it('pays VOID 50 Coin a contract, in bigint (D5)', () => {
    expect(voidPayoutLine('YES', 2)).toBe('계약당 50 Coin(합계 100 Coin)');
    expect(voidPayoutLine('NO', 1_000_000)).toBe('계약당 50 Coin(합계 50,000,000 Coin)');
  });
});

describe('confirmRows: every row of 확인 (ADR-0140 결정 2-8)', () => {
  it('즉시 매수 (수량): the expected fill’s payout, net and VOID total', () => {
    const rows = confirmRows({ terms: terms(), quote: quote() });
    expect(table(rows)).toEqual([
      ['contract', 'YES 매수'],
      ['kind', copy.orderKindIoc],
      ['size', '2계약'],
      ['limit', '65.00 Coin'],
      ['filled', '2계약'],
      ['avg', '63.00 Coin'],
      ['pay', '126 Coin'],
      ['max-spend', '130 Coin'],
      ['fee', '0 Coin'],
      ['payout-win', '200 Coin'],
      ['net', '74 Coin'],
      ['payout-lose', '0 Coin'],
      ['payout-void', '계약당 50 Coin(합계 100 Coin)'],
      ['unfilled', copy.orderUnfilledIoc],
    ]);
    expect(labelOf(rows, 'limit')).toBe(copy.orderMaxBuyPrice);
    expect(labelOf(rows, 'pay')).toBe(copy.orderPay);
  });

  it('즉시 매수 that fills part: 총지급·순이익·무효 on the fill, the rest cancelled (66-Q1)', () => {
    const rows = confirmRows({
      terms: terms({ qty: 3 }),
      quote: quote({ filledQty: 1, filledAmountCoin: '60', remainingQty: 2, maxSpendCoin: '195' }),
    });
    expect(table(rows)).toEqual([
      ['contract', 'YES 매수'],
      ['kind', copy.orderKindIoc],
      ['size', '3계약'],
      ['limit', '65.00 Coin'],
      ['filled', '1계약'],
      ['avg', '60.00 Coin'],
      ['pay', '60 Coin'],
      ['max-spend', '195 Coin'],
      ['fee', '0 Coin'],
      ['payout-win', '100 Coin'],
      ['net', '40 Coin'],
      ['payout-lose', '0 Coin'],
      ['payout-void', '계약당 50 Coin(합계 50 Coin)'],
      ['unfilled', copy.orderUnfilledIoc],
    ]);
  });

  it('즉시 매수 (금액): the budget, what is left of it, and its sentence', () => {
    const budget = terms({ qty: undefined, budgetCoin: '100' });
    const rows = confirmRows({
      terms: budget,
      quote: quote({
        filledQty: 1,
        filledAmountCoin: '60',
        remainingQty: null,
        unspentCoin: '40',
        maxSpendCoin: '100',
        stop: 'budget_spent',
      }),
    });
    expect(table(rows)).toEqual([
      ['contract', 'YES 매수'],
      ['kind', copy.orderKindIoc],
      ['size', '100 Coin'],
      ['limit', '65.00 Coin'],
      ['filled', '1계약'],
      ['avg', '60.00 Coin'],
      ['pay', '60 Coin'],
      ['unspent', '40 Coin'],
      ['max-spend', '100 Coin'],
      ['fee', '0 Coin'],
      ['payout-win', '100 Coin'],
      ['net', '40 Coin'],
      ['payout-lose', '0 Coin'],
      ['payout-void', '계약당 50 Coin(합계 50 Coin)'],
      ['unfilled', copy.orderUnfilledIoc],
    ]);
    expect(labelOf(rows, 'size')).toBe(copy.orderBudget);
    expect(confirmNotes({ terms: budget })).toEqual([
      copy.orderQuoteNotice,
      copy.orderBudgetNotice,
    ]);
    expect(confirmNotes({ terms: terms() })).toEqual([copy.orderQuoteNotice]);
  });

  it('지정가 매수: now and resting apart, the whole’s payment, payout, net and VOID (D5, D6, D8)', () => {
    const frozen = {
      terms: terms({ qty: 3, timeInForce: 'gtc', limitPriceCoin: 70 }),
      quote: quote({
        protectedLimitPriceCoin: 70,
        filledQty: 1,
        filledAmountCoin: '60',
        remainingQty: 2,
        maxSpendCoin: '210',
        stop: 'no_quote',
        status: 'partially_filled',
      }),
    };
    const rows = confirmRows(frozen);
    expect(table(rows)).toEqual([
      ['contract', 'YES 매수'],
      ['kind', copy.orderKindGtc],
      ['size', '3계약'],
      ['limit', '70.00 Coin'],
      ['immediate', '1계약'],
      ['resting', '2계약'],
      ['avg', '60.00 Coin'],
      ['pay', '60 Coin'],
      // 60 now, and 2 × 70 where the rest rests.
      ['pay-full', '200 Coin'],
      ['max-spend', '210 Coin'],
      ['fee', '0 Coin'],
      ['payout-win', '300 Coin'],
      ['net', '100 Coin'],
      ['payout-lose', '0 Coin'],
      ['payout-void', '계약당 50 Coin(합계 150 Coin)'],
      ['unfilled', copy.orderUnfilledGtc],
    ]);
    expect(labelOf(rows, 'limit')).toBe(copy.orderLimit);
    // The payment is the part that fills now, and says so (결정 2-23).
    expect(labelOf(rows, 'pay')).toBe(copy.orderPayImmediate);
    expect(immediateFillNotice(frozen)).toBe(
      `${copy.orderImmediateNoticeHead} 1계약${copy.orderImmediateNoticeTail}`,
    );
  });

  it('즉시 매도: the receipt and 최소 매도 단가, no 최소 수령, no payout or VOID row', () => {
    const rows = confirmRows({
      terms: terms({ side: 'sell' }),
      quote: quote({ protectedLimitPriceCoin: 35, filledAmountCoin: '80', maxSpendCoin: null }),
    });
    expect(table(rows)).toEqual([
      ['contract', 'YES 매도'],
      ['kind', copy.orderKindIoc],
      ['size', '2계약'],
      ['limit', '35.00 Coin'],
      ['filled', '2계약'],
      ['avg', '40.00 Coin'],
      ['pay', '80 Coin'],
      ['fee', '0 Coin'],
      ['unfilled', copy.orderUnfilledIoc],
    ]);
    expect(labelOf(rows, 'limit')).toBe(copy.orderMinSellPrice);
    expect(labelOf(rows, 'pay')).toBe(copy.orderReceive);
  });

  it('지정가 매도: 최소 수령 is the limit × the quantity', () => {
    const frozen = {
      terms: terms({ outcome: 'NO', side: 'sell', timeInForce: 'gtc', limitPriceCoin: 60 }),
      quote: quote({
        protectedLimitPriceCoin: 60,
        filledQty: 0,
        filledAmountCoin: '0',
        remainingQty: 2,
        maxSpendCoin: null,
        stop: 'no_quote',
        status: 'open',
      }),
    };
    expect(table(confirmRows(frozen))).toEqual([
      ['contract', 'NO 매도'],
      ['kind', copy.orderKindGtc],
      ['size', '2계약'],
      ['limit', '60.00 Coin'],
      ['immediate', '0계약'],
      ['resting', '2계약'],
      ['avg', copy.orderNone],
      ['pay', '0 Coin'],
      ['min-receive', '120 Coin'],
      ['fee', '0 Coin'],
      ['unfilled', copy.orderUnfilledGtc],
    ]);
    expect(labelOf(confirmRows(frozen), 'pay')).toBe(copy.orderReceiveImmediate);
    // Nothing fills at once: no D8 line.
    expect(immediateFillNotice(frozen)).toBeNull();
  });

  it('names a GTC’s payment as the part that fills now, and an immediate order’s as it was', () => {
    expect(copy.orderPayImmediate).not.toBe(copy.orderPay);
    expect(copy.orderReceiveImmediate).not.toBe(copy.orderReceive);
    expect(copy.orderPayImmediate).toContain(copy.orderPay);
    expect(copy.orderReceiveImmediate).toContain(copy.orderReceive);
  });

  it('shows 입력 the same rows of the quote that 확인 will', () => {
    expect(quoteRows({ terms: terms(), quote: quote() }).map((row) => row.id)).toEqual([
      'limit',
      'filled',
      'avg',
      'pay',
      'max-spend',
    ]);
  });

  it('leaves a GTC’s 한도가격 out of 입력’s quote — the field above says it — and keeps it in 확인', () => {
    const gtc = {
      terms: terms({ qty: 3, timeInForce: 'gtc', limitPriceCoin: 70 }),
      quote: quote({ protectedLimitPriceCoin: 70, filledQty: 1, remainingQty: 2 }),
    };
    expect(quoteRows(gtc).map((row) => row.id)).toEqual([
      'immediate',
      'resting',
      'avg',
      'pay',
      'max-spend',
    ]);
    expect(confirmRows(gtc).map((row) => row.id)).toContain('limit');
  });
});

describe('requestSummary: a sent request’s terms on one line (결정 2-23)', () => {
  const account = '33333333-3333-4333-8333-333333333333';
  const body: PlaceOrderBody = {
    outcome: 'YES',
    side: 'buy',
    timeInForce: 'gtc',
    qty: 3,
    limitPriceCoin: 70,
    expectedAccountId: account,
  };
  const budget: PlaceOrderBody = {
    outcome: 'NO',
    side: 'buy',
    timeInForce: 'ioc',
    budgetCoin: '100',
    limitPriceCoin: 65,
    expectedAccountId: account,
  };

  it('names the contract, the kind, the size and the limit as 확인 did', () => {
    expect(requestSummary(body)).toBe(
      `YES 매수 · ${copy.orderKindGtc} · 3계약 · ${copy.orderLimit} 70.00\u00a0Coin`,
    );
    expect(requestSummary({ ...body, side: 'sell', timeInForce: 'ioc', limitPriceCoin: 35 })).toBe(
      `YES 매도 · ${copy.orderKindIoc} · 3계약 · ${copy.orderMinSellPrice} 35.00\u00a0Coin`,
    );
    expect(requestSummary(budget)).toBe(
      `NO 매수 · ${copy.orderKindIoc} · ${copy.orderBudget} 100\u00a0Coin · ${copy.orderMaxBuyPrice} 65.00\u00a0Coin`,
    );
  });

  it('keeps every figure with its unit: no ordinary space inside one (결정 2-24)', () => {
    for (const line of [requestSummary(body), requestSummary(budget)]) {
      expect(line).not.toMatch(/\d Coin/);
      expect(line).toMatch(/\d\u00a0Coin/);
    }
  });
});

function order(over: Partial<Order> = {}): Order {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    requestId: '6f9619ff-8b86-4011-b42d-00c04fc964ff',
    marketId: '22222222-2222-4222-8222-222222222222',
    marketSlug: 'm',
    marketTitle: 'M',
    outcome: 'YES',
    side: 'buy',
    timeInForce: 'ioc',
    limitPriceCoin: 65,
    protectedLimitPriceCoin: 65,
    qty: 2,
    budgetCoin: null,
    filledQty: 2,
    filledAmountCoin: '126',
    cancelledQty: 0,
    unspentCoin: null,
    status: 'filled',
    rejectReason: null,
    cancelReason: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    endedAt: '2026-11-16T00:00:00.000Z',
    ...over,
  };
}

describe('resultRows: the server’s row (ADR-0140 결정 2-10)', () => {
  const ids = (o: Order) => resultRows(o).map((row) => row.id);

  it('fills: quantity, Coin and average', () => {
    expect(table(resultRows(order()))).toEqual([
      ['filled-qty', '2계약'],
      ['filled-amount', '126 Coin'],
      ['avg', '63.00 Coin'],
    ]);
  });

  it('gives an IOC remainder its cancelled quantity and no resting one', () => {
    const rest = order({
      filledQty: 1,
      filledAmountCoin: '60',
      cancelledQty: 1,
      status: 'cancelled',
      cancelReason: 'ioc_remainder',
    });
    expect(table(resultRows(rest))).toEqual([
      ['filled-qty', '1계약'],
      ['filled-amount', '60 Coin'],
      ['avg', '60.00 Coin'],
      ['cancelled', '1계약'],
    ]);
  });

  it('shows what rests only while it rests', () => {
    const resting = order({
      timeInForce: 'gtc',
      qty: 3,
      filledQty: 1,
      filledAmountCoin: '60',
      status: 'partially_filled',
      endedAt: null,
    });
    // At which limit, how much, and what it still locks: limit × the rest (결정 2-23).
    expect(table(resultRows(resting)).slice(3)).toEqual([
      ['limit', '65.00 Coin'],
      ['resting', '2계약'],
      ['locked', '130 Coin'],
    ]);
    expect(resultRows(resting).at(-1)?.label).toBe(copy.walletLocked);
    // A resting sell locks its resting contracts.
    const sell = order({
      side: 'sell',
      timeInForce: 'gtc',
      protectedLimitPriceCoin: 60,
      qty: 3,
      filledQty: 0,
      filledAmountCoin: '0',
      status: 'open',
      endedAt: null,
    });
    expect(table(resultRows(sell)).slice(3)).toEqual([
      ['limit', '60.00 Coin'],
      ['resting', '3계약'],
      ['locked', '3계약'],
    ]);
    expect(resultRows(sell).at(-1)?.label).toBe(copy.orderRestingSellLock);
    // A refused order rests nothing, its cancelledQty 0.
    const refused = order({
      filledQty: 0,
      filledAmountCoin: '0',
      status: 'rejected',
      rejectReason: 'insufficient_coin',
    });
    expect(ids(refused)).toEqual(['filled-qty', 'filled-amount', 'avg']);
    expect(resultRows(refused)[2]?.value).toBe(copy.orderNone);
  });

  it('gives back a budget order’s unspent Coin only after a fill', () => {
    const spent = order({
      qty: null,
      budgetCoin: '100',
      filledQty: 1,
      filledAmountCoin: '60',
      unspentCoin: '40',
    });
    expect(table(resultRows(spent)).at(-1)).toEqual(['unspent', '40 Coin']);
    // Refused for its status: all of the budget back, which is no unspent part of a trade.
    const refused = order({
      qty: null,
      budgetCoin: '100',
      filledQty: 0,
      filledAmountCoin: '0',
      unspentCoin: '100',
      status: 'rejected',
      rejectReason: 'closed',
    });
    expect(ids(refused)).toEqual(['filled-qty', 'filled-amount', 'avg']);
  });

  it('says a sell received', () => {
    expect(resultRows(order({ side: 'sell' }))[1]?.label).toBe(copy.orderFilledReceived);
    expect(resultRows(order())[1]?.label).toBe(copy.orderFilledPaid);
  });

  it('takes 잔액 부족’s 필요 from the row: the budget, or the narrowed limit × quantity', () => {
    expect(neededCoinOf({ budgetCoin: '100', qty: null, protectedLimitPriceCoin: 65 })).toBe(100n);
    expect(neededCoinOf({ budgetCoin: null, qty: 2, protectedLimitPriceCoin: 63 })).toBe(126n);
  });
});
