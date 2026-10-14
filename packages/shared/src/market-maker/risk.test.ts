import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OUTCOMES, ORDER_SIDES } from '../enums.js';
import { type LadderSettings, type QuoteLadder, type QuoteLevel, quoteLadder } from './ladder.js';
import {
  type BotBook,
  type BotOrder,
  type ByResult,
  type LiveBotOrder,
  type PlanBotOrder,
  RESULT_SCENARIOS,
  type RiskLimits,
  assertBotBook,
  assertRiskLimits,
  botRisk,
  checkBotOrder,
  maxBotFillQty,
  orderPnlDelta,
  planBotQuotes,
  reconcileBotQuotes,
  reservedPnl,
  resultPnl,
  riskStage,
  worstLoss,
} from './risk.js';
import { type ContractTerms, PROPOSED_CONTRACT_TERMS } from './terms.js';

// New checks of the new rules (N01 §10, ADR-0058): nothing from the direct-AMM era is reused.
const RUNS = { numRuns: 400 };
const T = PROPOSED_CONTRACT_TERMS;
const LIMITS: RiskLimits = {
  maxLoss: 1_000n,
  reduceAtBp: 7_000,
  haltAtBp: 9_000,
  reduceRatioBp: 5_000,
};

const book = (over: Partial<BotBook> = {}): BotBook => ({
  coin: 10_000n,
  yesQty: 0,
  noQty: 0,
  invested: 10_000n,
  recovered: 0n,
  ...over,
});
const buy = (outcome: 'YES' | 'NO', priceCoin: number, qty: number): BotOrder => ({
  outcome,
  side: 'buy',
  priceCoin,
  qty,
});

const bookArb: fc.Arbitrary<BotBook> = fc.record({
  coin: fc.bigInt({ min: 0n, max: 200_000n }),
  yesQty: fc.integer({ min: 0, max: 1_500 }),
  noQty: fc.integer({ min: 0, max: 1_500 }),
  invested: fc.bigInt({ min: 0n, max: 200_000n }),
  recovered: fc.bigInt({ min: 0n, max: 20_000n }),
});
const orderArb: fc.Arbitrary<BotOrder> = fc.record({
  outcome: fc.constantFrom(...OUTCOMES),
  side: fc.constantFrom(...ORDER_SIDES),
  priceCoin: fc.integer({ min: 1, max: 99 }),
  qty: fc.integer({ min: 1, max: 40 }),
});
const buyArb: fc.Arbitrary<BotOrder> = orderArb.map((o) => ({ ...o, side: 'buy' as const }));
const limitsArb: fc.Arbitrary<RiskLimits> = fc
  .record({
    maxLoss: fc.bigInt({ min: 1n, max: 50_000n }),
    a: fc.integer({ min: 0, max: 10_000 }),
    b: fc.integer({ min: 0, max: 10_000 }),
    reduceRatioBp: fc.integer({ min: 0, max: 5_000 }),
  })
  .map(({ maxLoss, a, b, reduceRatioBp }) => ({
    maxLoss,
    reduceAtBp: Math.min(a, b),
    haltAtBp: Math.max(a, b),
    reduceRatioBp,
  }));
/**
 * Terms on which every order of `orderArb` (prices 1–99) is valid: payout 100 or 200, tick 1,
 * any VOID split. The payouts per result are what a wrong mapping would get wrong.
 */
