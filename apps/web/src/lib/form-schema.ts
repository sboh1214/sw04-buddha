import { couponCodeSchema } from '@buddha/shared';
import * as z from 'zod';

/**
 * Building blocks for the admin forms, whose amounts are integer strings that get converted
 * with `BigInt()` (Coin is a bigint end to end — see `parseCoinAmount` in @buddha/shared).
 *
 * The conversion has to be gated. zod 4 keeps running a schema's later checks after an
 * earlier one has already failed, because it wants to report every issue at once, so a plain
 * `.regex(/^\d+$/).refine((v) => BigInt(v) > 0n)` still calls `BigInt('abc')` — which throws
 * SyntaxError straight out of `safeParse`. react-hook-form's resolver then rejects instead of
 * returning field errors, and the form silently does nothing at all when the admin submits.
 */

/** An integer string in `pattern`. Nothing here converts, so it is safe on any input. */
export const integerField = (pattern: RegExp, message: string) =>
  z.string().trim().regex(pattern, message);

/**
 * `integerField` plus a range check. `.pipe()` is the gate: the second schema runs only once
 * the first has passed, so `BigInt` never sees a string that is not digits.
 *
 * A cross-field `.refine()` on the surrounding object cannot be gated this way — it runs even
 * when one of its fields failed, and receives the raw string — so those have to test the
 * format themselves before converting, the way `updateChargePackageBodySchema` does.
 */
export const boundedInteger = (
  pattern: RegExp,
  formatMessage: string,
  inRange: (value: bigint) => boolean,
  rangeMessage: string,
) =>
  integerField(pattern, formatMessage).pipe(
    z.string().refine((value) => inRange(BigInt(value)), rangeMessage),
  );

/**
 * A coupon code an admin typed, or blank to let the server generate one
 * (`createCouponBodySchema.code` is optional, and the form omits the field when it is empty).
 *
 * The rule is the API's own `couponCodeSchema` rather than a restatement of it: stating it
 * twice is how the form came to accept `WELCOME_2026`, which the server rejects with nothing
 * but a generic toast. Only the message is localised, the same way `wallet/coupon-form.tsx`
 * localises the redeem field.
 */
export const optionalCouponCode = (message: string) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .refine((code) => code === '' || couponCodeSchema.safeParse(code).success, message);
