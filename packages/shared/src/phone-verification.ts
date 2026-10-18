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
 * The fixed values of the code (owner decisions 2026-10-17 and 2026-10-18, ADR-0069 decision 1
 * #57-3 and ADR-0070: fixed in code, not release settings): six digits, valid three minutes, a new
 * one sixty seconds after the account's previous send at the earliest, and five wrong entries
 * discard a code (a new one must be requested). A day's sends are bounded five ways:
 *
 * - `accountDailySends`: one account, whatever the numbers;
 * - `accountPhoneDailySends`: one account to one number. With these values an account reaches its
 *   own ten no later than any of its pairs (every send of a pair is a send of the account), so the
 *   account's limit answers first; the pair's is kept as the owner stated it;
 * - `phoneDailyAccounts`: the accounts one number may receive codes for — a fourth account is
 *   refused, the three that have sent to it are not;
 * - `ipDailySends`: one client address (as the per-address rate limit names it; a request that
 *   names no client — loopback, the web server's rewrite — is not counted by address). Fifty, not
 *   the twenty first decided: people behind one public address (a carrier's NAT, a school's or an
 *   office's network) share it (owner decision 2026-10-18, second round);
 * - `serviceDailySends`: the whole service.
 *
 * "A day" is the 24 hours before the request (rolling), not a calendar day, for each of them: the
 * bound holds at any moment, whatever time zone a member reads times in (ADR-0063), and never
 * lets twice the bound straddle a midnight.
 */
export const PHONE_VERIFICATION_LIMITS = {
  codeLength: 6,
  codeTtlSeconds: 180,
  resendIntervalSeconds: 60,
  maxAttempts: 5,
  accountDailySends: 10,
  accountPhoneDailySends: 10,
  phoneDailyAccounts: 3,
  ipDailySends: 50,
  serviceDailySends: 500,
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
 * PHONE_VERIFICATION_LIMITED (429): no code was sent, because of one of the fixed limits of
 * PHONE_VERIFICATION_LIMITS, each over the last 24 hours but the first:
 *
 * - `resend_interval`: the account's previous send is less than `resendIntervalSeconds` old;
 * - `account_daily`: the account has had `accountDailySends` codes;
 * - `account_phone_daily`: the account has had `accountPhoneDailySends` codes at this number;
 * - `phone_accounts`: the number has had codes for `phoneDailyAccounts` other accounts;
 * - `ip_daily`: the client address the request came from has asked for `ipDailySends` codes;
 * - `service_daily`: the service has sent `serviceDailySends` codes.
 *
 * `retryAfterSeconds` is when the same request would pass that limit (when several refuse, the
 * one that lasts longest). For the account's own limits (`resend_interval`, `account_daily`,
 * `account_phone_daily`) it is exact to the second. The limits counted with other accounts' sends
 * (`PHONE_VERIFICATION_SHARED_LIMIT_REASONS`: `phone_accounts`, `ip_daily`, `service_daily`)
 * answer whole minutes of the server's clock, rounded up, so the answer never tells another
 * account's send time to the second (owner decision 2026-10-18, second round, ADR-0070), and they
 * stay shut until that minute (third round): a send counts in them until the clock's first whole
 * minute after it is 24 hours old, so getting through tells no finer time either. The wait counts
 * from the start of the asking minute: never sooner than the limit opens, less than a minute after.
 */
export const PHONE_VERIFICATION_LIMIT_REASONS = [
  'resend_interval',
  'account_daily',
  'account_phone_daily',
  'phone_accounts',
  'ip_daily',
  'service_daily',
] as const;
export type PhoneVerificationLimitReason = (typeof PHONE_VERIFICATION_LIMIT_REASONS)[number];

/**
 * The limits that count other accounts' sends as well as the caller's — the number's accounts,
 * the client address and the whole service — whose `retryAfterSeconds` is answered in whole
 * minutes and which stay shut until that minute (PHONE_VERIFICATION_LIMITED above). The rest are
 * the account's own and exact.
 */
export const PHONE_VERIFICATION_SHARED_LIMIT_REASONS = [
  'phone_accounts',
  'ip_daily',
  'service_daily',
] as const satisfies readonly PhoneVerificationLimitReason[];
export type PhoneVerificationSharedLimitReason =
  (typeof PHONE_VERIFICATION_SHARED_LIMIT_REASONS)[number];

/** Whether `reason` is one of PHONE_VERIFICATION_SHARED_LIMIT_REASONS. */
export function isSharedLimitReason(
  reason: PhoneVerificationLimitReason,
): reason is PhoneVerificationSharedLimitReason {
  return (PHONE_VERIFICATION_SHARED_LIMIT_REASONS as readonly string[]).includes(reason);
}
export const phoneVerificationLimitedDetailsSchema = z.object({
  reason: z.enum(PHONE_VERIFICATION_LIMIT_REASONS),
  retryAfterSeconds: z.number().int().min(1),
});
export type PhoneVerificationLimitedDetails = z.infer<typeof phoneVerificationLimitedDetailsSchema>;

/**
 * VERIFICATION_CODE_REJECTED (409): the account is not verified by this confirmation, because
 * no code is waiting (`no_code`: none was sent, or the newest was used), the newest code is
 * past its three minutes (`expired`), it took its fifth wrong entry already and is discarded
 * (`attempts_exceeded`, also the answer to that fifth entry), the code typed is an older code of
 * the account that a newer send replaced (`superseded`: only the newest confirms, and this entry
 * is not counted against it — owner decision 2026-10-18, ADR-0070), or the code does not match
 * (`mismatch`, with the entries the code has left).
 */
export const VERIFICATION_CODE_REJECTIONS = [
  'no_code',
  'expired',
  'attempts_exceeded',
  'superseded',
  'mismatch',
] as const;
export type VerificationCodeRejection = (typeof VERIFICATION_CODE_REJECTIONS)[number];
export const verificationCodeRejectedDetailsSchema = z.discriminatedUnion('reason', [
  z.object({ reason: z.enum(['no_code', 'expired', 'attempts_exceeded', 'superseded']) }),
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

// ---- the admin's SMS send status ------------------------------------------------------------

/**
 * What the provider said of a recorded send (`phone_verification_codes.send_outcome`, ADR-0070):
 * `accepted` once it took the text, `unknown` until then — and for good when its answer never
 * came (SMS_SEND_UNCONFIRMED: a timeout, a 5xx, an unreadable answer). A send it certainly
 * refused is not a recorded send at all (SMS_SEND_FAILED): only its time is kept, apart.
 */
export const PHONE_VERIFICATION_SEND_OUTCOMES = ['accepted', 'unknown'] as const;
export type PhoneVerificationSendOutcome = (typeof PHONE_VERIFICATION_SEND_OUTCOMES)[number];

const sendCountSchema = z.number().int().min(0);

/**
 * One Korean calendar day of 본인확인 sends (Asia/Seoul, as the admin screens read times,
 * ADR-0061 #60-8): `sent` is every send recorded that day — what the daily limits count,
 * whatever the provider answered — `unknown` the part of them whose answer never came (or has not
 * yet: a send is `unknown` until the provider answers), and `refused` the sends the provider
 * certainly refused, which no limit counts.
 */
export const smsSendDaySchema = z
  .object({
    date: z.iso.date(),
    sent: sendCountSchema,
    unknown: sendCountSchema,
    refused: sendCountSchema,
  })
  .meta({ id: 'SmsSendDay' });
export type SmsSendDay = z.infer<typeof smsSendDaySchema>;

/** How many days `AdminSmsStatus.days` holds: today and the six before it. */
export const SMS_STATUS_DAYS = 7;

/**
 * `GET /admin/sms/status` (owner decision 2026-10-18, second round, ADR-0070): the admin's view of
 * the 본인확인 texts, as counts only — no number, name, address or account. `last24Hours` is the
 * window of the service's daily limit (the 24 hours before the minute of `asOf`, the database
 * clock, began, through `asOf`): `sent` against `serviceLimit` (`serviceDailySends`) is how close
 * the service is to stopping its sends.
 * `days` are the last SMS_STATUS_DAYS Korean calendar days, newest (today, so far) first.
 */
export const adminSmsStatusSchema = z
  .object({
    asOf: z.iso.datetime(),
    last24Hours: z.object({
      sent: sendCountSchema,
      unknown: sendCountSchema,
      refused: sendCountSchema,
      serviceLimit: z.number().int().positive(),
    }),
    days: z.array(smsSendDaySchema).length(SMS_STATUS_DAYS),
  })
  .meta({ id: 'AdminSmsStatus' });
export type AdminSmsStatus = z.infer<typeof adminSmsStatusSchema>;
