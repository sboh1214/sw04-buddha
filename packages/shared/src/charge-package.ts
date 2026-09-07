import * as z from 'zod';
import { pAmountInputSchema, pAmountSchema } from './api/p-amount.js';
import { uuidSchema } from './api/uuid.js';

/**
 * A charge package: the only way a user buys P (owner decision 2026-09-04). The KRW price is
 * the source of truth and is at most the face value, so the discount is derived, never
 * stored — 4,900원 for 5,000P is a 2% discount. Bigger packages carry bigger discounts, and
 * admins add, edit and remove packages at runtime.
 */
export const CHARGE_PACKAGE_MIN_P = 1_000n;
export const CHARGE_PACKAGE_MAX_P = 1_000_000n;
export const CHARGE_PACKAGE_MAX_KRW = 1_000_000;

/** `1 - price/amount`, rounded to whole percent for display (0 when the price is face value). */
export function discountPercent(amountP: bigint, priceKrw: number): number {
  if (amountP <= 0n) return 0;
  const discounted = Number(amountP) - priceKrw;
  return Math.round((discounted / Number(amountP)) * 100);
}

export const chargePackageSchema = z
  .object({
    id: z.uuid(),
    /** P credited on purchase. */
    amountP: pAmountSchema,
    /** What the user actually pays, in KRW. */
    priceKrw: z.number().int().positive(),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
  })
  .meta({ id: 'ChargePackage' });
export type ChargePackage = z.infer<typeof chargePackageSchema>;

/**
 * `POST /payments/charge`: users may only buy a package, never an arbitrary amount.
 *
 * The body echoes the terms the card showed. An admin may re-price a live package (ADR-0026)
 * while a catalogue that is already on screen keeps rendering the old offer, and the server
 * must not quietly substitute the new one — so the client states what it accepted and a
 * mismatch is refused. Same shape as the PLAN 5.3 slippage guard, which makes a trade carry
 * `maxCostP` / `minProceedsP` and answers `PRICE_MOVED` when the server disagrees.
 *
 * It also names the account the screen is showing. The cookie decides who is charged, and a
 * tab whose session was switched elsewhere (another tab signed in as somebody else; sign-ins
 * are not broadcast) keeps rendering the old account until it refetches — so the server
 * refuses (403 FORBIDDEN naming `expectedAccountId`) rather than credit an account the user is
 * not looking at, and the client's idempotency key never gets filed under the wrong account.
 */
export const chargeBodySchema = z
  .object({
    /** Lower-cased on the way in: the replay compares it with the payment row's (api/uuid.ts). */
    packageId: uuidSchema,
    /** P the card promised. */
    expectedAmountP: pAmountInputSchema,
    /** KRW the card asked for. */
    expectedPriceKrw: chargePackageSchema.shape.priceKrw,
    /** The signed-in user id the wallet screen is showing (better-auth `user.id`, text). */
    expectedAccountId: z.string().min(1).max(255),
  })
  .meta({ id: 'ChargeBody' });
export type ChargeBody = z.infer<typeof chargeBodySchema>;

const packageFields = {
  amountP: pAmountInputSchema.refine(
    (value) => value >= CHARGE_PACKAGE_MIN_P && value <= CHARGE_PACKAGE_MAX_P,
    `must be between ${CHARGE_PACKAGE_MIN_P.toString()} and ${CHARGE_PACKAGE_MAX_P.toString()}`,
  ),
  priceKrw: z.coerce.number().int().positive().max(CHARGE_PACKAGE_MAX_KRW),
  sortOrder: z.coerce.number().int().min(0).max(10_000),
  isActive: z.boolean(),
};

/** The price may never exceed the face value: P is sold at a discount or at par, never above. */
const priceWithinFaceValue = <T extends { amountP: bigint; priceKrw: number }>(value: T) =>
  BigInt(value.priceKrw) <= value.amountP;
const priceRefinement = {
  message: 'priceKrw must not exceed amountP',
  path: ['priceKrw'],
};

export const createChargePackageBodySchema = z
  .object({
    ...packageFields,
    sortOrder: packageFields.sortOrder.default(0),
    isActive: packageFields.isActive.default(true),
  })
  .refine(priceWithinFaceValue, priceRefinement)
  .meta({ id: 'CreateChargePackageBody' });
export type CreateChargePackageBody = z.infer<typeof createChargePackageBodySchema>;

/** PATCH: every field optional, but a price/amount pair still has to stay within face value. */
export const updateChargePackageBodySchema = z
  .object({
    amountP: packageFields.amountP.optional(),
    priceKrw: packageFields.priceKrw.optional(),
    sortOrder: packageFields.sortOrder.optional(),
    isActive: packageFields.isActive.optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'at least one field is required',
  )
  // Only checkable here when both halves are sent; the service re-checks against the stored
  // row for a patch that changes just one of them.
  .refine(
    (value) =>
      value.amountP === undefined ||
      value.priceKrw === undefined ||
      BigInt(value.priceKrw) <= value.amountP,
    priceRefinement,
  )
  .meta({ id: 'UpdateChargePackageBody' });
export type UpdateChargePackageBody = z.infer<typeof updateChargePackageBodySchema>;
