import { describe, expect, it } from 'vitest';
import {
  CHARGE_TIER_COUNT,
  chargeTiers,
  walletLoginPath,
  walletPackageHref,
  walletPackageId,
} from './charge-guide';
import { safeNextPath } from './next-path';

const PACKAGE_ID = '0190c7a4-0000-7000-8000-000000000001';

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
    expect(walletPackageHref(PACKAGE_ID)).toEqual({
      pathname: '/wallet',
      query: { package: PACKAGE_ID },
    });
  });
});

describe('walletPackageId', () => {
  it('reads one well-formed id, lower-cased as the API answers it', () => {
    expect(walletPackageId(PACKAGE_ID)).toBe(PACKAGE_ID);
    expect(walletPackageId(PACKAGE_ID.toUpperCase())).toBe(PACKAGE_ID);
  });

  it('drops what no link of ours carries: junk, an empty value, a repeated parameter', () => {
    expect(walletPackageId(undefined)).toBeUndefined();
    expect(walletPackageId('')).toBeUndefined();
    expect(walletPackageId('../admin')).toBeUndefined();
    expect(walletPackageId([PACKAGE_ID, PACKAGE_ID])).toBeUndefined();
  });
});

describe('walletLoginPath', () => {
  it('keeps the plain wallet redirect exactly as it was', () => {
    expect(walletLoginPath(undefined)).toBe('/login?next=/wallet');
  });

  it('carries the /charge package through the login, and the login page accepts it', () => {
    const next = new URL(walletLoginPath(PACKAGE_ID), 'https://x.invalid').searchParams.get('next');
    expect(next).toBe(`/wallet?package=${PACKAGE_ID}`);
    // What LoginPage does with it: same-origin, so it is where the sign-in lands.
    expect(safeNextPath(next)).toBe(`/wallet?package=${PACKAGE_ID}`);
  });
});
