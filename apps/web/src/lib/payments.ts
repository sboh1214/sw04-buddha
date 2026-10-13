import { PAYMENT_REFUND_WINDOW_DAYS, REFUND_REASON_MAX_LENGTH } from '@buddha/shared';
import type { InfiniteData } from '@tanstack/react-query';
import * as z from 'zod';
import { copy } from '@/copy';
import { type AdminPayment, type ApiError, type Payment, isApiError, validationField } from './api';
import { PAYMENT_STATUS_LABEL, PAYMENT_STATUS_PALETTE } from './market-admin';

/**
 * Pure decisions behind the payment screens (ADR-0042): the user's 결제 내역 and the admin
 * refund. Both are kept while paid Coin is closed (PAID_COIN_SALES_ENABLED, ADR-0049), and the
 * web draws neither then. No `'use client'` directive, so this app's node-only test runner
 * executes it.
 */

// ---- a closed route -------------------------------------------------------------------

/**
 * The answer a paid-Coin route gives while sales are closed (PAID_COIN_SALES_ENABLED, ADR-0049):
 * 404 NOT_FOUND naming no field, and no feature either. The screens that call those routes are
 * not drawn then; one that still meets the answer says only that it is unavailable
 * (`copy.unavailable`, owner decision 2026-10-13). The same shape answers an account with no
 * balance row on the charge and the redemption, and a payment that does not exist on the refund
 * — nothing the user could fix either.
 */
export function isUnavailable(error: unknown): boolean {
  return isApiError(error, 'NOT_FOUND') && validationField(error) === undefined;
}

// ---- 결제 내역 --------------------------------------------------------------------------

/** How often, and for how long, 결제 내역 is re-read while a row of it is still moving. */
export const PAYMENT_POLL_INTERVAL_MS = 5_000;
export const PAYMENT_POLL_LIMIT = 24;

/**
 * Every fetch of a query that has ended, answered or failed — the count the poll budgets by.
 * query-core adds nothing to `dataUpdateCount` for a failed fetch, so a budget of that alone
 * would never run out while the fetches keep failing: a 401 once the session expired (never
 * retried) or an outage would re-request every PAYMENT_POLL_INTERVAL_MS for as long as the tab
 * has focus.
 */
export function endedFetches(state: { dataUpdateCount: number; errorUpdateCount: number }): number {
  return state.dataUpdateCount + state.errorUpdateCount;
}

/**
 * A `cancelled` payment whose cancel at the provider nobody has confirmed (`cancelConfirmed`
 * false): the card may still be charged, so to the payer it is still being checked — the badge,
 * the reason line and the poll treat it as `pending`.
 */
export function isCancelUnconfirmed(payment: Pick<Payment, 'status' | 'cancelConfirmed'>): boolean {
  return payment.status === 'cancelled' && payment.cancelConfirmed === false;
}

/**
 * Why a payment that did not go through ended (`failed`, or `cancelled`) — the provider's
 * refusal, or the reason of a cancel — for the rows of both lists. Anything else's
 * `resultMessage` is the provider's word of approval and says nothing worth a line. The admin
 * list shows it for every such row; the payer's goes through paymentHistoryReason.
 */
export function paymentFailureReason(
  payment: Pick<Payment, 'status' | 'resultMessage'>,
): string | null {
  if (payment.status !== 'failed' && payment.status !== 'cancelled') return null;
  const said = payment.resultMessage?.trim() ?? '';
  return said === '' ? null : said;
}

/**
 * The reason line of a row of the payer's 결제 내역: paymentFailureReason, except for a payment
 * still being checked (isCancelUnconfirmed) — shown 처리 중, it has not ended, and the reason of
 * a cancel that may not have happened would say it had.
 */
export function paymentHistoryReason(
  payment: Pick<Payment, 'status' | 'resultMessage' | 'cancelConfirmed'>,
): string | null {
  return isCancelUnconfirmed(payment) ? null : paymentFailureReason(payment);
}

