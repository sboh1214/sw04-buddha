import { AppError } from '../common/errors/app-error.js';

/**
 * "Act only as the account the user is looking at" (the PLAN 5.3 shape of PRICE_MOVED).
 *
 * The cookie decides who acts; the body says who the screen shows. They differ when another
 * tab signed in as somebody else and this one has not refetched its session yet — sign-ins
 * are not broadcast, and a tab that never regains visibility keeps the old account for good.
 * Credited anyway, Coin (a charge, a one-use coupon) would land on an account the user is not
 * looking at. So a mismatch is refused before anything is looked up or reserved, with a 403
 * whose detail names the field; the web recognises that field, refetches the session and lets
 * SessionCacheGuard put the real account on screen. Distinct from the CSRF 403, which names no
 * field.
 */
export function assertExpectedAccount(userId: string, expectedAccountId: string): void {
  if (expectedAccountId === userId) return;
  throw new AppError('FORBIDDEN', {
    message: 'This session belongs to a different account than the one on screen',
    details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
  });
}
