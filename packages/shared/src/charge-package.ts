import * as z from 'zod';
import { coinAmountInputSchema, coinAmountSchema } from './api/coin-amount.js';
import { uuidSchema } from './api/uuid.js';
import { expectedAccountIdSchema, namesAFieldBesideAccount } from './expected-account.js';

/**
 * A charge package: the only way a user buys Coin (owner decision 2026-09-04). The KRW price is
 * the source of truth and is at most the face value, so the discount is derived, never
 * stored — 4,900원 for 5,000 Coin is a 2% discount. Bigger packages carry bigger discounts, and
 * admins add, edit and remove packages at runtime.
 */
export const CHARGE_PACKAGE_MIN_COIN = 1_000n;
export const CHARGE_PACKAGE_MAX_COIN = 1_000_000n;
export const CHARGE_PACKAGE_MAX_KRW = 1_000_000;

/** `1 - price/amount`, rounded to whole percent for display (0 when the price is face value). */
export function discountPercent(amountCoin: bigint, priceKrw: number): number {
  if (amountCoin <= 0n) return 0;
  const discounted = Number(amountCoin) - priceKrw;
  return Math.round((discounted / Number(amountCoin)) * 100);
}

export const chargePackageSchema = z
  .object({
    id: z.uuid(),
    /** Coin credited on purchase. */
    amountCoin: coinAmountSchema,
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
 * mismatch is refused with `PRICE_MOVED`.
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
    /** Coin the card promised. */
    expectedAmountCoin: coinAmountInputSchema,
    /** KRW the card asked for. */
    expectedPriceKrw: chargePackageSchema.shape.priceKrw,
    /** The signed-in user id the wallet screen is showing (better-auth `user.id`, text). */
    expectedAccountId: z.string().min(1).max(255),
  })
  .meta({ id: 'ChargeBody' });
export type ChargeBody = z.infer<typeof chargeBodySchema>;

const packageFields = {
  amountCoin: coinAmountInputSchema.refine(
    (value) => value >= CHARGE_PACKAGE_MIN_COIN && value <= CHARGE_PACKAGE_MAX_COIN,
    `must be between ${CHARGE_PACKAGE_MIN_COIN.toString()} and ${CHARGE_PACKAGE_MAX_COIN.toString()}`,
  ),
  priceKrw: z.coerce.number().int().positive().max(CHARGE_PACKAGE_MAX_KRW),
  sortOrder: z.coerce.number().int().min(0).max(10_000),
  isActive: z.boolean(),
};

/** The price may never exceed the face value: Coin is sold at a discount or at par, never above. */
const priceWithinFaceValue = <T extends { amountCoin: bigint; priceKrw: number }>(value: T) =>
  BigInt(value.priceKrw) <= value.amountCoin;
const priceRefinement = {
  message: 'priceKrw must not exceed amountCoin',
  path: ['priceKrw'],
};

/**
 * `POST /admin/charge-packages`, as the admin on screen (`expectedAccountId`, ADR-0092 — the edit
 * names it too, and the removal in its query).
 */
export const createChargePackageBodySchema = z
  .object({
    ...packageFields,
    sortOrder: packageFields.sortOrder.default(0),
    isActive: packageFields.isActive.default(true),
    expectedAccountId: expectedAccountIdSchema,
  })
  .refine(priceWithinFaceValue, priceRefinement)
  .meta({ id: 'CreateChargePackageBody' });
export type CreateChargePackageBody = z.infer<typeof createChargePackageBodySchema>;

/**
 * PATCH: every field optional — at least one beside the account — but a price/amount pair still
 * has to stay within face value.
 */
export const updateChargePackageBodySchema = z
  .object({
    amountCoin: packageFields.amountCoin.optional(),
    priceKrw: packageFields.priceKrw.optional(),
    sortOrder: packageFields.sortOrder.optional(),
    isActive: packageFields.isActive.optional(),
    expectedAccountId: expectedAccountIdSchema,
  })
  .refine(namesAFieldBesideAccount, 'at least one field is required')
  // Only checkable here when both halves are sent; the service re-checks against the stored
  // row for a patch that changes just one of them.
  .refine(
    (value) =>
      value.amountCoin === undefined ||
      value.priceKrw === undefined ||
      BigInt(value.priceKrw) <= value.amountCoin,
    priceRefinement,
  )
  .meta({ id: 'UpdateChargePackageBody' });
export type UpdateChargePackageBody = z.infer<typeof updateChargePackageBodySchema>;