/**
 * The PG's PayMethod of an approval (`Payment.method`), in Korean. An unknown value shows
 * verbatim rather than as a blank — a PG may add methods before this list learns them — and a
 * payment with no approval (the mock, a failure) has no method at all.
 */
const METHOD_LABEL: Readonly<Record<string, string>> = {
  CARD: copy.paymentMethodCard,
  BANK: copy.paymentMethodBank,
  CELLPHONE: copy.paymentMethodCellphone,
  KAKAO: copy.paymentMethodKakao,
  NAVER: copy.paymentMethodNaver,
  PAYCO: copy.paymentMethodPayco,
  SAMSUNGPAY: copy.paymentMethodSamsung,
  APPLEPAY: copy.paymentMethodApple,
  TOSS: copy.paymentMethodToss,
  LPAY: copy.paymentMethodLpay,
  PINPAY: copy.paymentMethodPinpay,
  SMILEPAY: copy.paymentMethodSmile,
  TMONEYPAY: copy.paymentMethodTmoney,
};

export function paymentMethodLabel(method: string | null): string | null {
  if (method === null || method.trim() === '') return null;
  return Object.hasOwn(METHOD_LABEL, method) ? (METHOD_LABEL[method] ?? method) : method;
}

/**
 * The status badge of the user's own list. The admin list shows the six statuses as they are;
 * here two of them read otherwise. A `pending` payment the provider never took up (no
 * `providerRef`) did not complete, and "처리 중" would claim the service is working on something
 * it has not received. And a `cancelled` one whose cancel is not confirmed (isCancelUnconfirmed)
 * is 처리 중: the card may still be charged, and "취소됨" would say it is not.
 */
export function paymentStatusView(
  payment: Pick<Payment, 'status' | 'providerRef' | 'cancelConfirmed'>,
): {
  label: string;
  palette: string;
} {
  if (payment.status === 'pending' && payment.providerRef === null) {
    return { label: copy.paymentStatusUnfinished, palette: 'gray' };
  }
  if (isCancelUnconfirmed(payment)) {
    return { label: PAYMENT_STATUS_LABEL.pending, palette: PAYMENT_STATUS_PALETTE.pending };
  }
  return {
    label: PAYMENT_STATUS_LABEL[payment.status],
    palette: PAYMENT_STATUS_PALETTE[payment.status],
  };
}

/**
 * A row of 결제 내역 about to change with nothing for the payer to do: a refund whose card
 * cancel is under way (`refunding`, 환불 처리 중), a `pending` payment the provider has taken up,
 * or a `cancelled` one whose cancel is not confirmed (isCancelUnconfirmed) — the last two shown
 * 처리 중. An untaken `pending` one (미완료) never moves by itself; polling for it would re-read
 * the list on every visit of a member who once left a payment unfinished.
 */
export function isPaymentInFlight(
  payment: Pick<Payment, 'status' | 'providerRef' | 'cancelConfirmed'>,
): boolean {
  return (
    payment.status === 'refunding' ||
    (payment.status === 'pending' && payment.providerRef !== null) ||
    isCancelUnconfirmed(payment)
  );
}

/** One call of the 결제 내역 poll: the loaded rows and the list's `endedFetches`. */
export type PaymentsPoll = (
  payments: readonly Pick<Payment, 'id' | 'status' | 'providerRef' | 'cancelConfirmed'>[],
  fetches: number,
) => number | false;

