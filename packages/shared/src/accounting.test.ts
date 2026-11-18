import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type PositionState, applyBuy, applySell, settle } from './accounting.js';
import { POSITION_QTY_MAX } from './constants.js';

const empty: PositionState = { qty: 0, costBasisCoin: 0n, realizedPnlCoin: 0n };

describe('applyBuy', () => {
  it('adds contracts and cost, leaving realised PnL alone', () => {
    const position = applyBuy({ qty: 5, costBasisCoin: 250n, realizedPnlCoin: -7n }, 10, 520n);
    expect(position).toEqual({ qty: 15, costBasisCoin: 770n, realizedPnlCoin: -7n });
    expect(applyBuy(empty, 1, 0n)).toEqual({ qty: 1, costBasisCoin: 0n, realizedPnlCoin: 0n });
  });

  it('never mutates its input', () => {
    const before: PositionState = { qty: 1, costBasisCoin: 50n, realizedPnlCoin: 0n };
    applyBuy(before, 1, 50n);
    expect(before).toEqual({ qty: 1, costBasisCoin: 50n, realizedPnlCoin: 0n });
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
    expect(held).toEqual({ qty: 10, costBasisCoin: 520n, realizedPnlCoin: 0n });
    expect(applySell(held, 10, 480n)).toEqual({ qty: 0, costBasisCoin: 0n, realizedPnlCoin: -40n });
  });

  it('releases cost pro rata with half-up rounding', () => {
    // 1000 Coin over 3 contracts: selling 1 releases 333.33 → 333; the remainder stays.
    const third = applySell({ qty: 3, costBasisCoin: 1000n, realizedPnlCoin: 0n }, 1, 400n);
    expect(third).toEqual({ qty: 2, costBasisCoin: 667n, realizedPnlCoin: 67n });
    // 1001 Coin over 2: selling 1 releases 500.5 → 501 (half up), never 500.
    const half = applySell({ qty: 2, costBasisCoin: 1001n, realizedPnlCoin: 0n }, 1, 0n);
    expect(half).toEqual({ qty: 1, costBasisCoin: 500n, realizedPnlCoin: -501n });
    // 5 Coin over 3: selling 2 releases 3.33 → 3.
    expect(applySell({ qty: 3, costBasisCoin: 5n, realizedPnlCoin: 0n }, 2, 10n)).toEqual({
      qty: 1,
      costBasisCoin: 2n,
      realizedPnlCoin: 7n,
    });
    // Odd holdings are never exactly half, so the bigint formula stays exact.
    expect(applySell({ qty: 3, costBasisCoin: 7n, realizedPnlCoin: 0n }, 1, 0n).costBasisCoin).toBe(
      5n,
    );
  });

  it('the released cost is round-half-up of costBasis·Δ/qty for any position', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        (qty, costBasisCoin, sellQty, proceedsCoin) => {
          fc.pre(sellQty <= qty);
          const after = applySell(
            { qty, costBasisCoin, realizedPnlCoin: 0n },
            sellQty,
            proceedsCoin,
          );
          const released = costBasisCoin - after.costBasisCoin;
          // 2·released is within one of 2·costBasis·Δ/qty: exact half-up.
          const twice = 2n * released * BigInt(qty);
          const target = 2n * costBasisCoin * BigInt(sellQty);
          expect(twice - target).toBeGreaterThanOrEqual(-BigInt(qty) + 1n);
          expect(twice - target).toBeLessThanOrEqual(BigInt(qty));
          expect(after.qty).toBe(qty - sellQty);
          expect(after.realizedPnlCoin).toBe(proceedsCoin - released);
          expect(after.costBasisCoin).toBeGreaterThanOrEqual(0n);
          if (sellQty === qty) expect(after.costBasisCoin).toBe(0n);
        },
      ),
      { numRuns: 1000 },
    );
  });

  /**
   * What each sale of a run realised and released, as @buddha/db `applyTradeFill` records it per
   * fill (#124, `fill_realizations`): the before/after difference of the state it wrote.
   */
  function sales(start: PositionState, sells: readonly [qty: number, proceedsCoin: bigint][]) {
    let state = start;
    const rows = sells.map(([qty, proceedsCoin]) => {
      const next = applySell(state, qty, proceedsCoin);
      const row = {
        released: state.costBasisCoin - next.costBasisCoin,
        realized: next.realizedPnlCoin - state.realizedPnlCoin,
      };
      state = next;
      return row;
    });
    return { rows, end: state };
  }

  it('realises per fill by the order of the fills: 100 over 3 at 40 each is +7, +6, +7', () => {
    // Path-dependent: the first sale releases round(100/3) = 33, the second round(67/2) = 34
    // (half-up), the last what is left — so a backfill replays the fills in order (#124).
    const { rows, end } = sales({ qty: 3, costBasisCoin: 100n, realizedPnlCoin: 0n }, [
      [1, 40n],
      [1, 40n],
      [1, 40n],
    ]);
    expect(rows).toEqual([
      { released: 33n, realized: 7n },
      { released: 34n, realized: 6n },
      { released: 33n, realized: 7n },
    ]);
    expect(end).toEqual({ qty: 0, costBasisCoin: 0n, realizedPnlCoin: 20n });
  });

  it('realises 340 over 7 as +23 on 2 at 60, then −18 on the other 5 at 45', () => {
    const { rows, end } = sales({ qty: 7, costBasisCoin: 340n, realizedPnlCoin: 0n }, [
      [2, 120n],
      [5, 225n],
    ]);
    // 340 × 2 / 7 = 97.14… → 97; the rest releases the 243 left.
    expect(rows).toEqual([
      { released: 97n, realized: 23n },
      { released: 243n, realized: -18n },
    ]);
    expect(end).toEqual({ qty: 0, costBasisCoin: 0n, realizedPnlCoin: 5n });
  });

  it('rounds the released cost half-up at the exact half, and down just below it', () => {
    // 5 × 1 / 2 = 2.5 → 3; 5 × 1 / 3 = 1.67 → 2; 4 × 1 / 3 = 1.33 → 1; 1 × 1 / 2 = 0.5 → 1.
    const released = (costBasisCoin: bigint, qty: number) =>
      sales({ qty, costBasisCoin, realizedPnlCoin: 0n }, [[1, 0n]]).rows[0]!.released;
    expect(released(5n, 2)).toBe(3n);
    expect(released(5n, 3)).toBe(2n);
    expect(released(4n, 3)).toBe(1n);
    expect(released(1n, 2)).toBe(1n);
    expect(released(0n, 2)).toBe(0n);
  });

  it('adds up per fill to the position: Σ realised is the P&L, Σ released the cost sold', () => {
    // Any run of buys and sells: the per-fill figures are differences of one running state, so
    // their sums are the position's — to the Coin, whatever the rounding of each sale (#124).
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            buy: fc.boolean(),
            qty: fc.integer({ min: 1, max: 1_000 }),
            priceCoin: fc.integer({ min: 1, max: 99 }),
          }),
          { minLength: 1, maxLength: 40 },
        ),
        (steps) => {
          let state = empty;
          let bought = 0n;
          let realized = 0n;
          let released = 0n;
          for (const step of steps) {
            const amount = BigInt(step.priceCoin) * BigInt(step.qty);
            if (step.buy || state.qty === 0) {
              state = applyBuy(state, step.qty, amount);
              bought += amount;
              continue;
            }
            const qty = Math.min(step.qty, state.qty);
            const proceeds = BigInt(step.priceCoin) * BigInt(qty);
            const next = applySell(state, qty, proceeds);
            const cost = state.costBasisCoin - next.costBasisCoin;
            expect(cost).toBeGreaterThanOrEqual(0n);
            expect(next.realizedPnlCoin - state.realizedPnlCoin).toBe(proceeds - cost);
            // What a fill's record holds, summed on its own — not the state's own differences.
            realized += proceeds - cost;
            released += cost;
            state = next;
          }
          expect(realized).toBe(state.realizedPnlCoin);
          // Every Coin of cost is either still in the position or was released by a sale.
          expect(released + state.costBasisCoin).toBe(bought);
          // Sold out: the sales released the whole cost.
          if (state.qty > 0) {
            const proceeds = BigInt(state.qty);
            const last = applySell(state, state.qty, proceeds);
            expect(released + state.costBasisCoin - last.costBasisCoin).toBe(bought);
            expect(last.costBasisCoin).toBe(0n);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refuses to sell more than is held, or a non-positive amount', () => {
    const held: PositionState = { qty: 10, costBasisCoin: 500n, realizedPnlCoin: 0n };
    expect(() => applySell(held, 15, 700n)).toThrow(RangeError);
    expect(() => applySell(held, 0, 0n)).toThrow(RangeError);
    expect(() => applySell(held, 2.5, 0n)).toThrow(RangeError);
    expect(() => applySell(held, 1, -1n)).toThrow(RangeError);
    expect(() => applySell(empty, 1, 0n)).toThrow(RangeError);
  });
});

describe('settle', () => {
  it('pays 100 Coin per contract to the winner and realises payout − cost', () => {
    const won = settle({ qty: 10, costBasisCoin: 520n, realizedPnlCoin: 3n }, true);
    expect(won).toEqual({ qty: 0, costBasisCoin: 0n, realizedPnlCoin: 483n, payoutCoin: 1000n });
  });

  it('pays nothing to the loser and realises −cost', () => {
    const lost = settle({ qty: 10, costBasisCoin: 520n, realizedPnlCoin: 3n }, false);
    expect(lost).toEqual({ qty: 0, costBasisCoin: 0n, realizedPnlCoin: -517n, payoutCoin: 0n });
  });

  it('is a no-op on an empty row and validates the row', () => {
    expect(settle(empty, true)).toEqual({ ...empty, payoutCoin: 0n });
    expect(() => settle({ ...empty, qty: -1 }, true)).toThrow(RangeError);
  });
});
