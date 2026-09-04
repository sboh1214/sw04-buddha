import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { isStaleCatalogue } from './use-wallet';

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
    expect(isStaleCatalogue(apiError(404, 'NOT_FOUND'))).toBe(true);
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
    expect(isStaleCatalogue(apiError(500, 'INTERNAL'))).toBe(false);
    expect(isStaleCatalogue(apiError(401, 'UNAUTHENTICATED'))).toBe(false);
    expect(isStaleCatalogue(new Error('network'))).toBe(false);
    expect(isStaleCatalogue(undefined)).toBe(false);
  });
});
