import * as z from 'zod';
import { pAmountInputSchema, pAmountSchema } from './api/p-amount.js';
import {
  COUPON_CODE_MAX_LENGTH,
  COUPON_CODE_MIN_LENGTH,
  COUPON_CODE_PATTERN,
} from './constants.js';

/**
 * Coupons let an admin hand out P without touching a balance directly (owner decision
 * 2026-09-04): they carry an amount, an optional expiry and an optional redemption cap, and
 * each account may redeem a given code once. Redeeming writes a BONUS ledger entry.
 */
export const COUPON_MIN_P = 1n;
export const COUPON_MAX_P = 1_000_000n;
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

export const redeemCouponBodySchema = z
  .object({ code: couponCodeSchema })
  .meta({ id: 'RedeemCouponBody' });
export type RedeemCouponBody = z.infer<typeof redeemCouponBodySchema>;

export const couponSchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    amountP: pAmountSchema,
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

export const createCouponBodySchema = z
  .object({
    /** Omitted: the server generates a readable random code. */
    code: couponCodeSchema.optional(),
    amountP: pAmountInputSchema.refine(
      (value) => value >= COUPON_MIN_P && value <= COUPON_MAX_P,
      `must be between ${COUPON_MIN_P.toString()} and ${COUPON_MAX_P.toString()}`,
    ),
    maxRedemptions: z.coerce.number().int().positive().max(1_000_000).nullish(),
    expiresAt: z.iso.datetime().nullish(),
    memo: z.string().trim().max(COUPON_MEMO_MAX_LENGTH).nullish(),
  })
  .meta({ id: 'CreateCouponBody' });
export type CreateCouponBody = z.infer<typeof createCouponBodySchema>;

/** Only the knobs that stay safe once a coupon is out in the world. */
export const updateCouponBodySchema = z
  .object({
    isActive: z.boolean().optional(),
    maxRedemptions: z.coerce.number().int().positive().max(1_000_000).nullish(),
    expiresAt: z.iso.datetime().nullish(),
    memo: z.string().trim().max(COUPON_MEMO_MAX_LENGTH).nullish(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'at least one field is required',
  )
  .meta({ id: 'UpdateCouponBody' });
export type UpdateCouponBody = z.infer<typeof updateCouponBodySchema>;
