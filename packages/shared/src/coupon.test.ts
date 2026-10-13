import { describe, expect, it } from 'vitest';
import {
  COUPON_MAX_COIN,
  couponCodeSchema,
  couponSchema,
  createCouponBodySchema,
  redeemCouponBodySchema,
  updateCouponBodySchema,
} from './coupon.js';

describe('couponCodeSchema', () => {
  it('upper-cases and trims what the user types', () => {
    expect(couponCodeSchema.parse('  welcome-2026 ')).toBe('WELCOME-2026');
    expect(redeemCouponBodySchema.parse({ code: 'abcd', expectedAccountId: 'user-1' })).toEqual({
      code: 'ABCD',
      expectedAccountId: 'user-1',
    });
    // The account the screen shows is required: a stale tab must not redeem for the cookie's.
    expect(redeemCouponBodySchema.safeParse({ code: 'abcd' }).success).toBe(false);
  });

  it('rejects codes that are too short, too long or use other characters', () => {
    for (const code of ['ABC', 'A'.repeat(33), 'WITH SPACE', 'under_score', '한글쿠폰', '']) {
      expect(couponCodeSchema.safeParse(code).success, code).toBe(false);
    }
  });
});

describe('createCouponBodySchema', () => {
  it('takes an amount and optional limits; the code may be omitted', () => {
    expect(createCouponBodySchema.parse({ amountCoin: '5000' })).toEqual({ amountCoin: 5_000n });
    expect(
      createCouponBodySchema.parse({
        code: 'welcome',
        amountCoin: '5000',
        maxRedemptions: 100,
        expiresAt: '2026-12-31T14:59:59.000Z',
        memo: '  런칭 이벤트  ',
      }),
    ).toMatchObject({ code: 'WELCOME', maxRedemptions: 100, memo: '런칭 이벤트' });
  });

  it('refuses a non-positive amount, an amount above the cap and a zero cap', () => {
    for (const body of [
      { amountCoin: '0' },
      { amountCoin: '-100' },
      { amountCoin: (COUPON_MAX_COIN + 1n).toString() },
      { amountCoin: '1000', maxRedemptions: 0 },
      { amountCoin: '1000', expiresAt: 'tomorrow' },
    ]) {
      expect(createCouponBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('updateCouponBodySchema', () => {
  it('accepts a single field and allows clearing the optional limits', () => {
    expect(updateCouponBodySchema.parse({ isActive: false })).toEqual({ isActive: false });
    expect(updateCouponBodySchema.parse({ expiresAt: null })).toEqual({ expiresAt: null });
    expect(updateCouponBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('couponSchema', () => {
  it('parses a coupon with unlimited redemptions and no expiry', () => {
    expect(
      couponSchema.parse({
        id: '3f1a5b6c-1111-4222-8333-444455556666',
        code: 'WELCOME',
        amountCoin: '5000',
        maxRedemptions: null,
        redeemedCount: 3,
        expiresAt: null,
        isActive: true,
        memo: null,
        createdAt: '2026-09-04T04:05:06.000Z',
      }),
    ).toMatchObject({ code: 'WELCOME', redeemedCount: 3 });
  });
});
