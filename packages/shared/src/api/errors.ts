import * as z from 'zod';

/** PLAN 7.4 error codes. The API never emits a code outside this list. */
export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'MARKET_NOT_OPEN',
  'MARKET_CLOSED',
  'INSUFFICIENT_BALANCE',
  'INSUFFICIENT_POSITION',
  'PRICE_MOVED',
  'DUPLICATE_REQUEST',
  'RATE_LIMITED',
  'DISPUTE_WINDOW_CLOSED',
  'RULES_REQUIRED',
  // No brackets or quotes in the comments of this list: scripts/generate-api-doc.mjs reads it
  // with a regex. The detail shapes of the codes below are in its ERROR_NOTES.
  /** No real name / mobile number on the account yet, and the action needs them (ADR-0043). */
  'CONTACT_REQUIRED',
  /** An admin refund or settle outside the policy; the first detail names why (ADR-0042). */
  'REFUND_NOT_ALLOWED',
  /**
   * The PG answered and said no; the first detail carries its ResultCode and ResultMsg. A
   * second detail `settle_required` (path `payment`): a retried refund stays `refunding` for an
   * admin to settle by hand.
   */
  'PAYMENT_GATEWAY_REFUSED',
  /** The PG could not be reached, or its answer is unknown (502). */
  'PAYMENT_GATEWAY_ERROR',
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
