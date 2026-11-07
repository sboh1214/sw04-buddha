import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { CONTRACT_TERMS, orderIntakeLock } from './contract.js';
import {
  MARKET_STATUSES,
  ORDER_SIDES,
  OUTCOMES,
  TIME_IN_FORCES,
  type MarketStatus,
  type OrderSide,
  type Outcome,
} from './enums.js';
import { findExcludedIdentifier, namesPersonalProbability } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import {
  orderBookOf,
  orderBookSchema,
  orderQuoteOf,
  orderQuoteSchema,
  sellableContractOf,
  sellableSchema,
} from './market.js';
import {
  type BookOrder,
  type IncomingOrder,
  type OrderOwner,
  matchLine,
  matchOrder,
} from './matching.js';
import {
  bookDepth,
  bookLevels,
  contractDepth,
  quoteOrder,
  quoteTermsOf,
  sellableOf,
  type MarketTradingFacts,
  type OrderQuoteFigures,
  type QuoteTerms,
} from './order-book.js';
import {
  intakeMarketGate,
  marketRejectReason,
  marketTradingRejectReason,
  orderEndState,
  planIntakeMatch,
  protectedLimit,
  quoteOrderBodySchema,
  type OrderTerms,
} from './orders.js';

// 공개 호가와 견적 (#179, ADR-0114): the depth of each line, the quote as the intake's gate and plan
// with no owner, the sellable figures, and the public DTOs — examples, then properties against
// the intake's own composition.
const RUNS = { numRuns: 300 };
const PAYOUT = CONTRACT_TERMS.payoutCoin;

const A: OrderOwner = { id: 'A', human: true };
const B: OrderOwner = { id: 'B', human: true };
const C: OrderOwner = { id: 'C', human: true };
const M1: OrderOwner = { id: 'M1', human: false };
const M2: OrderOwner = { id: 'M2', human: false };
const OWNERS = [A, B, C, M1, M2];

const resting = (
  id: string,
  owner: OrderOwner,
  outcome: Outcome,
  side: OrderSide,
  priceCoin: number,
  remainingQty: number,
  arrival: number,
): BookOrder => ({ id, owner, outcome, side, priceCoin, remainingQty, arrival });

const OPEN: MarketTradingFacts = { status: 'open', widthTicks: 10 };

const terms = (overrides: Partial<QuoteTerms> = {}): QuoteTerms => ({
  outcome: 'YES',
  side: 'buy',
  timeInForce: 'ioc',
  limitPriceCoin: null,
  qty: 1,
  budgetCoin: null,
  ...overrides,
});

const quoted = (
  book: readonly BookOrder[],
  overrides: Partial<QuoteTerms> = {},
  market: MarketTradingFacts = OPEN,
  owner: OrderOwner | null = null,
): OrderQuoteFigures => {
  const answer = quoteOrder(book, market, terms(overrides), owner);
  if (answer.kind !== 'quoted') throw new Error(`expected a quote, got ${answer.kind}`);
  return answer.figures;
};

