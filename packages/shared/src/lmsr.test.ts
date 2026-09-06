import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BP_MAX, ORDER_QTY_MAX } from './constants.js';
import { type Outcome } from './enums.js';
import {
  type LmsrState,
  cost,
  initState,
  maxLossP,
  parseQuantity,
  priceOf,
  probabilityBp,
  probabilityYes,
  quoteBuy,
  quoteSell,
  serializeQuantity,
  sharesForSpend,
} from './lmsr.js';

const RUNS = { numRuns: 1000 };

// ---- generators (M3 design 1.1) --------------------------------------------------------
const bArb = fc.double({ min: 1, max: 1e6, noNaN: true, noDefaultInfinity: true });
const p0Arb = fc.double({ min: 0.0001, max: 0.9999, noNaN: true, noDefaultInfinity: true });
const deltaArb = fc.integer({ min: 1, max: 1_000_000 });
const outcomeArb: fc.Arbitrary<Outcome> = fc.constantFrom('YES', 'NO');
const sideArb = fc.constantFrom('buy', 'sell');

/** |qY − qN| / b ≤ 20: probabilities stay well inside (0, 1), so the strict claims hold. */
const saneStateArb: fc.Arbitrary<LmsrState> = fc
  .record({
    b: bArb,
    qNo: fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
    spread: fc.double({ min: -20, max: 20, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ b, qNo, spread }) => ({ qYes: qNo + spread * b, qNo, b }));

/** Anything finite the DB could hold; probabilities may saturate to exactly 0 or 1. */
const anyStateArb: fc.Arbitrary<LmsrState> = fc.record({
  qYes: fc.double({ min: -1e8, max: 1e8, noNaN: true, noDefaultInfinity: true }),
  qNo: fc.double({ min: -1e8, max: 1e8, noNaN: true, noDefaultInfinity: true }),
  b: bArb,
});

/** |qY − qN| / b ≥ 40: exp() has saturated and every quote is a clamp. */
const saturatedStateArb: fc.Arbitrary<LmsrState & { favoured: Outcome }> = fc
  .record({
    b: bArb,
    qNo: fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
    spread: fc.double({ min: 40, max: 80, noNaN: true, noDefaultInfinity: true }),
    favoured: outcomeArb,
  })
  .map(({ b, qNo, spread, favoured }) =>
    favoured === 'YES'
      ? { qYes: qNo + spread * b, qNo, b, favoured }
      : { qYes: qNo - spread * b, qNo, b, favoured },
  );

const probabilityOf = (state: LmsrState, outcome: Outcome) =>
  outcome === 'YES' ? probabilityYes(state) : 1 - probabilityYes(state);

const flipped = (state: LmsrState): LmsrState => ({ qYes: state.qNo, qNo: state.qYes, b: state.b });

describe('initState / priceOf (PLAN M3 AC 2)', () => {
  it('starts at the requested probability and moves the price up after a YES buy', () => {
    const state = initState(0.5, 1000);
    expect(state).toEqual({ qYes: 0, qNo: 0, b: 1000 });
    expect(priceOf(state)).toBe(50);
    expect(probabilityBp(state)).toBe(5000);

    const quote = quoteBuy(state, 'YES', 100);
    expect(priceOf(quote.next)).toBe(52);
    expect(quote.priceBeforeBp).toBe(5000);
    expect(quote.priceAfterBp).toBe(5250);
    // The NO display price is 100 − YES within ±1.
    const noPrice = Math.round((1 - probabilityYes(quote.next)) * 100);
    expect(Math.abs(noPrice - (100 - priceOf(quote.next)))).toBeLessThanOrEqual(1);
  });

  it('reproduces p0 for any initial probability', () => {
    fc.assert(
      fc.property(p0Arb, bArb, (p0, b) => {
        const state = initState(p0, b);
        expect(probabilityYes(state)).toBeCloseTo(p0, 9);
        expect(state.qNo).toBe(0);
      }),
      RUNS,
    );
  });

  it('matches the PLAN 5.3 guide values for the reserve at 50%', () => {
    expect(maxLossP(0.5, 500)).toBe(34_658n);
    expect(maxLossP(0.5, 1000)).toBe(69_315n);
    expect(maxLossP(0.5, 3000)).toBe(207_945n);
    // ADR-0027: away from 50% the worst case is −ln(min(p0, 1 − p0)), not ln 2.
    expect(maxLossP(0.1, 1000)).toBe(230_259n);
    expect(maxLossP(0.9, 1000)).toBe(230_259n);
  });
});

describe('invariant 1: a buy moves the price towards the bought outcome', () => {
  it('display prices move monotonically and the bought probability strictly increases', () => {
    fc.assert(
      fc.property(saneStateArb, outcomeArb, deltaArb, (state, outcome, delta) => {
        const quote = quoteBuy(state, outcome, delta);
        const before = probabilityBp(state);
        const after = probabilityBp(quote.next);
        if (outcome === 'YES') {
          expect(after).toBeGreaterThanOrEqual(before);
          expect(priceOf(quote.next)).toBeGreaterThanOrEqual(priceOf(state));
        } else {
          expect(after).toBeLessThanOrEqual(before);
          expect(priceOf(quote.next)).toBeLessThanOrEqual(priceOf(state));
        }
        const pBefore = probabilityOf(state, outcome);
        const pAfter = probabilityOf(quote.next, outcome);
        if (pBefore > 1e-9 && pBefore < 1 - 1e-9 && pAfter > 1e-9 && pAfter < 1 - 1e-9) {
          expect(pAfter).toBeGreaterThan(pBefore);
        }
      }),
      RUNS,
    );
  });

  it('a sell moves the price the other way', () => {
    fc.assert(
      fc.property(saneStateArb, outcomeArb, deltaArb, (state, outcome, delta) => {
        const quote = quoteSell(state, outcome, delta);
        const pBefore = probabilityOf(state, outcome);
        const pAfter = probabilityOf(quote.next, outcome);
        expect(pAfter).toBeLessThanOrEqual(pBefore);
      }),
      RUNS,
    );
  });
});

describe('invariant 2: amounts stay within the integer boundary clamps', () => {
  it('buy: 1 ≤ amountP ≤ 100·Δ; sell: 0 ≤ amountP ≤ 100·Δ; prices in basis points', () => {
    fc.assert(
      fc.property(anyStateArb, outcomeArb, deltaArb, (state, outcome, delta) => {
        const buy = quoteBuy(state, outcome, delta);
        expect(buy.amountP).toBeGreaterThanOrEqual(1n);
        expect(buy.amountP).toBeLessThanOrEqual(100n * BigInt(delta));
        expect(buy.priceAvgBp).toBeGreaterThanOrEqual(0);
        expect(buy.priceAvgBp).toBeLessThanOrEqual(BP_MAX);
        expect(Number.isInteger(buy.priceAvgBp)).toBe(true);
        const sell = quoteSell(state, outcome, delta);
        expect(sell.amountP).toBeGreaterThanOrEqual(0n);
        expect(sell.amountP).toBeLessThanOrEqual(100n * BigInt(delta));
        expect(sell.priceAvgBp).toBeLessThanOrEqual(BP_MAX);
        for (const quote of [buy, sell]) {
          expect(quote.shares).toBe(delta);
          for (const bp of [quote.priceBeforeBp, quote.priceAfterBp]) {
            expect(Number.isInteger(bp)).toBe(true);
            expect(bp).toBeGreaterThanOrEqual(0);
            expect(bp).toBeLessThanOrEqual(BP_MAX);
          }
        }
      }),
      RUNS,
    );
  });
});

describe('invariant 3: an immediate round trip never profits', () => {
  it('sell proceeds ≤ buy cost for the same Δ', () => {
    fc.assert(
      fc.property(anyStateArb, outcomeArb, deltaArb, (state, outcome, delta) => {
        const buy = quoteBuy(state, outcome, delta);
        const sell = quoteSell(buy.next, outcome, delta);
        expect(sell.amountP).toBeLessThanOrEqual(buy.amountP);
        expect(sell.next.qYes).toBeCloseTo(state.qYes, 6);
        expect(sell.next.qNo).toBeCloseTo(state.qNo, 6);
      }),
      RUNS,
    );
  });
});

describe('invariant 4: operator loss is bounded by maxLossP', () => {
  const tradeArb = fc.record({ outcome: outcomeArb, side: sideArb, delta: deltaArb });

  it('holds over any sequence of ≤ 50 trades from initState(p0, b)', () => {
    fc.assert(
      fc.property(p0Arb, bArb, fc.array(tradeArb, { maxLength: 50 }), (p0, b, trades) => {
        let state = initState(p0, b);
        // Contracts held by the public per outcome, tracked as integers — never as q_final −
        // q_initial, which would smuggle double error into the bound.
        const held = { YES: 0, NO: 0 };
        let collected = 0n;
        let executed = 0;
        for (const trade of trades) {
          if (trade.side === 'buy') {
            const quote = quoteBuy(state, trade.outcome, trade.delta);
            collected += quote.amountP;
            held[trade.outcome] += trade.delta;
            state = quote.next;
            executed += 1;
          } else {
            const delta = Math.min(trade.delta, held[trade.outcome]);
            if (delta === 0) continue;
            const quote = quoteSell(state, trade.outcome, delta);
            collected -= quote.amountP;
            held[trade.outcome] -= delta;
            state = quote.next;
            executed += 1;
          }
        }
        const payout = 100n * BigInt(Math.max(held.YES, held.NO));
        const loss = payout - collected;
        expect(loss).toBeLessThanOrEqual(maxLossP(p0, b) + BigInt(executed));
      }),
      RUNS,
    );
  });
});

describe('invariant 5: pY + pN = 1', () => {
  it('holds within 1e-9 for any state', () => {
    fc.assert(
      fc.property(anyStateArb, (state) => {
        expect(Math.abs(probabilityYes(state) + probabilityYes(flipped(state)) - 1)).toBeLessThan(
          1e-9,
        );
        expect(probabilityBp(state) + probabilityBp(flipped(state))).toBeGreaterThanOrEqual(
          BP_MAX - 1,
        );
        expect(probabilityBp(state) + probabilityBp(flipped(state))).toBeLessThanOrEqual(
          BP_MAX + 1,
        );
      }),
      RUNS,
    );
  });
});

/** Closed forms of ΔC; exact in double while Δ/b < 709 and the traded outcome is not certain. */
const closedBuy = (state: LmsrState, outcome: Outcome, delta: number) =>
  state.b * Math.log1p(probabilityOf(state, outcome) * Math.expm1(delta / state.b));
const closedSell = (state: LmsrState, outcome: Outcome, delta: number) =>
  -state.b * Math.log1p(probabilityOf(state, outcome) * Math.expm1(-delta / state.b));

const expectWithinRounding = (amountP: bigint, closed: number) => {
  // amountP is ceil/floor of 100·ΔC, so allow 0.01 on top of the relative tolerance.
  expect(Math.abs(Number(amountP) / 100 - closed)).toBeLessThanOrEqual(0.01 + 1e-6 * closed);
};

describe('cost increments', () => {
  it('agrees with the log-sum-exp difference where that is exact (sane states, Δ/b ≤ 30)', () => {
    fc.assert(
      fc.property(saneStateArb, outcomeArb, deltaArb, (state, outcome, delta) => {
        fc.pre(delta / state.b <= 30);
        const buy = quoteBuy(state, outcome, delta);
        const sell = quoteSell(state, outcome, delta);
        const lseBuy = cost(buy.next) - cost(state);
        const lseSell = cost(state) - cost(sell.next);
        // amountP is ceil/floor of 100·ΔC, so allow 0.01 on top of the relative tolerance.
        expect(Math.abs(Number(buy.amountP) / 100 - lseBuy)).toBeLessThanOrEqual(
          0.01 + 1e-6 * Math.abs(lseBuy),
        );
        expect(Math.abs(Number(sell.amountP) / 100 - lseSell)).toBeLessThanOrEqual(
          0.01 + 1e-6 * Math.abs(lseSell),
        );
      }),
      RUNS,
    );
  });

  it('agrees with the log1p/expm1 closed form for large Δ/b, as far as expm1 reaches', () => {
    const bigDeltaArb = fc
      .record({
        b: fc.double({ min: 1, max: 1000, noNaN: true }),
        ratio: fc.double({ min: 30.5, max: 600, noNaN: true }),
      })
      .map(({ b, ratio }) => ({
        b,
        delta: Math.min(ORDER_QTY_MAX, Math.max(1, Math.round(ratio * b))),
      }))
      .filter(({ b, delta }) => delta / b > 30);
    fc.assert(
      fc.property(
        bigDeltaArb,
        fc.double({ min: -20, max: 20, noNaN: true }),
        outcomeArb,
        ({ b, delta }, spread, outcome) => {
          const state: LmsrState = { qYes: spread * b, qNo: 0, b };
          expectWithinRounding(
            quoteBuy(state, outcome, delta).amountP,
            closedBuy(state, outcome, delta),
          );
          expectWithinRounding(
            quoteSell(state, outcome, delta).amountP,
            closedSell(state, outcome, delta),
          );
        },
      ),
      RUNS,
    );
  });

  it('stays finite and clamped once Δ/b passes what expm1 can represent (> 709)', () => {
    // From 50% with b = 1: ΔC_buy = Δ − ln 2 and ΔC_sell = ln 2 exactly.
    const even = initState(0.5, 1);
    expect(quoteBuy(even, 'YES', ORDER_QTY_MAX).amountP).toBe(100n * BigInt(ORDER_QTY_MAX) - 69n);
    expect(quoteSell(even, 'YES', ORDER_QTY_MAX).amountP).toBe(69n);
    const tiny = initState(0.5, 0.001);
    expect(quoteBuy(tiny, 'YES', ORDER_QTY_MAX).amountP).toBe(100n * BigInt(ORDER_QTY_MAX));
    expect(quoteSell(tiny, 'NO', ORDER_QTY_MAX).amountP).toBe(0n);
  });

  /**
   * Regression: a `cost(q') − cost(q)` fallback loses whole P once |q| ≳ 1e11 because both
   * terms carry ulp(|q|). The column holds |q| < 1e14, so quotes there must still be P-exact,
   * monotone in Δ and free of round-trip profit. Magnitudes stay inside one binade
   * ([2^45, 2^46) ≈ [3.5e13, 7e13]) so that q ± Δ itself is exactly representable.
   */
  it('stays P-exact at |q| ≈ 5e13, where log-sum-exp differences lose whole P', () => {
    const hugeArb = fc
      .record({
        b: fc.double({ min: 1, max: 30, noNaN: true }),
        magnitude: fc.double({ min: 4e13, max: 6e13, noNaN: true }),
        sign: fc.constantFrom(-1, 1),
        spread: fc.double({ min: -3, max: 3, noNaN: true }),
        around: fc.integer({ min: -40, max: 40 }),
        outcome: outcomeArb,
      })
      .map(({ b, magnitude, sign, spread, around, outcome }) => ({
        state: { qYes: sign * magnitude + spread * b, qNo: sign * magnitude, b },
        // Straddles Δ/b = 30, where the old scheme switched formulas.
        delta: Math.max(1, Math.round(30 * b) + around),
        outcome,
      }));
    fc.assert(
      fc.property(hugeArb, ({ state, delta, outcome }) => {
        const buy = quoteBuy(state, outcome, delta);
        const sell = quoteSell(state, outcome, delta);
        expectWithinRounding(buy.amountP, closedBuy(state, outcome, delta));
        expectWithinRounding(sell.amountP, closedSell(state, outcome, delta));
        expect(quoteBuy(state, outcome, delta + 1).amountP).toBeGreaterThanOrEqual(buy.amountP);
        expect(quoteSell(state, outcome, delta + 1).amountP).toBeGreaterThanOrEqual(sell.amountP);
        expect(quoteSell(buy.next, outcome, delta).amountP).toBeLessThanOrEqual(buy.amountP);
        expect(quoteBuy(sell.next, outcome, delta).amountP).toBeGreaterThanOrEqual(sell.amountP);
      }),
      RUNS,
    );
  });

  it('closes the round trips that the log-sum-exp fallback let profit by 1P', () => {
    // Buy 187 YES (Δ/b ≈ 30.3), then sell it back as 184 + 3 (Δ/b < 30 each).
    const a: LmsrState = {
      qYes: -64336481856651.15,
      qNo: -64336481856668.31,
      b: 6.164575771951637,
    };
    const buy = quoteBuy(a, 'YES', 187);
    expect(buy.amountP).toBe(18664n); // exact 100·ΔC = 18663.05; the fallback answered 18662
    const sell1 = quoteSell(buy.next, 'YES', 184);
    const sell2 = quoteSell(sell1.next, 'YES', 3);
    expect(sell1.amountP + sell2.amountP).toBeLessThanOrEqual(buy.amountP);

    // Sell 238 NO, then buy it back as 150 + 88.
    const b: LmsrState = { qYes: 94463348451489.16, qNo: 94463348451505.94, b: 5.0244602054563225 };
    const sell = quoteSell(b, 'NO', 238);
    const buy1 = quoteBuy(sell.next, 'NO', 150);
    const buy2 = quoteBuy(buy1.next, 'NO', 88);
    expect(buy1.amountP + buy2.amountP).toBeGreaterThanOrEqual(sell.amountP);

    // Proceeds must not drop when Δ crosses 30·b.
    const c: LmsrState = { qYes: -819602152941.809, qNo: -819602152935.5134, b: 4.143499480652604 };
    expect(quoteSell(c, 'YES', 125).amountP).toBeGreaterThanOrEqual(
      quoteSell(c, 'YES', 124).amountP,
    );
    const d: LmsrState = { qYes: -99999999999993.8, qNo: -99999999999995.55, b: 1 };
    expect(quoteSell(d, 'YES', 31).amountP).toBeGreaterThanOrEqual(quoteSell(d, 'YES', 30).amountP);
    expect(quoteBuy(d, 'YES', 31).amountP).toBe(3084n); // exact 3083.98; the fallback answered 3085
  });

  it('cost() is the log-sum-exp and never overflows', () => {
    expect(cost({ qYes: 0, qNo: 0, b: 1000 })).toBeCloseTo(1000 * Math.LN2, 9);
    expect(cost({ qYes: 1e8, qNo: -1e8, b: 1 })).toBe(1e8);
    expect(Number.isFinite(cost({ qYes: 1e8, qNo: 1e8, b: 1 }))).toBe(true);
  });
});

describe('saturated region (|qY − qN|/b ≥ 40)', () => {
  it('quotes the clamped values and the display price sits at 1 or 99', () => {
    fc.assert(
      fc.property(saturatedStateArb, deltaArb, (state, delta) => {
        const other: Outcome = state.favoured === 'YES' ? 'NO' : 'YES';
        expect(priceOf(state)).toBe(state.favoured === 'YES' ? 99 : 1);
        expect(probabilityBp(state)).toBe(state.favoured === 'YES' ? BP_MAX : 0);
        expect(quoteBuy(state, state.favoured, delta).amountP).toBe(100n * BigInt(delta));
        expect(quoteSell(state, other, delta).amountP).toBe(0n);
        // Selling the favoured outcome pulls the state back towards 50%. While it stays
        // saturated the true proceeds sit a hair under 100P per contract, so `floor` answers
        // 100·Δ − 1 unless double rounding tips it onto the clamp at exactly 100·Δ.
        const favouredSell = quoteSell(state, state.favoured, delta);
        expect(favouredSell.amountP).toBeLessThanOrEqual(100n * BigInt(delta));
        if (Math.abs(state.qYes - state.qNo) / state.b - delta / state.b >= 40) {
          expect(favouredSell.amountP).toBeGreaterThanOrEqual(100n * BigInt(delta) - 1n);
        }
        const cheap = quoteBuy(state, other, delta);
        expect(cheap.amountP).toBeGreaterThanOrEqual(1n);
        expect(cheap.amountP).toBeLessThanOrEqual(100n * BigInt(delta));
      }),
      RUNS,
    );
  });

  it('a buy of the near-certain outcome costs exactly 100P per contract', () => {
    const state: LmsrState = { qYes: 50_000, qNo: 0, b: 1000 };
    expect(probabilityYes(state)).toBe(1);
    expect(quoteBuy(state, 'YES', 7).amountP).toBe(700n);
    expect(quoteBuy(state, 'YES', 7).priceAvgBp).toBe(BP_MAX);
    expect(quoteBuy(state, 'NO', 7).amountP).toBe(1n);
    expect(quoteSell(state, 'NO', 7).amountP).toBe(0n);
    expect(quoteSell(state, 'NO', 7).priceAvgBp).toBe(0);
  });
});

describe('sharesForSpend', () => {
  it('is exact: cost(Δ) ≤ spend < cost(Δ + 1)', () => {
    const spendArb = fc.oneof(
      fc.bigInt({ min: 0n, max: 10n ** 6n }),
      fc.bigInt({ min: 0n, max: 10n ** 9n }),
      fc.constant(10n ** 15n),
    );
    fc.assert(
      fc.property(anyStateArb, outcomeArb, spendArb, (state, outcome, spend) => {
        const shares = sharesForSpend(state, outcome, spend);
        expect(Number.isInteger(shares)).toBe(true);
        expect(shares).toBeGreaterThanOrEqual(0);
        expect(shares).toBeLessThanOrEqual(ORDER_QTY_MAX);
        if (shares > 0) expect(quoteBuy(state, outcome, shares).amountP).toBeLessThanOrEqual(spend);
        if (shares < ORDER_QTY_MAX) {
          expect(quoteBuy(state, outcome, shares + 1).amountP).toBeGreaterThan(spend);
        }
      }),
      RUNS,
    );
  });

  it('answers 0 when one contract already costs more, and the cap when everything fits', () => {
    const state = initState(0.5, 1000);
    expect(sharesForSpend(state, 'YES', 0n)).toBe(0);
    expect(sharesForSpend(state, 'YES', 50n)).toBe(0);
    expect(sharesForSpend(state, 'YES', 51n)).toBe(1);
    expect(sharesForSpend(state, 'YES', 10n ** 9n)).toBe(ORDER_QTY_MAX);
    expect(() => sharesForSpend(state, 'YES', -1n)).toThrow(RangeError);
    expect(() => sharesForSpend(state, 'YES', 5 as unknown as bigint)).toThrow(RangeError);
  });
});

describe('input validation', () => {
  const state = initState(0.5, 1000);

  it('rejects non-integer, zero, negative or oversized share counts', () => {
    for (const shares of [0, -1, 1.5, ORDER_QTY_MAX + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => quoteBuy(state, 'YES', shares), String(shares)).toThrow(RangeError);
      expect(() => quoteSell(state, 'NO', shares), String(shares)).toThrow(RangeError);
    }
    expect(quoteBuy(state, 'YES', ORDER_QTY_MAX).shares).toBe(ORDER_QTY_MAX);
  });

  it('rejects a non-finite or non-positive state', () => {
    const bad: LmsrState[] = [
      { qYes: Number.NaN, qNo: 0, b: 1 },
      { qYes: 0, qNo: Number.POSITIVE_INFINITY, b: 1 },
      { qYes: 0, qNo: 0, b: 0 },
      { qYes: 0, qNo: 0, b: -1 },
      { qYes: 0, qNo: 0, b: Number.NaN },
      { qYes: '1' as unknown as number, qNo: 0, b: 1 },
    ];
    for (const s of bad) {
      expect(() => cost(s)).toThrow(RangeError);
      expect(() => probabilityYes(s)).toThrow(RangeError);
      expect(() => priceOf(s)).toThrow(RangeError);
      expect(() => quoteBuy(s, 'YES', 1)).toThrow(RangeError);
      expect(() => quoteSell(s, 'YES', 1)).toThrow(RangeError);
      expect(() => sharesForSpend(s, 'YES', 1n)).toThrow(RangeError);
    }
  });

  it('rejects an initial probability outside (0, 1) and a non-positive b', () => {
    for (const p0 of [0, 1, -0.5, 1.5, Number.NaN]) {
      expect(() => initState(p0, 1000), String(p0)).toThrow(RangeError);
      expect(() => maxLossP(p0, 1000), String(p0)).toThrow(RangeError);
    }
    for (const b of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => initState(0.5, b), String(b)).toThrow(RangeError);
      expect(() => maxLossP(0.5, b), String(b)).toThrow(RangeError);
    }
  });
});

