import * as z from 'zod';

/** PLAN 7.4 error codes. The API never emits a code outside this list. */
export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'MARKET_NOT_OPEN',
  'INSUFFICIENT_BALANCE',
  'PRICE_MOVED',
  'DUPLICATE_REQUEST',
  'RATE_LIMITED',
  'RULES_REQUIRED',
  // No brackets or quotes in the comments of this list: scripts/generate-api-doc.mjs reads it
  // with a regex. The detail shapes of the codes below are in its ERROR_NOTES.
  /**
   * The account has not completed the SMS verification yet, and the action needs it. Took the
   * place of the contact-required code when the verified number replaced the unverified contact.
   */
  'VERIFICATION_REQUIRED',
  /** An admin refund outside the policy; the first detail names why (ADR-0042). */
  'REFUND_NOT_ALLOWED',
  /**
   * The PG answered and said no; the first detail carries its result code and message. A
   * retried refund it refuses stays `refunding`: the first attempt may have cancelled the card.
   */
  'PAYMENT_GATEWAY_REFUSED',
  /** The PG could not be reached, or its answer is unknown (502). */
  'PAYMENT_GATEWAY_ERROR',
  /**
   * An admin grant or revoke the rules refuse; the first detail names why, one of
   * ADMIN_GRANT_REFUSALS or ADMIN_REVOKE_REFUSALS in admin-accounts.ts.
   */
  'ROLE_CHANGE_NOT_ALLOWED',
  /**
   * A decision on a two-person request the rule refuses: the decider requested it, or it is
   * decided already. The first detail names which, one of APPROVAL_REFUSALS in approvals.ts.
   */
  'APPROVAL_NOT_ALLOWED',
  /**
   * A verification the rules refuse: the account verified already, or the number is the verified
   * number of another account. Details carry the reason, phoneVerificationNotAllowedDetailsSchema.
   */
  'PHONE_VERIFICATION_NOT_ALLOWED',
  /**
   * No code was sent: the resend interval or a daily send limit of the account or the number.
   * Details carry the reason and retryAfterSeconds, phoneVerificationLimitedDetailsSchema.
   */
  'PHONE_VERIFICATION_LIMITED',
  /**
   * A typed code that verifies nothing: none waiting, expired, discarded after its wrong entries,
   * or wrong with entries left. Details carry the reason, verificationCodeRejectedDetailsSchema.
   */
  'VERIFICATION_CODE_REJECTED',
  /**
   * The SMS provider did not confirm the send (502): it refused or could not be reached — nothing
   * was sent, and nothing is counted — or its answer was lost, and the text may have gone: then
   * the send counts against the limits and its code can still be confirmed (ADR-0070 7-3). The
   * body does not say which, as no 5xx body says anything of its own.
   */
  'SMS_SEND_FAILED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const errorCodeSchema = z.enum(ERROR_CODES).meta({ id: 'ErrorCode' });

/** One entry of `error.details` for VALIDATION_ERROR: which field and why. */
export const validationIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
  })
  .meta({ id: 'ValidationIssue' });
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

/** PLAN 7 failure envelope `{ error: { code, message, details? } }`. */
export const errorEnvelopeSchema = z
  .object({
    error: z.object({
      code: errorCodeSchema,
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: 'ErrorEnvelope' });
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * The PLAN 7 failure envelope, built in one place.
 *
 * `details` is OMITTED rather than set to `undefined` when there is none: the REST filter and
 * the realtime filter used to build this object by hand in two files, and the socket's copy
 * always carried the key. JSON drops an `undefined` value, so the wire bytes agreed and the
 * drift was invisible until something serialised the envelope some other way.
 */
export function errorEnvelope(code: ErrorCode, message: string, details?: unknown): ErrorEnvelope {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
