import {
  CARD_MIN_PRICE_KRW,
  PAYMENT_REFUND_WINDOW_DAYS,
  PAYMENT_RETURN_RESULTS,
  PAYMENT_STATUSES,
  REFUND_REASON_MAX_LENGTH,
  type PaymentStatus,
  formatKrw,
} from '@buddha/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminPayment, ApiError, type Payment } from './api';
import { PAYMENT_STATUS_LABEL, PAYMENT_STATUS_PALETTE } from './market-admin';
import { safeNextPath } from './next-path';
import {
  type AdminPaymentPage,
  PAYMENT_POLL_INTERVAL_MS,
  PAYMENT_POLL_LIMIT,
  checkoutErrorTitle,
  isBelowCardMinimum,
  isFlowUnavailable,
  parseWalletSearch,
  paymentFailureReason,
  paymentMethodLabel,
  paymentOutcome,
  paymentPollInterval,
  paymentResultNotice,
  paymentStatusView,
  refundAction,
  refundDeadline,
  refundErrorView,
  refundFormSchema,
  refundKeepsDialog,
  replacePaymentRow,
  walletHref,
  walletLoginPath,
} from './smartro-payments';

const PAYMENT_ID = '0b9e4a52-4f7e-4f43-9d3a-2a4f1a3c5e11';
const PACKAGE_ID = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);

const APPROVED_AT = '2026-09-20T03:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: PAYMENT_ID,
    amountP: '10000',
    priceKrw: 9900,
    packageId: PACKAGE_ID,
    provider: 'smartro',
    providerRef: 'StdTid0123456789',
    status: 'succeeded',
    method: 'CARD',
    approvedAt: APPROVED_AT,
    refundedAt: null,
    resultMessage: null,
    createdAt: '2026-09-20T02:59:00.000Z',
    ...overrides,
  };
}

function adminPayment(id: string, status: PaymentStatus = 'succeeded'): AdminPayment {
  return { ...payment({ id, status }), userId: 'user-1', nickname: '닉네임' };
}

describe('parseWalletSearch', () => {
  it('reads the three parts of a wallet URL, each only when well formed', () => {
    expect(
      parseWalletSearch({ payment: PAYMENT_ID, result: 'succeeded', package: PACKAGE_ID }),
    ).toEqual({ paymentId: PAYMENT_ID, result: 'succeeded', packageId: PACKAGE_ID });
    for (const result of PAYMENT_RETURN_RESULTS) {
      expect(parseWalletSearch({ result }).result).toBe(result);
    }
    expect(parseWalletSearch({})).toEqual({});
  });

  it('lower-cases the ids, as the API answers them', () => {
    expect(parseWalletSearch({ payment: PAYMENT_ID.toUpperCase() }).paymentId).toBe(PAYMENT_ID);
    expect(parseWalletSearch({ package: PACKAGE_ID.toUpperCase() }).packageId).toBe(PACKAGE_ID);
  });

  it('drops what no URL of ours carries: junk, unknown results, repeated parameters', () => {
    expect(
      parseWalletSearch({ payment: 'not-a-uuid', result: 'refunded', package: '../admin' }),
    ).toEqual({});
    expect(parseWalletSearch({ payment: [PAYMENT_ID, PAYMENT_ID], result: ['failed'] })).toEqual(
      {},
    );
    expect(parseWalletSearch({ result: '' })).toEqual({});
  });
});

describe('walletLoginPath', () => {
  it('keeps the plain wallet redirect exactly as it was', () => {
    expect(walletHref({})).toBe('/wallet');
    expect(walletLoginPath({})).toBe('/login?next=/wallet');
  });

  it('carries the /charge package through the login, and the login page accepts it', () => {
    const path = walletLoginPath({ packageId: PACKAGE_ID });
    const next = new URL(path, 'https://x.invalid').searchParams.get('next');
    expect(next).toBe(`/wallet?package=${PACKAGE_ID}`);
    // What LoginPage does with it: same-origin, so it is where the sign-in lands.
    expect(safeNextPath(next)).toBe(`/wallet?package=${PACKAGE_ID}`);
  });

  it('carries a payment-window return too, in a fixed order', () => {
    const search = { paymentId: PAYMENT_ID, result: 'pending' as const, packageId: PACKAGE_ID };
    expect(walletHref(search)).toBe(
      `/wallet?payment=${PAYMENT_ID}&result=pending&package=${PACKAGE_ID}`,
    );
    const next = new URL(walletLoginPath(search), 'https://x.invalid').searchParams.get('next');
    expect(next).toBe(walletHref(search));
  });
});

