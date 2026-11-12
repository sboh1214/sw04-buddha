import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findPrivateField } from './guards/private-data.js';
import { orderBookOf, orderBookSchema, orderQuoteOf, orderQuoteSchema } from './market.js';
import { type BotMatchSnapshot, planRiskIntakeMatch } from './market-maker/risk-matching.js';
import type { BookOrder, OrderOwner } from './matching.js';
import {
  bookDepth,
  quoteOrder,
  sellableOf,
  type MarketTradingFacts,
  type QuoteTerms,
} from './order-book.js';

const HUMAN: OrderOwner = { id: 'human', human: true };
const BOT: OrderOwner = { id: 'bot', human: false };
const OPEN: MarketTradingFacts = {
  status: 'open',
  widthTicks: 98,
  now: new Date('2026-11-11T00:00:00Z'),
  closeAt: new Date('2026-11-12T00:00:00Z'),
};
const RISK: BotMatchSnapshot = {
  book: { coin: 1000n, invested: 1000n, recovered: 0n, yesQty: 0, noQty: 0 },
  limits: { maxLoss: 100n },
};
const bid = (id: string, priceCoin: number, remainingQty = 10, arrival = 1): BookOrder => ({
  id,
  owner: BOT,
  outcome: 'NO',
  side: 'buy',
  priceCoin,
  remainingQty,
  arrival,
});
const TERMS: QuoteTerms = {
  outcome: 'YES',
  side: 'buy',
  timeInForce: 'ioc',
  limitPriceCoin: 99,
  qty: 20,
  budgetCoin: null,
};
const quoted = (
  book: BookOrder[],
  terms: Partial<QuoteTerms> = {},
  risk = RISK,
  owner: OrderOwner | null = null,
) => {
  const result = quoteOrder(book, OPEN, { ...TERMS, ...terms }, owner, risk);
  if (result.kind !== 'quoted') throw new Error('Expected quote');
  return result.figures;
};