const termsArb: fc.Arbitrary<ContractTerms> = fc
  .record({
    payout: fc.constantFrom(100, 200),
    voidYes: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map(({ payout, voidYes }) => {
    const voidPayoutYesCoin = Math.round(voidYes * payout);
    return {
      payoutCoin: payout,
      tickCoin: 1,
      priceMinCoin: 1,
      priceMaxCoin: payout - 1,
      voidPayoutYesCoin,
      voidPayoutNoCoin: payout - voidPayoutYesCoin,
    };
  });
const ladderSettingsArb: fc.Arbitrary<LadderSettings> = fc.record({
  b: fc.double({ min: 2, max: 500, noNaN: true }),
  safetyTicks: fc.integer({ min: 0, max: 2 }),
  levels: fc.integer({ min: 1, max: 12 }),
  quantity: fc.integer({ min: 1, max: 60 }),
});

/** Applies a fill of `qty` of `order` to the book, then burns the pairs (ADR-0058 결정 1의 6). */
function fill(state: BotBook, order: BotOrder, qty: number): BotBook {
  const cost = BigInt(order.priceCoin) * BigInt(qty);
  const sign = order.side === 'buy' ? 1 : -1;
  let next: BotBook = {
    ...state,
    coin: order.side === 'buy' ? state.coin - cost : state.coin + cost,
    yesQty: state.yesQty + (order.outcome === 'YES' ? sign * qty : 0),
    noQty: state.noQty + (order.outcome === 'NO' ? sign * qty : 0),
  };
  const pairs = Math.min(next.yesQty, next.noQty);
  next = {
    ...next,
    yesQty: next.yesQty - pairs,
    noQty: next.noQty - pairs,
    coin: next.coin + BigInt(pairs) * BigInt(T.payoutCoin),
  };
  return next;
}

/** Orders whose cancel is pending: still live (ADR-0058 결정 1의 7). */
const pend = (orders: readonly BotOrder[]): PlanBotOrder[] =>
  orders.map((order) => ({ ...order, cancelPending: true }));

const asOrders = (plan: Pick<QuoteLadder, 'yesBids' | 'noBids'>): BotOrder[] => [
  ...plan.yesBids.map((l) => buy('YES', l.priceCoin, l.qty)),
  ...plan.noBids.map((l) => buy('NO', l.priceCoin, l.qty)),
];
const total = (levels: readonly { qty: number }[]) => levels.reduce((s, l) => s + l.qty, 0);

/** Every result either ends within L or does not get worse (결정 1의 10, 결정 2). */
function expectWithinOrNoWorse(
  after: ByResult<bigint>,
  before: ByResult<bigint>,
  maxLoss: bigint,
): void {
  for (const result of RESULT_SCENARIOS) {
    expect(after[result] >= -maxLoss || after[result] >= before[result], result).toBe(true);
  }
}

describe('result PnL and worst loss (N01 §7)', () => {
  it('starts at zero on every result with the whole allocation in Coin', () => {
    expect(resultPnl(book(), T)).toEqual({ YES: 0n, NO: 0n, VOID: 0n });
    expect(worstLoss(resultPnl(book(), T))).toBe(0n);
  });

  it('counts Coin, contracts at their payout and the vault, never collateral twice', () => {
    // Bought 10 YES at 40: YES pays 1,000, VOID 500.
    const held = book({ coin: 9_600n, yesQty: 10 });
    expect(resultPnl(held, T)).toEqual({ YES: 600n, NO: -400n, VOID: 100n });
    expect(worstLoss(resultPnl(held, T))).toBe(400n);
    // Burning a pair changes no result: 1 YES + 1 NO ↔ 100 Coin.
    const paired = book({ coin: 9_500n, yesQty: 3, noQty: 3, recovered: 0n });
    const burned = book({ coin: 9_800n, yesQty: 0, noQty: 0 });
    expect(resultPnl(paired, T)).toEqual(resultPnl(burned, T));
    // Coin already returned to the vault counts (순손익 = 회수액 + 회수한 자금 − 투입).
    expect(resultPnl(book({ coin: 0n, recovered: 10_000n }), T)).toEqual({
      YES: 0n,
      NO: 0n,
      VOID: 0n,
    });
  });

  it('pays each result by its own payout, VOID included (N03 §6, #173)', () => {
    const voidSplit: ContractTerms = { ...T, voidPayoutYesCoin: 30, voidPayoutNoCoin: 70 };
    // 10 YES pay 300 on VOID: 9,600 + 300 − 10,000.
    expect(resultPnl(book({ coin: 9_600n, yesQty: 10 }), voidSplit)).toEqual({
      YES: 600n,
      NO: -400n,
      VOID: -100n,
    });
    fc.assert(
      fc.property(bookArb, termsArb, (s, terms) => {
        const base = s.coin + s.recovered - s.invested;
        const yes = BigInt(s.yesQty);
        const no = BigInt(s.noQty);
        expect(resultPnl(s, terms)).toEqual({
          YES: base + yes * BigInt(terms.payoutCoin),
          NO: base + no * BigInt(terms.payoutCoin),
          VOID: base + yes * BigInt(terms.voidPayoutYesCoin) + no * BigInt(terms.voidPayoutNoCoin),
        });
      }),
      RUNS,
    );
  });

  it('moves each result by the order at its own price', () => {
    expect(orderPnlDelta(buy('YES', 40, 2), T)).toEqual({ YES: 120n, NO: -80n, VOID: 20n });
    expect(orderPnlDelta(buy('NO', 70, 1), T)).toEqual({ YES: -70n, NO: 30n, VOID: -20n });
    expect(orderPnlDelta({ outcome: 'YES', side: 'sell', priceCoin: 60, qty: 1 }, T)).toEqual({
      YES: -40n,
      NO: 60n,
      VOID: 10n,
    });
  });
});

describe('reservedPnl (결정 1의 9)', () => {
  it('lets each result take every resting order that loses on it', () => {
    const held = book({ coin: 9_600n, yesQty: 10 });
    const orders = [buy('NO', 45, 10), buy('YES', 35, 10)];
    // YES: 600 − 450 (the NO bids); NO: −400 − 350 (the YES bids); VOID: both gain.
    expect(reservedPnl(held, orders, T)).toEqual({ YES: 150n, NO: -750n, VOID: 100n });
  });

  it('is a floor no fill order or partial fill can go below, and the worst case reaches it', () => {
    fc.assert(
      fc.property(
        bookArb,
        fc.array(fc.tuple(orderArb, fc.double({ min: 0, max: 1, noNaN: true })), {
          maxLength: 8,
        }),
        termsArb,
        (state, picks, T) => {
          const orders = picks.map(([o]) => o);
          const floor = reservedPnl(state, orders, T);
          // Any partial fills (sells may exceed holdings here: PnL is linear either way).
          const filled = picks.reduce(
            (pnl, [o, share]) => {
              const qty = Math.floor(o.qty * share);
              const delta = orderPnlDelta({ ...o, qty: Math.max(qty, 1) }, T);
              return qty === 0
                ? pnl
                : { YES: pnl.YES + delta.YES, NO: pnl.NO + delta.NO, VOID: pnl.VOID + delta.VOID };
            },
            resultPnl(state, T),
          );
          for (const result of RESULT_SCENARIOS) {
            expect(filled[result] >= floor[result]).toBe(true);
            // Filling exactly the orders that lose on this result reaches the floor.
            const worst = orders.reduce((pnl, o) => {
              const d = orderPnlDelta(o, T)[result];
              return d < 0n ? pnl + d : pnl;
            }, resultPnl(state, T)[result]);
            expect(worst).toBe(floor[result]);
          }
        },
      ),
      RUNS,
    );
  });
});

describe('riskStage and botRisk (결정 1의 8·12)', () => {
  it('splits the utilization at 70% and 90% of L, holdings only', () => {
    expect(riskStage(0n, LIMITS)).toBe('normal');
    expect(riskStage(699n, LIMITS)).toBe('normal');
    expect(riskStage(700n, LIMITS)).toBe('reduce');
    expect(riskStage(899n, LIMITS)).toBe('reduce');
    expect(riskStage(900n, LIMITS)).toBe('halt');
    expect(riskStage(5_000n, LIMITS)).toBe('halt');
  });

  it('follows whatever thresholds the release settings give', () => {
    const other = { ...LIMITS, reduceAtBp: 5_000, haltAtBp: 6_000 };
    expect(riskStage(499n, other)).toBe('normal');
    expect(riskStage(500n, other)).toBe('reduce');
    expect(riskStage(600n, other)).toBe('halt');
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 100_000n }), limitsArb, (loss, l) => {
        const at = (bp: number) => loss * 10_000n >= BigInt(bp) * l.maxLoss;
        expect(riskStage(loss, l)).toBe(
          at(l.haltAtBp) ? 'halt' : at(l.reduceAtBp) ? 'reduce' : 'normal',
        );
      }),
      RUNS,
    );
  });

  it('reports holdings and reserved figures, and ignores orders for the stage', () => {
    const held = book({ coin: 9_600n, yesQty: 10 });
    const risk = botRisk(held, [buy('NO', 45, 10), buy('YES', 35, 10)], LIMITS, T);
    expect(risk).toEqual({
      pnl: { YES: 600n, NO: -400n, VOID: 100n },
      worstLoss: 400n,
      reservedPnl: { YES: 150n, NO: -750n, VOID: 100n },
      reservedWorstLoss: 750n,
      utilizationBp: 4_000n,
      stage: 'normal',
    });
    expect(botRisk(held, [], LIMITS, T).stage).toBe(risk.stage);
  });

  it('keeps reading above 100% once L was lowered', () => {
    const risk = botRisk(book({ coin: 9_000n, yesQty: 10 }), [], { ...LIMITS, maxLoss: 500n }, T);
    expect(risk.worstLoss).toBe(1_000n);
    expect(risk.utilizationBp).toBe(20_000n);
    expect(risk.stage).toBe('halt');
  });
});