/**
 * `refetchInterval` of 결제 내역 (ADR-0042): while a loaded row is in flight
 * (`isPaymentInFlight`), the list is re-read every PAYMENT_POLL_INTERVAL_MS for at most
 * PAYMENT_POLL_LIMIT fetches — two minutes — so 환불 처리 중 turns into 환불됨 on screen without a
 * focus or a remount. The realtime `user:balance` restart cannot do it: only the refund's
 * claw-back moves P, and its finish publishes nothing.
 *
 * The budget belongs to the rows it waits on, not to the query, and a failed fetch spends it
 * like an answered one (`endedFetches`): the rows it waits on are then the last ones the list
 * loaded, still in the cache, so a list that keeps failing stops after its two minutes as well.
 * `fetches` also counts every refetch a trade's `user:balance` asks for, so a count kept since
 * the list first loaded would be spent long before a refund starts on a wallet left open. So
 * each new set of in-flight rows (a row joined or left, or changed status) starts a fresh count,
 * a set that stays as it is stops after its two minutes (a payment still 처리 중 then waits for a
 * person), and a count smaller than where the set began — the cache was reset under the page —
 * starts over. Hence a function with memory, one per list observer (`usePayments` keeps it in
 * state).
 */
export function paymentsPoll(): PaymentsPoll {
  let waitingOn = '';
  let from = 0;
  return (payments, fetches) => {
    const inFlight = payments
      .filter(isPaymentInFlight)
      .map((payment) => `${payment.id}:${payment.status}`)
      .sort()
      .join(',');
    if (inFlight !== waitingOn || fetches < from) {
      waitingOn = inFlight;
      from = fetches;
    }
    return inFlight !== '' && fetches - from < PAYMENT_POLL_LIMIT
      ? PAYMENT_POLL_INTERVAL_MS
      : false;
  };
}

// ---- the admin refund -----------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The last instant a refund is allowed: `PAYMENT_REFUND_WINDOW_DAYS` after the approval, or
 * after the reservation for a row credited before `approved_at` existed — the API's own rule
 * (payment-refund.service: refused once `now - since > window`, with the DB clock).
 */
export function refundDeadline(payment: Pick<Payment, 'approvedAt' | 'createdAt'>): number {
  return Date.parse(payment.approvedAt ?? payment.createdAt) + PAYMENT_REFUND_WINDOW_DAYS * DAY_MS;
}

export type RefundAction = 'refund' | 'retry';

/**
 * Which refund button a row offers (ADR-0042 「관리자 환불」), or none:
 * - `refund`: `succeeded`, still inside the window. Whether the user has spent the P is the
 *   one condition the list cannot see (it has no balances); the API answers that one.
 * - `retry`: `refunding` — the P was clawed back and the card cancel is not confirmed: the PG's
 *   answer never came, or a retry it refused left it for a person to check. The window does not
 *   apply: the claw-back already happened inside it.
 * - Neither for a row with no `providerRef` (nothing at the PG to cancel; the API refuses it
 *   with `provider`), or for anything else.
 *
 * `now` is the browser's clock, so a row at the very edge can still be refused with
 * `window_closed` by the API's; the button is a convenience, the API is the rule.
 */
export function refundAction(
  payment: Pick<Payment, 'status' | 'providerRef' | 'approvedAt' | 'createdAt'>,
  now: number = Date.now(),
): RefundAction | null {
  if (payment.providerRef === null) return null;
  if (payment.status === 'refunding') return 'retry';
  if (payment.status !== 'succeeded') return null;
  const deadline = refundDeadline(payment);
  return Number.isNaN(deadline) || now > deadline ? null : 'refund';
}

/** The refund dialog's one field: required, as the API's `refundPaymentBodySchema`. */
export const refundFormSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, copy.errRefundReason)
    .max(REFUND_REASON_MAX_LENGTH, copy.errRefundReason),
});
export type RefundFormValues = z.infer<typeof refundFormSchema>;

/** A `details` entry's message, trimmed, when it is a non-blank string. */
function messageOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const message = (entry as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined;
}

/** The `message` of the first `details` entry: how the refund answers say which case it is. */
function detailMessage(error: ApiError): string | undefined {
  if (!Array.isArray(error.details)) return undefined;
  return messageOf(error.details[0]);
}

/** The `message` of the first `details` entry whose path starts with `key`. */
function detailAt(error: ApiError, key: string): string | undefined {
  if (!Array.isArray(error.details)) return undefined;
  for (const entry of error.details as unknown[]) {
    const path = (entry as { path?: unknown } | null)?.path;
    if (Array.isArray(path) && path[0] === key) return messageOf(entry);
  }
  return undefined;
}

