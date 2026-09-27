import {
  CARD_MIN_PRICE_KRW,
  PAYMENT_REFUND_WINDOW_DAYS,
  REFUND_REASON_MAX_LENGTH,
  type PaymentReturnResult,
  type PaymentStatus,
  paymentReturnResultSchema,
  uuidSchema,
} from '@buddha/shared';
import type { InfiniteData } from '@tanstack/react-query';
import * as z from 'zod';
import { copy } from '@/copy';
import { type AdminPayment, type ApiError, type Payment, isApiError, validationField } from './api';
import { PAYMENT_STATUS_LABEL, PAYMENT_STATUS_PALETTE } from './market-admin';

/**
 * Pure decisions behind the payment screens (ADR-0042): the wallet's return from the
 * SmartroPay window (`/wallet?payment=&result=&package=`), the user's 결제 내역, and the admin
 * refund. No `'use client'` directive, so the server page parses its `searchParams` here; the
 * components only render what these answer, and this app's node-only test runner executes it.
 */

// ---- the wallet URL -----------------------------------------------------------------

type SearchValue = string | string[] | undefined;

/** What `/wallet` understands in its query, each part present only when it is well formed. */
export interface WalletSearch {
  /** The payment the window just finished (`payment`, a uuid, lower-cased). */
  paymentId?: string;
  /** How the API says it ended (`result`, one of PAYMENT_RETURN_RESULTS). */
  result?: PaymentReturnResult;
  /** The package the public `/charge` page sent the visitor to buy (`package`, a uuid). */
  packageId?: string;
}

/**
 * A repeated parameter reaches a page as an array. Nothing builds one — the API's redirect
 * and `/charge` both write each key once — so an array is not a URL of ours and is ignored
 * rather than read by position.
 */
function single(value: SearchValue): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function uuidOf(value: SearchValue): string | undefined {
  const parsed = uuidSchema.safeParse(single(value));
  return parsed.success ? parsed.data : undefined;
}

export function parseWalletSearch(params: {
  payment?: SearchValue;
  result?: SearchValue;
  package?: SearchValue;
}): WalletSearch {
  const result = paymentReturnResultSchema.safeParse(single(params.result));
  const paymentId = uuidOf(params.payment);
  const packageId = uuidOf(params.package);
  return {
    ...(paymentId === undefined ? {} : { paymentId }),
    ...(result.success ? { result: result.data } : {}),
    ...(packageId === undefined ? {} : { packageId }),
  };
}

/** `/wallet` with exactly the parts of `search` it holds, in a fixed order. */
export function walletHref(search: WalletSearch): string {
  const query = new URLSearchParams();
  if (search.paymentId !== undefined) query.set('payment', search.paymentId);
  if (search.result !== undefined) query.set('result', search.result);
  if (search.packageId !== undefined) query.set('package', search.packageId);
  const rest = query.toString();
  return rest === '' ? '/wallet' : `/wallet?${rest}`;
}

/**
 * Where an anonymous `/wallet` visit goes: the login page, told to come back to THIS wallet
 * URL. The `/charge` CTA (`?package=`) is the common case — without it the package the visitor
 * chose would be lost at the sign-in — and a return from the payment window whose session
 * did not survive keeps its notice the same way. Only the parsed parts travel, so nothing a
 * crafted link adds rides into `next`; the login page re-checks it with `safeNextPath`.
 */
export function walletLoginPath(search: WalletSearch): string {
  const next = walletHref(search);
  return next === '/wallet' ? '/login?next=/wallet' : `/login?next=${encodeURIComponent(next)}`;
}

// ---- the result notice ----------------------------------------------------------------

/**
 * The outcome a payment's CURRENT status stands for, in the redirect's own words — the API's
 * mapping (smartro-pay.service `RESULT_BY_STATUS`): a refund in progress or done was a
 * payment that went through.
 */
const OUTCOME_BY_STATUS: Readonly<Record<PaymentStatus, PaymentReturnResult>> = {
  pending: 'pending',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  refunding: 'succeeded',
  refunded: 'succeeded',
};