describe('public executable risk depth and quotes (#128)', () => {
  it('virtually cancels a zero allowance before exposing the later executable converted price', () => {
    const book = [bid('zero', 50), bid('later', 40, 10, 2)];
    const before = structuredClone({ book, risk: RISK });
    expect(bookDepth(book, RISK)).toEqual([
      {
        outcome: 'YES',
        asks: [{ priceCoin: 60, qty: 2 }],
        bids: [],
        bestAskCoin: 60,
        bestBidCoin: null,
      },
      {
        outcome: 'NO',
        asks: [],
        bids: [{ priceCoin: 40, qty: 2 }],
        bestAskCoin: null,
        bestBidCoin: 40,
      },
    ]);
    expect(quoted(book, { limitPriceCoin: 40 })).toMatchObject({
      filledQty: 0,
      filledAmountCoin: 0n,
      stop: 'price_limit',
    });
    expect(quoted(book, { limitPriceCoin: 50 })).toMatchObject({
      filledQty: 0,
      filledAmountCoin: 0n,
      stop: 'price_limit',
    });
    expect(quoted(book, { limitPriceCoin: 60 })).toMatchObject({
      filledQty: 2,
      filledAmountCoin: 120n,
    });
    expect({ book, risk: RISK }).toEqual(before);
  });

  it.each([
    [59n, 0, 59n],
    [60n, 1, 0n],
    [119n, 1, 59n],
    [120n, 2, 0n],
    [121n, 2, 1n],
  ])(
    'preserves budget stopping and integer contracts for budget %s',
    (budgetCoin, filledQty, unspentCoin) => {
      expect(
        quoted([bid('zero', 50), bid('later', 40, 10, 2)], { qty: null, budgetCoin }),
      ).toMatchObject({ filledQty, filledAmountCoin: BigInt(filledQty) * 60n, unspentCoin });
    },
  );

  it('shares reservations across multiple same-outcome quotes and continues to a human level', () => {
    const book = [
      bid('first', 40, 3),
      bid('second', 40, 3, 2),
      {
        ...bid('person', 61, 4, 3),
        owner: HUMAN,
        outcome: 'YES' as const,
        side: 'sell' as const,
      },
    ];
    expect(bookDepth(book, RISK)[0]!.asks).toEqual([
      { priceCoin: 60, qty: 2 },
      { priceCoin: 61, qty: 4 },
    ]);
    expect(quoted(book)).toMatchObject({ filledQty: 6, filledAmountCoin: 364n });
  });

  it('uses the executable price as the protection reference without committing virtual cancellations', () => {
    const book = [bid('zero', 50), bid('later', 40, 10, 2)];
    const result = quoteOrder(book, { ...OPEN, widthTicks: 2 }, TERMS, null, RISK);
    expect(result).toMatchObject({
      kind: 'quoted',
      figures: { protectedLimitPriceCoin: 62, filledQty: 2 },
    });
    expect(book.map((order) => order.remainingQty)).toEqual([10, 10]);
  });

  it('preserves the holder self-trade stop instead of filtering out their bid', () => {
    const book = [
      bid('zero', 50),
      { ...bid('own', 45, 1, 2), owner: HUMAN },
      bid('later', 40, 10, 3),
    ];
    const value = sellableOf(book, OPEN, { outcome: 'NO', qty: 10, lockedQty: 2 }, HUMAN, RISK);
    expect(value).toMatchObject({ unlockedQty: 8, quote: { filledQty: 0, stop: 'self_trade' } });
    expect(quoted(book, { outcome: 'NO', side: 'sell', limitPriceCoin: 1, qty: 8 })).toMatchObject({
      filledQty: 3,
      filledAmountCoin: 125n,
    });
  });

  it('shows human liquidity when a valid positive L has no remaining loss room', () => {
    const book = [
      bid('bot', 40),
      { ...bid('human', 61, 3, 2), owner: HUMAN, outcome: 'YES' as const, side: 'sell' as const },
    ];
    const risk = { ...RISK, book: { ...RISK.book, coin: 900n } };
    expect(bookDepth(book, risk)[0]!.asks).toEqual([{ priceCoin: 61, qty: 3 }]);
    expect(quoted(book, {}, risk)).toMatchObject({ filledQty: 3, filledAmountCoin: 183n });
    expect(() => bookDepth(book, { ...risk, limits: { maxLoss: 0n } })).toThrow(RangeError);
  });

  it.each([
    { ...OPEN, ledgerHeld: true },
    { ...OPEN, status: 'paused' as const },
    { ...OPEN, now: OPEN.closeAt },
  ])('does not expose retained locks for a non-trading market %j', (market) => {
    const book = [bid('bot', 40)];
    expect(
      orderBookOf('market', market, book, RISK).contracts.every(
        (contract) => contract.asks.length + contract.bids.length === 0,
      ),
    ).toBe(true);
    expect(quoteOrder(book, market, TERMS, null, RISK)).toMatchObject({
      kind: 'quoted',
      figures: { filledQty: 0, status: 'rejected' },
    });
  });

  it('serializes only the existing public aggregate fields', () => {
    const book = [bid('private-order', 40)];
    const depth = orderBookOf('00000000-0000-4000-8000-000000000001', OPEN, book, RISK);
    const quote = orderQuoteOf(quoted(book));
    expect(depth).toEqual(orderBookSchema.parse(depth));
    expect(quote).toEqual(orderQuoteSchema.parse(quote));
    const keys = (value: unknown): string[] =>
      value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, nested]) => [key, ...keys(nested)])
        : [];
    expect(keys([depth, quote]).flatMap((key) => findPrivateField(key))).toEqual([]);
    expect(JSON.stringify([depth, quote])).not.toMatch(/private-order|bot|invested|maxLoss/);
  });

  it('matches each unlimited public direction to its independent actual intake walk', () => {
    const row = fc.record({
      outcome: fc.constantFrom('YES' as const, 'NO' as const),
      side: fc.constantFrom('buy' as const, 'sell' as const),
      priceCoin: fc.integer({ min: 1, max: 99 }),
      remainingQty: fc.integer({ min: 1, max: 20 }),
      owner: fc.constantFrom(HUMAN, BOT),
    });
    fc.assert(
      fc.property(fc.array(row, { maxLength: 12 }), (rows) => {
        const book = rows.map((value, arrival) => ({ ...value, id: String(arrival), arrival }));
        const risk = {
          ...RISK,
          book: { coin: 10000n, invested: 20000n, recovered: 0n, yesQty: 100, noQty: 100 },
        };
        const before = structuredClone({ book, risk });
        const depth = bookDepth(book, risk);
        for (const outcome of ['YES', 'NO'] as const)
          for (const side of ['buy', 'sell'] as const) {
            const result = planRiskIntakeMatch(
              book,
              { ...TERMS, outcome, side, limitPriceCoin: side === 'buy' ? 99 : 1, qty: 1000 },
              98,
              null,
              risk,
            );
            if (result.kind !== 'planned') throw new Error('Anonymous intake refused');
            const levels = depth.find((contract) => contract.outcome === outcome)![
              side === 'buy' ? 'asks' : 'bids'
            ];
            expect(levels.reduce((qty, level) => qty + level.qty, 0)).toBe(
              result.plan.result.filledQty,
            );
            expect(
              levels.reduce(
                (coin, level) => coin + BigInt(level.priceCoin) * BigInt(level.qty),
                0n,
              ),
            ).toBe(
              result.plan.result.fills.reduce(
                (coin, fill) => coin + BigInt(fill.priceCoin) * BigInt(fill.qty),
                0n,
              ),
            );
          }
        expect({ book, risk }).toEqual(before);
      }),
      { numRuns: 300 },
    );
  });
});
