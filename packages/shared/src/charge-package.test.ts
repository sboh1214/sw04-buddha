import { describe, expect, it } from 'vitest';
import {
  CHARGE_PACKAGE_MAX_P,
  CHARGE_PACKAGE_MIN_P,
  chargeBodySchema,
  chargePackageSchema,
  createChargePackageBodySchema,
  discountPercent,
  updateChargePackageBodySchema,
} from './charge-package.js';

const packageId = '3f1a5b6c-1111-4222-8333-444455556666';

describe('discountPercent', () => {
  it('derives the discount from the price and the face value', () => {
    // The seeded ladder: bigger packages are cheaper per P (owner decision 2026-09-04).
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
  const terms = { packageId, expectedAmountP: '10000', expectedPriceKrw: 9_700 };

  it('takes a package id, the terms the card showed and the account on screen', () => {
    expect(chargeBodySchema.parse({ ...terms, expectedAccountId: 'user-1' })).toEqual({
      packageId,
      expectedAmountP: 10_000n,
      expectedPriceKrw: 9_700,
      expectedAccountId: 'user-1',
    });
    expect(chargeBodySchema.safeParse({ amountP: '10000' }).success).toBe(false);
    expect(chargeBodySchema.safeParse({ packageId: 'not-a-uuid' }).success).toBe(false);
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
      chargeBodySchema.safeParse({ ...terms, expectedAmountP: undefined, expectedAccountId: 'u' })
        .success,
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
        amountP: '5000',
        priceKrw: 4900,
        sortOrder: 10,
        isActive: true,
      }),
    ).toMatchObject({ priceKrw: 4900, isActive: true });
  });
});

describe('createChargePackageBodySchema', () => {
  it('defaults the order and availability, and yields a bigint amount', () => {
    expect(createChargePackageBodySchema.parse({ amountP: '5000', priceKrw: 4900 })).toEqual({
      amountP: 5_000n,
      priceKrw: 4900,
      sortOrder: 0,
      isActive: true,
    });
  });

  it('refuses a price above face value and amounts outside the bounds', () => {
    for (const body of [
      { amountP: '5000', priceKrw: 5001 },
      { amountP: (CHARGE_PACKAGE_MIN_P - 1n).toString(), priceKrw: 500 },
      { amountP: (CHARGE_PACKAGE_MAX_P + 1n).toString(), priceKrw: 1000 },
      { amountP: '5000', priceKrw: 0 },
      { amountP: '5000', priceKrw: -100 },
      { amountP: '5000' },
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
        const result = schema.safeParse({ amountP: '5000', priceKrw });
        expect(result.success, String(priceKrw)).toBe(false);
        expect(result.error?.issues.map((issue) => [issue.path, issue.code])).toEqual([
          [['priceKrw'], 'invalid_type'],
        ]);
      }
    }
    // The Standard Schema entry point is what the API's validation pipe calls.
    const standard = await createChargePackageBodySchema['~standard'].validate({
      amountP: '5000',
      priceKrw: 1.5,
    });
    expect(standard.issues?.map((issue) => issue.path)).toEqual([['priceKrw']]);
  });

  it('still runs after a range failure, where the price is an integer and BigInt is safe', () => {
    // `.max()` failing is not aborting, so the refinement does run — on an integer.
    const result = createChargePackageBodySchema.safeParse({
      amountP: '5000',
      priceKrw: 2_000_000,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big', 'custom']);
  });
});

describe('updateChargePackageBodySchema', () => {
  it('accepts a single field but not an empty patch', () => {
    expect(updateChargePackageBodySchema.parse({ isActive: false })).toEqual({ isActive: false });
    expect(updateChargePackageBodySchema.parse({ priceKrw: 4500 })).toEqual({ priceKrw: 4500 });
    expect(updateChargePackageBodySchema.safeParse({}).success).toBe(false);
  });

  it('still refuses a price above the amount when both are given', () => {
    expect(
      updateChargePackageBodySchema.safeParse({ amountP: '5000', priceKrw: 6000 }).success,
    ).toBe(false);
  });
});