describe('quantity strings (numeric(24,10))', () => {
  it('round-trips through toFixed(10) without exponent notation', () => {
    expect(serializeQuantity(0)).toBe('0.0000000000');
    expect(serializeQuantity(-1000 * Math.LN2)).toBe('-693.1471805599');
    expect(serializeQuantity(1e13)).toBe('10000000000000.0000000000');
    expect(parseQuantity('10000000000000.0000000000')).toBe(1e13);
    expect(parseQuantity('-693.1471805599')).toBeCloseTo(-693.14718056, 9);
    fc.assert(
      fc.property(
        fc.double({ min: -1e13, max: 1e13, noNaN: true, noDefaultInfinity: true }),
        (q) => {
          const text = serializeQuantity(q);
          expect(text).toMatch(/^-?\d+\.\d{10}$/);
          expect(Math.abs(parseQuantity(text) - q)).toBeLessThanOrEqual(
            1e-10 + 1e-12 * Math.abs(q),
          );
        },
      ),
      RUNS,
    );
  });

  it('refuses what the column cannot hold or what is not a number', () => {
    expect(() => serializeQuantity(1e14)).toThrow(RangeError);
    expect(() => serializeQuantity(Number.NaN)).toThrow(RangeError);
    expect(() => serializeQuantity(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
    expect(() => parseQuantity('')).toThrow(RangeError);
    expect(() => parseQuantity('   ')).toThrow(RangeError);
    expect(() => parseQuantity('abc')).toThrow(RangeError);
    expect(() => parseQuantity('Infinity')).toThrow(RangeError);
  });
});
