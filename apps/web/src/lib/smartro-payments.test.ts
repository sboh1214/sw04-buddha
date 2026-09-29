import {
  CARD_MIN_PRICE_KRW,
  PAYMENT_REFUND_WINDOW_DAYS,
  PAYMENT_RETURN_RESULTS,
  PAYMENT_SETTLE_OUTCOMES,
  PAYMENT_STATUSES,
  REFUND_REASON_MAX_LENGTH,
  SETTLE_TID_MAX_LENGTH,
  type PaymentSettleOutcome,
  type PaymentStatus,
  formatKrw,
  settlePaymentBodySchema,
} from '@buddha/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminPayment, ApiError, type Payment } from './api';
import { PAYMENT_STATUS_LABEL, PAYMENT_STATUS_PALETTE } from './market-admin';
import { safeNextPath } from './next-path';
import {
  type AdminPaymentPage,
  MERCHANT_ADMIN_URL,
  PAYMENT_POLL_INTERVAL_MS,
  PAYMENT_POLL_LIMIT,
  SETTLE_OUTCOME_VIEW,
  checkoutErrorTitle,
  endedFetches,
  isBelowCardMinimum,
  isCancelUnconfirmed,
  isFlowUnavailable,
  isPaymentInFlight,
  merchantAdminSites,
  merchantOrderId,
  offersSettle,
  parseWalletSearch,
  paymentFailureReason,
  paymentHistoryReason,
  paymentMethodLabel,
  paymentOutcome,
  paymentPollInterval,
  paymentResultNotice,
  paymentStatusView,
  paymentsPoll,
  refundAction,
  refundDeadline,
  refundErrorView,
  refundFormSchema,
  refundKeepsDialog,
  replacePaymentRow,
  settleErrorView,
  settleFormSchema,
  settleKeepsDialog,
  settleOutcomesFor,
  toSettleBody,
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
    cancelConfirmed: null,
    createdAt: '2026-09-20T02:59:00.000Z',
    ...overrides,
  };
}