describe('checkBotOrder (N01 §7: 새 주문의 자산·한도 검사)', () => {
  const held = book({ coin: 9_600n, yesQty: 10 }); // worst NO −400

  it('accepts what fits and names what does not', () => {
    expect(checkBotOrder(held, [], buy('YES', 30, 10), LIMITS, T)).toBe('ok');
    // NO −400 − 30·21 = −1,030 < −1,000.
    expect(checkBotOrder(held, [], buy('YES', 30, 21), LIMITS, T)).toBe('loss_limit');
    // The resting bid's reservation counts: −400 − 300 − 30·11.
    expect(checkBotOrder(held, [buy('YES', 30, 10)], buy('YES', 30, 11), LIMITS, T)).toBe(
      'loss_limit',
    );
    // Coin locked in live orders is not free: 9,600 − 9,500 < 30·5.
    expect(checkBotOrder(held, [buy('NO', 95, 100)], buy('YES', 30, 5), LIMITS, T)).toBe(
      'insufficient_coin',
    );
    const sellYes = { outcome: 'YES', side: 'sell', priceCoin: 60, qty: 6 } as const;
    expect(checkBotOrder(held, [{ ...sellYes, qty: 5 }], sellYes, LIMITS, T)).toBe(
      'insufficient_contracts',
    );
    expect(checkBotOrder(held, [], { ...sellYes, outcome: 'NO' }, LIMITS, T)).toBe(
      'insufficient_contracts',
    );
  });

  it('lets a bot already past a lowered L reduce, never add (결정 2)', () => {
    const lowered = { ...LIMITS, maxLoss: 300n }; // NO is at −400
    // Buying NO gains on NO; on YES it ends at 600 − 50·5 = 350, within L.
    expect(checkBotOrder(held, [], buy('NO', 50, 5), lowered, T)).toBe('ok');
    // One NO bid leaves NO at −400 (still past L): it does not lower NO, but does not add to it.
    expect(checkBotOrder(held, [], buy('NO', 50, 1), lowered, T)).toBe('ok');
    expect(checkBotOrder(held, [], buy('YES', 1, 1), lowered, T)).toBe('loss_limit');
  });

  it('accepts every order the assets cover that keeps each result within L or no worse', () => {
    fc.assert(
      fc.property(
        bookArb,
        fc.array(buyArb, { maxLength: 6 }),
        buyArb,
        limitsArb,
        termsArb,
        (s, live, o, l, T) => {
          const locked = live.reduce((sum, x) => sum + BigInt(x.priceCoin * x.qty), 0n);
          fc.pre(BigInt(o.priceCoin * o.qty) <= s.coin - locked);
          const before = reservedPnl(s, live, T);
          const delta = orderPnlDelta(o, T);
          const fits = RESULT_SCENARIOS.every(
            (r) => delta[r] >= 0n || before[r] + delta[r] >= -l.maxLoss,
          );
          expect(checkBotOrder(s, live, o, l, T)).toBe(fits ? 'ok' : 'loss_limit');
        },
      ),
      RUNS,
    );
  });

  it('never lets reserved losses end past L or grow past it', () => {
    fc.assert(
      fc.property(
        bookArb,
        fc.array(buyArb, { maxLength: 6 }),
        orderArb,
        limitsArb,
        termsArb,
        (s, live, o, l, T) => {
          if (checkBotOrder(s, live, o, l, T) !== 'ok') return;
          expectWithinOrNoWorse(
            reservedPnl(s, [...live, o], T),
            reservedPnl(s, live, T),
            l.maxLoss,
          );
        },
      ),
      RUNS,
    );
  });
});

