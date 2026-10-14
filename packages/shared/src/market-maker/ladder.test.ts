import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lmsrCost } from '../lmsr.js';
import {
  type LadderSettings,
  type QuoteLevel,
  assertLadderSettings,
  quoteLadder,
  yesBidPriceCoin,
} from './ladder.js';
import { type ContractTerms, PROPOSED_CONTRACT_TERMS } from './terms.js';

// New checks of the new rule (N01 §10): nothing from the direct-AMM era is reused.
const RUNS = { numRuns: 500 };
const T = PROPOSED_CONTRACT_TERMS;

const settings = (over: Partial<LadderSettings> = {}): LadderSettings => ({
  b: 10,
  safetyTicks: 0,
  levels: 10,
  quantity: 10,
  ...over,
});

const flat = (levels: readonly QuoteLevel[]): [number, number][] =>
  levels.map((level) => [level.priceCoin, level.qty]);

/** One price per contract, best first. */
const units = (levels: readonly QuoteLevel[]): number[] =>
  levels.flatMap((level) => Array.from({ length: level.qty }, () => level.priceCoin));

const settingsArb: fc.Arbitrary<LadderSettings> = fc.record({
  b: fc.double({ min: 0.5, max: 2000, noNaN: true }),
  safetyTicks: fc.integer({ min: 0, max: 3 }),
  levels: fc.integer({ min: 1, max: 15 }),
  quantity: fc.integer({ min: 1, max: 120 }),
});