/**
 * What the notice says happened. The URL is what the API knew when it redirected; the
 * payment, once loaded, is what it knows now, and that wins: a `pending` return that the
 * 재통보 has since credited is a success, and a `failed` one it credited too. The one thing
 * only the URL knows is that a `failed` payment was the payer's own 결제 취소 (StopUrl), so
 * `stopped` survives a `failed` row. Without a loaded payment — no id in the URL, someone
 * else's id (404), a failed fetch — the URL's word is all there is.
 */
export function paymentOutcome(
  result: PaymentReturnResult,
  payment: Pick<Payment, 'status'> | undefined,
): PaymentReturnResult {
  if (payment === undefined) return result;
  const current = OUTCOME_BY_STATUS[payment.status];
  return current === 'failed' && result === 'stopped' ? 'stopped' : current;
}

export type NoticeStatus = 'success' | 'error' | 'warning' | 'info';

export interface PaymentResultNotice {
  outcome: PaymentReturnResult;
  status: NoticeStatus;
  message: string;
  /** The PG's own words (`resultMessage`) under a failure; null when there are none. */
  reason: string | null;
}

const NOTICE: Readonly<Record<PaymentReturnResult, { status: NoticeStatus; message: string }>> = {
  succeeded: { status: 'success', message: copy.paymentResultSucceeded },
  failed: { status: 'error', message: copy.paymentResultFailed },
  stopped: { status: 'info', message: copy.paymentResultStopped },
  pending: { status: 'warning', message: copy.paymentResultPending },
  cancelled: { status: 'warning', message: copy.paymentResultCancelled },
};

/**
 * The Alert `/wallet` shows after the payment window (DESIGN §6.2). The reason is the last
 * ResultMsg the PG gave (`Payment.resultMessage`, e.g. a card refusal) and is shown for the
 * two outcomes that need explaining; a success's message is the PG's "승인" and says nothing.
 */
export function paymentResultNotice(
  result: PaymentReturnResult,
  payment: Pick<Payment, 'status' | 'resultMessage'> | undefined,
): PaymentResultNotice {
  const outcome = paymentOutcome(result, payment);
  const said = payment?.resultMessage?.trim() ?? '';
  const explains = outcome === 'failed' || outcome === 'cancelled';
  return { outcome, ...NOTICE[outcome], reason: explains && said !== '' ? said : null };
}

/** How often, and for how long, a `pending` payment is re-read while its notice is up. */
export const PAYMENT_POLL_INTERVAL_MS = 5_000;
export const PAYMENT_POLL_LIMIT = 24;

/**
 * `refetchInterval` of the notice's payment: every 5 s while it is still `pending` — the
 * approval's answer was lost, or the 재통보 has not come yet — for two minutes, after which
 * the notice keeps saying so and 결제 내역 carries the rest (a person settles what is left).
 * `fetches` is the query's `dataUpdateCount`.
 */
export function paymentPollInterval(
  payment: Pick<Payment, 'status'> | undefined,
  fetches: number,
): number | false {
  return payment?.status === 'pending' && fetches < PAYMENT_POLL_LIMIT
    ? PAYMENT_POLL_INTERVAL_MS
    : false;
}

// ---- 결제 내역 --------------------------------------------------------------------------

/**
 * The PG's last word on a payment that did not go through (`failed`, or `cancelled` after an
 * approval we could not credit) — a card refusal, a window error — for the rows of both
 * lists. Anything else's `resultMessage` is the PG's "승인" and says nothing worth a line.
 */
export function paymentFailureReason(
  payment: Pick<Payment, 'status' | 'resultMessage'>,
): string | null {
  if (payment.status !== 'failed' && payment.status !== 'cancelled') return null;
  const said = payment.resultMessage?.trim() ?? '';
  return said === '' ? null : said;
}

/**
 * SmartroPay's `PayMethod` of an approval (`Payment.method`), in Korean. We only ever ASK for
 * CARD (owner decision 2), but the window offers the easy-pay buttons too and the approval
 * names the one the payer used. An unknown value shows verbatim rather than as a blank — the
 * PG may add methods before this list learns them — and a payment with no approval (the
 * mock, a failure) has no method at all.
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
 * here one of them is split: a `pending` payment nothing has claimed (no `providerRef`) is a
 * window that was opened and never completed — closed, abandoned, or still open in another
 * tab — and "처리 중" would claim the service is working on something it has not received.
 * Once the window hands back an authentication the payment is claimed, and "처리 중" is true.
 */