describe('the public book (#177 4항, N01 §4)', () => {
  it('shows a NO buy 40×10 as a NO bid and a YES ask at 60, and 10 can fill from it', () => {
    const book = [resting('n', A, 'NO', 'buy', 40, 10, 1)];
    expect(bookDepth(book)).toEqual([
      {
        outcome: 'YES',
        asks: [{ priceCoin: 60, qty: 10 }],
        bids: [],
        bestAskCoin: 60,
        bestBidCoin: null,
      },
      {
        outcome: 'NO',
        asks: [],
        bids: [{ priceCoin: 40, qty: 10 }],
        bestAskCoin: null,
        bestBidCoin: 40,
      },
    ]);
    // A YES buy of 15 fills the 10 once (not 10 + 10 across both views) and stops 호가 부족.
    expect(quoted(book, { qty: 15 })).toEqual({
      protectedLimitPriceCoin: 70,
      filledQty: 10,
      filledAmountCoin: 600n,
      remainingQty: 5,
      unspentCoin: null,
      maxSpendCoin: 70n * 15n,
      stop: 'no_quote',
      status: 'cancelled',
      rejectReason: null,
      cancelReason: 'ioc_remainder',
    });
  });

  it('merges a direct sell and a converted buy at one price into one level, with no source', () => {
    const book = [
      resting('s', B, 'YES', 'sell', 60, 3, 1),
      resting('n', A, 'NO', 'buy', 40, 4, 2),
      resting('m', M1, 'NO', 'buy', 38, 5, 3),
    ];
    const yes = contractDepth(book, 'YES');
    expect(yes.asks).toEqual([
      { priceCoin: 60, qty: 7 },
      { priceCoin: 62, qty: 5 },
    ]);
    for (const level of yes.asks) expect(Object.keys(level).sort()).toEqual(['priceCoin', 'qty']);
    expect(Object.keys(yes).sort()).toEqual([
      'asks',
      'bestAskCoin',
      'bestBidCoin',
      'bids',
      'outcome',
    ]);
  });

  it('keeps the bids direct and computes no complement: YES + NO is not 100', () => {
    // Only a YES sell: no bid anywhere (never NO bid 40), and NO has no ask (no cross-sell).
    expect(bookDepth([resting('s', B, 'YES', 'sell', 60, 3, 1)])).toEqual([
      {
        outcome: 'YES',
        asks: [{ priceCoin: 60, qty: 3 }],
        bids: [],
        bestAskCoin: 60,
        bestBidCoin: null,
      },
      { outcome: 'NO', asks: [], bids: [], bestAskCoin: null, bestBidCoin: null },
    ]);
    const spread = bookDepth([
      resting('ys', B, 'YES', 'sell', 60, 1, 1),
      resting('ns', C, 'NO', 'sell', 45, 1, 2),
      resting('yb', A, 'YES', 'buy', 30, 1, 3),
    ]);
    expect(spread[0]!.bestAskCoin! + spread[1]!.bestAskCoin!).toBe(105);
    // The YES bid at 30 is a NO ask at 70; the NO ask at 45 sorts first.
    expect(spread[1]!.asks).toEqual([
      { priceCoin: 45, qty: 1 },
      { priceCoin: 70, qty: 1 },
    ]);
    expect(spread[0]!.bestBidCoin).toBe(30);
    expect(spread[1]!.bestBidCoin).toBeNull();
  });

  it('gives every level of a side, up to 99, asks cheapest first and bids highest first', () => {
    const book: BookOrder[] = [];
    for (let price = 1; price <= 99; price += 1) {
      book.push(resting(`s${String(price)}`, B, 'YES', 'sell', price, 1, price));
      book.push(resting(`b${String(price)}`, A, 'YES', 'buy', price, 2, 100 + price));
    }
    const yes = contractDepth(book, 'YES');
    expect(yes.asks).toHaveLength(99);
    expect(yes.bids).toHaveLength(99);
    expect(yes.asks.map((level) => level.priceCoin)).toEqual(
      Array.from({ length: 99 }, (_, i) => i + 1),
    );
    expect(yes.bids.map((level) => level.priceCoin)).toEqual(
      Array.from({ length: 99 }, (_, i) => 99 - i),
    );
    expect([yes.bestAskCoin, yes.bestBidCoin]).toEqual([1, 99]);
    expect(bookDepth([])).toEqual(
      OUTCOMES.map((outcome) => ({
        outcome,
        asks: [],
        bids: [],
        bestAskCoin: null,
        bestBidCoin: null,
      })),
    );
  });

  it('refuses a malformed book', () => {
    const order = resting('a', A, 'YES', 'sell', 60, 1, 1);
    expect(() => bookDepth([order, order])).toThrow(RangeError);
    expect(() => contractDepth([{ ...order, remainingQty: 0 }], 'YES')).toThrow(RangeError);
  });
});