describe('maxBotFillQty (결정 1의 13)', () => {
  const held = book({ coin: 9_600n, yesQty: 10 }); // NO −400
  const bid = buy('YES', 30, 20);

  it('fills a properly reserved order in full', () => {
    // Registered when the reservation was −400 − 600 = −1,000.
    expect(maxBotFillQty(held, [], bid, 20, LIMITS, T)).toBe(20);
    expect(maxBotFillQty(held, [], bid, 7, LIMITS, T)).toBe(7);
    expect(maxBotFillQty(held, [], bid, 99, LIMITS, T)).toBe(20);
  });

  it('cuts the fill at L after L was lowered, and to nothing once past it', () => {
    expect(maxBotFillQty(held, [], bid, 20, { ...LIMITS, maxLoss: 700n }, T)).toBe(10);
    expect(maxBotFillQty(held, [], bid, 20, { ...LIMITS, maxLoss: 400n }, T)).toBe(0);
    expect(maxBotFillQty(held, [], bid, 20, { ...LIMITS, maxLoss: 300n }, T)).toBe(0);
    // A NO bid gains on NO, the result past L, so it still fills.
    expect(maxBotFillQty(held, [], buy('NO', 50, 5), 5, { ...LIMITS, maxLoss: 300n }, T)).toBe(5);
  });

  it('cuts fills that start near the limit exactly where a result would pass it', () => {
    fc.assert(
      fc.property(
        bookArb,
        fc.array(buyArb, { maxLength: 4 }),
        buyArb,
        fc.integer({ min: 0, max: 300 }),
        termsArb,
        (s, others, o, extra, T) => {
          const base = reservedPnl(s, others, T);
          // L just above the worst reserved loss without the order: the order rarely fits whole.
          const l = { ...LIMITS, maxLoss: worstLoss(base) + BigInt(extra) + 1n };
          const step = orderPnlDelta({ ...o, qty: 1 }, T);
          const expected = RESULT_SCENARIOS.reduce((n, r) => {
            if (step[r] >= 0n) return n;
            const room = base[r] + l.maxLoss;
            return Math.min(n, room <= 0n ? 0 : Number(room / -step[r]));
          }, o.qty);
          expect(maxBotFillQty(s, others, o, o.qty, l, T)).toBe(expected);
        },
      ),
      RUNS,
    );
  });

  it('is the largest fill that, with the remainder cancelled, keeps every result in bounds', () => {
    fc.assert(
      fc.property(
        bookArb,
        fc.array(buyArb, { maxLength: 6 }),
        orderArb,
        fc.integer({ min: 0, max: 60 }),
        limitsArb,
        termsArb,
        (s, others, o, requested, l, T) => {
          const n = maxBotFillQty(s, others, o, requested, l, T);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThanOrEqual(Math.min(requested, o.qty));
          const base = reservedPnl(s, others, T);
          const at = (k: number) => {
            const d = orderPnlDelta({ ...o, qty: 1 }, T);
            const kk = BigInt(k);
            return {
              YES: base.YES + kk * d.YES,
              NO: base.NO + kk * d.NO,
              VOID: base.VOID + kk * d.VOID,
            };
          };
          expectWithinOrNoWorse(at(n), base, l.maxLoss);
          if (n < Math.min(requested, o.qty)) {
            const over = at(n + 1);
            expect(RESULT_SCENARIOS.some((r) => over[r] < -l.maxLoss && over[r] < base[r])).toBe(
              true,
            );
          }
        },
      ),
      RUNS,
    );
  });
});

