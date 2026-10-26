import { describe, expect, it } from 'vitest';
import {
  CHARGE_PACKAGE_MAX_COIN,
  CHARGE_PACKAGE_MIN_COIN,
  chargeBodySchema,
  chargePackageSchema,
  createChargePackageBodySchema,
  discountPercent,
  updateChargePackageBodySchema,
} from './charge-package.js';

const packageId = '3f1a5b6c-1111-4222-8333-444455556666';

describe('discountPercent', () => {
  it('derives the discount from the price and the face value', () => {
    // The seeded ladder: bigger packages are cheaper per Coin (owner decision 2026-09-04).
    expect(discountPercent(5_000n, 4_900)).toBe(2);
    expect(discountPercent(10_000n, 9_700)).toBe(3);
    expect(discountPercent(30_000n, 28_500)).toBe(5);
    expect(discountPercent(50_000n, 46_500)).toBe(7);
    expect(discountPercent(100_000n, 90_000)).toBe(10);
  });

  it('is 0 at face value and never negative in practice', () => {
    expect(discountPercent(10_000n, 10_000)).toBe(0);
    expect(discountPercent(0n, 100)).toBe(0);
  });
});

describe('chargeBodySchema', () => {
  const terms = { packageId, expectedAmountCoin: '10000', expectedPriceKrw: 9_700 };

  it('takes a package id, the terms the card showed and the account on screen', () => {
    expect(chargeBodySchema.parse({ ...terms, expectedAccountId: 'user-1' })).toEqual({
      packageId,
      expectedAmountCoin: 10_000n,
      expectedPriceKrw: 9_700,
      expectedAccountId: 'user-1',
    });
    expect(chargeBodySchema.safeParse({ amountCoin: '10000' }).success).toBe(false);
    expect(chargeBodySchema.safeParse({ packageId: 'not-a-uuid' }).success).toBe(false);
    // Lower-cased on the way in: the replay compares it with the payment row's (api/uuid.ts).
    expect(
      chargeBodySchema.parse({
        ...terms,
        packageId: packageId.toUpperCase(),
        expectedAccountId: 'user-1',
      }).packageId,
    ).toBe(packageId);
  });

  it('requires both terms: an id alone cannot say what offer was accepted', () => {
    expect(chargeBodySchema.safeParse({ packageId, expectedAccountId: 'user-1' }).success).toBe(
      false,
    );
    expect(
      chargeBodySchema.safeParse({ ...terms, expectedPriceKrw: undefined, expectedAccountId: 'u' })
        .success,
    ).toBe(false);
    expect(
      chargeBodySchema.safeParse({
        ...terms,
        expectedAmountCoin: undefined,
        expectedAccountId: 'u',
      }).success,
    ).toBe(false);
  });

  it('requires the account the screen is showing', () => {
    // A stale tab must not be able to charge whoever the cookie now belongs to.
    expect(chargeBodySchema.safeParse(terms).success).toBe(false);
    expect(chargeBodySchema.safeParse({ ...terms, expectedAccountId: '' }).success).toBe(false);
  });
});

describe('chargePackageSchema', () => {
  it('parses a package row', () => {
    expect(
      chargePackageSchema.parse({
        id: packageId,
        amountCoin: '5000',
        priceKrw: 4900,
        sortOrder: 10,
        isActive: true,
      }),
    ).toMatchObject({ priceKrw: 4900, isActive: true });
  });
});

/** The admin on screen, which an admin's charge package write names (ADR-0092). */
const account = { expectedAccountId: 'admin-1' } as const;

describe('createChargePackageBodySchema', () => {
  it('defaults the order and availability, and yields a bigint amount', () => {
    expect(
      createChargePackageBodySchema.parse({ amountCoin: '5000', priceKrw: 4900, ...account }),
    ).toEqual({
      amountCoin: 5_000n,
      priceKrw: 4900,
      sortOrder: 0,
      isActive: true,
      ...account,
    });
  });

  it('refuses a price above face value and amounts outside the bounds', () => {
    for (const body of [
      { amountCoin: '5000', priceKrw: 5001, ...account },
      { amountCoin: (CHARGE_PACKAGE_MIN_COIN - 1n).toString(), priceKrw: 500, ...account },
      { amountCoin: (CHARGE_PACKAGE_MAX_COIN + 1n).toString(), priceKrw: 1000, ...account },
      { amountCoin: '5000', priceKrw: 0, ...account },
      { amountCoin: '5000', priceKrw: -100, ...account },
      { amountCoin: '5000', ...account },
      // ADR-0092: the admin on screen.
      { amountCoin: '5000', priceKrw: 4900 },
    ]) {
      expect(createChargePackageBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });
});

describe('face-value refinement', () => {
  it('never sees a fractional price: that is one invalid_type issue, not a RangeError', async () => {
    // `priceWithinFaceValue` calls BigInt(priceKrw), which throws on 1.5. It never gets the
    // chance: zod 4's `.int()` reports a fraction as an aborting `invalid_type` issue, and an
    // object's refinements are skipped once any aborting issue exists (documented as the
    // `when` escape hatch, which nothing here uses). Exactly one issue proves the refinement
    // did not run. Pinned because a zod upgrade that changed this would turn the documented
    // VALIDATION_ERROR into a 500.
    for (const priceKrw of [1.5, '1.5', -0.5]) {
      for (const schema of [createChargePackageBodySchema, updateChargePackageBodySchema]) {
        const result = schema.safeParse({ amountCoin: '5000', priceKrw, ...account });
        expect(result.success, String(priceKrw)).toBe(false);
        expect(result.error?.issues.map((issue) => [issue.path, issue.code])).toEqual([
          [['priceKrw'], 'invalid_type'],
        ]);
      }
    }
    // The Standard Schema entry point is what the API's validation pipe calls.
    const standard = await createChargePackageBodySchema['~standard'].validate({
      amountCoin: '5000',
      priceKrw: 1.5,
      ...account,
    });
    expect(standard.issues?.map((issue) => issue.path)).toEqual([['priceKrw']]);
  });

  it('still runs after a range failure, where the price is an integer and BigInt is safe', () => {
    // `.max()` failing is not aborting, so the refinement does run — on an integer.
    const result = createChargePackageBodySchema.safeParse({
      amountCoin: '5000',
      priceKrw: 2_000_000,
      ...account,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big', 'custom']);
  });
});

describe('updateChargePackageBodySchema', () => {
  it('accepts a single field but not an empty patch', () => {
    expect(updateChargePackageBodySchema.parse({ isActive: false, ...account })).toEqual({
      isActive: false,
      ...account,
    });
    expect(updateChargePackageBodySchema.parse({ priceKrw: 4500, ...account })).toEqual({
      priceKrw: 4500,
      ...account,
    });
    // The account is always there, so it is no field: a patch of it alone is empty.
    expect(updateChargePackageBodySchema.safeParse({ ...account }).success).toBe(false);
    expect(updateChargePackageBodySchema.safeParse({ isActive: false }).success).toBe(false);
  });

  it('still refuses a price above the amount when both are given', () => {
    expect(
      updateChargePackageBodySchema.safeParse({ amountCoin: '5000', priceKrw: 6000, ...account })
        .success,
    ).toBe(false);
  });
});
