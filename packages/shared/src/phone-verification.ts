import * as z from 'zod';

/**
 * 본인확인 (#183, ADR-0070): a signed-in account proves it holds a Korean mobile number by typing
 * back the six-digit code the server texted to it, and gives its real name on the same screen
 * (ADR-0069 decision 1, #57-3). What the account then has is one record — the number it proved,
 * the real name it gave and when — which replaces ADR-0043's unverified real name and number: the
 * verification step is the only place a number is entered, and the number cannot be changed by
 * the member afterwards (operators change it in the database, #57-3). The real name stays
 * editable in MY 설정.
 *
 * Neither the number nor the record is public (N04 §2, PRIVATE_DATA `phone` and
 * `identity-verification`): only the account itself reads them, on `GET /me`.
 */

/** phone_verifications.real_name is varchar(30). */
export const REAL_NAME_MIN_LENGTH = 2;
export const REAL_NAME_MAX_LENGTH = 30;

/**
 * Letters of any script (Hangul, Latin, …), with spaces and the middle dot `·` between them —
 * no digits, no other symbols. Starts and ends with a letter (or a combining mark after one).
 */
export const REAL_NAME_PATTERN = /^\p{L}[\p{L}\p{M} ·]*[\p{L}\p{M}]$/u;

/** A Korean mobile number, digits only: 010/011/016/017/018/019 + 7 or 8 digits. */
export const PHONE_PATTERN = /^01[016789]\d{7,8}$/;

/**
 * NFC-normalised before the checks, so a name typed as decomposed Hangul (NFD, macOS) is stored
 * as the same syllables and counted by syllable, not by jamo. Checked for shape only: the code
 * proves the number, not the name.
 */
export const realNameSchema = z
  .string()
  .trim()
  .normalize('NFC')
  .min(REAL_NAME_MIN_LENGTH)
  .max(REAL_NAME_MAX_LENGTH)
  .regex(REAL_NAME_PATTERN, 'only letters, spaces and ·');

/**
 * Accepts the ways a number is usually typed (`010-1234-5678`, `010 1234 5678`) and yields the
 * digits alone — the one spelling that is stored, compared for "one account per number" and
 * texted to, so two spellings of one number can never pass as two numbers.
 */
export const phoneSchema = z
  .string()
  .trim()
  .max(20)
  .regex(/^[0-9 -]+$/, 'only digits, spaces and -')
  .transform((value) => value.replace(/[ -]/g, ''))
  .pipe(z.string().regex(PHONE_PATTERN, 'must be a Korean mobile number (01X)'));

/**
 * The fixed values of the code (owner decision 2026-10-17, ADR-0069 decision 1 #57-3: fixed in
 * code, not release settings): six digits, valid three minutes, a new one sixty seconds after the
 * previous send at the earliest, five wrong entries discard a code (a new one must be requested),
 * and at most ten sends a day for one account and for one number. "A day" is the 24 hours before
 * the request (rolling), not a calendar day: the bound holds at any moment, whatever time zone a
 * member reads times in (ADR-0063), and never lets twenty sends straddle a midnight.
 */
export const PHONE_VERIFICATION_LIMITS = {
  codeLength: 6,
  codeTtlSeconds: 180,
  resendIntervalSeconds: 60,
  maxAttempts: 5,
  dailySends: 10,
  dailyWindowSeconds: 24 * 60 * 60,
} as const;

/** The code as typed: exactly the six digits (spaces around them trimmed). */
export const phoneVerificationCodeSchema = z
  .string()
  .trim()
  .regex(
    new RegExp(`^\\d{${String(PHONE_VERIFICATION_LIMITS.codeLength)}}$`),
    `must be ${String(PHONE_VERIFICATION_LIMITS.codeLength)} digits`,
  );

/** The signed-in user id the screen is showing (better-auth `user.id`, text). */
const expectedAccountIdSchema = z.string().min(1).max(255);

/**
 * `POST /me/phone-verification/code`: the real name and the number, typed on one screen, and the
 * account the screen shows (`expectedAccountId`, as on every owner write since A-PG-24). The
 * server texts a new code to the number and keeps the name with it until the code is confirmed.
 */
export const requestPhoneVerificationCodeBodySchema = z
  .object({
    realName: realNameSchema,
    phone: phoneSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'RequestPhoneVerificationCodeBody' });
export type RequestPhoneVerificationCodeBody = z.infer<
  typeof requestPhoneVerificationCodeBodySchema
>;

/**
 * The answer to a sent code: how long it is valid and how long until another may be requested,
 * in seconds from the answer — relative, like `RATE_LIMITED`'s `retryAfterSeconds`, so a
 * countdown does not depend on the browser's clock agreeing with the server's. The server takes
 * off what it spent before answering (the SMS provider's time included): `expiresInSeconds`
 * rounded down, `resendAfterSeconds` up, so a countdown started on arrival never outlasts the
 * code nor ends before a resend is allowed (only the answer's trip over the network is not
 * counted). At most `codeTtlSeconds` and `resendIntervalSeconds`.
 */