describe('planBotQuotes (결정 1의 6·7·10·11, 결정 2)', () => {
  const settings: LadderSettings = { b: 20, safetyTicks: 0, levels: 20, quantity: 20 };
  const ladderAt = (state: BotBook, over: Partial<LadderSettings> = {}) =>
    quoteLadder(state.noQty - state.yesQty, { ...settings, ...over }, T);
  const unitsOf = (levels: readonly QuoteLevel[]) =>
    levels.flatMap((l) => Array<number>(l.qty).fill(l.priceCoin));
  const spent = (levels: readonly QuoteLevel[]) =>
    levels.reduce((s, l) => s + l.priceCoin * l.qty, 0);
  /** Each contract kept, filled in order from `state`, does not raise the worst loss. */
  const expectEachLowers = (state: BotBook, outcome: 'YES' | 'NO', kept: readonly QuoteLevel[]) => {
    let at = state;
    for (const price of unitsOf(kept)) {
      const next = fill(at, buy(outcome, price, 1), 1);
      expect(worstLoss(resultPnl(next, T)) <= worstLoss(resultPnl(at, T))).toBe(true);
      at = next;
    }
  };

  it('keeps the whole ladder when the bot is well within L and Coin', () => {
    const ladder = ladderAt(book());
    const plan = planBotQuotes(ladder, book(), [], 20, { ...LIMITS, maxLoss: 10_000n }, T);
    expect(plan).toEqual({
      stage: 'normal',
      overLimit: false,
      first: 'yesBids',
      yesBids: ladder.yesBids,
      noBids: ladder.noBids,
    });
  });

  it('stops each direction where L would be passed, the far contracts first', () => {
    const ladder = ladderAt(book());
    const plan = planBotQuotes(ladder, book(), [], 20, { ...LIMITS, maxLoss: 300n }, T);
    // From balance every YES bid loses its price on NO, every NO bid on YES.
    expect(total(plan.yesBids)).toBeLessThan(total(ladder.yesBids));
    expect(total(plan.noBids)).toBeLessThan(total(ladder.noBids));
    expect(worstLoss(reservedPnl(book(), asOrders(plan), T))).toBeLessThanOrEqual(300n);
    const next = unitsOf(ladder.yesBids)[total(plan.yesBids)]!;
    expect(spent(plan.yesBids) + next).toBeGreaterThan(300);
    expect(plan.yesBids[0]?.priceCoin).toBe(ladder.yesBids[0]?.priceCoin);
  });

  it('spends short Coin on the risk-lowering direction first: NO bids for a bot long YES', () => {
    // Long 30 YES (bought at 50): NO is the worst result, so NO bids lower the risk.
    const state = book({ coin: 300n, yesQty: 30, invested: 1_800n });
    const ladder = ladderAt(state);
    const plan = planBotQuotes(ladder, state, [], 20, { ...LIMITS, maxLoss: 10_000n }, T);
    expect(plan.first).toBe('noBids');
    const noUnits = unitsOf(ladder.noBids);
    const kept = total(plan.noBids);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(noUnits.length);
    expect(spent(plan.noBids) + noUnits[kept]!).toBeGreaterThan(300);
    expect(spent(plan.yesBids)).toBeLessThanOrEqual(300 - spent(plan.noBids));
  });

  it('and YES bids for a bot long NO, down to the last Coin', () => {
    // Long 30 NO: YES is the worst result (−1,500), so YES bids lower the risk.
    const state = book({ coin: 300n, noQty: 30, invested: 1_800n });
    const ladder = ladderAt(state);
    const plan = planBotQuotes(ladder, state, [], 20, { ...LIMITS, maxLoss: 10_000n }, T);
    expect(plan.first).toBe('yesBids');
    const yesUnits = unitsOf(ladder.yesBids);
    const kept = total(plan.yesBids);
    expect(kept).toBeGreaterThan(0);
    expect(spent(plan.yesBids) + yesUnits[kept]!).toBeGreaterThan(300);
    expect(spent(plan.noBids)).toBeLessThanOrEqual(300 - spent(plan.yesBids));
    // A contract priced at exactly the Coin left is still affordable.
    const exact = book({ coin: BigInt(yesUnits[0]! + yesUnits[1]!), noQty: 30, invested: 1_800n });
    const tight = planBotQuotes(ladderAt(exact), exact, [], 20, { ...LIMITS, maxLoss: 10_000n }, T);
    expect(unitsOf(tight.yesBids)).toEqual(yesUnits.slice(0, 2));
    expect(tight.noBids).toEqual([]);
  });

  it('cuts the risk-raising contracts to 기본 물량 × ratio at reduce and to none at halt', () => {
    // Long 15 YES bought at 52: worst NO −780 of L 1,000 → 78%, reduce.
    const reduce = book({ coin: 9_220n, yesQty: 15 });
    expect(botRisk(reduce, [], LIMITS, T).stage).toBe('reduce');
    const ladder = ladderAt(reduce);
    const plan = (reduceRatioBp: number) =>
      planBotQuotes(ladder, reduce, [], 20, { ...LIMITS, reduceRatioBp }, T);
    // YES bids only add to the NO loss: the ratio caps them (at 50% L caps them first, at 8).
    expect(total(plan(5_000).yesBids)).toBe(8);
    expect(total(plan(2_500).yesBids)).toBe(5);
    expect(total(plan(0).yesBids)).toBe(0);
    // NO bids first unwind the YES (15 lower the risk), then add up to 20 × ratio raising ones.
    expect(total(plan(0).noBids)).toBe(15);
    expect(total(plan(5_000).noBids)).toBe(20);
    expectEachLowers(reduce, 'NO', plan(0).noBids);

    // Long 19 YES at 50 (−950 → 95%, halt): only risk-lowering NO bids.
    const halt = book({ coin: 9_050n, yesQty: 19 });
    const halted = planBotQuotes(ladderAt(halt), halt, [], 20, LIMITS, T);
    expect(halted.stage).toBe('halt');
    expect(halted.yesBids).toEqual([]);
    expect(total(halted.noBids)).toBeGreaterThan(0);
    expectEachLowers(halt, 'NO', halted.noBids);
  });

  it('counts pending risk-raising cancels against the reduce budget', () => {
    // Long 150 YES bought at 52: −7,800 of L 10,000 → 78%, reduce; L leaves room for many more.
    const state = book({ coin: 92_200n, yesQty: 150, invested: 100_000n });
    const ladder = quoteLadder(-150, { ...settings, b: 200 }, T);
    const wide = { ...LIMITS, maxLoss: 10_000n };
    expect(total(planBotQuotes(ladder, state, [], 20, wide, T).yesBids)).toBe(10);
    // Four pending YES bids at 40 fill ahead and each raises the NO loss: 10 − 4 new ones.
    expect(
      total(planBotQuotes(ladder, state, pend([buy('YES', 40, 4)]), 20, wide, T).yesBids),
    ).toBe(6);
    // At 20 they stand behind the new bids (32–29) and may raise it when they fill: also 6.
    expect(
      total(planBotQuotes(ladder, state, pend([buy('YES', 20, 4)]), 20, wide, T).yesBids),
    ).toBe(6);
  });

  it('treats a contract that leaves the worst loss where it is as not raising it', () => {
    // In profit on every result (+500) with both thresholds at 0%: halt from the start. YES bids
    // keep the worst loss at 0 until the NO result goes below zero.
    const profit = book({ coin: 10_500n });
    const halted = { ...LIMITS, reduceAtBp: 0, haltAtBp: 0 };
    const plan = planBotQuotes(ladderAt(profit), profit, [], 20, halted, T);
    expect(plan.stage).toBe('halt');
    expect(spent(plan.yesBids)).toBeLessThanOrEqual(500);
    expect(
      spent(plan.yesBids) + unitsOf(ladderAt(profit).yesBids)[total(plan.yesBids)]!,
    ).toBeGreaterThan(500);
  });

  it('lets a bot past a lowered L unwind (결정 2)', () => {
    const held = book({ coin: 9_600n, yesQty: 10 }); // NO −400, L lowered to 300
    const plan = planBotQuotes(ladderAt(held), held, [], 20, { ...LIMITS, maxLoss: 300n }, T);
    expect(plan.overLimit).toBe(true);
    expect(plan.yesBids).toEqual([]);
    expect(total(plan.noBids)).toBeGreaterThan(0);
    expectEachLowers(held, 'NO', plan.noBids);
  });

  it('plans only risk-lowering quotes while a reserved loss is past L, whatever the stage', () => {
    // Pending YES bids reserve −500 on NO; L lowered to 300. Holdings are balanced: 0%, normal.
    const pending = pend([buy('YES', 50, 10)]);
    const past = planBotQuotes(
      ladderAt(book()),
      book(),
      pending,
      20,
      { ...LIMITS, maxLoss: 300n },
      T,
    );
    expect([past.stage, past.overLimit]).toEqual(['normal', true]);
    // From balance every contract raises the worst loss, so nothing goes out.
    expect([past.yesBids, past.noBids]).toEqual([[], []]);
    const within = planBotQuotes(ladderAt(book()), book(), pending, 20, LIMITS, T);
    expect(within.overLimit).toBe(false);
    expect(total(within.noBids)).toBeGreaterThan(0);

    // Long 2 YES (NO −100, 10%): NO bids lower the risk and still go out, YES bids do not.
    const long = book({ coin: 9_900n, yesQty: 2 });
    const unwind = planBotQuotes(
      ladderAt(long),
      long,
      pend([buy('YES', 50, 5)]),
      20,
      {
        ...LIMITS,
        maxLoss: 300n,
      },
      T,
    );
    expect([unwind.stage, unwind.overLimit]).toEqual(['normal', true]);
    expect(unwind.yesBids).toEqual([]);
    expect(total(unwind.noBids)).toBeGreaterThan(0);
    expectEachLowers(long, 'NO', unwind.noBids);
  });

  it('judges past-L with every live order, as in the bids-only example of 결정 2', () => {
    // The bot rests its whole L = 10,000 plan (YES −750, NO −750 reserved) at 0% utilization,
    // then L is lowered to 300. Nothing new may raise the risk, and every live bid is cancelled.
    const ladder = ladderAt(book());
    const resting = planBotQuotes(ladder, book(), [], 20, { ...LIMITS, maxLoss: 10_000n }, T);
    const live = asOrders(resting).map((o, i): LiveBotOrder => ({ id: String(i), ...o }));
    const lowered = { ...LIMITS, maxLoss: 300n };
    const plan = planBotQuotes(ladder, book(), live, 20, lowered, T);
    expect([plan.stage, plan.overLimit]).toEqual(['normal', true]);
    expect([plan.yesBids, plan.noBids]).toEqual([[], []]);
    const changes = reconcileBotQuotes(plan, live);
    expect(changes.place).toEqual([]);
    expect(changes.cancel).toEqual(live.map((o) => ({ id: o.id, qty: o.qty })));
    // While those cancels are pending the book is still past L: still nothing new.
    const waiting = live.map((o) => ({ ...o, cancelPending: true }));
    expect(planBotQuotes(ladder, book(), waiting, 20, lowered, T).overLimit).toBe(true);
    // Once they are gone the bot quotes again within the new L.
    const after = planBotQuotes(ladder, book(), [], 20, lowered, T);
    expect(after.overLimit).toBe(false);
    expect(worstLoss(reservedPnl(book(), asOrders(after), T))).toBeLessThanOrEqual(300n);
  });

  it('puts pending cancels on the path by price and posts that many fewer contracts', () => {
    const ladder = ladderAt(book());
    const units = unitsOf(ladder.yesBids);
    const wide = { ...LIMITS, maxLoss: 10_000n };
    // Below the ladder: they fill last, and the new contracts are the ladder's first five.
    const low = planBotQuotes(ladder, book(), pend([buy('YES', 10, 15)]), 20, wide, T);
    expect(unitsOf(low.yesBids)).toEqual(units.slice(0, 5));
    expect(low.noBids).toEqual(ladder.noBids);
    // Above it: they fill first, so the new contracts take the curve from the fourth on.
    const high = planBotQuotes(ladder, book(), pend([buy('YES', 60, 3)]), 20, wide, T);
    expect(unitsOf(high.yesBids)).toEqual(units.slice(3, 20));
  });

  it('stands a pending sell where the matching bid would, a tie going to the older order', () => {
    // Selling YES at x supplies YES buyers like a NO bid at 100 − x does: same direction.
    const state = book({ coin: 9_850n, yesQty: 3 });
    const ladder = ladderAt(state);
    const curve = unitsOf(ladder.noBids);
    const sell: BotOrder = { outcome: 'YES', side: 'sell', priceCoin: 100 - curve[1]!, qty: 3 };
    const plan = planBotQuotes(ladder, state, pend([sell]), 20, { ...LIMITS, maxLoss: 10_000n }, T);
    expect(unitsOf(plan.noBids)).toEqual([curve[0], ...curve.slice(4, 20)]);
  });

  it('adds nothing at halt while pending cancels already unwind the risk', () => {
    // Halt (95%): the plan is 19 risk-lowering NO bids. With the safety raised every price
    // changes, so all 19 are pending a cancel; past them the curve only raises the risk again.
    const halt = book({ coin: 9_050n, yesQty: 19 });
    const wide = { quantity: 40, levels: 40 };
    const first = planBotQuotes(ladderAt(halt, wide), halt, [], 40, LIMITS, T);
    expect(total(first.noBids)).toBe(19);
    const pending = pend(asOrders(first));
    const again = planBotQuotes(
      ladderAt(halt, { ...wide, safetyTicks: 3 }),
      halt,
      pending,
      40,
      LIMITS,
      T,
    );
    expect(again.noBids).toEqual([]);
  });

  it('keeps every plan within L, the Coin, 기본 물량, the curve and the stage', () => {
    /** Pending and new contracts of one outcome in the order they fill: price, then age. */
    const pathOf = (
      outcome: 'YES' | 'NO',
      pending: readonly BotOrder[],
      kept: readonly QuoteLevel[],
    ) =>
      [
        ...pending
          .filter((o) => o.outcome === outcome)
          .flatMap((o) =>
            Array.from({ length: o.qty }, () => ({ price: o.priceCoin, isNew: false })),
          ),
        ...unitsOf(kept).map((price) => ({ price, isNew: true })),
      ].sort((a, b) => b.price - a.price || Number(a.isNew) - Number(b.isNew));
    fc.assert(
      fc.property(
        bookArb,
        fc.array(buyArb, { maxLength: 4 }),
        fc.array(buyArb, { maxLength: 3 }),
        ladderSettingsArb,
        limitsArb,
        fc.integer({ min: 1, max: 12_000 }),
        fc.boolean(),
        (s, pending, others, ls, anyLimits, utilizationBp, staged) => {
          // Half the cases put L where the holdings sit at a chosen utilization, so the reduce
          // and halt stages come up often.
          const holdings = worstLoss(resultPnl(s, T));
          const l =
            staged && holdings > 0n
              ? {
                  ...anyLimits,
                  reduceAtBp: 7_000,
                  haltAtBp: 9_000,
                  maxLoss: (holdings * 10_000n) / BigInt(utilizationBp) || 1n,
                }
              : anyLimits;
          const ladder = quoteLadder(s.noQty - s.yesQty, ls, T);
          const plan = planBotQuotes(ladder, s, [...pend(pending), ...others], ls.quantity, l, T);
          const before = reservedPnl(s, pending, T);
          expect(plan.stage).toBe(botRisk(s, pending, l, T).stage);
          expect(plan.overLimit).toBe(
            worstLoss(reservedPnl(s, [...pending, ...others], T)) > l.maxLoss,
          );
          // Within L, or no result worse than the pending orders alone left it.
          expectWithinOrNoWorse(
            reservedPnl(s, [...pending, ...asOrders(plan)], T),
            before,
            l.maxLoss,
          );
          // Within the Coin the pending orders leave free.
          const locked = pending.reduce((sum, o) => sum + BigInt(o.priceCoin * o.qty), 0n);
          const newCoin = BigInt(spent(plan.yesBids) + spent(plan.noBids));
          if (newCoin > 0n) expect(newCoin <= s.coin - locked).toBe(true);
          const budget =
            plan.overLimit || plan.stage === 'halt'
              ? 0
              : plan.stage === 'reduce'
                ? Math.floor((ls.quantity * l.reduceRatioBp) / 10_000)
                : Infinity;
          for (const [side, outcome] of [
            ['yesBids', 'YES'],
            ['noBids', 'NO'],
          ] as const) {
            const path = pathOf(outcome, pending, plan[side]);
            const kept = total(plan[side]);
            if (kept > 0) expect(path.length).toBeLessThanOrEqual(ls.quantity);
            const curve = unitsOf(ladder[side]);
            // PnL along the path (pending orders may lock more Coin than the book has here).
            let pnl = resultPnl(s, T);
            let raised = 0;
            let newRaising = false;
            path.forEach((unit, position) => {
              const d = orderPnlDelta(buy(outcome, unit.price, 1), T);
              const next = { YES: pnl.YES + d.YES, NO: pnl.NO + d.NO, VOID: pnl.VOID + d.VOID };
              const raises = worstLoss(next) > worstLoss(pnl);
              if (unit.isNew) {
                // Priced at the curve position it fills at, pending cancels ahead included.
                expect(unit.price).toBe(curve[position]);
                if (raises) expect(raised).toBeLessThan(budget);
                if (raises) newRaising = true;
              }
              if (raises) raised += 1;
              pnl = next;
            });
            // With a new risk-raising contract in, the whole path stays within the budget,
            // pending contracts behind it included.
            if (newRaising && budget !== Infinity) expect(raised).toBeLessThanOrEqual(budget);
          }
        },
      ),
      RUNS,
    );
  });
});