describe('quoteOrder (#177 2·3·10·12항, ADR-0111 결정 8)', () => {
  const book = [
    resting('s1', B, 'YES', 'sell', 55, 2, 1),
    resting('n1', A, 'NO', 'buy', 42, 3, 2),
    resting('s2', C, 'YES', 'sell', 70, 5, 3),
    resting('b1', A, 'YES', 'buy', 45, 4, 4),
    resting('b2', M1, 'YES', 'buy', 40, 6, 5),
  ];

  it('walks several levels and stops at the protected limit: only the part inside fills', () => {
    // Best ask 55 + 10 = 65: the 55 and the converted 58 fill, the 70 is beyond (가격 한도).
    expect(quoted(book, { qty: 20 })).toMatchObject({
      protectedLimitPriceCoin: 65,
      filledQty: 5,
      filledAmountCoin: 2n * 55n + 3n * 58n,
      remainingQty: 15,
      maxSpendCoin: 65n * 20n,
      stop: 'price_limit',
      status: 'cancelled',
      cancelReason: 'ioc_remainder',
    });
    // A limit sent below the reference is never widened: 50 meets nothing.
    expect(quoted(book, { qty: 2, limitPriceCoin: 50 })).toMatchObject({
      protectedLimitPriceCoin: 50,
      filledQty: 0,
      stop: 'price_limit',
      status: 'rejected',
      rejectReason: 'price_limit',
    });
  });

  it('quotes an immediate sell by quantity alone, down to max(best bid − width, 1)', () => {
    expect(quoted(book, { side: 'sell', qty: 12 })).toEqual({
      protectedLimitPriceCoin: 35,
      filledQty: 10,
      filledAmountCoin: 4n * 45n + 6n * 40n,
      remainingQty: 2,
      unspentCoin: null,
      maxSpendCoin: null,
      stop: 'no_quote',
      status: 'cancelled',
      rejectReason: null,
      cancelReason: 'ioc_remainder',
    });
    expect(
      quoted(book, { side: 'sell', qty: 1 }, { status: 'open', widthTicks: 98 }),
    ).toMatchObject({ protectedLimitPriceCoin: 1, filledQty: 1 });
  });

  it('answers 호가 없음 with the limit as sent: nothing to narrow, nothing filled', () => {
    expect(quoted([], { qty: 3 })).toMatchObject({
      protectedLimitPriceCoin: 99,
      filledQty: 0,
      filledAmountCoin: 0n,
      remainingQty: 3,
      maxSpendCoin: 99n * 3n,
      stop: 'no_quote',
      status: 'rejected',
      rejectReason: 'no_quote',
    });
    expect(quoted([], { side: 'sell', qty: 3 })).toMatchObject({
      protectedLimitPriceCoin: 1,
      rejectReason: 'no_quote',
    });
  });

  it('spends at most a budget, stops before the next contract it cannot buy, and keeps the rest', () => {
    // 2 × 55 = 110, then 58 > 150 − 110: 전량 체결 with 40 unspent (never "all spent").
    expect(quoted(book, { qty: null, budgetCoin: 150n })).toEqual({
      protectedLimitPriceCoin: 65,
      filledQty: 2,
      filledAmountCoin: 110n,
      remainingQty: null,
      unspentCoin: 40n,
      maxSpendCoin: 150n,
      stop: 'budget_spent',
      status: 'filled',
      rejectReason: null,
      cancelReason: null,
    });
    expect(quoted(book, { qty: null, budgetCoin: 54n })).toMatchObject({
      filledQty: 0,
      unspentCoin: 54n,
      status: 'rejected',
      rejectReason: 'budget_too_small',
    });
    // A budget past the supply inside the limit: what fills, the rest unspent, 가격 한도.
    expect(quoted(book, { qty: null, budgetCoin: 10_000n })).toMatchObject({
      filledQty: 5,
      filledAmountCoin: 284n,
      unspentCoin: 10_000n - 284n,
      stop: 'price_limit',
      status: 'cancelled',
    });
  });

  it('rests a GTC remainder at its own limit, never narrowed, and counts it in the max spend', () => {
    expect(quoted(book, { timeInForce: 'gtc', limitPriceCoin: 60, qty: 9 })).toEqual({
      protectedLimitPriceCoin: 60,
      filledQty: 5,
      filledAmountCoin: 284n,
      remainingQty: 4,
      unspentCoin: null,
      maxSpendCoin: 60n * 9n,
      stop: 'price_limit',
      status: 'partially_filled',
      rejectReason: null,
      cancelReason: null,
    });
    expect(quoted([], { timeInForce: 'gtc', limitPriceCoin: 30, qty: 2 })).toMatchObject({
      status: 'open',
      stop: 'no_quote',
    });
    // A GTC order uses no width: a market with none quotes it.
    expect(
      quoted(
        book,
        { timeInForce: 'gtc', limitPriceCoin: 99, qty: 1 },
        { status: 'open', widthTicks: null },
      ),
    ).toMatchObject({ protectedLimitPriceCoin: 99, filledQty: 1 });
    expect(() => quoteOrder(book, OPEN, terms({ timeInForce: 'gtc' }), null)).toThrow(RangeError);
  });

  it('answers a market not OPEN as the intake’s rejected row: its reason, nothing walked', () => {
    for (const status of MARKET_STATUSES) {
      if (status === 'draft' || status === 'review') {
        expect(() => quoteOrder(book, { status, widthTicks: 10 }, terms(), null)).toThrow(
          RangeError,
        );
        continue;
      }
      if (status === 'open') continue;
      for (const widthTicks of [10, null]) {
        expect(
          quoteOrder(book, { status, widthTicks }, terms({ qty: 4, limitPriceCoin: 62 }), null),
        ).toEqual({
          kind: 'quoted',
          figures: {
            protectedLimitPriceCoin: 62,
            filledQty: 0,
            filledAmountCoin: 0n,
            remainingQty: 4,
            unspentCoin: null,
            maxSpendCoin: null,
            stop: null,
            status: 'rejected',
            rejectReason: marketRejectReason(status),
            cancelReason: null,
          },
        });
      }
      expect(
        quoted(book, { qty: null, budgetCoin: 80n }, { status, widthTicks: 10 }),
      ).toMatchObject({
        protectedLimitPriceCoin: 99,
        remainingQty: null,
        unspentCoin: 80n,
      });
    }
  });

  it('answers an immediate order on a market with no width `closed`, as the intake does', () => {
    const noWidth = { status: 'open', widthTicks: null } as const;
    expect(quoteOrder(book, noWidth, terms(), null)).toEqual({
      kind: 'closed',
      why: 'price_protection',
    });
    expect(quoteOrder(book, noWidth, terms({ side: 'sell' }), null).kind).toBe('closed');
  });

  it('skips the self-trade check with no owner, and stops at the owner’s own order with one', () => {
    expect(quoted(book, { side: 'sell', qty: 4 }).filledQty).toBe(4);
    expect(quoted(book, { side: 'sell', qty: 4 }, OPEN, A)).toMatchObject({
      filledQty: 0,
      stop: 'self_trade',
      status: 'rejected',
      rejectReason: 'self_trade',
    });
    // The 운영 마켓메이커 bundle: M2 never meets M1's bid.
    expect(quoted(book, { side: 'sell', qty: 6 }, OPEN, M2)).toMatchObject({
      filledQty: 4,
      stop: 'self_trade',
      cancelReason: 'self_trade',
    });
  });

  it('takes its terms from the quote body, absent fields as null', () => {
    expect(
      quoteTermsOf(
        quoteOrderBodySchema.parse({
          outcome: 'NO',
          side: 'buy',
          timeInForce: 'ioc',
          budgetCoin: '70',
        }),
      ),
    ).toEqual({
      outcome: 'NO',
      side: 'buy',
      timeInForce: 'ioc',
      limitPriceCoin: null,
      qty: null,
      budgetCoin: 70n,
    });
    expect(
      quoteTermsOf(
        quoteOrderBodySchema.parse({
          outcome: 'YES',
          side: 'sell',
          timeInForce: 'gtc',
          limitPriceCoin: 61,
          qty: 3,
        }),
      ),
    ).toEqual({
      outcome: 'YES',
      side: 'sell',
      timeInForce: 'gtc',
      limitPriceCoin: 61,
      qty: 3,
      budgetCoin: null,
    });
  });
});

