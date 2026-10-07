import {
  CARD_MIN_PRICE_KRW,
  PAYMENT_REFUND_WINDOW_DAYS,
  PAYMENT_SETTLE_OUTCOMES,
  REFUND_REASON_MAX_LENGTH,
  SETTLE_TID_MAX_LENGTH,
  type PaymentReturnResult,
  type PaymentStatus,
  paymentIdToMoid,
  paymentReturnResultSchema,
  uuidSchema,
} from '@buddha/shared';
import type { InfiniteData } from '@tanstack/react-query';
import * as z from 'zod';
import { copy } from '@/copy';
import {
  type AdminPayment,
  type ApiError,
  type Payment,
  type PaymentProviderInfo,
  type PaymentSettleOutcome,
  type SettlePaymentBody,
  isApiError,
  validationField,
} from './api';
import { PAYMENT_STATUS_LABEL, PAYMENT_STATUS_PALETTE } from './market-admin';

/**
 * Pure decisions behind the payment screens (ADR-0042): the wallet's return from the
 * SmartroPay window (`/wallet?payment=&result=&package=`), the user's 결제 내역, and the admin
 * refund and 수동 정리. No `'use client'` directive, so the server page parses its
 * `searchParams` here; the components only render what these answer, and this app's node-only
 * test runner executes it.
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
 * A `cancelled` payment whose card cancel nobody has confirmed (`cancelConfirmed` false): the
 * cancel of an approval we could not credit got no clear answer, or has not had one yet. The
 * card may still be charged, and an admin may yet settle it either way (credit it, or confirm
 * the cancel) — so to the payer it is still being checked, as the ReturnUrl's `pending` said:
 * the notice, the badge and both polls treat it as `pending`.
 */
export function isCancelUnconfirmed(payment: Pick<Payment, 'status' | 'cancelConfirmed'>): boolean {
  return payment.status === 'cancelled' && payment.cancelConfirmed === false;
}

/**
 * What the notice says happened. The URL is what the API knew when it redirected; the
 * payment, once loaded, is what it knows now, and that wins: a `pending` return that the
 * 재통보 has since credited is a success, and a `failed` one it credited too. The one thing
 * only the URL knows is that a `failed` payment was the payer's own 결제 취소 (StopUrl), so
 * `stopped` survives a `failed` row. A `cancelled` payment whose cancel is not confirmed is
 * still `pending` (isCancelUnconfirmed). Without a loaded payment — no id in the URL, someone
 * else's id (404), a failed fetch — the URL's word is all there is; the API redirects with
 * `cancelled` only once the cancel is confirmed (an unconfirmed one says `pending`), so that word
 * never claims a cancel the card may not have had.
 */
