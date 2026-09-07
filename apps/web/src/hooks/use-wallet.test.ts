import { describe, expect, it } from 'vitest';
import { ApiError, isForAnotherAccount } from '@/lib/api';
import { isChargeInProgress, isCouponRejection, isStaleCatalogue } from './use-wallet';

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);

describe('isStaleCatalogue', () => {
  it('refetches on the three rejections that mean the cards are out of date', () => {
    // Re-priced, retired and deleted. Without the refetch the refused card keeps showing the
    // offer the server just rejected and every further click re-sends the same terms.
    expect(isStaleCatalogue(apiError(409, 'PRICE_MOVED'))).toBe(true);
    expect(
      isStaleCatalogue(apiError(404, 'NOT_FOUND', [{ path: ['packageId'], message: 'not found' }])),
    ).toBe(true);
    expect(
      isStaleCatalogue(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['packageId'], message: 'inactive' }]),
      ),
    ).toBe(true);
  });

  it('leaves the cards alone when the catalogue is not the problem', () => {
    // A declined payment is a VALIDATION_ERROR too, but on `amountP` — refetching would be
    // pointless, and a refetch that fails swaps the whole card list for the error alert.
    expect(
      isStaleCatalogue(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['amountP'], message: 'payment refused' }]),
      ),
    ).toBe(false);
    expect(isStaleCatalogue(apiError(400, 'VALIDATION_ERROR'))).toBe(false);
    // `charge` answers 404 for an account with no balance row too (refused before anything
    // is reserved or charged). That one names no field: the catalogue still lists the
    // package, so refetching it and calling the package unavailable would only invite the
    // same failure again.
    expect(isStaleCatalogue(apiError(404, 'NOT_FOUND'))).toBe(false);
    expect(isStaleCatalogue(apiError(500, 'INTERNAL'))).toBe(false);
    expect(isStaleCatalogue(apiError(401, 'UNAUTHENTICATED'))).toBe(false);
    expect(isStaleCatalogue(new Error('network'))).toBe(false);
    expect(isStaleCatalogue(undefined)).toBe(false);
  });
});

describe('isChargeInProgress', () => {
  it('is true only for the DUPLICATE_REQUEST that names the header', () => {
    // The first request with this key is still running: the key must be kept so the next
    // click collects that purchase instead of opening another one (PLAN 5.4).
    expect(
      isChargeInProgress(
        apiError(409, 'DUPLICATE_REQUEST', [{ path: ['Idempotency-Key'], message: 'in progress' }]),
      ),
    ).toBe(true);
  });

  it('is false for the other 409 and for everything else', () => {
    // Same key, different terms: the key was spent by a different purchase, so a new one is
    // right. Nothing else says anything about the key at all.
    expect(isChargeInProgress(apiError(409, 'DUPLICATE_REQUEST'))).toBe(false);
    expect(isChargeInProgress(apiError(409, 'PRICE_MOVED'))).toBe(false);
    expect(
      isChargeInProgress(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['Idempotency-Key'], message: 'required' }]),
      ),
    ).toBe(false);
    expect(isChargeInProgress(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('isForAnotherAccount', () => {
  it('is true only for the FORBIDDEN that names the account field', () => {
    // The screen showed A, the cookie was B's: the server refused to charge, or redeem for, B.
    expect(
      isForAnotherAccount(
        apiError(403, 'FORBIDDEN', [
          { path: ['expectedAccountId'], message: 'session belongs to another account' },
        ]),
      ),
    ).toBe(true);
  });

  it('is false for the CSRF 403, for other codes and for a transport failure', () => {
    expect(isForAnotherAccount(apiError(403, 'FORBIDDEN'))).toBe(false);
    expect(
      isForAnotherAccount(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['expectedAccountId'], message: 'required' }]),
      ),
    ).toBe(false);
    expect(isForAnotherAccount(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('isCouponRejection', () => {
  it('is true only for the one answer the API gives about the code itself', () => {
    // Unknown, disabled, expired and exhausted are deliberately indistinguishable (A-M2-9)
    // and all arrive as a VALIDATION_ERROR naming `code`.
    expect(
      isCouponRejection(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['code'], message: 'invalid or expired' }]),
      ),
    ).toBe(true);
  });

  it('leaves everything else off the field, where it would call a good code invalid', () => {
    // Its NOT_FOUND means the account has no balance row; a 500, a dead session or an
    // unreachable API say nothing about what the user typed.
    expect(isCouponRejection(apiError(404, 'NOT_FOUND'))).toBe(false);
    expect(isCouponRejection(apiError(500, 'INTERNAL'))).toBe(false);
    expect(isCouponRejection(apiError(401, 'UNAUTHENTICATED'))).toBe(false);
    expect(isCouponRejection(apiError(400, 'VALIDATION_ERROR'))).toBe(false);
    expect(isCouponRejection(new TypeError('Failed to fetch'))).toBe(false);
    // The duplicate is handled on its own branch before this predicate runs.
    expect(isCouponRejection(apiError(409, 'DUPLICATE_REQUEST'))).toBe(false);
  });
});