describe('intakeMarketGate (ADR-0112 결정 4 steps 4–5)', () => {
  it('rejects a market not OPEN first, then closes an immediate order on one with no width', () => {
    for (const status of MARKET_STATUSES) {
      if (status === 'draft' || status === 'review') {
        expect(() => intakeMarketGate({ status, widthTicks: 5 }, 'gtc')).toThrow(RangeError);
        continue;
      }
      const reason = marketRejectReason(status);
      for (const widthTicks of [5, null]) {
        for (const timeInForce of TIME_IN_FORCES) {
          const expected =
            reason !== null
              ? { kind: 'reject', reason }
              : timeInForce === 'ioc' && widthTicks === null
                ? { kind: 'closed', why: 'price_protection' }
                : null;
          expect(intakeMarketGate({ status, widthTicks }, timeInForce)).toEqual(expected);
        }
      }
    }
  });
});

describe('planIntakeMatch (ADR-0112 결정 4 steps 6 and 8)', () => {
  it('refuses terms no request can carry, and an immediate order with no width', () => {
    const base: OrderTerms = {
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'ioc',
      limitPriceCoin: 60,
      qty: 1,
      budgetCoin: null,
    };
    expect(() => planIntakeMatch([], base, null, null)).toThrow(RangeError);
    expect(() => planIntakeMatch([], { ...base, qty: null }, 5, null)).toThrow(RangeError);
    expect(() => planIntakeMatch([], { ...base, budgetCoin: 10n }, 5, null)).toThrow(RangeError);
    for (const bad of [
      { side: 'sell', timeInForce: 'ioc' },
      { side: 'buy', timeInForce: 'gtc' },
    ] as const) {
      expect(() =>
        planIntakeMatch([], { ...base, ...bad, qty: null, budgetCoin: 10n }, 5, null),
      ).toThrow(RangeError);
    }
    // A GTC records no reference and no width.
    expect(planIntakeMatch([], { ...base, timeInForce: 'gtc' }, 5, null)).toMatchObject({
      referencePriceCoin: null,
      widthTicks: null,
      protectedLimitPriceCoin: 60,
    });
  });
});

