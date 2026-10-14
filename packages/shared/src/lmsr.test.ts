import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BP_MAX } from './constants.js';
import { type LmsrState, cost, initState, probabilityBp, probabilityYes } from './lmsr.js';

// Curve maths only: nothing trades against this curve directly (#125), so there are no quote,
// round-trip or loss-bound properties to check here — those belonged to the direct AMM and are
// not guarantees of the new engine (N01 §6, §10).
const RUNS = { numRuns: 1000 };

const bArb = fc.double({ min: 1, max: 1e6, noNaN: true, noDefaultInfinity: true });
const p0Arb = fc.double({ min: 0.0001, max: 0.9999, noNaN: true, noDefaultInfinity: true });

/** Anything finite; probabilities may saturate to exactly 0 or 1. */
const anyStateArb: fc.Arbitrary<LmsrState> = fc.record({
  qYes: fc.double({ min: -1e8, max: 1e8, noNaN: true, noDefaultInfinity: true }),
  qNo: fc.double({ min: -1e8, max: 1e8, noNaN: true, noDefaultInfinity: true }),
  b: bArb,
});

const flipped = (state: LmsrState): LmsrState => ({ qYes: state.qNo, qNo: state.qYes, b: state.b });

describe('initState', () => {
  it('starts at the requested probability', () => {
    expect(initState(0.5, 1000)).toEqual({ qYes: 0, qNo: 0, b: 1000 });
    expect(probabilityBp(initState(0.5, 1000))).toBe(5000);
    fc.assert(
      fc.property(p0Arb, bArb, (p0, b) => {
        const state = initState(p0, b);
        expect(probabilityYes(state)).toBeCloseTo(p0, 9);
        expect(state.qNo).toBe(0);
      }),
      RUNS,
    );
  });
});

describe('pY + pN = 1', () => {
  it('holds within 1e-9 for any state, and within one basis point after rounding', () => {
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

  it('saturates to 0 or 10000 basis points once |qY − qN|/b passes ~37', () => {
    const state: LmsrState = { qYes: 50_000, qNo: 0, b: 1000 };
    expect(probabilityYes(state)).toBe(1);
    expect(probabilityBp(state)).toBe(BP_MAX);
    expect(probabilityBp(flipped(state))).toBe(0);
  });
});

describe('cost', () => {
  it('is the log-sum-exp and never overflows', () => {
    expect(cost({ qYes: 0, qNo: 0, b: 1000 })).toBeCloseTo(1000 * Math.LN2, 9);
    expect(cost({ qYes: 1e8, qNo: -1e8, b: 1 })).toBe(1e8);
    expect(Number.isFinite(cost({ qYes: 1e8, qNo: 1e8, b: 1 }))).toBe(true);
  });
});

describe('input validation', () => {
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
      expect(() => probabilityBp(s)).toThrow(RangeError);
    }
  });

  it('rejects an initial probability outside (0, 1) and a non-positive b', () => {
    for (const p0 of [0, 1, -0.5, 1.5, Number.NaN]) {
      expect(() => initState(p0, 1000), String(p0)).toThrow(RangeError);
    }
    for (const b of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => initState(0.5, b), String(b)).toThrow(RangeError);
    }
  });
});
