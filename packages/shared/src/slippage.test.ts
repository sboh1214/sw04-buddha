import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parsePAmount } from './api/p-amount.js';
import { MAX_P_AMOUNT } from './constants.js';
import { TRADE_SLIPPAGE_BP, TRADE_SLIPPAGE_MIN_P, slippageGuard } from './slippage.js';

const RUNS = { numRuns: 1000 };

/** The result has no discriminant field: a buy answers only maxCostP, a sell only minProceedsP. */
function maxCostOf(amountP: bigint, budgetP?: bigint): bigint {
  const guard = slippageGuard('buy', amountP, budgetP);
  if (!('maxCostP' in guard)) throw new TypeError('a buy must guard with maxCostP');
  return parsePAmount(guard.maxCostP);
}

function minProceedsOf(amountP: bigint): bigint {
  const guard = slippageGuard('sell', amountP);
  if (!('minProceedsP' in guard)) throw new TypeError('a sell must guard with minProceedsP');
  return parsePAmount(guard.minProceedsP);
}

describe('slippageGuard', () => {
  it('is a fixed 1% tolerance with a 1P floor', () => {
    expect(TRADE_SLIPPAGE_BP).toBe(100);
    expect(TRADE_SLIPPAGE_MIN_P).toBe(1n);
  });

  it('gives both sides the same headroom around the quote', () => {
    expect(slippageGuard('buy', 6300n)).toEqual({ maxCostP: '6363' });
    expect(slippageGuard('sell', 6300n)).toEqual({ minProceedsP: '6237' });
  });

  it('floors the headroom at 1P so a cheap trade still tolerates a move', () => {
    // 1% of 40P is 0.4P: rounded down the sell would have had zero tolerance and every
    // cheap sell would thrash into PRICE_MOVED.
    expect(slippageGuard('buy', 40n)).toEqual({ maxCostP: '41' });
    expect(slippageGuard('sell', 40n)).toEqual({ minProceedsP: '39' });
  });

  it('never exceeds a spend-mode budget, and ignores one above the ceiling', () => {
    expect(slippageGuard('buy', 4000n, 4020n)).toEqual({ maxCostP: '4020' });
    expect(slippageGuard('buy', 4000n, 999_999n)).toEqual({ maxCostP: '4040' });
  });

  it('keeps the body inside the bounds tradeBodySchema enforces', () => {
    // maxCostP is boundedPAmount(1n): a zero quote, or a zero budget, still sends 1.
    expect(slippageGuard('buy', 0n)).toEqual({ maxCostP: '1' });
    expect(slippageGuard('buy', 4000n, 0n)).toEqual({ maxCostP: '1' });
    // minProceedsP is boundedPAmount(0n) and never goes negative.
    expect(slippageGuard('sell', 0n)).toEqual({ minProceedsP: '0' });
    expect(slippageGuard('buy', MAX_P_AMOUNT)).toEqual({ maxCostP: MAX_P_AMOUNT.toString() });
  });

  it('brackets the quote and stays inside the schema bounds for any amount', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_P_AMOUNT }), (amountP) => {
        const maxCostP = maxCostOf(amountP);
        expect(maxCostP).toBeGreaterThanOrEqual(amountP);
        expect(maxCostP).toBeGreaterThanOrEqual(1n);
        expect(maxCostP).toBeLessThanOrEqual(MAX_P_AMOUNT);

        const minProceedsP = minProceedsOf(amountP);
        expect(minProceedsP).toBeGreaterThanOrEqual(0n);
        expect(minProceedsP).toBeLessThanOrEqual(amountP);
      }),
      RUNS,
    );
  });

  it('never charges more than the budget a spend-mode buy authored', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: MAX_P_AMOUNT }),
        fc.bigInt({ min: 1n, max: MAX_P_AMOUNT }),
        (amountP, budgetP) => {
          expect(maxCostOf(amountP, budgetP)).toBeLessThanOrEqual(budgetP);
        },
      ),
      RUNS,
    );
  });
});