describe('sellableOf (#177 15항 매도 가능액)', () => {
  const bids = [
    resting('b1', B, 'YES', 'buy', 50, 3, 1),
    resting('b2', C, 'YES', 'buy', 45, 2, 2),
    resting('b3', B, 'YES', 'buy', 35, 9, 3),
  ];

  it('quotes the unlocked quantity alone, and reports the resting sells apart', () => {
    const figures = sellableOf(bids, OPEN, { outcome: 'YES', qty: 8, lockedQty: 3 }, A);
    expect(figures).toMatchObject({ outcome: 'YES', qty: 8, restingSellQty: 3, unlockedQty: 5 });
    expect(figures.quote).toEqual(quoted(bids, { side: 'sell', qty: 5 }, OPEN, A));
    expect(figures.quote).toMatchObject({
      protectedLimitPriceCoin: 40,
      filledQty: 5,
      filledAmountCoin: 3n * 50n + 2n * 45n,
      status: 'filled',
    });
  });

  it('says only part is possible when the bids inside the limit or the bids run out', () => {
    // The 35 is below max(50 − 10, 1) = 40: 5 of 9 fill (가격 한도).
    const limited = sellableOf(bids, OPEN, { outcome: 'YES', qty: 9, lockedQty: 0 }, A).quote!;
    expect(limited).toMatchObject({
      filledQty: 5,
      stop: 'price_limit',
      cancelReason: 'ioc_remainder',
    });
    const wide = { status: 'open', widthTicks: 20 } as const;
    const outOfBids = sellableOf(bids, wide, { outcome: 'YES', qty: 20, lockedQty: 0 }, A).quote!;
    expect(outOfBids).toMatchObject({ filledQty: 14, remainingQty: 6, stop: 'no_quote' });
  });

  it('stops at the holder’s own bid, as their own immediate sell would', () => {
    const own = sellableOf(bids, OPEN, { outcome: 'YES', qty: 4, lockedQty: 0 }, B).quote!;
    expect(own).toMatchObject({ filledQty: 0, stop: 'self_trade', rejectReason: 'self_trade' });
  });

  it('quotes nothing with nothing unlocked or no width, and the market’s reason when not OPEN', () => {
    expect(sellableOf(bids, OPEN, { outcome: 'NO', qty: 0, lockedQty: 0 }, A)).toEqual({
      outcome: 'NO',
      qty: 0,
      restingSellQty: 0,
      unlockedQty: 0,
      quote: null,
    });
    expect(sellableOf(bids, OPEN, { outcome: 'YES', qty: 4, lockedQty: 4 }, A).quote).toBeNull();
    expect(
      sellableOf(
        bids,
        { status: 'open', widthTicks: null },
        { outcome: 'YES', qty: 4, lockedQty: 0 },
        A,
      ).quote,
    ).toBeNull();
    expect(
      sellableOf(
        bids,
        { status: 'paused', widthTicks: 10 },
        { outcome: 'YES', qty: 4, lockedQty: 0 },
        A,
      ).quote,
    ).toMatchObject({ status: 'rejected', rejectReason: 'paused', filledQty: 0, remainingQty: 4 });
  });

  it('quotes a holding above ORDER_QTY_MAX in one walk', () => {
    const deep = [resting('b', B, 'YES', 'buy', 50, 2_000_000, 1)];
    const quote = sellableOf(
      deep,
      OPEN,
      { outcome: 'YES', qty: 1_500_000, lockedQty: 0 },
      A,
    ).quote!;
    expect(quote).toMatchObject({ filledQty: 1_500_000, status: 'filled' });
  });

  it('refuses a malformed holding', () => {
    for (const holding of [
      { outcome: 'YES', qty: 2, lockedQty: 3 },
      { outcome: 'YES', qty: -1, lockedQty: 0 },
      { outcome: 'YES', qty: 1.5, lockedQty: 0 },
      { outcome: 'YES', qty: 2, lockedQty: -1 },
      { outcome: 'MAYBE', qty: 2, lockedQty: 0 },
    ]) {
      expect(() => sellableOf(bids, OPEN, holding as never, A), JSON.stringify(holding)).toThrow(
        RangeError,
      );
    }
  });
});

