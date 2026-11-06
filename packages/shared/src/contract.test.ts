import { describe, expect, it } from 'vitest';
import { PAYOUT_PER_CONTRACT_COIN, PRICE_MAX, PRICE_MIN, TICK_COIN } from './constants.js';
import {
  CONTRACT_TERMS,
  LIVE_ORDER_STATUSES,
  type OrderLockFacts,
  applyPairBurn,
  isContractPrice,
  isLiveOrderStatus,
  orderIntakeLock,
  orderRemainingLock,
  pairPrices,
  priceImprovementCoin,
} from './contract.js';
import { ORDER_STATUSES } from './enums.js';
import { assertContractTerms } from './market-maker/terms.js';
import { RELEASE_SETTINGS } from './release-settings.js';

describe('CONTRACT_TERMS', () => {
  it('is the approved value (ADR-0107 #177 1항), in step with the shared constants', () => {
    expect(CONTRACT_TERMS).toEqual({
      payoutCoin: 100,
      tickCoin: 1,
      priceMinCoin: 1,
      priceMaxCoin: 99,
      voidPayoutYesCoin: 50,
      voidPayoutNoCoin: 50,
    });
    expect(CONTRACT_TERMS.payoutCoin).toBe(Number(PAYOUT_PER_CONTRACT_COIN));
    expect(CONTRACT_TERMS.tickCoin).toBe(TICK_COIN);
    expect([CONTRACT_TERMS.priceMinCoin, CONTRACT_TERMS.priceMaxCoin]).toEqual([
      PRICE_MIN,
      PRICE_MAX,
    ]);
    expect(() => assertContractTerms(CONTRACT_TERMS)).not.toThrow();
  });

  it('is no release setting: no registered key names a contract value', () => {
    // Only the contract values themselves (#177 1항): the price-protection band #119 registers
    // is a release setting counted in ticks (#177 2항), so 'price' or 'tick' alone is allowed.
    const contractValue = /^contract\.|payout|void|tick_(coin|size)|price_(min|max|range)/;
    for (const key of RELEASE_SETTINGS.keys()) expect(key).not.toMatch(contractValue);
    expect('order.price_protection_ticks').not.toMatch(contractValue);
  });
});