describe('paymentOutcome', () => {
  it("is the URL's word until the payment is loaded", () => {
    for (const result of PAYMENT_RETURN_RESULTS)
      expect(paymentOutcome(result, undefined)).toBe(result);
  });

  it("is the payment's current status once it is, in the redirect's words", () => {
    // A lost approval answer the 재통보 has since credited: the notice follows the payment.
    expect(paymentOutcome('pending', { status: 'succeeded' })).toBe('succeeded');
    expect(paymentOutcome('failed', { status: 'succeeded' })).toBe('succeeded');
    expect(paymentOutcome('succeeded', { status: 'pending' })).toBe('pending');
    expect(paymentOutcome('pending', { status: 'cancelled' })).toBe('cancelled');
    // A refund of it since: it still went through (the API maps the two the same way).
    expect(paymentOutcome('succeeded', { status: 'refunding' })).toBe('succeeded');
    expect(paymentOutcome('succeeded', { status: 'refunded' })).toBe('succeeded');
  });

  it("keeps 'stopped' for a failed payment: only the URL knows the payer stopped it", () => {
    expect(paymentOutcome('stopped', { status: 'failed' })).toBe('stopped');
    expect(paymentOutcome('failed', { status: 'failed' })).toBe('failed');
    // A stop the 재통보 overruled is a success after all.
    expect(paymentOutcome('stopped', { status: 'succeeded' })).toBe('succeeded');
  });
});

describe('paymentResultNotice', () => {
  it('has an alert status and a message for every result', () => {
    expect(paymentResultNotice('succeeded', undefined)).toEqual({
      outcome: 'succeeded',
      status: 'success',
      message: copy.paymentResultSucceeded,
      reason: null,
    });
    expect(paymentResultNotice('failed', undefined).status).toBe('error');
    expect(paymentResultNotice('failed', undefined).message).toBe(copy.paymentResultFailed);
    expect(paymentResultNotice('stopped', undefined).status).toBe('info');
    expect(paymentResultNotice('stopped', undefined).message).toBe(copy.paymentResultStopped);
    expect(paymentResultNotice('pending', undefined).status).toBe('warning');
    expect(paymentResultNotice('pending', undefined).message).toBe(copy.paymentResultPending);
    expect(paymentResultNotice('cancelled', undefined).status).toBe('warning');
    expect(paymentResultNotice('cancelled', undefined).message).toBe(copy.paymentResultCancelled);
  });

  it("shows the PG's reason under a failure or an automatic cancel, and nowhere else", () => {
    const refused = payment({ status: 'failed', resultMessage: '  한도 초과  ', approvedAt: null });
    expect(paymentResultNotice('failed', refused).reason).toBe('한도 초과');
    const cancelled = payment({ status: 'cancelled', resultMessage: '금액 불일치' });
    expect(paymentResultNotice('succeeded', cancelled)).toMatchObject({
      outcome: 'cancelled',
      reason: '금액 불일치',
    });
    // A success's ResultMsg is the PG's "승인" — nothing to explain.
    expect(paymentResultNotice('succeeded', payment({ resultMessage: '승인' })).reason).toBeNull();
    expect(
      paymentResultNotice('failed', payment({ status: 'failed', resultMessage: ' ' })).reason,
    ).toBeNull();
    expect(paymentResultNotice('failed', undefined).reason).toBeNull();
  });
});

