import { AppError } from './app-error.js';
import { PG_INTEGRITY_CONSTRAINT_VIOLATION, isPgError } from './pg-error.js';

/**
 * The triggers of migration 0043 that refuse a new row of a closed account (#140, ADR-0086) from
 * the writers that take no lock the closure holds: a watch, a recorded search, a 본인확인 record
 * and a code send. They raise with their own name as the constraint.
 */
const CLOSED_ACCOUNT_ROW_TRIGGERS = [
  'market_watches_open_account',
  'market_searches_open_account',
  'phone_verifications_open_account',
  'phone_verification_codes_open_account',
] as const;

/**
 * A write refused because its account was closed meanwhile, as UNAUTHENTICATED, or undefined for
 * any other failure. Only a request that passed SessionGuard before the closure committed meets
 * it — the closure deleted every session, so any later request is UNAUTHENTICATED at the guard —
 * and it answers what that later request would have. The original error is not attached: a
 * driver error carries the row's values (a number, a real name) in its message and parameters.
 */
export function closedAccountRefusal(error: unknown): AppError | undefined {
  return CLOSED_ACCOUNT_ROW_TRIGGERS.some((trigger) =>
    isPgError(error, PG_INTEGRITY_CONSTRAINT_VIOLATION, trigger),
  )
    ? new AppError('UNAUTHENTICATED', { message: 'The account was closed' })
    : undefined;
}