export interface RefundErrorView {
  title: string;
  /** The PG's own words for a refusal it gave (`<ResultCode> <ResultMsg>`). */
  description?: string;
}

/**
 * The toast for a refused refund, by code and — where one code covers several cases — by the
 * detail the API names (payment-refund.service):
 * - INSUFFICIENT_BALANCE: the user has spent some of the P (owner decision 5: unused only).
 * - REFUND_NOT_ALLOWED: `window_closed`, `status` (already refunded, or never succeeded) or
 *   `provider` (nothing at the PG to cancel).
 * - PAYMENT_GATEWAY_REFUSED: the PG said no, and its answer (the `gateway` detail) is shown as
 *   it came. The P taken back is restored only by a first attempt that still held the payment
 *   (환불 처리 중, not taken over by a retry); a refused retry leaves it 환불 처리 중 for a person to
 *   check. So the copy claims neither and points to the list. (A refusal after another attempt
 *   refunded the payment answers 200 `refunded`: the success it is.)
 * - PAYMENT_GATEWAY_ERROR: no answer; the payment stays 환불 처리 중 for a retry.
 * - DUPLICATE_REQUEST: an earlier attempt on this payment is still waiting for the PG.
 * - NOT_FOUND: the route is closed (isUnavailable).
 */
export function refundErrorView(error: unknown): RefundErrorView {
  if (isApiError(error, 'INSUFFICIENT_BALANCE')) return { title: copy.errRefundPUsed };
  if (isApiError(error, 'REFUND_NOT_ALLOWED')) {
    const reason = detailMessage(error);
    if (reason === 'window_closed') return { title: copy.errRefundWindowClosed };
    if (reason === 'provider') return { title: copy.errRefundProvider };
    return { title: copy.errRefundStatus };
  }
  if (isApiError(error, 'PAYMENT_GATEWAY_REFUSED')) {
    const answer = detailAt(error, 'gateway');
    return answer === undefined
      ? { title: copy.errRefundGatewayRefused }
      : {
          title: copy.errRefundGatewayRefused,
          description: `${copy.refundGatewayAnswer} ${answer}`,
        };
  }
  if (isApiError(error, 'PAYMENT_GATEWAY_ERROR')) return { title: copy.errRefundGatewayError };
  if (isApiError(error, 'DUPLICATE_REQUEST')) return { title: copy.errRefundInProgress };
  if (isUnavailable(error)) return { title: copy.unavailable };
  if (isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'reason') {
    return { title: copy.errRefundReason };
  }
  return { title: copy.errUnknown };
}

/**
 * Whether the refund dialog stays open after a refusal. An answer from the API is a decision
 * about the payment as it now is — the list is refreshed and shows the row's new state and
 * button — except the reason being refused, which the admin fixes in the dialog. A request
 * that never came back decided nothing, so the dialog stays for a retry; the API's lease and
 * status checks make that retry safe.
 */
export function refundKeepsDialog(error: unknown): boolean {
  if (!isApiError(error)) return true;
  return isApiError(error, 'VALIDATION_ERROR');
}

export interface AdminPaymentPage {
  items: AdminPayment[];
  nextCursor: string | null;
}

/**
 * The refunded row, as the API answered it, written over its copy in every cached page — the
 * seed that keeps the list honest if the refetch after it fails. Untouched pages, and the
 * whole cache when no page holds the row, keep their identity.
 */
export function replacePaymentRow(
  data: InfiniteData<AdminPaymentPage> | undefined,
  fresh: AdminPayment,
): InfiniteData<AdminPaymentPage> | undefined {
  if (data === undefined) return undefined;
  let changed = false;
  const pages = data.pages.map((page) => {
    if (!page.items.some((row) => row.id === fresh.id)) return page;
    changed = true;
    return { ...page, items: page.items.map((row) => (row.id === fresh.id ? fresh : row)) };
  });
  return changed ? { ...data, pages } : data;
}