describe('the public DTOs (#113)', () => {
  const book = [resting('n', A, 'NO', 'buy', 40, 10, 1), resting('m', M1, 'YES', 'buy', 30, 2, 2)];
  const marketId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  it('shows an OPEN market’s levels and an empty book with the reason otherwise', () => {
    const open = orderBookOf(marketId, OPEN, book);
    expect(orderBookSchema.parse(open)).toEqual(open);
    expect(open).toEqual({ marketId, marketRejectReason: null, contracts: bookDepth(book) });
    for (const status of ['scheduled', 'paused', 'closed', 'settled'] as MarketStatus[]) {
      expect(orderBookOf(marketId, { ...OPEN, status }, book)).toEqual({
        marketId,
        marketRejectReason: marketRejectReason(status),
        contracts: bookDepth([]),
      });
    }
    expect(() => orderBookOf(marketId, { ...OPEN, status: 'draft' }, book)).toThrow(RangeError);
  });

  it('empties the book where the intake gate and the quote reject (ADR-0114 결정 2·3)', () => {
    // One check, `marketTradingRejectReason`, for the book, the gate and the quote, all four taking
    // one `MarketTradingFacts` — so each case below is one value handed to all four, and a field
    // #120 adds (`close_at`, the snapshot clock) is one fixture they all see. This catches a split
    // only for a case it holds: #120 adds an OPEN market past its `close_at` here (ADR-0114 결과 5).
    const terms: QuoteTerms = {
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'gtc',
      limitPriceCoin: 50,
      qty: 3,
      budgetCoin: null,
    };
    const cases: MarketTradingFacts[] = MARKET_STATUSES.flatMap((status) =>
      [5, null].map((widthTicks) => ({ status, widthTicks })),
    );
    for (const facts of cases) {
      if (facts.status === 'draft' || facts.status === 'review') {
        expect(() => marketTradingRejectReason(facts)).toThrow(RangeError);
        expect(() => intakeMarketGate(facts, 'gtc')).toThrow(RangeError);
        expect(() => orderBookOf(marketId, facts, book)).toThrow(RangeError);
        expect(() => quoteOrder(book, facts, terms, null)).toThrow(RangeError);
        continue;
      }
      const reason = marketTradingRejectReason(facts);
      expect(intakeMarketGate(facts, 'gtc')).toEqual(
        reason === null ? null : { kind: 'reject', reason },
      );
      const shown = orderBookOf(marketId, facts, book);
      expect(shown.marketRejectReason).toBe(reason);
      expect(shown.contracts).toEqual(bookDepth(reason === null ? book : []));
      const quote = quoteOrder(book, facts, terms, null);
      expect(quote.kind === 'quoted' && quote.figures.rejectReason).toBe(reason);
    }
  });

  it('sends a quote with Coin as strings and the fee 0', () => {
    const figures = quoted(book, { qty: null, budgetCoin: 200n });
    const wire = orderQuoteOf(figures);
    expect(orderQuoteSchema.parse(wire)).toEqual(wire);
    expect(wire).toEqual({
      protectedLimitPriceCoin: 70,
      filledQty: 3,
      filledAmountCoin: '180',
      remainingQty: null,
      unspentCoin: '20',
      maxSpendCoin: '200',
      feeCoin: '0',
      stop: 'budget_spent',
      status: 'filled',
      rejectReason: null,
      cancelReason: null,
    });
    expect(orderQuoteSchema.safeParse({ ...wire, feeCoin: '1' }).success).toBe(false);
    const sell = orderQuoteOf(quoted(book, { side: 'sell', qty: 1 }));
    expect([sell.unspentCoin, sell.maxSpendCoin]).toEqual([null, null]);
  });

  it('sends the sellable figures in one shape', () => {
    const wire = {
      marketId,
      contracts: OUTCOMES.map((outcome) =>
        sellableContractOf(sellableOf(book, OPEN, { outcome, qty: 3, lockedQty: 1 }, B)),
      ),
    };
    expect(sellableSchema.parse(wire)).toEqual(wire);
    expect(wire.contracts[0]!.quote).toMatchObject({ filledQty: 2, filledAmountCoin: '60' });
    expect(
      sellableContractOf(sellableOf(book, OPEN, { outcome: 'NO', qty: 0, lockedQty: 0 }, B)),
    ).toEqual({ outcome: 'NO', qty: 0, restingSellQty: 0, unlockedQty: 0, quote: null });
  });

  it('names no private data, excluded feature or probability in the book and the quote', () => {
    const names = (schema: z.ZodType) => {
      const walk = (node: unknown): string[] => {
        if (Array.isArray(node)) return node.flatMap(walk);
        if (node === null || typeof node !== 'object') return [];
        const record = node as Record<string, unknown>;
        const own =
          record.properties !== null && typeof record.properties === 'object'
            ? Object.keys(record.properties)
            : [];
        return [...own, ...Object.values(record).flatMap(walk)];
      };
      return walk(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }));
    };
    const fields = [...names(orderBookSchema), ...names(orderQuoteSchema)];
    expect(fields).toEqual(expect.arrayContaining(['asks', 'bids', 'qty', 'filledAmountCoin']));
    expect(fields.flatMap((name) => findPrivateField(name))).toEqual([]);
    expect(fields.flatMap((name) => findExcludedIdentifier(name, 'api'))).toEqual([]);
    expect(fields.filter(namesPersonalProbability)).toEqual([]);
  });
});

// ---- properties -------------------------------------------------------------------------------

const priceArb = fc.integer({ min: 1, max: 99 });

/** Any well-formed book (possibly crossed): ≤ 16 orders, five owners, unique arrivals. */
const bookArb: fc.Arbitrary<BookOrder[]> = fc
  .array(
    fc.record({
      owner: fc.constantFrom(...OWNERS),
      outcome: fc.constantFrom(...OUTCOMES),
      side: fc.constantFrom(...ORDER_SIDES),
      priceCoin: priceArb,
      remainingQty: fc.integer({ min: 1, max: 20 }),
    }),
    { maxLength: 16 },
  )
  .chain((rows) =>
    fc
      .uniqueArray(fc.nat({ max: 10_000 }), { minLength: rows.length, maxLength: rows.length })
      .map((arrivals) =>
        rows.map((row, i) => ({ ...row, id: `o${String(i)}`, arrival: arrivals[i]! })),
      ),
  );