export function paymentOutcome(
  result: PaymentReturnResult,
  payment: Pick<Payment, 'status' | 'cancelConfirmed'> | undefined,
): PaymentReturnResult {
  if (payment === undefined) return result;
  if (isCancelUnconfirmed(payment)) return 'pending';
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
 * The Alert `/wallet` shows after the payment window (ADR-0042). The reason is why the
 * payment ended (`Payment.resultMessage`: the PG's refusal, or why it was cancelled) and is
 * shown for the two outcomes that need explaining; a success's message is the PG's "승인" and
 * says nothing, and a payment still being checked has not ended.
 */
export function paymentResultNotice(
  result: PaymentReturnResult,
  payment: Pick<Payment, 'status' | 'resultMessage' | 'cancelConfirmed'> | undefined,
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
 * approval's answer was lost, or the 재통보 has not come yet; or a `cancelled` one whose cancel
 * is not confirmed yet (isCancelUnconfirmed) — for two minutes, after which the notice keeps
 * saying so and 결제 내역 carries the rest (a person settles what is left). `fetches` is
 * `endedFetches` of the query's state: a failed fetch spends the budget too.
 */
export function paymentPollInterval(
  payment: Pick<Payment, 'status' | 'cancelConfirmed'> | undefined,
  fetches: number,
): number | false {
  const open =
    payment !== undefined && (payment.status === 'pending' || isCancelUnconfirmed(payment));
  return open && fetches < PAYMENT_POLL_LIMIT ? PAYMENT_POLL_INTERVAL_MS : false;
}

/**
 * Every fetch of a query that has ended, answered or failed — the count the two polls budget by.
 * query-core adds nothing to `dataUpdateCount` for a failed fetch, so a budget of that alone
 * would never run out while the fetches keep failing: a 401 once the session expired (never
 * retried) or an outage would re-request every PAYMENT_POLL_INTERVAL_MS for as long as the tab
 * has focus.
 */
export function endedFetches(state: { dataUpdateCount: number; errorUpdateCount: number }): number {
  return state.dataUpdateCount + state.errorUpdateCount;
}

// ---- 결제 내역 --------------------------------------------------------------------------

/**
 * Why a payment that did not go through ended (`failed`, or `cancelled` after an approval we
 * could not credit) — a card refusal, a window error, the reason of a cancel — for the rows of
 * both lists. Anything else's `resultMessage` is the PG's "승인" and says nothing worth a line.
 * The admin list shows it for every such row; the payer's goes through paymentHistoryReason.
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
 * here two of them read otherwise. A `pending` payment nothing has claimed (no `providerRef`) is
 * a window that was opened and never completed — closed, abandoned, or still open in another
 * tab — and "처리 중" would claim the service is working on something it has not received.
 * Once the window hands back an authentication the payment is claimed, and "처리 중" is true.
 * And a `cancelled` one whose cancel is not confirmed (isCancelUnconfirmed) is 처리 중 too: the
 * card may still be charged, and "취소됨" would say it is not.
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
 * cancel is under way (`refunding`, 환불 처리 중), or a claimed `pending` payment — or a
 * `cancelled` one whose cancel is not confirmed (isCancelUnconfirmed) — shown 처리 중, that the
 * 재통보 or an admin's 수동 정리 still settles. An unclaimed `pending` one (미완료) only moves
 * when the payer comes back from the window, and that return reloads the wallet anyway;
 * polling for it would re-read the list on every visit of a member who once closed a window.
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
 * PAYMENT_POLL_LIMIT fetches — `paymentPollInterval`'s two minutes — so 환불 처리 중 turns into
 * 환불됨 on screen without a focus or a remount. The realtime `user:balance` restart cannot do it:
 * only the refund's claw-back moves P, and its finish publishes nothing (nor does a settle that
 * moves no P: 환불 완료, 취소 확인, 실패로 닫기).
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
 * Which refund button a row offers (ADR-0042 「관리자 환불」), or none:
 * - `refund`: `succeeded`, still inside the window. Whether the user has spent the P is the
 *   one condition the list cannot see (it has no balances); the API answers that one.
 * - `retry`: `refunding` — the P was clawed back and the card cancel is not confirmed: the PG's
 *   answer never came, or a refused retry, a taken-over first attempt or a partial cancel on
 *   record left it for 수동 정리 (`settle_required`). The window does not apply: the claw-back
 *   already happened inside it.
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

/**
 * The `message` of the first `details` entry whose path starts with `key` — a PG refusal carries
 * two (`gateway`: the PG's words, `payment`: `settle_required`), so position alone cannot say.
 */
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
  /** What to do next, and the PG's own words for a refusal it gave (`<ResultCode> <ResultMsg>`). */
  description?: string;
}

/**
 * The toast for a refused refund, by code and — where one code covers several cases — by the
 * detail the API names (payment-refund.service):
 * - INSUFFICIENT_BALANCE: the user has spent some of the P (owner decision 5: unused only).
 * - REFUND_NOT_ALLOWED: `window_closed`, `status` (already refunded, or never succeeded) or
 *   `provider` (nothing at the PG to cancel).
 * - PAYMENT_GATEWAY_REFUSED: the PG said no, and its answer (the `gateway` detail) is shown as
 *   it came. With a second detail, `payment: settle_required` — a refused retry, a first attempt
 *   a retry took over, a partial cancel on record — nothing was put back and the payment stays
 *   환불 처리 중 until an admin checks the card in the merchant admin and settles it (수동 정리),
 *   and the copy says exactly that. Without it the P taken back is restored only if the payment
 *   was still 환불 처리 중 by then (the same code answers when it was not, with nothing
 *   restored), so the copy claims neither and points to the list. (A refusal the PG's own cancel
 *   재통보 contradicts answers 200 `refunded`: the success it is.)
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
    const answer = detailAt(error, 'gateway');
    const said = answer === undefined ? undefined : `${copy.refundGatewayAnswer} ${answer}`;
    if (detailAt(error, 'payment') === 'settle_required') {
      return {
        title: copy.errRefundSettleRequired,
        description:
          said === undefined
            ? copy.errRefundSettleRequiredHint
            : `${copy.errRefundSettleRequiredHint} ${said}`,
      };
    }
    return said === undefined
      ? { title: copy.errRefundGatewayRefused }
      : { title: copy.errRefundGatewayRefused, description: said };
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

// ---- the admin 수동 정리 (settle) ------------------------------------------------------

/**
 * The outcomes `POST /admin/payments/:id/settle` takes from a payment as the list shows it, in
 * the order the dialog offers them — the API's own table (payment-settle.service
 * `transitionOf`), which refuses every other pair with REFUND_NOT_ALLOWED `status`:
 * - `pending`: `failed` always (never approved, or the window was abandoned); `credit` and
 *   `cancelled` too once it is claimed (`providerRef` set: an approval was asked for).
 * - `failed`: claimed only — `credit`, `cancelled`, or `failed` again (checked: it stays failed
 *   and drops its flag). An unclaimed one was never approved; there is nothing to settle.
 * - `cancelled`: claimed, while its net cancel is not confirmed — `credit` (the card was not
 *   cancelled after all) or `cancelled` (it was). The list cannot see the net cancel's outcome;
 *   for this status `needsReview` says exactly "no confirmed net cancel", which is what it has.
 * - `refunding`: `refunded` (the card cancel went through) or `restore` (it did not).
 * Only a SmartroPay payment is settled (the API refuses the rest with `provider`), so a mock row
 * gets none.
 */
export function settleOutcomesFor(
  payment: Pick<AdminPayment, 'provider' | 'status' | 'providerRef' | 'needsReview'>,
): readonly PaymentSettleOutcome[] {
  if (payment.provider !== 'smartro') return [];
  const claimed = payment.providerRef !== null;
  switch (payment.status) {
    case 'pending':
      return claimed ? ['credit', 'cancelled', 'failed'] : ['failed'];
    case 'failed':
      return claimed ? ['credit', 'cancelled', 'failed'] : [];
    case 'cancelled':
      return claimed && payment.needsReview ? ['credit', 'cancelled'] : [];
    case 'refunding':
      return ['refunded', 'restore'];
    default:
      return [];
  }
}

/**
 * Whether a row offers 수동 정리 — beside its refund button, never instead of it: a row the API
 * flagged (`needsReview`: it could not settle it by itself), or any `refunding` one. A refund the
 * PG refused on a retry answers `settle_required` at once, while the flag waits for the row to
 * be two minutes old; until then the API itself answers `in_progress`, which the dialog says.
 * Either way only with an outcome to offer (`settleOutcomesFor`) — never on a mock row.
 */
export function offersSettle(
  payment: Pick<AdminPayment, 'provider' | 'status' | 'providerRef' | 'needsReview'>,
): boolean {
  if (settleOutcomesFor(payment).length === 0) return false;
  return payment.needsReview || payment.status === 'refunding';
}

/** What each outcome is called in the dialog, and what choosing it does, in plain Korean. */
export const SETTLE_OUTCOME_VIEW: Readonly<
  Record<PaymentSettleOutcome, { label: string; description: string }>
> = {
  credit: { label: copy.adminPaymentSettleCredit, description: copy.adminPaymentSettleCreditHint },
  cancelled: {
    label: copy.adminPaymentSettleCancelled,
    description: copy.adminPaymentSettleCancelledHint,
  },
  failed: { label: copy.adminPaymentSettleFailed, description: copy.adminPaymentSettleFailedHint },
  refunded: {
    label: copy.adminPaymentSettleRefunded,
    description: copy.adminPaymentSettleRefundedHint,
  },
  restore: {
    label: copy.adminPaymentSettleRestore,
    description: copy.adminPaymentSettleRestoreHint,
  },
};

export type MerchantAdminMode = 'STG' | 'REAL';

/** SmartroPay's merchant admin (스마일비즈), where the operator looks the card up first. */
export const MERCHANT_ADMIN_URL: Readonly<Record<MerchantAdminMode, string>> = {
  STG: 'https://newbiz.smilebiz.co.kr',
  REAL: 'https://www.smilebiz.co.kr',
};

/**
 * The merchant admin(s) the settle dialog points to: the one of the deployment's SmartroPay mode
 * (`GET /payments/provider`), or both while that is unknown — not loaded, failed, or the mock
 * (whose rows are never settled, but the dialog must not guess).
 */
export function merchantAdminSites(
  info: PaymentProviderInfo | undefined,
): readonly { mode: MerchantAdminMode; url: string }[] {
  if (info?.provider === 'smartro')
    return [{ mode: info.mode, url: MERCHANT_ADMIN_URL[info.mode] }];
  return (['STG', 'REAL'] as const).map((mode) => ({ mode, url: MERCHANT_ADMIN_URL[mode] }));
}

/**
 * The payment's SmartroPay order number (Moid: its id without hyphens), which the merchant
 * admin searches by. Null for an id that is not a uuid — never from this API, but the dialog
 * must not throw on one.
 */
export function merchantOrderId(paymentId: string): string | null {
  try {
    return paymentIdToMoid(paymentId);
  } catch {
    return null;
  }
}

/** The approval Tid the API takes: printable ASCII, no spaces (`settlePaymentBodySchema`). */
const TID_SHAPE = /^[\x21-\x7e]+$/;

/**
 * The settle dialog's fields: the outcome (required — a radio, absent until chosen; the
 * `.optional().pipe` of `resolveMarketFormSchema`), the reason (required, as the API bounds it)
 * and the approval Tid. The Tid is read for `credit` only, and blank is allowed there: the API
 * needs it only when no SUCCESSFUL approval is on record (none came, or it answered a PG error
 * code), and says so naming `tid`. A Tid typed for `credit` and left behind by switching to
 * another outcome is not checked — it is not sent.
 */
export const settleFormSchema = z
  .object({
    outcome: z
      .enum(PAYMENT_SETTLE_OUTCOMES, copy.errSettleOutcome)
      .optional()
      .pipe(z.enum(PAYMENT_SETTLE_OUTCOMES, copy.errSettleOutcome)),
    tid: z.string().trim(),
    reason: z
      .string()
      .trim()
      .min(1, copy.errSettleReason)
      .max(REFUND_REASON_MAX_LENGTH, copy.errSettleReason),
  })
  .superRefine((values, ctx) => {
    if (values.outcome !== 'credit' || values.tid === '') return;
    if (values.tid.length > SETTLE_TID_MAX_LENGTH || !TID_SHAPE.test(values.tid)) {
      ctx.addIssue({ code: 'custom', path: ['tid'], message: copy.errSettleTid });
    }
  });
/** What the inputs hold: `outcome` is absent until a radio is chosen. */
export type SettleFormValues = z.input<typeof settleFormSchema>;
/** What the schema hands the submit handler: an outcome, always; trimmed strings. */
export type SettleFormOutput = z.output<typeof settleFormSchema>;

/**
 * The body for values `settleFormSchema` accepted. `tid` rides only on a credit, and only when
 * typed — never an empty string (the API refuses one), and never filled in from `providerRef`:
 * that is the authentication's Tid, which may differ from the approval's (the manual, STEP 4),
 * and storing the wrong one would make a later refund cancel nothing.
 */
export function toSettleBody(values: SettleFormOutput): SettlePaymentBody {
  return {
    outcome: values.outcome,
    reason: values.reason,
    ...(values.outcome === 'credit' && values.tid !== '' ? { tid: values.tid } : {}),
  };
}

export interface SettleErrorView {
  title: string;
  /** What to do about it, where the title alone does not say. */
  description?: string;
  /** The dialog field the refusal is about; shown under it instead of a toast. */
  field?: 'tid' | 'reason';
}

/**
 * What a refused settle says, by code and — for REFUND_NOT_ALLOWED — by the detail the API names
 * (payment-settle.service; `details[0].message`):
 * - `status`: the outcome is not one the payment's status allows (it moved since the list was
 *   read), or a cancel 재통보 on record says the card IS cancelled, which refuses `credit` and
 *   `restore` — the two are not told apart on the wire, so the hint names the second's remedy.
 * - `provider`: not a SmartroPay payment. `in_progress`: touched in the last two minutes.
 * - `approval_mismatch` (credit): no approval on record matches the payment's amount, MID and
 *   order, or the Tid typed differs from the recorded one or is another payment's already.
 * - `partial_cancel` (credit, restore): the PG reported a partial cancel; settle it `cancelled`
 *   or `refunded` and square the balance with 잔고 조정.
 * - VALIDATION_ERROR on `tid` (a credit with no successful approval on record needs one) or
 *   `reason` goes under its field. NOT_FOUND: the payment is gone.
 */
export function settleErrorView(error: unknown): SettleErrorView {
  if (isApiError(error, 'REFUND_NOT_ALLOWED')) {
    switch (detailMessage(error)) {
      case 'provider':
        return { title: copy.errSettleProvider };
      case 'in_progress':
        return { title: copy.errSettleInProgress };
      case 'approval_mismatch':
        return {
          title: copy.errSettleApprovalMismatch,
          description: copy.errSettleApprovalMismatchHint,
        };
      case 'partial_cancel':
        return { title: copy.errSettlePartialCancel, description: copy.errSettlePartialCancelHint };
      default:
        // `status`, or a case the web does not know yet: not settleable like this now.
        return { title: copy.errSettleStatus, description: copy.errSettleStatusHint };
    }
  }
  if (isApiError(error, 'NOT_FOUND')) return { title: copy.errRefundNotFound };
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'tid') return { title: copy.errSettleTidRequired, field: 'tid' };
    if (field === 'reason') return { title: copy.errSettleReason, field: 'reason' };
  }
  return { title: copy.errUnknown };
}

/**
 * Whether the settle dialog stays open after a refusal — `refundKeepsDialog`'s rule, plus the
 * refusals the admin answers in the dialog itself: a field (`tid`, `reason`), a Tid or an
 * outcome to change (`approval_mismatch`: re-check the Tid, or cancel the card and choose 취소
 * 확인; `partial_cancel`: choose 취소 확인 or 환불 완료), and `in_progress`, which asks for the
 * same request two minutes later. Everything else is a decision about the payment as it now is:
 * the list is refreshed and shows it.
 */
export function settleKeepsDialog(error: unknown): boolean {
  if (!isApiError(error)) return true;
  if (isApiError(error, 'VALIDATION_ERROR')) return true;
  if (!isApiError(error, 'REFUND_NOT_ALLOWED')) return false;
  const reason = detailMessage(error);
  return reason === 'in_progress' || reason === 'approval_mismatch' || reason === 'partial_cancel';
}