export const phoneVerificationCodeSentSchema = z
  .object({
    expiresInSeconds: z.number().int().min(0),
    resendAfterSeconds: z.number().int().min(0),
  })
  .meta({ id: 'PhoneVerificationCodeSent' });
export type PhoneVerificationCodeSent = z.infer<typeof phoneVerificationCodeSentSchema>;

/**
 * `POST /me/phone-verification/confirm`: the code the account received, and the account the
 * screen shows. The code confirmed is the newest one sent for the account; the number and the
 * real name are the ones it was sent with.
 */
export const confirmPhoneVerificationBodySchema = z
  .object({
    code: phoneVerificationCodeSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'ConfirmPhoneVerificationBody' });
export type ConfirmPhoneVerificationBody = z.infer<typeof confirmPhoneVerificationBodySchema>;

/** `PUT /me/real-name` (MY 설정): the new real name, and the account the screen shows. */
export const updateRealNameBodySchema = z
  .object({
    realName: realNameSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'UpdateRealNameBody' });
export type UpdateRealNameBody = z.infer<typeof updateRealNameBodySchema>;

/**
 * An account's completed verification: the number it proved (digits only), the real name it
 * gave (editable later), and when the code was confirmed. `Me.verification`, and the answer of
 * the confirmation and the real-name change. Owner-only.
 */
export const phoneVerificationSchema = z
  .object({
    realName: z.string(),
    phone: z.string().regex(PHONE_PATTERN),
    verifiedAt: z.iso.datetime(),
  })
  .meta({ id: 'PhoneVerification' });
export type PhoneVerification = z.infer<typeof phoneVerificationSchema>;

// ---- refusals -------------------------------------------------------------------------------
// The `details` each refusal code carries, as an object with a `reason` (and what goes with it),
// so a client reads one typed shape per code. The codes themselves are in api/errors.ts.

/**
 * PHONE_VERIFICATION_NOT_ALLOWED (409): the account has verified already, or the number is the
 * verified number of another account (one account per number, ADR-0069 decision 1 #57-1). The
 * second is answered only to a confirmation — after the caller proved it holds the number — so
 * whether a number belongs to an account is told to nobody but that number's holder.
 */
export const PHONE_VERIFICATION_REFUSALS = ['already_verified', 'phone_in_use'] as const;
export type PhoneVerificationRefusal = (typeof PHONE_VERIFICATION_REFUSALS)[number];
export const phoneVerificationNotAllowedDetailsSchema = z.object({
  reason: z.enum(PHONE_VERIFICATION_REFUSALS),
});
export type PhoneVerificationNotAllowedDetails = z.infer<
  typeof phoneVerificationNotAllowedDetailsSchema
>;

/**
 * PHONE_VERIFICATION_LIMITED (429): no code was sent, because the account's previous send is
 * less than `resendIntervalSeconds` old (`resend_interval`), or the account (`account_daily`) or
 * the number (`phone_daily`) has had `dailySends` codes in the last 24 hours.
 * `retryAfterSeconds` is when the same request would pass that limit.
 */
export const PHONE_VERIFICATION_LIMIT_REASONS = [
  'resend_interval',
  'account_daily',
  'phone_daily',
] as const;
export type PhoneVerificationLimitReason = (typeof PHONE_VERIFICATION_LIMIT_REASONS)[number];
export const phoneVerificationLimitedDetailsSchema = z.object({
  reason: z.enum(PHONE_VERIFICATION_LIMIT_REASONS),
  retryAfterSeconds: z.number().int().min(1),
});
export type PhoneVerificationLimitedDetails = z.infer<typeof phoneVerificationLimitedDetailsSchema>;

/**
 * VERIFICATION_CODE_REJECTED (409): the account is not verified by this confirmation, because
 * no code is waiting (`no_code`: none was sent, or the newest was used), the newest code is
 * past its three minutes (`expired`), it took its fifth wrong entry already and is discarded
 * (`attempts_exceeded`, also the answer to that fifth entry), or the code does not match
 * (`mismatch`, with the entries the code has left).
 */
export const VERIFICATION_CODE_REJECTIONS = [
  'no_code',
  'expired',
  'attempts_exceeded',
  'mismatch',
] as const;
export type VerificationCodeRejection = (typeof VERIFICATION_CODE_REJECTIONS)[number];
export const verificationCodeRejectedDetailsSchema = z.discriminatedUnion('reason', [
  z.object({ reason: z.enum(['no_code', 'expired', 'attempts_exceeded']) }),
  z.object({
    reason: z.literal('mismatch'),
    remainingAttempts: z
      .number()
      .int()
      .min(1)
      .max(PHONE_VERIFICATION_LIMITS.maxAttempts - 1),
  }),
]);
export type VerificationCodeRejectedDetails = z.infer<typeof verificationCodeRejectedDetailsSchema>;
