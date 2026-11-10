import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONTRACT_TERMS } from '../contract.js';
import type { BookOrder, OrderOwner } from '../matching.js';
import { planIntakeMatch, type OrderTerms } from '../orders.js';
import { maxBotFillQty, reservedPnl, type BotBook, type BotOrder } from './risk.js';
import { planRiskIntakeMatch, type RiskIntakeMatchPlan } from './risk-matching.js';

const HUMAN: OrderOwner = { id: 'human', human: true };
const OTHER: OrderOwner = { id: 'other', human: true };
const BOT: OrderOwner = { id: 'bot', human: false };
const HOLDINGS: BotBook = { coin: 1000n, invested: 1000n, recovered: 0n, yesQty: 0, noQty: 0 };
const TERMS: OrderTerms = {
  outcome: 'YES',
  side: 'buy',
  timeInForce: 'ioc',
  limitPriceCoin: 99,
  qty: 20,
  budgetCoin: null,
};
const bid = (id: string, priceCoin = 50, qty = 10, arrival = 1): BookOrder => ({
  id,
  owner: BOT,
  outcome: 'NO',
  side: 'buy',
  priceCoin,
  remainingQty: qty,
  arrival,
});
const ask = (id: string, priceCoin = 60, qty = 10, arrival = 3): BookOrder => ({
  id,
  owner: OTHER,
  outcome: 'YES',
  side: 'sell',
  priceCoin,
  remainingQty: qty,
  arrival,
});
const orderOf = (order: BookOrder): BotOrder => ({
  outcome: order.outcome,
  side: order.side,
  priceCoin: order.priceCoin,
  qty: order.remainingQty,
});
const run = (
  book: readonly BookOrder[],
  terms: Partial<OrderTerms> = {},
  holdings = HOLDINGS,
  maxLoss = 100n,
  owner: OrderOwner | null = HUMAN,
) =>
  planRiskIntakeMatch(book, { ...TERMS, ...terms }, 20, owner, {
    book: holdings,
    limits: { maxLoss },
  });
const planned = (result: RiskIntakeMatchPlan) => {
  expect(result.kind).toBe('planned');
  if (result.kind !== 'planned') throw new Error('Expected executable plan');
  return result;
};