export function paymentStatusView(payment: Pick<Payment, 'status' | 'providerRef'>): {
  label: string;
  palette: string;
} {
  if (payment.status === 'pending' && payment.providerRef === null) {
    return { label: copy.paymentStatusUnfinished, palette: 'gray' };
  }
  return {
    label: PAYMENT_STATUS_LABEL[payment.status],
    palette: PAYMENT_STATUS_PALETTE[payment.status],
  };
}

/** The payment window takes cards from 1,000원 (ResultCode 3041 below); the API refuses first. */
export function isBelowCardMinimum(priceKrw: number): boolean {
  return priceKrw < CARD_MIN_PRICE_KRW;
}

/**
 * The charge refusals only the payment-window flow can meet, or `undefined` for everything
 * else — `ChargeForm` falls through to the immediate charge's own mapping, which both flows
 * share (the prepare route guards in the same order as the charge route). Contact first: a
 * user who reached the wallet without one (an account from before the onboarding gate, a
 * session older than it) is told what is missing rather than that the charge failed.
 */
export function checkoutErrorTitle(error: unknown): string | undefined {
  if (isApiError(error, 'CONTACT_REQUIRED')) return copy.chargeContactRequired;
  return undefined;
}

/**
 * The charge route's 404 that names no field: the configured provider does not offer this
 * flow any more (switched while the page was open), or — rarer — the account has no balance
 * row. Either way the provider info is worth re-reading: when it did change, the next click
 * takes the other flow instead of repeating the refusal.
 */
export function isFlowUnavailable(error: unknown): boolean {
  return isApiError(error, 'NOT_FOUND') && validationField(error) === undefined;
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
 * Which refund button a row offers (DESIGN §5.6/§6.2), or none:
 * - `refund`: `succeeded`, still inside the window. Whether the user has spent the P is the
 *   one condition the list cannot see (it has no balances); the API answers that one.
 * - `retry`: `refunding` — an earlier attempt took the P back but never heard the PG's answer.
 *   The window does not apply: the claw-back already happened inside it.
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

/** The `message` of the first `details` entry: how the refund answers say which case it is. */
function detailMessage(error: ApiError): string | undefined {
  if (!Array.isArray(error.details)) return undefined;
  const first: unknown = error.details[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const message = (first as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined;
}

export interface RefundErrorView {
  title: string;
  /** The PG's own words, for a refusal it gave (`<ResultCode> <ResultMsg>`). */
  description?: string;
}

/**
 * The toast for a refused refund, by code and — where one code covers several cases — by the
 * detail the API names (payment-refund.service):
 * - INSUFFICIENT_BALANCE: the user has spent some of the P (owner decision 5: unused only).
 * - REFUND_NOT_ALLOWED: `window_closed`, `status` (already refunded, or never succeeded) or
 *   `provider` (nothing at the PG to cancel).
 * - PAYMENT_GATEWAY_REFUSED: the PG said no, and its answer is shown as it came. The P taken
 *   back is restored only if the payment was still 환불 처리 중 by then (the same code answers
 *   when it was not, with nothing restored), so the copy claims neither and points to the list.
 * - PAYMENT_GATEWAY_ERROR: no answer; the payment stays 환불 처리 중 for a retry.
 * - DUPLICATE_REQUEST: an earlier attempt on this payment is still waiting for the PG.
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
    const answer = detailMessage(error);
    return answer === undefined
      ? { title: copy.errRefundGatewayRefused }
      : {
          title: copy.errRefundGatewayRefused,
          description: `${copy.refundGatewayAnswer} ${answer}`,
        };
  }
  if (isApiError(error, 'PAYMENT_GATEWAY_ERROR')) return { title: copy.errRefundGatewayError };
  if (isApiError(error, 'DUPLICATE_REQUEST')) return { title: copy.errRefundInProgress };
  if (isApiError(error, 'NOT_FOUND')) return { title: copy.errRefundNotFound };
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
 * seed that keeps the list honest if the refetch after it fails (`replaceDisputeRow`'s
 * reasoning). Untouched pages, and the whole cache when no page holds the row, keep their
 * identity.
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
