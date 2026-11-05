import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError } from './api';
import {
  canChangePriceProtection,
  priceProtectionDraft,
  priceProtectionFailure,
} from './market-price-protection';

const apiError = (status: number, code: string, message = 'x', details?: unknown) =>
  new ApiError(status, {
    code,
    message,
    ...(details === undefined ? {} : { details }),
  } as never);

const REASON = '호가가 촘촘해져 폭을 좁힙니다.';

describe('가격 보호 폭 변경 (#119, ADR-0112)', () => {
  it('is offered on an OPEN or PAUSED market only', () => {
    expect(canChangePriceProtection('open')).toBe(true);
    expect(canChangePriceProtection('paused')).toBe(true);
    for (const status of ['draft', 'review', 'scheduled', 'closed', 'settled'] as const) {
      expect(canChangePriceProtection(status), status).toBe(false);
    }
  });

  it('takes a whole number of ticks in 1..98 that is not the one held, and a reason', () => {
    expect(priceProtectionDraft('3', REASON, 5)).toEqual({
      ready: true,
      ticks: 3,
      ticksError: null,
      unchanged: false,
      reason: REASON,
    });
    // The bounds of the server's range, and a market that had none (submitted before #119).
    expect(priceProtectionDraft(' 1 ', REASON, null).ready).toBe(true);
    expect(priceProtectionDraft('98', REASON, null).ready).toBe(true);
    for (const text of ['0', '99', '2.5', '-1', 'abc', '1e1']) {
      const draft = priceProtectionDraft(text, REASON, 5);
      expect(draft, text).toMatchObject({ ready: false, ticks: null });
      expect(draft.ticksError, text).toBe(copy.errPriceProtectionTicks);
    }
    // Blank: not ready, nothing said yet.
    expect(priceProtectionDraft('', REASON, 5)).toMatchObject({ ready: false, ticksError: null });
    // The width held: not ready.
    expect(priceProtectionDraft('5', REASON, 5)).toMatchObject({ ready: false, unchanged: true });
    // No reason.
    expect(priceProtectionDraft('3', '   ', 5).ready).toBe(false);
  });

  it('says a refusal under the width, under the reason, or as the review dialogs say it', () => {
    const unchanged = apiError(400, 'VALIDATION_ERROR', 'x', [
      { path: ['priceProtectionTicks'], message: 'unchanged' },
    ]);
    // Another admin's change came first: said under the field, and the detail is read again.
    expect(priceProtectionFailure(unchanged)).toEqual({
      kind: 'field',
      field: 'priceProtectionTicks',
      message: copy.errPriceProtectionUnchanged,
      refresh: true,
    });
    expect(
      priceProtectionFailure(
        apiError(400, 'VALIDATION_ERROR', 'x', [
          { path: ['priceProtectionTicks'], message: 'Too big' },
        ]),
      ),
    ).toEqual({
      kind: 'field',
      field: 'priceProtectionTicks',
      message: copy.errPriceProtectionTicks,
      refresh: false,
    });
    expect(
      priceProtectionFailure(
        apiError(400, 'VALIDATION_ERROR', 'x', [{ path: ['reason'], message: 'Too big' }]),
      ),
    ).toMatchObject({ kind: 'field', field: 'reason', message: copy.errMarketReviewReason });
    // A status another admin moved (the market closed meanwhile): in the dialog, read again.
    expect(
      priceProtectionFailure(
        apiError(400, 'VALIDATION_ERROR', 'x', [{ path: ['status'], message: 'closed' }]),
      ),
    ).toEqual({ kind: 'alert', message: copy.errMarketStatus, refresh: true });
    expect(priceProtectionFailure(apiError(404, 'NOT_FOUND'))).toMatchObject({
      kind: 'alert',
      message: copy.adminMarketNotFound,
    });
    // The cookie of another account: a toast, nothing done.
    expect(
      priceProtectionFailure(
        apiError(403, 'FORBIDDEN', 'x', [{ path: ['expectedAccountId'], message: 'mismatch' }]),
      ),
    ).toEqual({ kind: 'toast', message: copy.sessionChanged });
  });
});
