import * as z from 'zod';
import { coinAmountInputSchema, coinAmountSchema } from './api/coin-amount.js';
import {
  COUPON_CODE_MAX_LENGTH,
  COUPON_CODE_MIN_LENGTH,
  COUPON_CODE_PATTERN,
} from './constants.js';
import { expectedAccountIdSchema, namesAFieldBesideAccount } from './expected-account.js';

/**
 * Coupons let an admin hand out Coin without touching a balance directly (owner decision
 * 2026-09-04): they carry an amount, an optional expiry and an optional redemption cap, and
 * each account may redeem a given code once. Redeeming writes a BONUS ledger entry.
 */
export const COUPON_MIN_COIN = 1n;
export const COUPON_MAX_COIN = 1_000_000n;
export const COUPON_MEMO_MAX_LENGTH = 200;

/** Codes are stored and compared upper-case; the client may type them in any case. */
export const couponCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(COUPON_CODE_MIN_LENGTH)
  .max(COUPON_CODE_MAX_LENGTH)
  .regex(COUPON_CODE_PATTERN, 'only A-Z, 0-9 and -')
  .meta({ id: 'CouponCode' });

/**
 * `POST /coupons/redeem`. `expectedAccountId` names the account the wallet screen is showing:
 * the cookie decides who redeems, and a tab whose session was switched elsewhere keeps showing
 * the old account until it refetches, so the server refuses (403 FORBIDDEN naming the field)
 * rather than spend a one-use or capped coupon on an account the user is not looking at.
 */
export const redeemCouponBodySchema = z
  .object({
    code: couponCodeSchema,
    /** The signed-in user id the wallet screen is showing (better-auth `user.id`, text). */
    expectedAccountId: z.string().min(1).max(255),
  })
  .meta({ id: 'RedeemCouponBody' });
export type RedeemCouponBody = z.infer<typeof redeemCouponBodySchema>;

export const couponSchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    amountCoin: coinAmountSchema,
    /** null = unlimited. */
    maxRedemptions: z.number().int().positive().nullable(),
    redeemedCount: z.number().int(),
    expiresAt: z.iso.datetime().nullable(),
    isActive: z.boolean(),
    memo: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Coupon' });
export type Coupon = z.infer<typeof couponSchema>;

/** `POST /admin/coupons`, as the admin on screen (`expectedAccountId`, ADR-0092). */
export const createCouponBodySchema = z
  .object({
    /** Omitted: the server generates a readable random code. */
    code: couponCodeSchema.optional(),
    amountCoin: coinAmountInputSchema.refine(
      (value) => value >= COUPON_MIN_COIN && value <= COUPON_MAX_COIN,
      `must be between ${COUPON_MIN_COIN.toString()} and ${COUPON_MAX_COIN.toString()}`,
    ),
    maxRedemptions: z.coerce.number().int().positive().max(1_000_000).nullish(),
    expiresAt: z.iso.datetime().nullish(),
    memo: z.string().trim().max(COUPON_MEMO_MAX_LENGTH).nullish(),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'CreateCouponBody' });
export type CreateCouponBody = z.infer<typeof createCouponBodySchema>;

/**
 * Only the knobs that stay safe once a coupon is out in the world — at least one — and the admin
 * on screen.
 */
export const updateCouponBodySchema = z
  .object({
    isActive: z.boolean().optional(),
    maxRedemptions: z.coerce.number().int().positive().max(1_000_000).nullish(),
    expiresAt: z.iso.datetime().nullish(),
    memo: z.string().trim().max(COUPON_MEMO_MAX_LENGTH).nullish(),
    expectedAccountId: expectedAccountIdSchema,
  })
  .refine(namesAFieldBesideAccount, 'at least one field is required')
  .meta({ id: 'UpdateCouponBody' });
export type UpdateCouponBody = z.infer<typeof updateCouponBodySchema>;