describe('paymentPollInterval', () => {
  it('re-reads a pending payment every few seconds, for a bounded while', () => {
    expect(paymentPollInterval({ status: 'pending' }, 1)).toBe(PAYMENT_POLL_INTERVAL_MS);
    expect(paymentPollInterval({ status: 'pending' }, PAYMENT_POLL_LIMIT - 1)).toBe(
      PAYMENT_POLL_INTERVAL_MS,
    );
    expect(paymentPollInterval({ status: 'pending' }, PAYMENT_POLL_LIMIT)).toBe(false);
    expect(PAYMENT_POLL_INTERVAL_MS * PAYMENT_POLL_LIMIT).toBe(2 * 60 * 1000);
  });

  it('stops once the payment has settled, and never starts without one', () => {
    for (const status of PAYMENT_STATUSES.filter((s) => s !== 'pending')) {
      expect(paymentPollInterval({ status }, 1), status).toBe(false);
    }
    expect(paymentPollInterval(undefined, 0)).toBe(false);
  });
});

describe('결제 내역 rows', () => {
  it('names the methods SmartroPay answers with, and shows an unknown one verbatim', () => {
    expect(paymentMethodLabel('CARD')).toBe(copy.paymentMethodCard);
    expect(paymentMethodLabel('KAKAO')).toBe(copy.paymentMethodKakao);
    expect(paymentMethodLabel('NAVER')).toBe(copy.paymentMethodNaver);
    expect(paymentMethodLabel('NEWPAY')).toBe('NEWPAY');
    // Keys of Object.prototype are not labels.
    expect(paymentMethodLabel('toString')).toBe('toString');
    expect(paymentMethodLabel('__proto__')).toBe('__proto__');
    // The mock and every unapproved payment: no method.
    expect(paymentMethodLabel(null)).toBeNull();
    expect(paymentMethodLabel(' ')).toBeNull();
  });

  it('calls an unclaimed pending payment unfinished, and every other status by its label', () => {
    expect(paymentStatusView({ status: 'pending', providerRef: null })).toEqual({
      label: copy.paymentStatusUnfinished,
      palette: 'gray',
    });
    for (const status of PAYMENT_STATUSES) {
      expect(paymentStatusView({ status, providerRef: 'tid' }), status).toEqual({
        label: PAYMENT_STATUS_LABEL[status],
        palette: PAYMENT_STATUS_PALETTE[status],
      });
    }
  });

  it("keeps the PG's reason for failed and cancelled payments only", () => {
    expect(paymentFailureReason({ status: 'failed', resultMessage: ' 잔액 부족 ' })).toBe(
      '잔액 부족',
    );
    expect(paymentFailureReason({ status: 'cancelled', resultMessage: '금액 불일치' })).toBe(
      '금액 불일치',
    );
    expect(paymentFailureReason({ status: 'failed', resultMessage: null })).toBeNull();
    expect(paymentFailureReason({ status: 'failed', resultMessage: '' })).toBeNull();
    expect(paymentFailureReason({ status: 'succeeded', resultMessage: '승인' })).toBeNull();
  });
});

describe('charging through the payment window', () => {
  it('offers no package the window would refuse', () => {
    expect(isBelowCardMinimum(CARD_MIN_PRICE_KRW - 1)).toBe(true);
    expect(isBelowCardMinimum(CARD_MIN_PRICE_KRW)).toBe(false);
    expect(copy.chargeBelowCardMinimum).toContain(formatKrw(CARD_MIN_PRICE_KRW));
  });

  it('names the missing contact, and leaves every other refusal to the shared mapping', () => {
    expect(checkoutErrorTitle(apiError(409, 'CONTACT_REQUIRED'))).toBe(copy.chargeContactRequired);
    expect(checkoutErrorTitle(apiError(409, 'PRICE_MOVED'))).toBeUndefined();
    expect(checkoutErrorTitle(apiError(409, 'DUPLICATE_REQUEST'))).toBeUndefined();
    expect(checkoutErrorTitle(new TypeError('Failed to fetch'))).toBeUndefined();
  });

  it("re-reads the provider on the charge routes' fieldless 404 only", () => {
    // "Not the configured provider": the flow on screen is gone.
    expect(isFlowUnavailable(apiError(404, 'NOT_FOUND'))).toBe(true);
    // A deleted package names its field — that is the catalogue's refetch, not the provider's.
    expect(
      isFlowUnavailable(apiError(404, 'NOT_FOUND', [{ path: ['packageId'], message: 'gone' }])),
    ).toBe(false);
    expect(isFlowUnavailable(apiError(409, 'CONTACT_REQUIRED'))).toBe(false);
    expect(isFlowUnavailable(new Error('network'))).toBe(false);
  });
});

