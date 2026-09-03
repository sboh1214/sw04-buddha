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