describe('one-way buying against the bot (N01 §10 일방향 연속 매수)', () => {
  it('raises the YES price, walks the stages up and never lets the loss pass L', () => {
    const settings: LadderSettings = { b: 30, safetyTicks: 1, levels: 5, quantity: 10 };
    let state = book({ coin: 5_000n, invested: 5_000n });
    const stages: string[] = [];
    let lastBestNoBid = Infinity;
    for (let round = 0; round < 60; round++) {
      const ladder = quoteLadder(state.noQty - state.yesQty, settings, T);
      const plan = planBotQuotes(ladder, state, [], settings.quantity, LIMITS, T);
      stages.push(plan.stage);
      // Every NO bid here raises the loss on YES, so at reduce at most 10 × 50% go out.
      if (plan.stage === 'reduce') expect(total(plan.noBids)).toBeLessThanOrEqual(5);
      // A YES buyer takes every NO bid (D17): the bot buys NO, the YES price goes up.
      const best = plan.noBids[0];
      if (best === undefined) break;
      expect(best.priceCoin).toBeLessThanOrEqual(lastBestNoBid);
      lastBestNoBid = best.priceCoin;
      for (const level of plan.noBids)
        state = fill(state, buy('NO', level.priceCoin, level.qty), level.qty);
      expect(worstLoss(resultPnl(state, T)) <= LIMITS.maxLoss).toBe(true);
    }
    expect(stages[0]).toBe('normal');
    expect(stages).toContain('reduce');
    expect(stages.at(-1)).toBe('halt');
    // At halt the bot still offers to buy YES back (risk-lowering), never more NO.
    const ladder = quoteLadder(state.noQty - state.yesQty, settings, T);
    const plan = planBotQuotes(ladder, state, [], settings.quantity, LIMITS, T);
    expect(plan.noBids).toEqual([]);
    expect(total(plan.yesBids)).toBeGreaterThan(0);
  });
});