describe('isContractPrice', () => {
  it('takes whole Coin from 1 to 99 only', () => {
    expect([0, 1, 50, 99, 100, 1.5, -1, Number.NaN].map(isContractPrice)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('pairPrices', () => {
  it("funds exactly one pair's collateral at every price", () => {
    for (let p = PRICE_MIN; p <= PRICE_MAX; p += 1) {
      const prices = pairPrices(p);
      expect(prices.YES).toBe(p);
      expect(prices.YES + prices.NO).toBe(CONTRACT_TERMS.payoutCoin);
    }
  });

  it('refuses a YES price that is no contract price', () => {
    for (const p of [0, 100, 1.5, -5]) expect(() => pairPrices(p)).toThrow(RangeError);
  });
});

describe('priceImprovementCoin', () => {
  it("is the N01 §4 example's 5 Coin and grows with qty", () => {
    expect(priceImprovementCoin(65, 60, 1)).toBe(5n);
    expect(priceImprovementCoin(70, 60, 3)).toBe(30n);
    expect(priceImprovementCoin(40, 40, 7)).toBe(0n);
  });

  it('refuses a price above the limit, prices off the grid and a bad qty', () => {
    expect(() => priceImprovementCoin(59, 60, 1)).toThrow(RangeError);
    expect(() => priceImprovementCoin(100, 60, 1)).toThrow(RangeError);
    expect(() => priceImprovementCoin(60, 0, 1)).toThrow(RangeError);
    expect(() => priceImprovementCoin(60, 50, 0)).toThrow(RangeError);
    expect(() => priceImprovementCoin(60, 50, 1.5)).toThrow(RangeError);
  });
});

describe('LIVE_ORDER_STATUSES', () => {
  it('are 대기 and 부분 체결, both order statuses', () => {
    expect(LIVE_ORDER_STATUSES).toEqual(['open', 'partially_filled']);
    for (const status of LIVE_ORDER_STATUSES) expect(ORDER_STATUSES).toContain(status);
    expect(ORDER_STATUSES.filter(isLiveOrderStatus)).toEqual([...LIVE_ORDER_STATUSES]);
    // 만료 (#119's sixth state, a GTC order at the close) has ended, as 거절 has.
    expect(isLiveOrderStatus('expired')).toBe(false);
  });
});

const buy = (over: Partial<OrderLockFacts> = {}): OrderLockFacts => ({
  side: 'buy',
  outcome: 'YES',
  limitPriceCoin: 60,
  qty: 10,
  filledQty: 0,
  budgetCoin: null,
  live: true,
  ...over,
});
const sell = (over: Partial<OrderLockFacts> = {}): OrderLockFacts => ({
  side: 'sell',
  outcome: 'NO',
  limitPriceCoin: 30,
  qty: 4,
  filledQty: 0,
  budgetCoin: null,
  live: true,
  ...over,
});
const budget = (over: Partial<OrderLockFacts> = {}): OrderLockFacts =>
  buy({ limitPriceCoin: null, qty: null, budgetCoin: 1_234n, live: false, ...over });

describe('orderIntakeLock', () => {
  it('locks limit × qty for a quantity buy, the budget for a Coin-amount buy, qty for a sell', () => {
    expect(orderIntakeLock(buy())).toEqual({ kind: 'coin', amountCoin: 600n });
    expect(orderIntakeLock(budget())).toEqual({ kind: 'coin', amountCoin: 1_234n });
    expect(orderIntakeLock(sell())).toEqual({ kind: 'contracts', outcome: 'NO', qty: 4 });
    expect(orderIntakeLock(sell({ limitPriceCoin: null }))).toEqual({
      kind: 'contracts',
      outcome: 'NO',
      qty: 4,
    });
  });

  it('refuses malformed facts', () => {
    for (const facts of [
      sell({ budgetCoin: 10n, qty: null, limitPriceCoin: null }),
      buy({ budgetCoin: 10n }),
      budget({ budgetCoin: 0n }),
      buy({ qty: null }),
      buy({ limitPriceCoin: null }),
      buy({ limitPriceCoin: 100 }),
      sell({ limitPriceCoin: 0 }),
      buy({ qty: 0 }),
      buy({ filledQty: 11 }),
      buy({ filledQty: -1 }),
    ]) {
      expect(() => orderIntakeLock(facts)).toThrow(RangeError);
    }
  });
});

describe('orderRemainingLock', () => {
  it('holds the unfilled part of a live order, at the limit for a buy', () => {
    expect(orderRemainingLock(buy({ filledQty: 3 }))).toEqual({ kind: 'coin', amountCoin: 420n });
    expect(orderRemainingLock(buy({ filledQty: 10 }))).toEqual({ kind: 'coin', amountCoin: 0n });
    expect(orderRemainingLock(sell({ filledQty: 1 }))).toEqual({
      kind: 'contracts',
      outcome: 'NO',
      qty: 3,
    });
  });

  it('holds nothing once an order ended, and never for a Coin-amount buy', () => {
    for (const status of ORDER_STATUSES) {
      const live = isLiveOrderStatus(status);
      expect(orderRemainingLock(buy({ filledQty: 2, live }))).toEqual({
        kind: 'coin',
        amountCoin: live ? 480n : 0n,
      });
      expect(orderRemainingLock(sell({ filledQty: 2, live }))).toEqual({
        kind: 'contracts',
        outcome: 'NO',
        qty: live ? 2 : 0,
      });
      expect(orderRemainingLock(budget({ live }))).toEqual({ kind: 'coin', amountCoin: 0n });
    }
  });
});

describe('applyPairBurn', () => {
  it('releases cost on both sides and realizes payout × qty minus it', () => {
    const yes = { qty: 3, costBasisCoin: 180n, realizedPnlCoin: 0n };
    const no = { qty: 5, costBasisCoin: 150n, realizedPnlCoin: 7n };
    const after = applyPairBurn(yes, no, 2);
    expect(after.YES).toEqual({ qty: 1, costBasisCoin: 60n, realizedPnlCoin: 100n - 120n });
    expect(after.NO).toEqual({ qty: 3, costBasisCoin: 90n, realizedPnlCoin: 7n + 100n - 60n });
    const released = 180n - 60n + (150n - 90n);
    const realized =
      after.YES.realizedPnlCoin +
      after.NO.realizedPnlCoin -
      yes.realizedPnlCoin -
      no.realizedPnlCoin;
    expect(realized).toBe(2n * PAYOUT_PER_CONTRACT_COIN - released);
  });

  it('refuses more pairs than either side holds, and a bad qty', () => {
    const one = { qty: 1, costBasisCoin: 50n, realizedPnlCoin: 0n };
    const two = { qty: 2, costBasisCoin: 100n, realizedPnlCoin: 0n };
    expect(() => applyPairBurn(one, two, 2)).toThrow(RangeError);
    expect(() => applyPairBurn(two, one, 2)).toThrow(RangeError);
    expect(() => applyPairBurn(two, two, 0)).toThrow(RangeError);
  });
});
