import {
  PAYMENT_REFUND_WINDOW_DAYS,
  PAYMENT_STATUSES,
  REFUND_REASON_MAX_LENGTH,
  type PaymentStatus,
} from '@buddha/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminPayment, ApiError, type Payment } from './api';
import { PAYMENT_STATUS_LABEL, PAYMENT_STATUS_PALETTE } from './market-admin';
import {
  type AdminPaymentPage,
  PAYMENT_POLL_INTERVAL_MS,
  PAYMENT_POLL_LIMIT,
  endedFetches,
  isCancelUnconfirmed,
  isPaymentInFlight,
  isUnavailable,
  paymentFailureReason,
  paymentHistoryReason,
  paymentMethodLabel,
  paymentStatusView,
  paymentsPoll,
  refundAction,
  refundDeadline,
  refundErrorView,
  refundFormSchema,
  refundKeepsDialog,
  replacePaymentRow,
} from './payments';

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
    amountCoin: '10000',
    priceKrw: 9900,
    packageId: PACKAGE_ID,
    provider: 'mock',
    providerRef: 'mock_0123456789',
    status: 'succeeded',
    method: null,
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
    ...overrides,
  };
}

describe('isUnavailable', () => {
  it("is the closed route's answer: a 404 naming no field", () => {
    // What every paid-Coin route answers while sales are closed (ADR-0049).
    expect(isUnavailable(apiError(404, 'NOT_FOUND'))).toBe(true);
    // A deleted package names its field: the catalogue is stale, the route is open.
    expect(
      isUnavailable(apiError(404, 'NOT_FOUND', [{ path: ['packageId'], message: 'gone' }])),
    ).toBe(false);
    expect(isUnavailable(apiError(409, 'DUPLICATE_REQUEST'))).toBe(false);
    expect(isUnavailable(new Error('network'))).toBe(false);
  });

  it('names no feature', () => {
    for (const word of ['충전', '결제', '쿠폰', '환불']) {
      expect(copy.unavailable).not.toContain(word);
    }
  });
});

describe('endedFetches', () => {
  it('counts a failed fetch like an answered one, so a poll that keeps failing runs out', () => {
    expect(endedFetches({ dataUpdateCount: 0, errorUpdateCount: 0 })).toBe(0);
    expect(endedFetches({ dataUpdateCount: 1, errorUpdateCount: 0 })).toBe(1);
    expect(endedFetches({ dataUpdateCount: 1, errorUpdateCount: 3 })).toBe(4);
    expect(PAYMENT_POLL_INTERVAL_MS * PAYMENT_POLL_LIMIT).toBe(2 * 60 * 1000);
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
    // 처리 중 too: a cancel with no clear answer yet.
    expect(isPaymentInFlight(UNCONFIRMED)).toBe(true);
    // 미완료: the provider never took it up, and it does not move by itself.
    expect(isPaymentInFlight(UNCLAIMED)).toBe(false);
    for (const status of PAYMENT_STATUSES.filter((s) => s !== 'pending' && s !== 'refunding')) {
      expect(
        isPaymentInFlight({ status, providerRef: 'mock_1', cancelConfirmed: null }),
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
  it('names the methods it knows, and shows an unknown one verbatim', () => {
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
      resultMessage: '승인 처리 실패로 인한 자동 취소',
    });
    expect(isCancelUnconfirmed(unconfirmed)).toBe(true);
    expect(paymentStatusView(unconfirmed)).toEqual({
      label: PAYMENT_STATUS_LABEL.pending,
      palette: PAYMENT_STATUS_PALETTE.pending,
    });
    expect(paymentHistoryReason(unconfirmed)).toBeNull();
    // The admin list still reads it.
    expect(paymentFailureReason(unconfirmed)).toBe('승인 처리 실패로 인한 자동 취소');
    // Confirmed: 취소됨, with its reason.
    const confirmed = { ...unconfirmed, cancelConfirmed: true };
    expect(isCancelUnconfirmed(confirmed)).toBe(false);
    expect(paymentStatusView(confirmed).label).toBe(PAYMENT_STATUS_LABEL.cancelled);
    expect(paymentHistoryReason(confirmed)).toBe('승인 처리 실패로 인한 자동 취소');
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
  it('says the Coin was already used for INSUFFICIENT_BALANCE', () => {
    expect(
      refundErrorView(
        apiError(409, 'INSUFFICIENT_BALANCE', [
          { path: ['amountCoin'], message: 'Coin already used' },
        ]),
      ),
    ).toEqual({ title: copy.errRefundCoinUsed });
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

  it('reads the answer by path, not position', () => {
    const gateway = { path: ['gateway'], message: '2002 취소 불가' };
    expect(
      refundErrorView(
        apiError(409, 'PAYMENT_GATEWAY_REFUSED', [{ path: ['payment'], message: 'x' }, gateway]),
      ),
    ).toEqual({
      title: copy.errRefundGatewayRefused,
      description: `${copy.refundGatewayAnswer} 2002 취소 불가`,
    });
  });

  it('maps the silent PG, an attempt in flight, the closed route and a blank reason', () => {
    expect(refundErrorView(apiError(502, 'PAYMENT_GATEWAY_ERROR')).title).toBe(
      copy.errRefundGatewayError,
    );
    expect(
      refundErrorView(
        apiError(409, 'DUPLICATE_REQUEST', [{ path: ['payment'], message: 'in progress' }]),
      ).title,
    ).toBe(copy.errRefundInProgress);
    // Closed while paid Coin is off (ADR-0049): said without naming the feature.
    expect(refundErrorView(apiError(404, 'NOT_FOUND')).title).toBe(copy.unavailable);
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
