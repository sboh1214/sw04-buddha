import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OUTCOMES, ORDER_SIDES } from '../enums.js';
import { type LadderSettings, type QuoteLadder, quoteLadder } from './ladder.js';
import {
  type BotBook,
  type BotOrder,
  type ByResult,
  type LiveBotOrder,
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
import { PROPOSED_CONTRACT_TERMS } from './terms.js';

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
        (state, picks) => {
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
    expect(checkBotOrder(held, [], buy('YES', 1, 1), lowered, T)).toBe('loss_limit');
  });

  it('never lets reserved losses end past L or grow past it', () => {
    fc.assert(
      fc.property(
        bookArb,
        fc.array(buyArb, { maxLength: 6 }),
        orderArb,
        limitsArb,
        (s, live, o, l) => {
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

  it('is the largest fill that, with the remainder cancelled, keeps every result in bounds', () => {
    fc.assert(
      fc.property(
        bookArb,
        fc.array(buyArb, { maxLength: 6 }),
        orderArb,
        fc.integer({ min: 0, max: 60 }),
        limitsArb,
        (s, others, o, requested, l) => {
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

describe('planBotQuotes (결정 1의 6·7·10·11)', () => {
  const settings: LadderSettings = { b: 20, safetyTicks: 0, levels: 20, quantity: 20 };
  const ladderAt = (state: BotBook) => quoteLadder(state.noQty - state.yesQty, settings, T);

  it('keeps the whole ladder when the bot is well within L and Coin', () => {
    const ladder = ladderAt(book());
    const plan = planBotQuotes(ladder, book(), [], 20, { ...LIMITS, maxLoss: 10_000n }, T);
    expect(plan).toEqual({ stage: 'normal', yesBids: ladder.yesBids, noBids: ladder.noBids });
  });

  it('stops each direction where L would be passed, the far contracts first', () => {
    const ladder = ladderAt(book());
    const plan = planBotQuotes(ladder, book(), [], 20, { ...LIMITS, maxLoss: 300n }, T);
    // From balance every YES bid loses its price on NO, every NO bid on YES.
    expect(total(plan.yesBids)).toBeLessThan(total(ladder.yesBids));
    expect(total(plan.noBids)).toBeLessThan(total(ladder.noBids));
    expect(worstLoss(reservedPnl(book(), asOrders(plan), T))).toBeLessThanOrEqual(300n);
    const paid = plan.yesBids.reduce((s, l) => s + l.priceCoin * l.qty, 0);
    const next = ladder.yesBids.flatMap((l) => Array<number>(l.qty).fill(l.priceCoin))[
      total(plan.yesBids)
    ]!;
    expect(paid + next).toBeGreaterThan(300);
    expect(plan.yesBids[0]?.priceCoin).toBe(ladder.yesBids[0]?.priceCoin);
  });

  it('spends short Coin on the risk-lowering direction first', () => {
    // Long 30 YES (bought at 50): NO is the worst result, so NO bids lower the risk.
    const state = book({ coin: 300n, yesQty: 30, invested: 1_800n });
    const ladder = ladderAt(state);
    const plan = planBotQuotes(ladder, state, [], 20, { ...LIMITS, maxLoss: 10_000n }, T);
    // The NO bids took the Coin until the next one did not fit; the YES bids got the rest.
    const noUnits = ladder.noBids.flatMap((l) => Array<number>(l.qty).fill(l.priceCoin));
    const kept = total(plan.noBids);
    const noSpent = noUnits.slice(0, kept).reduce((s, p) => s + p, 0);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(noUnits.length);
    expect(noSpent + noUnits[kept]!).toBeGreaterThan(300);
    const yesSpent = plan.yesBids.reduce((s, l) => s + l.priceCoin * l.qty, 0);
    expect(yesSpent).toBeLessThanOrEqual(300 - noSpent);
  });

  it('halves the risk-raising contracts at reduce and drops them at halt', () => {
    // Long 15 YES bought at 52 (worst NO −780 of L 1,000 → 78%, reduce).
    const reduce = book({ coin: 9_220n, yesQty: 15 });
    expect(botRisk(reduce, [], LIMITS, T).stage).toBe('reduce');
    const ladder = ladderAt(reduce);
    const plan = planBotQuotes(ladder, reduce, [], 20, { ...LIMITS, maxLoss: 1_000n }, T);
    // YES bids only add to the NO loss: at most 20 × 50% = 10, and L caps them further.
    expect(total(plan.yesBids)).toBeLessThanOrEqual(10);
    // NO bids first unwind the YES (lowering the risk), then may add 10 risk-raising ones.
    expect(total(plan.noBids)).toBeGreaterThan(10);

    // Long 19 YES at 50 (−950 → 95%, halt): only risk-lowering NO bids.
    const halt = book({ coin: 9_050n, yesQty: 19 });
    const halted = planBotQuotes(ladderAt(halt), halt, [], 20, LIMITS, T);
    expect(halted.stage).toBe('halt');
    expect(halted.yesBids).toEqual([]);
    expect(total(halted.noBids)).toBeGreaterThan(0);
    expect(total(halted.noBids)).toBeLessThanOrEqual(19);
  });

  it('posts fewer contracts while cancels are pending, and counts their risk and Coin', () => {
    const ladder = ladderAt(book());
    const pending = [buy('YES', 10, 15)];
    const plan = planBotQuotes(ladder, book(), pending, 20, { ...LIMITS, maxLoss: 10_000n }, T);
    expect(total(plan.yesBids)).toBe(5);
    expect(plan.noBids).toEqual(ladder.noBids);
  });

  it('keeps every planned set within L, the Coin, the quantity and the ladder', () => {
    fc.assert(
      fc.property(
        bookArb,
        fc.array(buyArb, { maxLength: 4 }),
        ladderSettingsArb,
        limitsArb,
        (s, pending, ls, l) => {
          const ladder = quoteLadder(s.noQty - s.yesQty, ls, T);
          const plan = planBotQuotes(ladder, s, pending, ls.quantity, l, T);
          expect(plan.stage).toBe(botRisk(s, pending, l, T).stage);
          // Within L, or no result worse than the pending orders alone left it.
          expectWithinOrNoWorse(
            reservedPnl(s, [...pending, ...asOrders(plan)], T),
            reservedPnl(s, pending, T),
            l.maxLoss,
          );
          // Within the Coin the pending orders leave free.
          const locked = pending.reduce((sum, o) => sum + BigInt(o.priceCoin * o.qty), 0n);
          const spent = asOrders(plan).reduce((sum, o) => sum + BigInt(o.priceCoin * o.qty), 0n);
          if (spent > 0n) expect(spent <= s.coin - locked).toBe(true);
          for (const [side, outcome] of [
            ['yesBids', 'YES'],
            ['noBids', 'NO'],
          ] as const) {
            const pendingHere = pending
              .filter((o) => o.outcome === outcome)
              .reduce((n, o) => n + o.qty, 0);
            expect(total(plan[side])).toBeLessThanOrEqual(Math.max(0, ls.quantity - pendingHere));
            // A prefix of the ladder: same prices from the top, the last level maybe shorter.
            plan[side].forEach((level, i) => {
              expect(level.priceCoin).toBe(ladder[side][i]!.priceCoin);
              expect(level.qty).toBeLessThanOrEqual(ladder[side][i]!.qty);
              if (i < plan[side].length - 1) expect(level.qty).toBe(ladder[side][i]!.qty);
            });
            if (plan.stage === 'halt') {
              // Every contract kept lowers the worst loss on holdings, one after another.
              let state = s;
              for (const level of plan[side]) {
                for (let k = 0; k < level.qty; k++) {
                  const next = fill(state, buy(outcome, level.priceCoin, 1), 1);
                  expect(worstLoss(resultPnl(next, T)) <= worstLoss(resultPnl(state, T))).toBe(
                    true,
                  );
                  state = next;
                }
              }
            }
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
    ];
    expect(reconcileBotQuotes(plan, orders)).toEqual({
      cancel: [
        { id: 'b', qty: 1 },
        { id: 'c', qty: 5 },
        { id: 'e', qty: 1 },
      ],
      place: [buy('YES', 46, 2), buy('NO', 50, 3)],
    });
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