function adminPayment(
  id: string,
  status: PaymentStatus = 'succeeded',
  overrides: Partial<AdminPayment> = {},
): AdminPayment {
  return {
    ...payment({ id, status }),
    userId: 'user-1',
    nickname: '닉네임',
    needsReview: false,
    ...overrides,
  };
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
    const now = (status: PaymentStatus) => ({ status, cancelConfirmed: null });
    // A lost approval answer the 재통보 has since credited: the notice follows the payment.
    expect(paymentOutcome('pending', now('succeeded'))).toBe('succeeded');
    expect(paymentOutcome('failed', now('succeeded'))).toBe('succeeded');
    expect(paymentOutcome('succeeded', now('pending'))).toBe('pending');
    const confirmed = { status: 'cancelled' as const, cancelConfirmed: true };
    expect(paymentOutcome('pending', confirmed)).toBe('cancelled');
    // A refund of it since: it still went through (the API maps the two the same way).
    expect(paymentOutcome('succeeded', now('refunding'))).toBe('succeeded');
    expect(paymentOutcome('succeeded', now('refunded'))).toBe('succeeded');
  });

  it('keeps a cancel nobody has confirmed pending: the card may still be charged', () => {
    // A net cancel that got no clear answer: the ReturnUrl said `pending`, and the payment,
    // `cancelled` all the same, does not overrule it — an admin may yet credit it.
    const unconfirmed = { status: 'cancelled' as const, cancelConfirmed: false };
    expect(paymentOutcome('pending', unconfirmed)).toBe('pending');
    // Whatever the URL said (a second submit answers the status as it stands).
    expect(paymentOutcome('cancelled', unconfirmed)).toBe('pending');
    // Confirmed since (the cancel 재통보, or an admin's 취소 확인): now it is over.
    expect(paymentOutcome('pending', { ...unconfirmed, cancelConfirmed: true })).toBe('cancelled');
    // Or credited after all (the admin's 승인 확인).
    expect(paymentOutcome('pending', { status: 'succeeded', cancelConfirmed: null })).toBe(
      'succeeded',
    );
  });

  it("keeps 'stopped' for a failed payment: only the URL knows the payer stopped it", () => {
    const failed = { status: 'failed' as const, cancelConfirmed: null };
    expect(paymentOutcome('stopped', failed)).toBe('stopped');
    expect(paymentOutcome('failed', failed)).toBe('failed');
    // A stop the 재통보 overruled is a success after all.
    expect(paymentOutcome('stopped', { status: 'succeeded', cancelConfirmed: null })).toBe(
      'succeeded',
    );
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

  it('shows the reason under a failure or a confirmed cancel, and nowhere else', () => {
    const refused = payment({ status: 'failed', resultMessage: '  한도 초과  ', approvedAt: null });
    expect(paymentResultNotice('failed', refused).reason).toBe('한도 초과');
    const cancelled = payment({
      status: 'cancelled',
      resultMessage: '가맹점 승인 처리 실패로 인한 자동 취소',
      cancelConfirmed: true,
    });
    expect(paymentResultNotice('succeeded', cancelled)).toMatchObject({
      outcome: 'cancelled',
      status: 'warning',
      message: copy.paymentResultCancelled,
      reason: '가맹점 승인 처리 실패로 인한 자동 취소',
    });
    // A cancel nobody has confirmed: still being checked, and no reason for an end it has not
    // reached.
    expect(paymentResultNotice('pending', { ...cancelled, cancelConfirmed: false })).toEqual({
      outcome: 'pending',
      status: 'warning',
      message: copy.paymentResultPending,
      reason: null,
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
    expect(paymentPollInterval({ status: 'pending', cancelConfirmed: null }, 1)).toBe(
      PAYMENT_POLL_INTERVAL_MS,
    );
    expect(
      paymentPollInterval({ status: 'pending', cancelConfirmed: null }, PAYMENT_POLL_LIMIT - 1),
    ).toBe(PAYMENT_POLL_INTERVAL_MS);
    expect(
      paymentPollInterval({ status: 'pending', cancelConfirmed: null }, PAYMENT_POLL_LIMIT),
    ).toBe(false);
    expect(PAYMENT_POLL_INTERVAL_MS * PAYMENT_POLL_LIMIT).toBe(2 * 60 * 1000);
  });

  it('stops once the payment has settled, and never starts without one', () => {
    for (const status of PAYMENT_STATUSES.filter((s) => s !== 'pending')) {
      expect(paymentPollInterval({ status, cancelConfirmed: null }, 1), status).toBe(false);
    }
    expect(paymentPollInterval({ status: 'cancelled', cancelConfirmed: true }, 1)).toBe(false);
    expect(paymentPollInterval(undefined, 0)).toBe(false);
  });

  it('waits on a cancel nobody has confirmed as on a pending payment, for as long', () => {
    const unconfirmed = { status: 'cancelled' as const, cancelConfirmed: false };
    expect(paymentPollInterval(unconfirmed, 1)).toBe(PAYMENT_POLL_INTERVAL_MS);
    expect(paymentPollInterval(unconfirmed, PAYMENT_POLL_LIMIT)).toBe(false);
  });
});

describe('endedFetches', () => {
  it('counts a failed fetch like an answered one, so a poll that keeps failing runs out', () => {
    expect(endedFetches({ dataUpdateCount: 0, errorUpdateCount: 0 })).toBe(0);
    expect(endedFetches({ dataUpdateCount: 1, errorUpdateCount: 0 })).toBe(1);
    // A pending payment re-read once, then refused every time (a 401 is never retried).
    const failing = (errors: number) =>
      paymentPollInterval(
        { status: 'pending', cancelConfirmed: null },
        endedFetches({ dataUpdateCount: 1, errorUpdateCount: errors }),
      );
    expect(failing(PAYMENT_POLL_LIMIT - 2)).toBe(PAYMENT_POLL_INTERVAL_MS);
    expect(failing(PAYMENT_POLL_LIMIT - 1)).toBe(false);
  });
});

describe('결제 내역 poll', () => {
  const REFUNDING = adminPayment('00000000-0000-4000-8000-0000000000a1', 'refunding');
  const CLAIMED = adminPayment('00000000-0000-4000-8000-0000000000a2', 'pending');
  const UNCLAIMED = { ...CLAIMED, id: '00000000-0000-4000-8000-0000000000a3', providerRef: null };
  const DONE = adminPayment('00000000-0000-4000-8000-0000000000a4', 'succeeded');
  const UNCONFIRMED = adminPayment('00000000-0000-4000-8000-0000000000a5', 'cancelled', {
    cancelConfirmed: false,
  });

  it('waits on a refund under way, a claimed pending payment and an unconfirmed cancel only', () => {
    expect(isPaymentInFlight(REFUNDING)).toBe(true);
    expect(isPaymentInFlight(CLAIMED)).toBe(true);
    // 처리 중 too: a net cancel with no clear answer, which the 재통보 or an admin settles.
    expect(isPaymentInFlight(UNCONFIRMED)).toBe(true);
    // 미완료: only the payer's return from the window moves it, and that reloads the wallet.
    expect(isPaymentInFlight(UNCLAIMED)).toBe(false);
    for (const status of PAYMENT_STATUSES.filter((s) => s !== 'pending' && s !== 'refunding')) {
      expect(
        isPaymentInFlight({ status, providerRef: 'StdTid', cancelConfirmed: null }),
        status,
      ).toBe(false);
    }
    expect(isPaymentInFlight({ ...UNCONFIRMED, cancelConfirmed: true })).toBe(false);
  });

  it('gives an unconfirmed cancel a set of its own: its confirmation ends the wait', () => {
    const poll = paymentsPoll();
    expect(poll([DONE, UNCONFIRMED], 1)).toBe(PAYMENT_POLL_INTERVAL_MS);
    expect(poll([DONE, { ...UNCONFIRMED, cancelConfirmed: true }], 2)).toBe(false);
  });

  it('re-reads the list every few seconds while a row is in flight, for a bounded while', () => {
    const poll = paymentsPoll();
    // The first answer is fetch 1: the budget runs from there.
    expect(poll([DONE, REFUNDING], 1)).toBe(PAYMENT_POLL_INTERVAL_MS);
    // Asked again for the same answer (query-core re-computes it), nothing is spent.
    expect(poll([DONE, REFUNDING], 1)).toBe(PAYMENT_POLL_INTERVAL_MS);
    expect(poll([DONE, REFUNDING], PAYMENT_POLL_LIMIT)).toBe(PAYMENT_POLL_INTERVAL_MS);
    expect(poll([DONE, REFUNDING], PAYMENT_POLL_LIMIT + 1)).toBe(false);
    // The refund finished: nothing left to wait on.
    expect(poll([DONE, { ...REFUNDING, status: 'refunded' }], PAYMENT_POLL_LIMIT + 2)).toBe(false);
  });

  it('never polls a list with nothing in flight, or an empty one', () => {
    const poll = paymentsPoll();
    expect(poll([], 0)).toBe(false);
    expect(poll([DONE, UNCLAIMED], 1)).toBe(false);
    expect(poll([DONE, UNCLAIMED], 2)).toBe(false);
  });

  it("gives each new set of in-flight rows its own budget, whatever the list's count", () => {
    const poll = paymentsPoll();
    // A wallet left open: trades restarted the list many times before anything was in flight,
    // and a payment stuck 처리 중 spent its own two minutes.
    expect(poll([CLAIMED, DONE], 40)).toBe(PAYMENT_POLL_INTERVAL_MS);
    expect(poll([CLAIMED, DONE], 40 + PAYMENT_POLL_LIMIT)).toBe(false);
    expect(poll([CLAIMED, DONE], 100)).toBe(false);
    // Then an admin refund claws DONE back (user:balance restarts the list): a new set.
    const clawedBack = { ...DONE, status: 'refunding' as const };
    expect(poll([CLAIMED, clawedBack], 101)).toBe(PAYMENT_POLL_INTERVAL_MS);
    expect(poll([CLAIMED, clawedBack], 100 + PAYMENT_POLL_LIMIT)).toBe(PAYMENT_POLL_INTERVAL_MS);
    expect(poll([CLAIMED, clawedBack], 101 + PAYMENT_POLL_LIMIT)).toBe(false);
    // A row leaving the set (the stuck one settled) is a new set too, and so is a new page.
    expect(poll([{ ...CLAIMED, status: 'succeeded' }, clawedBack], 130)).toBe(
      PAYMENT_POLL_INTERVAL_MS,
    );
  });

  it('starts over when the count runs backwards (the cache was reset under the page)', () => {
    const poll = paymentsPoll();
    expect(poll([REFUNDING], 50)).toBe(PAYMENT_POLL_INTERVAL_MS);
    expect(poll([REFUNDING], 50 + PAYMENT_POLL_LIMIT)).toBe(false);
    expect(poll([REFUNDING], 1)).toBe(PAYMENT_POLL_INTERVAL_MS);
  });

  it('keeps one memory per poll: two lists do not spend each other', () => {
    const one = paymentsPoll();
    const other = paymentsPoll();
    expect(one([REFUNDING], 1 + PAYMENT_POLL_LIMIT)).toBe(PAYMENT_POLL_INTERVAL_MS);
    expect(one([REFUNDING], 1 + 2 * PAYMENT_POLL_LIMIT)).toBe(false);
    expect(other([REFUNDING], 1 + 2 * PAYMENT_POLL_LIMIT)).toBe(PAYMENT_POLL_INTERVAL_MS);
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
    expect(
      paymentStatusView({ status: 'pending', providerRef: null, cancelConfirmed: null }),
    ).toEqual({
      label: copy.paymentStatusUnfinished,
      palette: 'gray',
    });
    for (const status of PAYMENT_STATUSES) {
      const cancelConfirmed = status === 'cancelled' ? true : null;
      expect(paymentStatusView({ status, providerRef: 'tid', cancelConfirmed }), status).toEqual({
        label: PAYMENT_STATUS_LABEL[status],
        palette: PAYMENT_STATUS_PALETTE[status],
      });
    }
  });

  it('shows a cancel nobody has confirmed as 처리 중, without its reason', () => {
    const unconfirmed = payment({
      status: 'cancelled',
      cancelConfirmed: false,
      resultMessage: '가맹점 승인 처리 실패로 인한 자동 취소',
    });
    expect(isCancelUnconfirmed(unconfirmed)).toBe(true);
    expect(paymentStatusView(unconfirmed)).toEqual({
      label: PAYMENT_STATUS_LABEL.pending,
      palette: PAYMENT_STATUS_PALETTE.pending,
    });
    expect(paymentHistoryReason(unconfirmed)).toBeNull();
    // The admin list still reads it (with 확인 필요 beside it).
    expect(paymentFailureReason(unconfirmed)).toBe('가맹점 승인 처리 실패로 인한 자동 취소');
    // Confirmed: 취소됨, with its reason.
    const confirmed = { ...unconfirmed, cancelConfirmed: true };
    expect(isCancelUnconfirmed(confirmed)).toBe(false);
    expect(paymentStatusView(confirmed).label).toBe(PAYMENT_STATUS_LABEL.cancelled);
    expect(paymentHistoryReason(confirmed)).toBe('가맹점 승인 처리 실패로 인한 자동 취소');
    expect(paymentHistoryReason(payment({ status: 'failed', resultMessage: '한도 초과' }))).toBe(
      '한도 초과',
    );
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

  it('says a refusal left for 수동 정리 kept the P out and the payment 환불 처리 중', () => {
    const gateway = { path: ['gateway'], message: '2002 취소 불가' };
    const settleRequired = { path: ['payment'], message: 'settle_required' };
    expect(
      refundErrorView(apiError(409, 'PAYMENT_GATEWAY_REFUSED', [gateway, settleRequired])),
    ).toEqual({
      title: copy.errRefundSettleRequired,
      description: `${copy.errRefundSettleRequiredHint} ${copy.refundGatewayAnswer} 2002 취소 불가`,
    });
    // The PG gave no words (an empty gateway detail): the instruction alone.
    expect(
      refundErrorView(
        apiError(409, 'PAYMENT_GATEWAY_REFUSED', [
          { path: ['gateway'], message: '' },
          settleRequired,
        ]),
      ),
    ).toEqual({
      title: copy.errRefundSettleRequired,
      description: copy.errRefundSettleRequiredHint,
    });
    // Read by path, not position.
    expect(
      refundErrorView(apiError(409, 'PAYMENT_GATEWAY_REFUSED', [settleRequired, gateway])).title,
    ).toBe(copy.errRefundSettleRequired);
    // Without it, the plain refusal (the P restored, or the row moved): no settle promised.
    expect(refundErrorView(apiError(409, 'PAYMENT_GATEWAY_REFUSED', [gateway])).title).toBe(
      copy.errRefundGatewayRefused,
    );
    expect(copy.errRefundSettleRequired).toContain(copy.paymentStatusRefunding);
    expect(copy.errRefundSettleRequiredHint).toContain(copy.adminPaymentSettle);
    // The refused refund just touched the row: a settle before two minutes answers in_progress.
    expect(copy.errRefundSettleRequiredHint).toContain('2분');
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

describe('settleOutcomesFor', () => {
  const ID = '00000000-0000-4000-8000-0000000000b1';
  const row = (status: PaymentStatus, overrides: Partial<AdminPayment> = {}) =>
    adminPayment(ID, status, overrides);

  /**
   * payment-settle.service `transitionOf`, row by row — every status, claimed or not, flagged or
   * not. For `cancelled` the API reads the net cancel's outcome, which the list sees only as
   * `needsReview` (no confirmed net cancel).
   */
  const TABLE: readonly [PaymentStatus, boolean, boolean, readonly PaymentSettleOutcome[]][] = [
    // status, claimed, needsReview, outcomes
    ['pending', true, true, ['credit', 'cancelled', 'failed']],
    ['pending', true, false, ['credit', 'cancelled', 'failed']],
    ['pending', false, false, ['failed']],
    ['failed', true, true, ['credit', 'cancelled', 'failed']],
    ['failed', true, false, ['credit', 'cancelled', 'failed']],
    ['failed', false, false, []],
    ['cancelled', true, true, ['credit', 'cancelled']],
    ['cancelled', true, false, []],
    ['cancelled', false, true, []],
    ['refunding', true, true, ['refunded', 'restore']],
    ['refunding', true, false, ['refunded', 'restore']],
    ['succeeded', true, false, []],
    ['refunded', true, false, []],
  ];

  it("mirrors the API's transition table", () => {
    for (const [status, claimed, needsReview, outcomes] of TABLE) {
      const payment = row(status, {
        providerRef: claimed ? 'StdTid0123456789' : null,
        needsReview,
      });
      expect(settleOutcomesFor(payment), `${status} claimed=${String(claimed)}`).toEqual(outcomes);
    }
    // Every status is in the table, and every outcome offered is one the API knows.
    expect(new Set(TABLE.map(([status]) => status))).toEqual(new Set(PAYMENT_STATUSES));
    for (const [, , , outcomes] of TABLE) {
      for (const outcome of outcomes) expect(PAYMENT_SETTLE_OUTCOMES).toContain(outcome);
    }
  });

  it('offers nothing on a mock payment, whatever its state (the API refuses `provider`)', () => {
    for (const status of PAYMENT_STATUSES) {
      const mock = row(status, { provider: 'mock', providerRef: 'mock_1', needsReview: true });
      expect(settleOutcomesFor(mock), status).toEqual([]);
      expect(offersSettle(mock), status).toBe(false);
    }
  });
});

describe('offersSettle', () => {
  const ID = '00000000-0000-4000-8000-0000000000b2';

  it('offers 수동 정리 on a flagged row with something to settle', () => {
    expect(offersSettle(adminPayment(ID, 'pending', { needsReview: true }))).toBe(true);
    expect(offersSettle(adminPayment(ID, 'failed', { needsReview: true }))).toBe(true);
    expect(offersSettle(adminPayment(ID, 'cancelled', { needsReview: true }))).toBe(true);
    // Not flagged: a claimed payment the API may still settle by itself.
    expect(offersSettle(adminPayment(ID, 'pending'))).toBe(false);
    expect(offersSettle(adminPayment(ID, 'failed'))).toBe(false);
    expect(offersSettle(adminPayment(ID, 'succeeded'))).toBe(false);
  });

  it('offers it on every refunding row, beside the retry (a refused one needs it at once)', () => {
    const refunding = adminPayment(ID, 'refunding');
    expect(offersSettle(refunding)).toBe(true);
    expect(refundAction(refunding)).toBe('retry');
    expect(offersSettle({ ...refunding, needsReview: true })).toBe(true);
  });
});

describe('the settle dialog', () => {
  it('describes every outcome in plain words', () => {
    for (const outcome of PAYMENT_SETTLE_OUTCOMES) {
      expect(SETTLE_OUTCOME_VIEW[outcome].label, outcome).not.toBe('');
      expect(SETTLE_OUTCOME_VIEW[outcome].description, outcome).not.toBe('');
    }
    expect(SETTLE_OUTCOME_VIEW.credit.description).toContain('승인이 확인되어 P를 충전합니다');
    expect(SETTLE_OUTCOME_VIEW.cancelled.description).toContain(
      '카드 결제가 취소된 것을 확인했습니다',
    );
    expect(SETTLE_OUTCOME_VIEW.failed.description).toContain('승인되지 않은 결제로 닫습니다');
    expect(SETTLE_OUTCOME_VIEW.refunded.description).toContain(
      '카드 취소가 확인되어 환불을 완료합니다',
    );
    expect(SETTLE_OUTCOME_VIEW.restore.description).toContain(
      '카드가 취소되지 않아 회수한 P를 돌려줍니다',
    );
  });

  it("points to the deployment's merchant admin, or both while that is unknown", () => {
    const both = [
      { mode: 'STG', url: 'https://newbiz.smilebiz.co.kr' },
      { mode: 'REAL', url: 'https://www.smilebiz.co.kr' },
    ];
    expect(merchantAdminSites(undefined)).toEqual(both);
    expect(merchantAdminSites({ provider: 'mock' })).toEqual(both);
    const smartro = (mode: 'STG' | 'REAL') =>
      ({ provider: 'smartro', mode, scriptUrl: { pc: 'p', mobile: 'm' } }) as const;
    expect(merchantAdminSites(smartro('STG'))).toEqual([
      { mode: 'STG', url: MERCHANT_ADMIN_URL.STG },
    ]);
    expect(merchantAdminSites(smartro('REAL'))).toEqual([
      { mode: 'REAL', url: MERCHANT_ADMIN_URL.REAL },
    ]);
  });

  it('shows the order number the merchant admin searches by, and never throws', () => {
    expect(merchantOrderId(PAYMENT_ID)).toBe(PAYMENT_ID.replaceAll('-', ''));
    expect(merchantOrderId('not-a-uuid')).toBeNull();
  });
});

describe('settleFormSchema · toSettleBody', () => {
  const parse = (values: { outcome?: PaymentSettleOutcome; tid?: string; reason?: string }) =>
    settleFormSchema.safeParse({ tid: '', reason: '확인함', ...values });
  const messages = (values: Parameters<typeof parse>[0]) => {
    const result = parse(values);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  it('requires an outcome and a reason, trimmed, within the API limit', () => {
    expect(messages({})).toEqual([copy.errSettleOutcome]);
    expect(messages({ outcome: 'failed', reason: '   ' })).toEqual([copy.errSettleReason]);
    expect(
      messages({ outcome: 'failed', reason: 'x'.repeat(REFUND_REASON_MAX_LENGTH + 1) }),
    ).toEqual([copy.errSettleReason]);
    expect(messages({ outcome: 'failed', reason: 'x'.repeat(REFUND_REASON_MAX_LENGTH) })).toEqual(
      [],
    );
  });

  it("checks a credit's Tid only when one is typed, by the API's own shape", () => {
    expect(messages({ outcome: 'credit' })).toEqual([]);
    expect(messages({ outcome: 'credit', tid: '  StdTid01  ' })).toEqual([]);
    expect(messages({ outcome: 'credit', tid: 'Std Tid' })).toEqual([copy.errSettleTid]);
    expect(messages({ outcome: 'credit', tid: '결제번호' })).toEqual([copy.errSettleTid]);
    expect(messages({ outcome: 'credit', tid: 'T'.repeat(SETTLE_TID_MAX_LENGTH + 1) })).toEqual([
      copy.errSettleTid,
    ]);
    expect(messages({ outcome: 'credit', tid: 'T'.repeat(SETTLE_TID_MAX_LENGTH) })).toEqual([]);
    // Left behind by switching to another outcome: not sent, so not checked.
    expect(messages({ outcome: 'cancelled', tid: 'Std Tid' })).toEqual([]);
  });

  it('sends the Tid with a credit only, and only when typed — never an empty one', () => {
    const body = (values: Parameters<typeof parse>[0]) => {
      const result = parse(values);
      if (!result.success) throw new Error('refused');
      return toSettleBody(result.data);
    };
    expect(body({ outcome: 'credit', tid: '  StdTid01 ', reason: ' 승인 확인 ' })).toEqual({
      outcome: 'credit',
      reason: '승인 확인',
      tid: 'StdTid01',
    });
    const blank = body({ outcome: 'credit', tid: '   ' });
    expect(blank).toEqual({ outcome: 'credit', reason: '확인함' });
    expect('tid' in blank).toBe(false);
    for (const outcome of PAYMENT_SETTLE_OUTCOMES.filter((o) => o !== 'credit')) {
      const other = body({ outcome, tid: 'StdTid01' });
      expect(other, outcome).toEqual({ outcome, reason: '확인함' });
    }
    // Every body the form builds is one the API accepts.
    for (const outcome of PAYMENT_SETTLE_OUTCOMES) {
      for (const tid of ['', 'StdTid01']) {
        expect(settlePaymentBodySchema.safeParse(body({ outcome, tid })).success).toBe(true);
      }
    }
  });
});

describe('settleErrorView', () => {
  const refused = (message: string) =>
    apiError(409, 'REFUND_NOT_ALLOWED', [{ path: ['payment'], message }]);

  it('tells every REFUND_NOT_ALLOWED detail of the settle route apart', () => {
    expect(settleErrorView(refused('status'))).toEqual({
      title: copy.errSettleStatus,
      description: copy.errSettleStatusHint,
    });
    expect(settleErrorView(refused('provider'))).toEqual({ title: copy.errSettleProvider });
    expect(settleErrorView(refused('in_progress'))).toEqual({ title: copy.errSettleInProgress });
    expect(settleErrorView(refused('approval_mismatch'))).toEqual({
      title: copy.errSettleApprovalMismatch,
      description: copy.errSettleApprovalMismatchHint,
    });
    expect(settleErrorView(refused('partial_cancel'))).toEqual({
      title: copy.errSettlePartialCancel,
      description: copy.errSettlePartialCancelHint,
    });
    // A detail the web does not know yet, or none: not settleable like this now.
    expect(settleErrorView(refused('something_new')).title).toBe(copy.errSettleStatus);
    expect(settleErrorView(apiError(409, 'REFUND_NOT_ALLOWED')).title).toBe(copy.errSettleStatus);
  });

  it('says what to do: the remedies the API names', () => {
    expect(copy.errSettleInProgress).toBe(
      '방금 처리 중인 결제입니다. 2분 뒤에 다시 시도해 주세요.',
    );
    // A card the PG says is cancelled: 취소 확인 or 환불 완료, never a credit or a restore.
    expect(copy.errSettleStatusHint).toContain(copy.adminPaymentSettleCancelled);
    expect(copy.errSettleStatusHint).toContain(copy.adminPaymentSettleRefunded);
    // The approval is not this payment's: cancel the card, then 취소 확인.
    expect(copy.errSettleApprovalMismatchHint).toContain(copy.adminPaymentSettleCancelled);
    // A partial cancel: settle it, then square the balance by hand.
    expect(copy.errSettlePartialCancelHint).toContain(copy.adminAdjust);
  });

  it('puts a refused Tid or reason under its field', () => {
    expect(
      settleErrorView(
        apiError(400, 'VALIDATION_ERROR', [
          {
            path: ['tid'],
            message: 'required: no successful approval of this payment is on record',
          },
        ]),
      ),
    ).toEqual({ title: copy.errSettleTidRequired, field: 'tid' });
    expect(
      settleErrorView(apiError(400, 'VALIDATION_ERROR', [{ path: ['reason'], message: 'x' }])),
    ).toEqual({ title: copy.errSettleReason, field: 'reason' });
    expect(copy.errSettleTidRequired).toContain(copy.adminPaymentSettleTid);
    // Asked for whenever no SUCCESSFUL approval is on record — also after an approval that
    // answered a PG error code, which the row shows as its reason.
    expect(copy.errSettleTidRequired).toContain('성공한 승인 응답이 없어');
  });

  it('maps a wrong id, and falls back to the generic message for everything else', () => {
    expect(settleErrorView(apiError(404, 'NOT_FOUND')).title).toBe(copy.errRefundNotFound);
    expect(settleErrorView(apiError(400, 'VALIDATION_ERROR')).title).toBe(copy.errUnknown);
    expect(
      settleErrorView(apiError(400, 'VALIDATION_ERROR', [{ path: ['outcome'], message: 'x' }])),
    ).toEqual({ title: copy.errUnknown });
    expect(settleErrorView(apiError(500, 'INTERNAL')).title).toBe(copy.errUnknown);
    expect(settleErrorView(new TypeError('Failed to fetch')).title).toBe(copy.errUnknown);
  });
});

describe('settleKeepsDialog', () => {
  const refused = (message: string) =>
    apiError(409, 'REFUND_NOT_ALLOWED', [{ path: ['payment'], message }]);

  it('keeps the dialog for what the admin answers in it', () => {
    expect(settleKeepsDialog(new TypeError('Failed to fetch'))).toBe(true);
    expect(
      settleKeepsDialog(apiError(400, 'VALIDATION_ERROR', [{ path: ['tid'], message: 'x' }])),
    ).toBe(true);
    for (const reason of ['in_progress', 'approval_mismatch', 'partial_cancel']) {
      expect(settleKeepsDialog(refused(reason)), reason).toBe(true);
    }
  });

  it('closes it over the refreshed list for every other answer', () => {
    for (const reason of ['status', 'provider', 'something_new']) {
      expect(settleKeepsDialog(refused(reason)), reason).toBe(false);
    }
    expect(settleKeepsDialog(apiError(409, 'REFUND_NOT_ALLOWED'))).toBe(false);
    expect(settleKeepsDialog(apiError(404, 'NOT_FOUND'))).toBe(false);
    expect(settleKeepsDialog(apiError(500, 'INTERNAL'))).toBe(false);
  });
});