describe('reconcileBotQuotes (#128 줄이거나 취소할 봇 대기 주문)', () => {
  const live = (id: string, o: BotOrder): LiveBotOrder => ({ id, ...o });

  it('keeps matching orders in time priority, trims the excess and places what is missing', () => {
    const plan = {
      first: 'yesBids' as const,
      yesBids: [
        { priceCoin: 48, qty: 3 },
        { priceCoin: 46, qty: 2 },
      ],
      noBids: [{ priceCoin: 50, qty: 4 }],
    };
    const orders = [
      live('a', buy('YES', 48, 2)),
      live('b', buy('YES', 48, 2)), // one too many at 48
      live('c', buy('YES', 40, 5)), // no longer in the plan
      live('d', buy('NO', 50, 1)),
      live('e', { outcome: 'NO', side: 'sell', priceCoin: 60, qty: 1 }), // the bot only bids
      // Already being cancelled: neither cancelled again nor kept toward the plan.
      { ...live('f', buy('YES', 46, 2)), cancelPending: true },
    ];
    expect(reconcileBotQuotes(plan, orders)).toEqual({
      cancel: [
        { id: 'b', qty: 1 },
        { id: 'c', qty: 5 },
        { id: 'e', qty: 1 },
      ],
      place: [buy('YES', 46, 2), buy('NO', 50, 3)],
    });
    // The direction that got the Coin first is placed first (결정 1의 6).
    expect(reconcileBotQuotes({ ...plan, first: 'noBids' }, orders).place).toEqual([
      buy('NO', 50, 3),
      buy('YES', 46, 2),
    ]);
  });

  it('leaves exactly the plan once applied', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 5 })), {
          maxLength: 6,
        }),
        fc.array(orderArb, { maxLength: 10 }),
        (yesLevels, orders) => {
          const prices = [...new Set(yesLevels.map(([p]) => p))].sort((a, b) => b - a);
          const plan = {
            first: 'yesBids' as const,
            yesBids: prices.map((p) => ({
              priceCoin: p,
              qty: yesLevels.find(([q]) => q === p)![1],
            })),
            noBids: [],
          };
          const liveOrders = orders.map((o, i) => live(String(i), o));
          const { cancel, place } = reconcileBotQuotes(plan, liveOrders);
          const left = new Map(liveOrders.map((o) => [o.id, o.qty]));
          for (const c of cancel) {
            expect(c.qty).toBeGreaterThan(0);
            expect(c.qty).toBeLessThanOrEqual(left.get(c.id)!);
            left.set(c.id, left.get(c.id)! - c.qty);
          }
          const resting = [
            ...liveOrders.map((o) => ({ ...o, qty: left.get(o.id)! })),
            ...place,
          ].filter((o) => o.qty > 0);
          expect(resting.every((o) => o.side === 'buy' && o.outcome === 'YES')).toBe(true);
          for (const level of plan.yesBids) {
            expect(
              resting.filter((o) => o.priceCoin === level.priceCoin).reduce((n, o) => n + o.qty, 0),
            ).toBe(level.qty);
          }
          expect(resting.every((o) => prices.includes(o.priceCoin))).toBe(true);
        },
      ),
      RUNS,
    );
  });
});

