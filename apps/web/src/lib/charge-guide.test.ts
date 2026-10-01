import { CARD_MIN_PRICE_KRW } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import {
  CHARGE_TIER_COUNT,
  chargeGuideOffers,
  chargeTiers,
  walletPackageHref,
} from './charge-guide';

describe('chargeTiers', () => {
  it('spans the smallest to the largest package over the four pictures', () => {
    expect(chargeTiers([1_000n, 5_000n, 10_000n, 50_000n])).toEqual([0, 1, 2, 3]);
    expect(chargeTiers([1_000n, 50_000n])).toEqual([0, CHARGE_TIER_COUNT - 1]);
    expect(chargeTiers([1_000n, 5_000n, 10_000n])).toEqual([0, 2, 3]);
  });

  it('ranks by amount, not by position, and keeps the input order', () => {
    expect(chargeTiers([50_000n, 1_000n, 10_000n, 5_000n])).toEqual([3, 0, 2, 1]);
  });

  it('gives equal amounts the same tier', () => {
    expect(chargeTiers([10_000n, 1_000n, 10_000n])).toEqual([3, 0, 3]);
  });

  it('squeezes a long catalogue into four tiers, both ends pinned', () => {
    const tiers = chargeTiers([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
    expect(tiers[0]).toBe(0);
    expect(tiers.at(-1)).toBe(CHARGE_TIER_COUNT - 1);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(new Set(tiers)).toEqual(new Set([0, 1, 2, 3]));
  });

  it('draws the single coin for a lone amount and nothing for an empty catalogue', () => {
    expect(chargeTiers([10_000n])).toEqual([0]);
    expect(chargeTiers([10_000n, 10_000n])).toEqual([0, 0]);
    expect(chargeTiers([])).toEqual([]);
  });
});

describe('walletPackageHref', () => {
  it('opens the wallet with the package preselected', () => {
    expect(walletPackageHref('0190c7a4-0000-7000-8000-000000000001')).toEqual({
      pathname: '/wallet',
      query: { package: '0190c7a4-0000-7000-8000-000000000001' },
    });
  });
});

describe('chargeGuideOffers', () => {
  it('holds back a package the SmartroPay window cannot take, from 1,000원 up it offers', () => {
    expect(chargeGuideOffers('smartro', CARD_MIN_PRICE_KRW - 1)).toBe(false);
    expect(chargeGuideOffers('smartro', 0)).toBe(false);
    expect(chargeGuideOffers('smartro', CARD_MIN_PRICE_KRW)).toBe(true);
    expect(chargeGuideOffers('smartro', 50_000)).toBe(true);
  });

  it('offers everything under the mock charge, which has no card minimum', () => {
    for (const price of [0, CARD_MIN_PRICE_KRW - 1, CARD_MIN_PRICE_KRW, 50_000]) {
      expect(chargeGuideOffers('mock', price), String(price)).toBe(true);
    }
  });

  it('leaves the page as it was when the provider could not be read — the wallet decides', () => {
    expect(chargeGuideOffers(null, CARD_MIN_PRICE_KRW - 1)).toBe(true);
    expect(chargeGuideOffers(null, CARD_MIN_PRICE_KRW)).toBe(true);
  });
});
