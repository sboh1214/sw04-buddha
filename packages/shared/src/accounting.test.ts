import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type PositionState, applyBuy, applySell, settle } from './accounting.js';
import { POSITION_QTY_MAX } from './constants.js';

const empty: PositionState = { qty: 0, costBasisP: 0n, realizedPnlP: 0n };

describe('applyBuy', () => {
  it('adds contracts and cost, leaving realised PnL alone', () => {
    const position = applyBuy({ qty: 5, costBasisP: 250n, realizedPnlP: -7n }, 10, 520n);
    expect(position).toEqual({ qty: 15, costBasisP: 770n, realizedPnlP: -7n });
    expect(applyBuy(empty, 1, 0n)).toEqual({ qty: 1, costBasisP: 0n, realizedPnlP: 0n });
  });

  it('never mutates its input', () => {
    const before: PositionState = { qty: 1, costBasisP: 50n, realizedPnlP: 0n };
    applyBuy(before, 1, 50n);
    expect(before).toEqual({ qty: 1, costBasisP: 50n, realizedPnlP: 0n });
  });

  it('refuses to grow past the int4 column', () => {
    expect(applyBuy(empty, POSITION_QTY_MAX, 1n).qty).toBe(POSITION_QTY_MAX);
    expect(() => applyBuy(empty, POSITION_QTY_MAX + 1, 1n)).toThrow(RangeError);
    expect(() => applyBuy({ ...empty, qty: POSITION_QTY_MAX }, 1, 1n)).toThrow(RangeError);
  });

  it('validates the delta, the amount and the position itself', () => {
    for (const qty of [0, -1, 1.5, Number.NaN]) {
      expect(() => applyBuy(empty, qty, 1n), String(qty)).toThrow(RangeError);
    }
    expect(() => applyBuy(empty, 1, -1n)).toThrow(RangeError);
    expect(() => applyBuy(empty, 1, 1 as unknown as bigint)).toThrow(RangeError);
    expect(() => applyBuy({ ...empty, qty: -1 }, 1, 1n)).toThrow(RangeError);
    expect(() => applyBuy({ ...empty, qty: 0.5 }, 1, 1n)).toThrow(RangeError);
  });
});

describe('applySell', () => {
  it('buy 10 then sell 10 leaves qty 0, cost 0, realised = proceeds − cost', () => {
    const held = applyBuy(empty, 10, 520n);
    expect(held).toEqual({ qty: 10, costBasisP: 520n, realizedPnlP: 0n });
    expect(applySell(held, 10, 480n)).toEqual({ qty: 0, costBasisP: 0n, realizedPnlP: -40n });
  });

  it('releases cost pro rata with half-up rounding', () => {
    // 1000P over 3 contracts: selling 1 releases 333.33 → 333; the remainder stays.
    const third = applySell({ qty: 3, costBasisP: 1000n, realizedPnlP: 0n }, 1, 400n);
    expect(third).toEqual({ qty: 2, costBasisP: 667n, realizedPnlP: 67n });
    // 1001P over 2: selling 1 releases 500.5 → 501 (half up), never 500.
    const half = applySell({ qty: 2, costBasisP: 1001n, realizedPnlP: 0n }, 1, 0n);
    expect(half).toEqual({ qty: 1, costBasisP: 500n, realizedPnlP: -501n });
    // 5P over 3: selling 2 releases 3.33 → 3.
    expect(applySell({ qty: 3, costBasisP: 5n, realizedPnlP: 0n }, 2, 10n)).toEqual({
      qty: 1,
      costBasisP: 2n,
      realizedPnlP: 7n,
    });
    // Odd holdings are never exactly half, so the bigint formula stays exact.
    expect(applySell({ qty: 3, costBasisP: 7n, realizedPnlP: 0n }, 1, 0n).costBasisP).toBe(5n);
  });

  it('the released cost is round-half-up of costBasis·Δ/qty for any position', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        (qty, costBasisP, sellQty, proceedsP) => {
          fc.pre(sellQty <= qty);
          const after = applySell({ qty, costBasisP, realizedPnlP: 0n }, sellQty, proceedsP);
          const released = costBasisP - after.costBasisP;
          // 2·released is within one of 2·costBasis·Δ/qty: exact half-up.
          const twice = 2n * released * BigInt(qty);
          const target = 2n * costBasisP * BigInt(sellQty);
          expect(twice - target).toBeGreaterThanOrEqual(-BigInt(qty) + 1n);
          expect(twice - target).toBeLessThanOrEqual(BigInt(qty));
          expect(after.qty).toBe(qty - sellQty);
          expect(after.realizedPnlP).toBe(proceedsP - released);
          expect(after.costBasisP).toBeGreaterThanOrEqual(0n);
          if (sellQty === qty) expect(after.costBasisP).toBe(0n);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('refuses to sell more than is held, or a non-positive amount', () => {
    const held: PositionState = { qty: 10, costBasisP: 500n, realizedPnlP: 0n };
    expect(() => applySell(held, 15, 700n)).toThrow(RangeError);
    expect(() => applySell(held, 0, 0n)).toThrow(RangeError);
    expect(() => applySell(held, 2.5, 0n)).toThrow(RangeError);
    expect(() => applySell(held, 1, -1n)).toThrow(RangeError);
    expect(() => applySell(empty, 1, 0n)).toThrow(RangeError);
  });
});

describe('settle', () => {
  it('pays 100P per contract to the winner and realises payout − cost', () => {
    const won = settle({ qty: 10, costBasisP: 520n, realizedPnlP: 3n }, true);
    expect(won).toEqual({ qty: 0, costBasisP: 0n, realizedPnlP: 483n, payoutP: 1000n });
  });

  it('pays nothing to the loser and realises −cost', () => {
    const lost = settle({ qty: 10, costBasisP: 520n, realizedPnlP: 3n }, false);
    expect(lost).toEqual({ qty: 0, costBasisP: 0n, realizedPnlP: -517n, payoutP: 0n });
  });

  it('is a no-op on an empty row and validates the row', () => {
    expect(settle(empty, true)).toEqual({ ...empty, payoutP: 0n });
    expect(() => settle({ ...empty, qty: -1 }, true)).toThrow(RangeError);
  });
});