describe('sequential bot risk intake', () => {
  it('keeps projected assets and all retained reservations consistent across arbitrary walks', () => {
    const entry = fc.record({
      owner: fc.constantFrom(BOT, OTHER),
      outcome: fc.constantFrom('YES' as const, 'NO' as const),
      side: fc.constantFrom('buy' as const, 'sell' as const),
      priceCoin: fc.integer({ min: 1, max: 99 }),
      remainingQty: fc.integer({ min: 1, max: 20 }),
    });
    fc.assert(
      fc.property(
        fc.array(entry, { maxLength: 12 }),
        fc.constantFrom('YES' as const, 'NO' as const),
        fc.constantFrom('buy' as const, 'sell' as const),
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 1, max: 100 }),
        fc.bigInt({ min: 1n, max: 3000n }),
        fc.bigInt({ min: 198000n, max: 202000n }),
        (rows, outcome, side, limitPriceCoin, qty, maxLoss, invested) => {
          const book = rows.map((row, arrival) => ({ ...row, id: String(arrival), arrival }));
          const holdings = { ...HOLDINGS, coin: 100000n, yesQty: 1000, noQty: 1000, invested };
          const before = structuredClone({ book, holdings });
          const result = planned(
            run(book, { outcome, side, limitPriceCoin, qty }, holdings, maxLoss),
          );
          const projected = { ...holdings };
          const remaining = new Map(
            book.filter((order) => !order.owner.human).map((order) => [order.id, orderOf(order)]),
          );
          const initialPnl = reservedPnl(holdings, [...remaining.values()], CONTRACT_TERMS);
          for (const fill of result.plan.result.fills) {
            const original = remaining.get(fill.restingOrderId);
            if (!original) continue;
            const delta = original.side === 'buy' ? fill.qty : -fill.qty;
            projected.coin -= BigInt(original.priceCoin) * BigInt(delta);
            if (original.outcome === 'YES') projected.yesQty += delta;
            else projected.noQty += delta;
            if (original.qty === fill.qty) remaining.delete(fill.restingOrderId);
            else remaining.set(fill.restingOrderId, { ...original, qty: original.qty - fill.qty });
          }
          for (const cancellation of result.botCancellations) {
            expect(remaining.get(cancellation.orderId)?.qty).toBe(cancellation.qty);
            remaining.delete(cancellation.orderId);
          }
          expect(result.projectedBook).toEqual(projected);
          expect({ book, holdings }).toEqual(before);
          const finalPnl = reservedPnl(projected, [...remaining.values()], CONTRACT_TERMS);
          for (const scenario of ['YES', 'NO', 'VOID'] as const) {
            const floor = initialPnl[scenario] < -maxLoss ? initialPnl[scenario] : -maxLoss;
            expect(finalPnl[scenario]).toBeGreaterThanOrEqual(floor);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('preserves ordinary results and call shapes when no bot risk policy is supplied', () => {
    expect(planIntakeMatch.length).toBe(4);
    const book = [ask('a')];
    const result = planned(run(book));
    expect(result.plan).toEqual(planIntakeMatch(book, TERMS, 20, HUMAN));
    expect(result.botCancellations).toEqual([]);
    expect(result.projectedBook).toEqual(HOLDINGS);
  });

  it('releases a zero-risk quote before evaluating the next quote, on separate reference/actual clones', () => {
    const first = bid('first', 50);
    const second = bid('second', 40, 10, 2);
    for (const [current, other] of [
      [first, second],
      [second, first],
    ] as const) {
      expect(
        maxBotFillQty(
          HOLDINGS,
          [orderOf(other)],
          orderOf(current),
          10,
          { maxLoss: 100n },
          CONTRACT_TERMS,
        ),
      ).toBe(0);
    }
    const result = planned(run([first, second]));
    expect(result.plan.referencePriceCoin).toBe(60);
    expect(result.plan.result.fills).toMatchObject([
      {
        restingOrderId: 'second',
        qty: 2,
        priceCoin: 60,
        restingPriceCoin: 40,
        restingRemainingQty: 8,
      },
    ]);
    expect(result.botCancellations).toEqual([
      { orderId: 'first', ownerId: 'bot', qty: 10 },
      { orderId: 'second', ownerId: 'bot', qty: 8 },
    ]);
    // The bot paid NO's price, not the converted YES price; collateral is not counted twice.
    expect(result.projectedBook).toEqual({ ...HOLDINGS, coin: 920n, noQty: 2 });
  });

  it.each([
    [40, [], 0],
    [50, [{ orderId: 'first', ownerId: 'bot', qty: 10 }], 0],
    [
      60,
      [
        { orderId: 'first', ownerId: 'bot', qty: 10 },
        { orderId: 'second', ownerId: 'bot', qty: 8 },
      ],
      2,
    ],
  ] as const)(
    'only cancels encountered quotes at actual limit %i',
    (limitPriceCoin, cancels, qty) => {
      const result = planned(run([bid('first'), bid('second', 40, 10, 2)], { limitPriceCoin }));
      expect(result.plan.referencePriceCoin).toBe(60);
      expect(result.plan.protectedLimitPriceCoin).toBe(limitPriceCoin);
      expect(result.botCancellations).toEqual(cancels);
      expect(result.plan.result.filledQty).toBe(qty);
    },
  );

  it('cancels the unsafe full remainder even when the incoming quantity is below its safe cap', () => {
    const result = planned(run([bid('b', 40)], { qty: 1 }));
    expect(result.plan.result.fills[0]).toMatchObject({ qty: 1, restingRemainingQty: 9 });
    expect(result.botCancellations).toEqual([{ orderId: 'b', ownerId: 'bot', qty: 9 }]);
    expect(result.projectedBook).toEqual({ ...HOLDINGS, coin: 960n, noQty: 1 });
  });

  it('keeps a safe partial remainder and never mutates the source holdings or book', () => {
    const book = [bid('b', 40, 2)];
    const before = structuredClone({ book, holdings: HOLDINGS });
    const result = planned(run(book, { qty: 1 }));
    expect(result.botCancellations).toEqual([]);
    expect(result.plan.result.fills[0]?.restingRemainingQty).toBe(1);
    expect({ book, holdings: HOLDINGS }).toEqual(before);
  });

  it('continues to later human quotes after capped bot fills', () => {
    const result = planned(run([bid('b', 50), ask('a', 60)], { qty: 5 }));
    expect(result.plan.result.fills.map((fill) => [fill.restingOrderId, fill.qty])).toEqual([
      ['b', 2],
      ['a', 3],
    ]);
    expect(result.plan.result.amountCoin).toBe(280n);
    expect(result.botCancellations).toEqual([{ orderId: 'b', ownerId: 'bot', qty: 8 }]);
    expect(result.projectedBook).toEqual({ ...HOLDINGS, coin: 900n, noQty: 2 });
  });

  it('uses the updated holdings after each fill for later risk caps', () => {
    const book = [bid('a', 50, 1), bid('b', 40, 10, 2)];
    const result = planned(run(book));
    // First is zero because second reserves too much; removing it allows exactly two of b.
    expect(result.botCancellations.map((c) => [c.orderId, c.qty])).toEqual([
      ['a', 1],
      ['b', 8],
    ]);
    const remaining: BotOrder[] = [];
    const pnl = reservedPnl(result.projectedBook, remaining, CONTRACT_TERMS);
    expect(Object.values(pnl).every((value) => value >= -100n)).toBe(true);
  });

  it('honors budget affordability before zero-risk cancellation', () => {
    const result = planned(run([bid('a'), bid('b', 40, 10, 2)], { qty: null, budgetCoin: 49n }));
    expect(result.plan.result.stop).toBe('budget_spent');
    expect(result.botCancellations).toEqual([]);
  });

  it('caps a budget buyer and proceeds within the original budget', () => {
    const result = planned(run([bid('b'), ask('a', 60)], { qty: null, budgetCoin: 225n }));
    expect(result.plan.result).toMatchObject({
      filledQty: 4,
      amountCoin: 220n,
      unspentCoin: 5n,
      stop: 'budget_spent',
    });
    expect(result.botCancellations).toEqual([{ orderId: 'b', ownerId: 'bot', qty: 8 }]);
  });

  it('uses the original sell leg for bot trades', () => {
    const botAsk = { ...ask('b', 60, 10), owner: BOT };
    const holdings = { ...HOLDINGS, yesQty: 10, invested: 1500n };
    const result = planned(run([botAsk], { qty: 1 }, holdings, 1000n));
    expect(result.projectedBook).toEqual({ ...holdings, coin: 1060n, yesQty: 9 });
    expect(result.botCancellations).toEqual([]);
  });

  it('preserves arrival order at equal prices and does not count human fills as bot assets', () => {
    const result = planned(run([bid('b', 40, 2, 2), ask('a', 60, 1, 1)], { qty: 2 }));
    expect(result.plan.result.fills.map((fill) => fill.restingOrderId)).toEqual(['a', 'b']);
    expect(result.projectedBook).toEqual({ ...HOLDINGS, coin: 960n, noQty: 1 });
  });

  it('allows ownerless projections without exposing another matching algorithm', () => {
    const result = planned(run([bid('b')], { qty: 1 }, HOLDINGS, 100n, null));
    expect(result.plan.result.filledQty).toBe(1);
    expect(result.botCancellations[0]?.qty).toBe(9);
  });
});

describe('incoming bot admission', () => {
  it('checks the whole quantity at its protected price before any fill or remainder', () => {
    const result = run([ask('a', 40, 1)], { qty: 2 }, HOLDINGS, 100n, BOT);
    expect(result).toMatchObject({
      kind: 'bot_risk_rejected',
      reason: 'loss_limit',
      referencePriceCoin: 40,
      protectedLimitPriceCoin: 60,
      widthTicks: 20,
    });
    expect(result).not.toHaveProperty('plan');
    expect(result).not.toHaveProperty('botCancellations');
  });

  it('admits with the narrowed limit instead of the requested limit', () => {
    const result = planned(run([ask('a', 30, 1)], { qty: 2 }, HOLDINGS, 100n, BOT));
    expect(result.plan.protectedLimitPriceCoin).toBe(50);
    expect(result.projectedBook).toEqual({ ...HOLDINGS, coin: 970n, yesQty: 1 });
  });

  it('reserves the whole GTC remainder against old live bot orders', () => {
    const result = run(
      [bid('old', 50, 1)],
      { qty: 2, timeInForce: 'gtc', limitPriceCoin: 99 },
      HOLDINGS,
      100n,
      BOT,
    );
    expect(result).toMatchObject({ kind: 'bot_risk_rejected' });
  });

  it('returns existing asset refusals with row protection metadata', () => {
    const result = run(
      [ask('a', 40)],
      { qty: 2 },
      { ...HOLDINGS, coin: 100n, invested: 100n },
      1000n,
      BOT,
    );
    expect(result).toMatchObject({
      kind: 'bot_asset_rejected',
      reason: 'insufficient_coin',
      referencePriceCoin: 40,
      protectedLimitPriceCoin: 60,
      widthTicks: 20,
    });
    const sell = run([], { side: 'sell', qty: 1 }, HOLDINGS, 1000n, BOT);
    expect(sell).toMatchObject({ kind: 'bot_asset_rejected', reason: 'insufficient_contracts' });
  });

  it('stops at its own bot group without canceling that order', () => {
    const result = planned(
      run([bid('own', 50, 1)], { qty: 1 }, HOLDINGS, 1000n, { id: 'other-bot', human: false }),
    );
    expect(result.plan.result.stop).toBe('self_trade');
    expect(result.plan.referencePriceCoin).toBe(50);
    expect(result.botCancellations).toEqual([]);
    expect(result.projectedBook).toEqual(HOLDINGS);
  });

  it('checks a budget whole-plan at actual prices without guessing a quantity', () => {
    const result = planned(
      run(
        [ask('a', 30, 1), ask('b', 40, 1, 4)],
        { qty: null, budgetCoin: 99n },
        HOLDINGS,
        80n,
        BOT,
      ),
    );
    expect(result.plan.result).toMatchObject({ filledQty: 2, amountCoin: 70n, unspentCoin: 29n });
    expect(result.projectedBook).toEqual({ ...HOLDINGS, coin: 930n, yesQty: 2 });
  });

  it('atomically discards an earlier safe budget fill when a later actual fill exceeds L', () => {
    const result = run(
      [ask('a', 30, 1), ask('b', 40, 1, 4)],
      { qty: null, budgetCoin: 99n },
      HOLDINGS,
      60n,
      BOT,
    );
    expect(result).toMatchObject({ kind: 'bot_risk_rejected', reason: 'loss_limit' });
    expect(result).not.toHaveProperty('plan');
    expect(result).not.toHaveProperty('projectedBook');
    expect(HOLDINGS.coin).toBe(1000n);
  });

  it('reserves the entire budget even when actual fills would cost less', () => {
    const result = run(
      [ask('a', 30, 1)],
      { qty: null, budgetCoin: 101n },
      { ...HOLDINGS, coin: 100n, invested: 100n },
      1000n,
      BOT,
    );
    expect(result).toMatchObject({ kind: 'bot_asset_rejected', reason: 'insufficient_coin' });
  });

  it('includes untouched live reservations in every budget fill check', () => {
    const old = { ...bid('old', 50, 1), outcome: 'YES' as const };
    const result = run([old, ask('a', 30, 2)], { qty: null, budgetCoin: 60n }, HOLDINGS, 100n, BOT);
    expect(result).toMatchObject({ kind: 'bot_risk_rejected' });
  });

  it('does not hide malformed snapshot errors as risk refusals', () => {
    expect(() => run([], {}, { ...HOLDINGS, coin: -1n })).toThrow(RangeError);
    expect(() => run([], {}, HOLDINGS, 0n)).toThrow(RangeError);
  });
});