/** Quote terms as the body allows them: a quantity order, or an IOC buy's budget. */
const termsArb: fc.Arbitrary<QuoteTerms> = fc.oneof(
  fc
    .record({
      outcome: fc.constantFrom(...OUTCOMES),
      side: fc.constantFrom(...ORDER_SIDES),
      timeInForce: fc.constantFrom(...TIME_IN_FORCES),
      limitPriceCoin: fc.option(priceArb, { nil: null }),
      qty: fc.integer({ min: 1, max: 60 }),
    })
    .map((row) => ({
      ...row,
      limitPriceCoin: row.timeInForce === 'gtc' ? (row.limitPriceCoin ?? 50) : row.limitPriceCoin,
      budgetCoin: null,
    })),
  fc.record({
    outcome: fc.constantFrom(...OUTCOMES),
    side: fc.constant('buy' as const),
    timeInForce: fc.constant('ioc' as const),
    limitPriceCoin: fc.option(priceArb, { nil: null }),
    qty: fc.constant(null),
    budgetCoin: fc.bigInt({ min: 1n, max: 3_000n }),
  }),
);
const widthArb = fc.integer({ min: 1, max: 98 });

/** The intake's composition before #179 (db orders.ts): reference, limit, walk, end state. */
function intakeReference(
  book: readonly BookOrder[],
  t: OrderTerms,
  widthTicks: number,
  owner: OrderOwner | null,
) {
  const isIoc = t.timeInForce === 'ioc';
  const referencePrice = isIoc ? (matchLine(book, t.outcome, t.side)[0]?.priceCoin ?? null) : null;
  const limit = protectedLimit({
    side: t.side,
    timeInForce: t.timeInForce,
    limitPriceCoin: t.limitPriceCoin,
    referencePriceCoin: referencePrice,
    widthTicks: isIoc ? widthTicks : null,
  });
  const incoming = (
    t.budgetCoin === null
      ? { ...t, owner, limitPriceCoin: limit, budgetCoin: null }
      : { ...t, owner, limitPriceCoin: limit, qty: null }
  ) as IncomingOrder;
  const result = matchOrder(book, incoming);
  return { referencePrice, limit, incoming, result, end: orderEndState(incoming, result) };
}

const limitOf = (t: QuoteTerms) =>
  t.limitPriceCoin ??
  (t.side === 'buy' ? CONTRACT_TERMS.priceMaxCoin : CONTRACT_TERMS.priceMinCoin);