describe('refundAction', () => {
  const deadline = Date.parse(APPROVED_AT) + PAYMENT_REFUND_WINDOW_DAYS * DAY_MS;

  it('offers a refund for a succeeded payment up to the end of the window, inclusive', () => {
    expect(refundDeadline(payment())).toBe(deadline);
    expect(refundAction(payment(), Date.parse(APPROVED_AT))).toBe('refund');
    // The API refuses only once `now - approvedAt` EXCEEDS the window.
    expect(refundAction(payment(), deadline)).toBe('refund');
    expect(refundAction(payment(), deadline + 1)).toBeNull();
  });

  it('counts from the reservation for a row credited before approved_at existed', () => {
    const legacy = payment({ approvedAt: null });
    expect(refundDeadline(legacy)).toBe(
      Date.parse(legacy.createdAt) + PAYMENT_REFUND_WINDOW_DAYS * DAY_MS,
    );
    expect(refundAction(legacy, Date.parse(legacy.createdAt) + DAY_MS)).toBe('refund');
  });

  it('offers a retry for a refunding payment, whatever the clock says', () => {
    // The claw-back already happened inside the window; only the PG's answer is missing.
    expect(refundAction(payment({ status: 'refunding' }), deadline + 30 * DAY_MS)).toBe('retry');
  });

  it('offers nothing for any other status, or with nothing at the PG to cancel', () => {
    for (const status of ['pending', 'failed', 'cancelled', 'refunded'] as const) {
      expect(refundAction(payment({ status }), Date.parse(APPROVED_AT)), status).toBeNull();
    }
    expect(refundAction(payment({ providerRef: null }), Date.parse(APPROVED_AT))).toBeNull();
    expect(
      refundAction(payment({ status: 'refunding', providerRef: null }), Date.parse(APPROVED_AT)),
    ).toBeNull();
    expect(refundAction(payment({ approvedAt: 'not a date' }), Date.parse(APPROVED_AT))).toBeNull();
  });

  it('says the same window in its copy', () => {
    expect(copy.adminPaymentRefundBody).toContain(`${String(PAYMENT_REFUND_WINDOW_DAYS)}일`);
    expect(copy.errRefundWindowClosed).toContain(`${String(PAYMENT_REFUND_WINDOW_DAYS)}일`);
  });
});

describe('refundFormSchema', () => {
  it('requires a reason, trimmed, within the API limit', () => {
    expect(refundFormSchema.parse({ reason: '  청약철회 요청  ' })).toEqual({
      reason: '청약철회 요청',
    });
    expect(
      refundFormSchema.safeParse({ reason: 'x'.repeat(REFUND_REASON_MAX_LENGTH) }).success,
    ).toBe(true);
    for (const reason of ['', '   ', 'x'.repeat(REFUND_REASON_MAX_LENGTH + 1)]) {
      const parsed = refundFormSchema.safeParse({ reason });
      expect(parsed.success, JSON.stringify(reason)).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe(copy.errRefundReason);
    }
    expect(copy.errRefundReason).toContain(String(REFUND_REASON_MAX_LENGTH));
  });
});

