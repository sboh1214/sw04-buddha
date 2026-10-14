import * as z from 'zod';

/**
 * Header PLAN 5.4 assigns to client-generated request keys (`POST /payments/charge`). The
 * client makes one key per intent, re-sends the same key when it never saw an answer, and the
 * server replies with what the first request did instead of acting twice. A key re-used with a
 * different body is refused with DUPLICATE_REQUEST (PLAN 7.4: "멱등키 충돌·다른 페이로드").
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Any URL-safe token of a sensible length; the web client sends a UUID. */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(IDEMPOTENCY_KEY_PATTERN, 'only letters, digits, - and _');
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;
