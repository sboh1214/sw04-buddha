import { describe, expect, it } from 'vitest';
import {
  matchOrder,
  matchOrderWithBotRisk,
  type BookOrder,
  type BotMatchRiskPolicy,
  type IncomingOrder,
  type MatchFill,
  type OrderOwner,
} from './matching.js';

const HUMAN: OrderOwner = { id: 'human', human: true };
const OTHER: OrderOwner = { id: 'other', human: true };
const BOT: OrderOwner = { id: 'bot', human: false };
const resting = (over: Partial<BookOrder> = {}): BookOrder => ({
  id: 'bot-no',
  owner: BOT,
  outcome: 'NO',
  side: 'buy',
  priceCoin: 50,
  remainingQty: 10,
  arrival: 1,
  ...over,
});
const incoming = (qty = 1, limitPriceCoin = 99): IncomingOrder => ({
  owner: HUMAN,
  outcome: 'YES',
  side: 'buy',
  timeInForce: 'ioc',
  qty,
  budgetCoin: null,
  limitPriceCoin,
});
function policy(cap: number) {
  const caps: string[] = [];
  const fills: MatchFill[] = [];
  const cancels: { id: string; qty: number }[] = [];
  const risk: BotMatchRiskPolicy = {
    maxRestingQty(order) {
      caps.push(order.id);
      return cap;
    },
    onFill(_incoming, _order, fill) {
      fills.push(fill);
    },
    onCancel(order, qty) {
      cancels.push({ id: order.id, qty });
    },
  };
  return { risk, caps, fills, cancels };
}

describe('the shared matcher with an internal bot risk policy', () => {
  it('keeps the default two-argument entry point and result shape', () => {
    const book = [resting()];
    const state = policy(10);
    expect(matchOrder.length).toBe(2);
    expect(matchOrderWithBotRisk(book, incoming(3), state.risk)).toEqual(
      matchOrder(book, incoming(3)),
    );
    expect(state.cancels).toEqual([]);
  });

  it.each([
    { order: incoming(1, 40), stop: 'price_limit' },
    { order: { ...incoming(), qty: null, budgetCoin: 49n } as IncomingOrder, stop: 'budget_spent' },
    { order: { ...incoming(), owner: BOT }, stop: 'self_trade' },
  ])('checks $stop before invoking the risk policy', ({ order, stop }) => {
    const state = policy(0);
    expect(matchOrderWithBotRisk([resting()], order, state.risk)).toMatchObject({
      stop,
      filledQty: 0,
    });
    expect(state.caps).toEqual([]);
    expect(state.fills).toEqual([]);
    expect(state.cancels).toEqual([]);
  });

  it('cancels a zero-cap bot entry and continues to a later human quote', () => {
    const state = policy(0);
    const result = matchOrderWithBotRisk(
      [
        resting(),
        resting({
          id: 'human-yes',
          owner: OTHER,
          outcome: 'YES',
          side: 'sell',
          priceCoin: 60,
          arrival: 2,
        }),
      ],
      incoming(1),
      state.risk,
    );
    expect(result).toMatchObject({
      filledQty: 1,
      amountCoin: 60n,
      stop: 'filled',
      counterpartyOwnerIds: ['other'],
    });
    expect(result.fills).toHaveLength(1);
    expect(state.caps).toEqual(['bot-no']);
    expect(state.cancels).toEqual([{ id: 'bot-no', qty: 10 }]);
  });

  it('cancels an unsafe remainder even when the incoming order takes less than the safe allowance', () => {
    const state = policy(2);
    const result = matchOrderWithBotRisk([resting()], incoming(1), state.risk);
    expect(result.fills[0]).toMatchObject({ qty: 1, restingRemainingQty: 9 });
    expect(state.cancels).toEqual([{ id: 'bot-no', qty: 9 }]);
    expect(result).not.toHaveProperty('botCancellations');
  });

  it('retains a normally reserved partial remainder', () => {
    const state = policy(10);
    expect(matchOrderWithBotRisk([resting()], incoming(1), state.risk).fills[0]).toMatchObject({
      qty: 1,
      restingRemainingQty: 9,
    });
    expect(state.cancels).toEqual([]);
  });

  it.each([-1, 0.5, 11, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid or quantity-widening cap %s',
    (cap) => {
      expect(() => matchOrderWithBotRisk([resting()], incoming(), policy(cap).risk)).toThrow(
        RangeError,
      );
    },
  );

  it('never applies a bot cap to a human order', () => {
    const state = policy(0);
    const book = [resting({ owner: OTHER })];
    expect(matchOrderWithBotRisk(book, incoming(1), state.risk)).toEqual(
      matchOrder(book, incoming(1)),
    );
    expect(state.caps).toEqual([]);
    expect(state.cancels).toEqual([]);
  });
});