describe('refundErrorView', () => {
  it('says the P was already used for INSUFFICIENT_BALANCE', () => {
    expect(
      refundErrorView(
        apiError(409, 'INSUFFICIENT_BALANCE', [{ path: ['amountP'], message: 'P already used' }]),
      ),
    ).toEqual({ title: copy.errRefundPUsed });
  });

  it('tells the three REFUND_NOT_ALLOWED cases apart by their detail', () => {
    const refused = (message: string) =>
      apiError(409, 'REFUND_NOT_ALLOWED', [{ path: ['payment'], message }]);
    expect(refundErrorView(refused('window_closed')).title).toBe(copy.errRefundWindowClosed);
    expect(refundErrorView(refused('status')).title).toBe(copy.errRefundStatus);
    expect(refundErrorView(refused('provider')).title).toBe(copy.errRefundProvider);
    // A case the web does not know yet still reads as "not refundable now".
    expect(refundErrorView(refused('something_new')).title).toBe(copy.errRefundStatus);
    expect(refundErrorView(apiError(409, 'REFUND_NOT_ALLOWED')).title).toBe(copy.errRefundStatus);
  });

  it("shows the PG's own answer with a refusal", () => {
    expect(
      refundErrorView(
        apiError(409, 'PAYMENT_GATEWAY_REFUSED', [
          { path: ['gateway'], message: '2003 취소 불가 거래' },
        ]),
      ),
    ).toEqual({
      title: copy.errRefundGatewayRefused,
      description: `${copy.refundGatewayAnswer} 2003 취소 불가 거래`,
    });
    expect(refundErrorView(apiError(409, 'PAYMENT_GATEWAY_REFUSED'))).toEqual({
      title: copy.errRefundGatewayRefused,
    });
    expect(
      refundErrorView(
        apiError(409, 'PAYMENT_GATEWAY_REFUSED', [{ path: ['gateway'], message: ' ' }]),
      ),
    ).toEqual({ title: copy.errRefundGatewayRefused });
  });

  it('maps the silent PG, an attempt in flight, a wrong id and a blank reason', () => {
    expect(refundErrorView(apiError(502, 'PAYMENT_GATEWAY_ERROR')).title).toBe(
      copy.errRefundGatewayError,
    );
    expect(
      refundErrorView(
        apiError(409, 'DUPLICATE_REQUEST', [{ path: ['payment'], message: 'in progress' }]),
      ).title,
    ).toBe(copy.errRefundInProgress);
    expect(refundErrorView(apiError(404, 'NOT_FOUND')).title).toBe(copy.errRefundNotFound);
    expect(
      refundErrorView(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['reason'], message: 'required' }]),
      ).title,
    ).toBe(copy.errRefundReason);
  });

  it('falls back to the generic message for everything else', () => {
    expect(refundErrorView(apiError(400, 'VALIDATION_ERROR')).title).toBe(copy.errUnknown);
    expect(refundErrorView(apiError(500, 'INTERNAL')).title).toBe(copy.errUnknown);
    expect(refundErrorView(new TypeError('Failed to fetch')).title).toBe(copy.errUnknown);
  });
});

describe('refundKeepsDialog', () => {
  it('keeps the dialog for a lost request and for a refused reason only', () => {
    expect(refundKeepsDialog(new TypeError('Failed to fetch'))).toBe(true);
    expect(
      refundKeepsDialog(
        apiError(400, 'VALIDATION_ERROR', [{ path: ['reason'], message: 'required' }]),
      ),
    ).toBe(true);
    for (const code of [
      'INSUFFICIENT_BALANCE',
      'REFUND_NOT_ALLOWED',
      'PAYMENT_GATEWAY_REFUSED',
      'DUPLICATE_REQUEST',
      'NOT_FOUND',
    ]) {
      expect(refundKeepsDialog(apiError(409, code)), code).toBe(false);
    }
    expect(refundKeepsDialog(apiError(502, 'PAYMENT_GATEWAY_ERROR'))).toBe(false);
  });
});

describe('replacePaymentRow', () => {
  const first = adminPayment('00000000-0000-4000-8000-000000000001');
  const second = adminPayment('00000000-0000-4000-8000-000000000002');
  const third = adminPayment('00000000-0000-4000-8000-000000000003');
  const cache: InfiniteData<AdminPaymentPage> = {
    pages: [
      { items: [first, second], nextCursor: 'c1' },
      { items: [third], nextCursor: null },
    ],
    pageParams: [undefined, 'c1'],
  };

  it('writes the answered row over its copy, leaving every other page as it was', () => {
    const refunded = { ...second, status: 'refunded' as const, refundedAt: APPROVED_AT };
    const next = replacePaymentRow(cache, refunded);
    expect(next?.pages[0]?.items).toEqual([first, refunded]);
    expect(next?.pages[1]).toBe(cache.pages[1]);
    // Copied, never mutated.
    expect(cache.pages[0]?.items[1]).toBe(second);
  });

  it('hands back the same cache when no page holds the row, and nothing for no cache', () => {
    expect(replacePaymentRow(cache, adminPayment('00000000-0000-4000-8000-000000000009'))).toBe(
      cache,
    );
    expect(replacePaymentRow(undefined, first)).toBeUndefined();
  });
});