describe('properties', () => {
  it('D1 the levels of a line sum it, each order once, best first, one level per price', () => {
    fc.assert(
      fc.property(bookArb, (book) => {
        for (const depth of bookDepth(book)) {
          for (const [side, levels, best] of [
            ['buy', depth.asks, depth.bestAskCoin],
            ['sell', depth.bids, depth.bestBidCoin],
          ] as const) {
            const line = matchLine(book, depth.outcome, side);
            const ids = line.map((entry) => entry.order.id);
            expect(new Set(ids).size).toBe(ids.length);
            const sum = (rows: readonly { qty: number }[]) =>
              rows.reduce((n, row) => n + row.qty, 0);
            expect(sum(levels)).toBe(line.reduce((n, entry) => n + entry.order.remainingQty, 0));
            expect(best).toBe(line[0]?.priceCoin ?? null);
            expect(levels).toEqual(bookLevels(line));
            for (let i = 1; i < levels.length; i += 1) {
              const step = levels[i]!.priceCoin - levels[i - 1]!.priceCoin;
              expect(side === 'buy' ? step > 0 : step < 0).toBe(true);
            }
            expect(levels.length).toBeLessThanOrEqual(99);
            for (const level of levels) {
              // Each level is real orders at that price: a converted one only from an opposite buy.
              const at = book.filter((order) =>
                side === 'buy'
                  ? (order.outcome === depth.outcome &&
                      order.side === 'sell' &&
                      order.priceCoin === level.priceCoin) ||
                    (order.outcome !== depth.outcome &&
                      order.side === 'buy' &&
                      PAYOUT - order.priceCoin === level.priceCoin)
                  : order.outcome === depth.outcome &&
                    order.side === 'buy' &&
                    order.priceCoin === level.priceCoin,
              );
              expect(at.reduce((n, order) => n + order.remainingQty, 0)).toBe(level.qty);
            }
          }
        }
      }),
      RUNS,
    );
  });

  it('D2 the plan is the intake’s composition, with or without an owner', () => {
    fc.assert(
      fc.property(
        bookArb,
        termsArb,
        widthArb,
        fc.option(fc.constantFrom(...OWNERS), { nil: null }),
        (book, quoteTerms, widthTicks, owner) => {
          const t: OrderTerms = { ...quoteTerms, limitPriceCoin: limitOf(quoteTerms) };
          const plan = planIntakeMatch(book, t, widthTicks, owner);
          const reference = intakeReference(book, t, widthTicks, owner);
          expect(plan).toEqual({
            referencePriceCoin: reference.referencePrice,
            widthTicks: t.timeInForce === 'ioc' ? widthTicks : null,
            protectedLimitPriceCoin: reference.limit,
            incoming: reference.incoming,
            result: reference.result,
            end: reference.end,
          });
        },
      ),
      RUNS,
    );
  });

  it('D3 a quote is the plan’s totals, inside the protected limit and the budget', () => {
    fc.assert(
      fc.property(bookArb, termsArb, widthArb, (book, t, widthTicks) => {
        const market = { status: 'open', widthTicks } as const;
        const answer = quoteOrder(book, market, t, null);
        if (answer.kind !== 'quoted') throw new Error('an OPEN market with a width quotes');
        const figures = answer.figures;
        const limit = limitOf(t);
        const plan = planIntakeMatch(book, { ...t, limitPriceCoin: limit }, widthTicks, null);
        expect(figures).toEqual({
          protectedLimitPriceCoin: plan.protectedLimitPriceCoin,
          filledQty: plan.result.filledQty,
          filledAmountCoin: plan.result.amountCoin,
          remainingQty: plan.result.remainingQty,
          unspentCoin: plan.result.unspentCoin,
          maxSpendCoin:
            t.side === 'sell'
              ? null
              : (t.budgetCoin ?? BigInt(plan.protectedLimitPriceCoin) * BigInt(t.qty!)),
          stop: plan.result.stop,
          status: plan.end.status,
          rejectReason: plan.end.rejectReason,
          cancelReason: plan.end.cancelReason,
        });
        // The limit: a GTC's own; an IOC's narrowed to the best opposite ± width, capped 99/1.
        const best = matchLine(book, t.outcome, t.side)[0]?.priceCoin ?? null;
        let expected = limit;
        if (t.timeInForce === 'ioc' && best !== null) {
          expected =
            t.side === 'buy'
              ? Math.min(limit, best + widthTicks, 99)
              : Math.max(limit, best - widthTicks, 1);
        }
        expect(figures.protectedLimitPriceCoin).toBe(expected);
        if (best === null) {
          expect(figures.stop).toBe('no_quote');
          expect(figures.filledQty).toBe(0);
        }
        if (t.timeInForce === 'gtc' && figures.stop !== 'filled') {
          expect(['open', 'partially_filled']).toContain(figures.status);
        }
        if (t.budgetCoin !== null) {
          expect(figures.filledAmountCoin).toBeLessThanOrEqual(t.budgetCoin);
          expect(figures.unspentCoin).toBe(t.budgetCoin - figures.filledAmountCoin);
          expect(figures.maxSpendCoin).toBe(t.budgetCoin);
          if (figures.filledQty === 0 && figures.stop === 'budget_spent') {
            expect(figures.rejectReason).toBe('budget_too_small');
          }
          // Stopped on the budget: the next entry inside the limit costs more than is left.
          if (figures.stop === 'budget_spent') {
            const next = matchLine(book, t.outcome, 'buy').find((entry) => {
              const fill = plan.result.fills.find((f) => f.restingOrderId === entry.order.id);
              return fill === undefined || fill.restingRemainingQty > 0;
            });
            if (next !== undefined) {
              expect(BigInt(next.priceCoin)).toBeGreaterThan(figures.unspentCoin!);
            }
          }
        }
        if (t.side === 'buy' && t.budgetCoin === null) {
          expect(figures.maxSpendCoin).toBe(
            (
              orderIntakeLock({
                side: 'buy',
                outcome: t.outcome,
                limitPriceCoin: figures.protectedLimitPriceCoin,
                qty: t.qty,
                filledQty: 0,
                budgetCoin: null,
                live: true,
              }) as { amountCoin: bigint }
            ).amountCoin,
          );
        }
      }),
      RUNS,
    );
  });

  it('D4 the sellable quote is the holder’s own immediate sell of the unlocked quantity', () => {
    fc.assert(
      fc.property(
        bookArb,
        fc.constantFrom(...OUTCOMES),
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 40 }),
        widthArb,
        fc.constantFrom(...OWNERS),
        (book, outcome, a, b, widthTicks, owner) => {
          const [lockedQty, qty] = a <= b ? [a, b] : [b, a];
          const market = { status: 'open', widthTicks } as const;
          const figures = sellableOf(book, market, { outcome, qty, lockedQty }, owner);
          expect(figures.unlockedQty + figures.restingSellQty).toBe(qty);
          if (figures.unlockedQty === 0) {
            expect(figures.quote).toBeNull();
            return;
          }
          const own = quoteOrder(
            book,
            market,
            terms({ outcome, side: 'sell', qty: figures.unlockedQty }),
            owner,
          );
          expect(own.kind === 'quoted' ? own.figures : null).toEqual(figures.quote);
          expect(figures.quote!.filledQty).toBeLessThanOrEqual(figures.unlockedQty);
        },
      ),
      RUNS,
    );
  });
});