/** Any valid terms: a tick dividing the payout and both range ends, VOID sharing the payout. */
const termsArb: fc.Arbitrary<ContractTerms> = fc
  .record({
    tick: fc.constantFrom(1, 2, 5),
    steps: fc.integer({ min: 4, max: 200 }),
    lo: fc.double({ min: 0, max: 1, noNaN: true }),
    hi: fc.double({ min: 0, max: 1, noNaN: true }),
    voidShare: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map(({ tick, steps, lo, hi, voidShare }) => {
    const min = 1 + Math.floor(Math.min(lo, hi) * (steps - 2));
    const max = min + Math.floor(Math.abs(hi - lo) * (steps - 1 - min));
    const payoutCoin = tick * steps;
    const voidPayoutYesCoin = tick * Math.round(voidShare * steps);
    return {
      payoutCoin,
      tickCoin: tick,
      priceMinCoin: tick * min,
      priceMaxCoin: tick * max,
      voidPayoutYesCoin,
      voidPayoutNoCoin: payoutCoin - voidPayoutYesCoin,
    };
  });

const dArb = fc.integer({ min: -3000, max: 3000 });

/** The curve's cost of the bot buying n YES (d → d − n) or n NO (d → d + n), from C itself. */
const curveCostOfYes = (d: number, n: number, b: number, payout: number) =>
  lmsrCost(d, 0, b, payout) - lmsrCost(d - n, 0, b, payout);
const curveCostOfNo = (d: number, n: number, b: number, payout: number) =>
  lmsrCost(d, 0, b, payout) - lmsrCost(d, -n, b, payout);

describe('quoteLadder examples (design proposal: payout 100, tick 1, prices 1–99)', () => {
  it('quotes both directions alike at the balanced opening', () => {
    // Per-contract curve costs from d = 0, b = 10: 48.75, 46.26, 43.78, … for the YES it buys.
    const ladder = quoteLadder(0, settings({ safetyTicks: 1, levels: 3 }), T);
    expect(flat(ladder.yesBids)).toEqual([
      [47, 1],
      [45, 1],
      [42, 1],
    ]);
    expect(ladder.noBids).toEqual(ladder.yesBids);
  });

  it('groups the contracts that round to one price', () => {
    const ladder = quoteLadder(0, settings({ b: 100, levels: 5, quantity: 30 }), T);
    expect(flat(ladder.yesBids)).toEqual([
      [49, 4],
      [48, 4],
      [47, 4],
      [46, 4],
      [45, 4],
    ]);
  });

  it('follows the inventory: after net YES sales the YES price is higher on both sides', () => {
    // d = 5: the bot holds five more NO than YES; reference 62.2.
    const up = quoteLadder(5, settings({ levels: 4, quantity: 12 }), T);
    expect(flat(up.yesBids)).toEqual([
      [61, 1],
      [58, 1],
      [56, 1],
      [53, 1],
    ]);
    // A NO bid at 36 offers YES at 64 to a YES buyer (D17).
    expect(flat(up.noBids)).toEqual([
      [36, 1],
      [34, 1],
      [32, 1],
      [29, 1],
    ]);
    const down = quoteLadder(-5, settings({ levels: 4, quantity: 12 }), T);
    expect(down.yesBids).toEqual(up.noBids);
    expect(down.noBids).toEqual(up.yesBids);
  });

  it('stops a direction at the first contract below the price range', () => {
    // b = 1: each contract moves the curve far; the fifth YES would cost 0.something.
    expect(flat(quoteLadder(0, settings({ b: 1 }), T).yesBids)).toEqual([
      [37, 1],
      [18, 1],
      [7, 1],
      [3, 1],
      [1, 1],
    ]);
    // Near 100%: no NO bid could be 1 Coin or more (no YES offer at 99 or less).
    const high = quoteLadder(30, settings({ b: 5 }), T);
    expect(flat(high.yesBids)).toEqual([
      [99, 7],
      [98, 3],
    ]);
    expect(high.noBids).toEqual([]);
  });

  it('stays finite and bounded however far d is beyond b', () => {
    const far = quoteLadder(1e9, settings({ b: 1, quantity: 50 }), T);
    expect(flat(far.yesBids)).toEqual([[99, 50]]);
    expect(far.noBids).toEqual([]);
    expect(quoteLadder(-1e9, settings({ b: 1, quantity: 50 }), T).noBids).toEqual(far.yesBids);
  });
});

describe('quoteLadder properties', () => {
  it('has distinct falling prices on the tick grid inside the range, within levels and quantity', () => {
    fc.assert(
      fc.property(dArb, settingsArb, termsArb, (d, s, terms) => {
        const ladder = quoteLadder(d, s, terms);
        for (const side of [ladder.yesBids, ladder.noBids]) {
          expect(side.length).toBeLessThanOrEqual(s.levels);
          expect(side.reduce((sum, level) => sum + level.qty, 0)).toBeLessThanOrEqual(s.quantity);
          side.forEach((level, i) => {
            expect(level.qty).toBeGreaterThanOrEqual(1);
            expect(level.priceCoin % terms.tickCoin).toBe(0);
            expect(level.priceCoin).toBeGreaterThanOrEqual(terms.priceMinCoin);
            expect(level.priceCoin).toBeLessThanOrEqual(terms.priceMaxCoin);
            if (i > 0) expect(level.priceCoin).toBeLessThan(side[i - 1]!.priceCoin);
          });
        }
      }),
      RUNS,
    );
  });

  it('never pays more than the curve for any prefix that fills', () => {
    fc.assert(
      fc.property(dArb, settingsArb, termsArb, (d, s, terms) => {
        const ladder = quoteLadder(d, s, terms);
        const check = (prices: number[], curve: (n: number) => number) => {
          let paid = 0;
          prices.forEach((price, i) => {
            paid += price;
            expect(paid).toBeLessThanOrEqual(curve(i + 1) + 1e-6);
          });
        };
        check(units(ladder.yesBids), (n) => curveCostOfYes(d, n, s.b, terms.payoutCoin));
        check(units(ladder.noBids), (n) => curveCostOfNo(d, n, s.b, terms.payoutCoin));
      }),
      RUNS,
    );
  });

  it('prices each contract at its curve cost rounded down, less the safety ticks', () => {
    fc.assert(
      fc.property(dArb, settingsArb, termsArb, (d, s, terms) => {
        const { yesBids, noBids } = quoteLadder(d, s, terms);
        const t = terms.tickCoin;
        const each = (prices: number[], unitCost: (k: number) => number) =>
          prices.forEach((price, i) => {
            const cost = unitCost(i + 1);
            expect(price).toBeLessThanOrEqual(cost - s.safetyTicks * t + 1e-6);
            expect(price).toBeGreaterThan(cost - (s.safetyTicks + 1) * t - 1e-5);
          });
        each(units(yesBids), (k) => curveCostOfYes(d - k + 1, 1, s.b, terms.payoutCoin));
        each(units(noBids), (k) => curveCostOfNo(d + k - 1, 1, s.b, terms.payoutCoin));
      }),
      RUNS,
    );
  });

  it('ends a direction only at the quantity, the levels or the price range', () => {
    fc.assert(
      fc.property(dArb, settingsArb, termsArb, (d, s, terms) => {
        const ladder = quoteLadder(d, s, terms);
        for (const [side, dir] of [
          [ladder.yesBids, d],
          [ladder.noBids, -d],
        ] as const) {
          const n = units(side).length;
          if (n === s.quantity) continue;
          const next = yesBidPriceCoin(dir, n + 1, s, terms);
          const outside = next < terms.priceMinCoin || next > terms.priceMaxCoin;
          const newLevelPastCap = side.length === s.levels && next !== side.at(-1)?.priceCoin;
          expect(outside || newLevelPastCap).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('quotes NO as the mirror of YES', () => {
    fc.assert(
      fc.property(dArb, settingsArb, termsArb, (d, s, terms) => {
        expect(quoteLadder(d, s, terms).noBids).toEqual(quoteLadder(-d, s, terms).yesBids);
      }),
      RUNS,
    );
  });

  it('moves every price with the inventory and never against it', () => {
    fc.assert(
      fc.property(dArb, dArb, settingsArb, fc.integer({ min: 1, max: 40 }), (d1, d2, s, k) => {
        fc.pre(d1 !== d2);
        const [lo, hi] = d1 < d2 ? [d1, d2] : [d2, d1];
        // After net YES sales (d up) the bot bids more for YES and less for NO, so its YES
        // offer to a buyer (100 − NO bid) does not fall.
        expect(yesBidPriceCoin(lo, k, s, T)).toBeLessThanOrEqual(yesBidPriceCoin(hi, k, s, T));
        expect(yesBidPriceCoin(-lo, k, s, T)).toBeGreaterThanOrEqual(yesBidPriceCoin(-hi, k, s, T));
      }),
      RUNS,
    );
  });

  it('lowers each contract by one tick per extra safety tick', () => {
    fc.assert(
      fc.property(dArb, settingsArb, fc.integer({ min: 1, max: 40 }), (d, s, k) => {
        const wider = { ...s, safetyTicks: s.safetyTicks + 1 };
        expect(yesBidPriceCoin(d, k, wider, T)).toBe(yesBidPriceCoin(d, k, s, T) - T.tickCoin);
      }),
      RUNS,
    );
  });
});

describe('input validation', () => {
  it('accepts the design proposal and positive whole settings', () => {
    expect(() => assertLadderSettings(settings())).not.toThrow();
    expect(() => assertLadderSettings(settings({ b: 0.25, safetyTicks: 0 }))).not.toThrow();
  });

  it('rejects a bad d, b or setting', () => {
    for (const d of [Number.NaN, Number.POSITIVE_INFINITY, '0' as unknown as number]) {
      expect(() => quoteLadder(d, settings(), T), String(d)).toThrow(RangeError);
    }
    const bad: Partial<LadderSettings>[] = [
      { b: 0 },
      { b: -1 },
      { b: Number.NaN },
      { b: Number.POSITIVE_INFINITY },
      { b: '10' as unknown as number },
      { safetyTicks: -1 },
      { safetyTicks: 0.5 },
      { levels: 0 },
      { levels: 2.5 },
      { quantity: 0 },
      { quantity: Number.MAX_SAFE_INTEGER + 2 },
    ];
    for (const over of bad) {
      expect(() => quoteLadder(0, settings(over), T), JSON.stringify(over)).toThrow(RangeError);
    }
  });

  it('rejects terms the ladder cannot price on', () => {
    expect(() => quoteLadder(0, settings(), { ...T, tickCoin: 0 })).toThrow(RangeError);
  });
});
