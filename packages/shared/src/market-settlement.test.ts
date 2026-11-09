import { describe, expect, it } from 'vitest';
import { settlePosition, settlementPayoutPerContract } from './market-settlement.js';

describe('settlement (#126)', () => {
  it.each([
    ['YES', 'YES', 100],
    ['YES', 'NO', 0],
    ['NO', 'YES', 0],
    ['NO', 'NO', 100],
    ['VOID', 'YES', 50],
    ['VOID', 'NO', 50],
  ] as const)('%s pays each %s contract %i Coin', (result, outcome, payout) => {
    expect(settlementPayoutPerContract(result, outcome)).toBe(payout);
    expect(
      settlePosition({ qty: 3, costBasisCoin: 180n, realizedPnlCoin: 7n }, result, outcome),
    ).toEqual({
      qty: 0,
      costBasisCoin: 0n,
      payoutPerContractCoin: payout,
      payoutCoin: BigInt(payout * 3),
      settlementPnlCoin: BigInt(payout * 3) - 180n,
      realizedPnlCoin: BigInt(payout * 3) - 173n,
    });
  });

  it('VOID pays the same amount at different costs and keeps earlier realized PnL', () => {
    for (const costBasisCoin of [20n, 80n]) {
      const after = settlePosition({ qty: 1, costBasisCoin, realizedPnlCoin: 13n }, 'VOID', 'YES');
      expect(after.payoutCoin).toBe(50n);
      expect(after.settlementPnlCoin).toBe(50n - costBasisCoin);
      expect(after.realizedPnlCoin).toBe(63n - costBasisCoin);
    }
  });

  it('closes zero holdings without a payout or new PnL and refuses malformed holdings', () => {
    const empty = { qty: 0, costBasisCoin: 0n, realizedPnlCoin: -9n };
    expect(settlePosition(empty, 'VOID', 'NO')).toMatchObject({
      ...empty,
      payoutCoin: 0n,
      settlementPnlCoin: 0n,
    });
    for (const qty of [-1, 0.5, Number.NaN]) {
      expect(() => settlePosition({ ...empty, qty }, 'YES', 'YES')).toThrow(RangeError);
    }
    expect(() => settlePosition({ ...empty, costBasisCoin: 1n }, 'YES', 'YES')).toThrow(RangeError);
  });
});