describe('input validation', () => {
  it('rejects a bad book, limits or order', () => {
    for (const over of [
      { coin: -1n },
      { coin: 1 as unknown as bigint },
      { yesQty: -1 },
      { noQty: 0.5 },
      { invested: -1n },
      { recovered: -1n },
    ] as Partial<BotBook>[]) {
      expect(() => assertBotBook(book(over)), JSON.stringify(Object.keys(over))).toThrow(
        RangeError,
      );
    }
    for (const over of [
      { maxLoss: 0n },
      { reduceAtBp: -1 },
      { reduceAtBp: 9_500 },
      { haltAtBp: 10_001, reduceAtBp: 7_000 },
      { reduceRatioBp: 5_001 },
      { reduceRatioBp: 0.5 },
    ] as Partial<RiskLimits>[]) {
      expect(
        () => assertRiskLimits({ ...LIMITS, ...over }),
        JSON.stringify(over, (_: string, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
      ).toThrow(RangeError);
    }
    for (const order of [
      { ...buy('YES', 0, 1) },
      { ...buy('YES', 100, 1) },
      { ...buy('YES', 50, 0) },
      { ...buy('YES', 50.5, 1) },
      { ...buy('YES', 50, 1), outcome: 'MAYBE' as 'YES' },
      { ...buy('YES', 50, 1), side: 'hold' as 'buy' },
    ]) {
      expect(() => orderPnlDelta(order, T), JSON.stringify(order)).toThrow(RangeError);
    }
    expect(() =>
      orderPnlDelta(buy('YES', 3, 1), { ...T, tickCoin: 2, priceMinCoin: 2, priceMaxCoin: 98 }),
    ).toThrow(RangeError);
    expect(() => maxBotFillQty(book(), [], buy('YES', 50, 1), -1, LIMITS, T)).toThrow(RangeError);
    expect(() => planBotQuotes({ yesBids: [], noBids: [] }, book(), [], 0, LIMITS, T)).toThrow(
      RangeError,
    );
  });
});
