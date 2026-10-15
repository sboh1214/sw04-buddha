import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lmsrCost, probabilityYes, referencePriceCoin, yesUnitCostCoin } from './lmsr.js';

// The curve alone (N01 §6). The quotes built on it and their properties are in
// market-maker/ladder.test.ts; the direct-AMM examples and checks are not results of this engine
// (N01 §10), so none of them is reused here.
const RUNS = { numRuns: 1000 };
const P = 100;

const bArb = fc.double({ min: 0.5, max: 1e5, noNaN: true, noDefaultInfinity: true });
const dArb = fc.double({ min: -1e5, max: 1e5, noNaN: true, noDefaultInfinity: true });

describe('probabilityYes and the reference price', () => {
  it('is 50% at the balanced opening (d = 0) for every b', () => {
    fc.assert(
      fc.property(bArb, (b) => {
        expect(probabilityYes(0, b)).toBe(0.5);
        expect(referencePriceCoin(0, b, P)).toBe(50);
      }),
      RUNS,
    );
  });

  it('rises with d, falls back as d returns, and pY + pN = 1', () => {
    fc.assert(
      fc.property(dArb, dArb, bArb, (d1, d2, b) => {
        const [lo, hi] = d1 <= d2 ? [d1, d2] : [d2, d1];
        expect(probabilityYes(lo, b)).toBeLessThanOrEqual(probabilityYes(hi, b));
        expect(Math.abs(probabilityYes(d1, b) + probabilityYes(-d1, b) - 1)).toBeLessThan(1e-12);
      }),
      RUNS,
    );
  });

  it('moves less for the same inventory change when b is larger', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 1e4, noNaN: true }), bArb, bArb, (d, b1, b2) => {
        fc.pre(b1 !== b2);
        const [small, large] = b1 < b2 ? [b1, b2] : [b2, b1];
        expect(probabilityYes(d, large) - 0.5).toBeLessThanOrEqual(probabilityYes(d, small) - 0.5);
      }),
      RUNS,
    );
  });

  it('rounds to exactly 1 past d/b ≈ 37 but reaches exactly 0 only past about −745', () => {
    expect(probabilityYes(37, 1)).toBe(1);
    expect(probabilityYes(-40, 1)).toBeGreaterThan(0);
    expect(probabilityYes(-746, 1)).toBe(0);
  });

  it('saturates without overflow when |d| is far beyond b', () => {
    expect(probabilityYes(1e12, 1)).toBe(1);
    expect(probabilityYes(-1e12, 1)).toBe(0);
    expect(referencePriceCoin(-1e12, 1e-3, P)).toBe(0);
  });
});

describe('lmsrCost', () => {
  it('is P·b·ln 2 at zero and moves by P per pair minted (qY and qN both + t)', () => {
    expect(lmsrCost(0, 0, 1000, P)).toBeCloseTo(P * 1000 * Math.LN2, 6);
    fc.assert(
      fc.property(dArb, dArb, bArb, fc.integer({ min: -1000, max: 1000 }), (qY, qN, b, t) => {
        const shifted = lmsrCost(qY + t, qN + t, b, P);
        expect(shifted - lmsrCost(qY, qN, b, P)).toBeCloseTo(P * t, 3);
      }),
      RUNS,
    );
  });

  it('never overflows', () => {
    expect(lmsrCost(1e8, -1e8, 1, P)).toBe(1e10);
    expect(Number.isFinite(lmsrCost(1e8, 1e8, 1e-3, P))).toBe(true);
  });
});

describe('yesUnitCostCoin', () => {
  it('is the cost of one more YES on the curve, C(qY + 1, qN) − C(qY, qN)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -2000, max: 2000 }),
        fc.double({ min: 0.5, max: 5000, noNaN: true }),
        (d, b) => {
          const diff = lmsrCost(d + 1, 0, b, P) - lmsrCost(d, 0, b, P);
          expect(Math.abs(yesUnitCostCoin(d, b, P) - diff)).toBeLessThan(1e-6);
        },
      ),
      RUNS,
    );
  });

  it('stays inside [0, P], rises with d and mirrors: Y(d) + Y(−d − 1) = P', () => {
    const anyB = fc.double({ min: 1e-3, max: 1e7, noNaN: true });
    fc.assert(
      fc.property(dArb, anyB, (d, b) => {
        const y = yesUnitCostCoin(d, b, P);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(P * (1 + 1e-12));
        expect(yesUnitCostCoin(d + 1, b, P)).toBeGreaterThanOrEqual(y - 1e-9);
        expect(Math.abs(y + yesUnitCostCoin(-d - 1, b, P) - P)).toBeLessThan(1e-7);
      }),
      RUNS,
    );
  });

  it('keeps its digits for a large b and does not overflow for a tiny one', () => {
    // b = 1e7: one contract barely moves the curve, so a unit costs a hair over P·σ(d/b).
    expect(yesUnitCostCoin(0, 1e7, P)).toBeGreaterThan(50);
    expect(yesUnitCostCoin(0, 1e7, P)).toBeLessThan(50 + 1e-5);
    // b = 1e-3 (1/b = 1000, the log-sum-exp branch): one contract all but settles the curve.
    // From 50% the next YES costs P·(1 − b·ln 2); the one that brings it back to 50%, P·b·ln 2.
    expect(yesUnitCostCoin(0, 1e-3, P)).toBeCloseTo(P * (1 - 1e-3 * Math.LN2), 9);
    expect(yesUnitCostCoin(-1, 1e-3, P)).toBeCloseTo(P * 1e-3 * Math.LN2, 9);
    expect(yesUnitCostCoin(-2, 1e-3, P)).toBeCloseTo(0, 9);
    expect(yesUnitCostCoin(-1e9, 0.01, P)).toBe(0);
  });
});

describe('input validation', () => {
  it('rejects non-finite values, a non-positive b or payout, and non-numbers', () => {
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown as number];
    for (const v of bad) {
      expect(() => lmsrCost(v, 0, 1, P)).toThrow(RangeError);
      expect(() => lmsrCost(0, v, 1, P)).toThrow(RangeError);
      expect(() => probabilityYes(v, 1)).toThrow(RangeError);
      expect(() => yesUnitCostCoin(v, 1, P)).toThrow(RangeError);
    }
    for (const b of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => lmsrCost(0, 0, b, P), String(b)).toThrow(RangeError);
      expect(() => probabilityYes(0, b), String(b)).toThrow(RangeError);
      expect(() => yesUnitCostCoin(0, b, P), String(b)).toThrow(RangeError);
    }
    // 1/b or P·b would overflow: the formulas would give NaN or Infinity.
    for (const b of [1e-310, 5e-324]) {
      expect(() => lmsrCost(0, 0, b, P), String(b)).toThrow(RangeError);
      expect(() => probabilityYes(-1, b), String(b)).toThrow(RangeError);
      expect(() => yesUnitCostCoin(-1, b, P), String(b)).toThrow(RangeError);
    }
    expect(() => yesUnitCostCoin(-1e308, 1e307, P)).toThrow(RangeError);
    expect(() => lmsrCost(0, 0, 1e307, P)).toThrow(RangeError);
    for (const payout of [0, -100, Number.NaN]) {
      expect(() => lmsrCost(0, 0, 1, payout)).toThrow(RangeError);
      expect(() => referencePriceCoin(0, 1, payout)).toThrow(RangeError);
      expect(() => yesUnitCostCoin(0, 1, payout)).toThrow(RangeError);
    }
  });
});
