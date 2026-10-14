import { describe, expect, it } from 'vitest';
import { PAYOUT_PER_CONTRACT_COIN, PRICE_MAX, PRICE_MIN } from '../constants.js';
import {
  CONTRACT_PAYOUT_MAX_COIN,
  type ContractTerms,
  PROPOSED_CONTRACT_TERMS,
  assertContractTerms,
} from './terms.js';

describe('PROPOSED_CONTRACT_TERMS', () => {
  it("is the plan's design proposal, in step with the shared constants", () => {
    expect(PROPOSED_CONTRACT_TERMS).toEqual({
      payoutCoin: 100,
      tickCoin: 1,
      priceMinCoin: 1,
      priceMaxCoin: 99,
      voidPayoutYesCoin: 50,
      voidPayoutNoCoin: 50,
    });
    expect(PROPOSED_CONTRACT_TERMS.payoutCoin).toBe(Number(PAYOUT_PER_CONTRACT_COIN));
    expect([PROPOSED_CONTRACT_TERMS.priceMinCoin, PROPOSED_CONTRACT_TERMS.priceMaxCoin]).toEqual([
      PRICE_MIN,
      PRICE_MAX,
    ]);
    expect(() => assertContractTerms(PROPOSED_CONTRACT_TERMS)).not.toThrow();
  });
});

describe('assertContractTerms', () => {
  const T = PROPOSED_CONTRACT_TERMS;

  it('accepts other grids that keep the rules', () => {
    const coarse: ContractTerms = {
      payoutCoin: 1000,
      tickCoin: 5,
      priceMinCoin: 10,
      priceMaxCoin: 990,
      voidPayoutYesCoin: 400,
      voidPayoutNoCoin: 600,
    };
    expect(() => assertContractTerms(coarse)).not.toThrow();
    expect(() =>
      assertContractTerms({ ...T, voidPayoutYesCoin: 0, voidPayoutNoCoin: 100 }),
    ).not.toThrow();
    expect(() =>
      assertContractTerms({
        payoutCoin: CONTRACT_PAYOUT_MAX_COIN,
        tickCoin: 1,
        priceMinCoin: 1,
        priceMaxCoin: CONTRACT_PAYOUT_MAX_COIN - 1,
        voidPayoutYesCoin: CONTRACT_PAYOUT_MAX_COIN / 2,
        voidPayoutNoCoin: CONTRACT_PAYOUT_MAX_COIN / 2,
      }),
    ).not.toThrow();
  });

  it.each<[string, Partial<ContractTerms>]>([
    ['a zero payout', { payoutCoin: 0 }],
    ['a fractional payout', { payoutCoin: 100.5 }],
    ['a zero tick', { tickCoin: 0 }],
    ['a tick that does not divide the payout', { tickCoin: 3, priceMinCoin: 3, priceMaxCoin: 99 }],
    [
      'a payout above the cap',
      {
        payoutCoin: 2_000_000_000,
        priceMaxCoin: 99,
        voidPayoutYesCoin: 1_000_000_000,
        voidPayoutNoCoin: 1_000_000_000,
      },
    ],
    ['a zero lowest price', { priceMinCoin: 0 }],
    ['a highest price at the payout', { priceMaxCoin: 100 }],
    ['an empty range', { priceMinCoin: 60, priceMaxCoin: 40 }],
    ['a lowest price off the tick grid', { tickCoin: 2, priceMinCoin: 1, priceMaxCoin: 98 }],
    ['a highest price off the tick grid', { tickCoin: 2, priceMinCoin: 2, priceMaxCoin: 97 }],
    ['a negative VOID payout', { voidPayoutYesCoin: -10, voidPayoutNoCoin: 110 }],
    [
      'VOID payouts that do not add up to the payout',
      { voidPayoutYesCoin: 50, voidPayoutNoCoin: 40 },
    ],
    ['a non-number', { priceMaxCoin: '99' as unknown as number }],
  ])('rejects %s', (_, over) => {
    expect(() => assertContractTerms({ ...T, ...over })).toThrow(RangeError);
  });
});
