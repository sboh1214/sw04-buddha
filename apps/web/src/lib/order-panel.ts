import {
  type MarketStatusRejectReason,
  type OrderSide,
  type Outcome,
  type TimeInForce,
  ORDER_BUDGET_MAX_COIN,
  ORDER_QTY_MAX,
  PRICE_MAX,
  PRICE_MIN,
  parseCoinAmount,
} from '@buddha/shared';
import {
  type ApiError,
  type Order,
  type OrderBook,
  type OrderBookLevel,
  type OrderQuote,
  type PlaceOrderBody,
  type QuoteOrderBody,
  isApiError,
  isForAnotherAccount,
} from './api';
import {
  INITIAL_ORDER_SHEET,
  type OrderSheetState,
  closeOrderSheet,
  openOrderSheet,
} from './market-detail';

/**
 * 주문 패널 (#66, ADR-0140): what the panel decides without React — the input and its checks, the
 * bodies of the quote and the order, the steps from 입력 to 결과 as a reducer, which line keeps 주문
 * 확인 off, and when the quote is read again. Pure, so the node runner tests it; the provider
 * (components/market/order-panel-provider.tsx) holds the state and does the requests.
 *
 * Money rules (ADR-0140 결정 2): the order's limit is the frozen quote's `protectedLimitPriceCoin`
 * and nothing else — never 99 or 1, never a quote the screen did not show — and a request id is
 * made once when 확인 opens and sent again only with the same body.
 */

// ---- input -------------------------------------------------------------------------------

/** 수량 or 금액: the size of an immediate buy (#177 3항). Every other order is a quantity. */
export type OrderSizeMode = 'qty' | 'budget';

/** What the panel's fields hold, as typed. Text, never a number: the checks below parse it. */
export interface OrderInput {
  outcome: Outcome;
  side: OrderSide;
  kind: TimeInForce;
  size: OrderSizeMode;
  qty: string;
  budget: string;
  limit: string;
}

export function initialOrderInput(outcome: Outcome = 'YES'): OrderInput {
  return { outcome, side: 'buy', kind: 'ioc', size: 'qty', qty: '', budget: '', limit: '' };
}

/** Whether the input is a budget order: an immediate buy with 금액 chosen. */
export function isBudgetInput(input: Pick<OrderInput, 'side' | 'kind' | 'size'>): boolean {
  return input.side === 'buy' && input.kind === 'ioc' && input.size === 'budget';
}

/**
 * A field's text as digits, or null: spaces and the grouping commas a reader may type are
 * dropped in this one place, and what is left must be digits alone — '1e3', '1.5', '-1' and
 * '' are null. Leading zeros stay for the caller to read away ("0100" is 100).
 */
export function digitsOf(text: string): string | null {
  const stripped = text.replace(/[\s,]/g, '');
  return /^\d+$/.test(stripped) ? stripped : null;
}

/** The terms an input names once it is whole and in range: a quote's and an order's. */
export interface OrderTerms {
  outcome: Outcome;
  side: OrderSide;
  timeInForce: TimeInForce;
  /** 1..ORDER_QTY_MAX, unless a budget. */
  qty?: number;
  /** A decimal string of 1..ORDER_BUDGET_MAX_COIN Coin, with no leading zeros. */
  budgetCoin?: string;
  /** A GTC order's own limit, 1..99; absent for an immediate one (the quote narrows 99 or 1). */
  limitPriceCoin?: number;
}

export type OrderField = 'qty' | 'budget' | 'limit';

/** Why a field holds no term: still empty (no message), not digits, or out of range. */
export type FieldProblem = 'empty' | 'digits' | 'range';

export type TermsCheck =
  | { ok: true; terms: OrderTerms }
  | { ok: false; problems: Partial<Record<OrderField, FieldProblem>> };

function wholeIn(text: string, min: bigint, max: bigint): bigint | FieldProblem {
  if (text.trim() === '') return 'empty';
  const digits = digitsOf(text);
  if (digits === null) return 'digits';
  const value = BigInt(digits);
  return value < min || value > max ? 'range' : value;
}

/**
 * The input's terms, or the problem of each field that holds none. Only the fields the order
 * uses are read: a budget for an immediate buy with 금액, a quantity otherwise, a limit for GTC.
 * A sell's quantity is checked against ORDER_QTY_MAX here; the holding is `orderBlock`'s.
 */
export function orderTermsOf(input: OrderInput): TermsCheck {
  const problems: Partial<Record<OrderField, FieldProblem>> = {};
  const terms: OrderTerms = { outcome: input.outcome, side: input.side, timeInForce: input.kind };
  if (isBudgetInput(input)) {
    const budget = wholeIn(input.budget, 1n, ORDER_BUDGET_MAX_COIN);
    if (typeof budget === 'bigint') terms.budgetCoin = budget.toString();
    else problems.budget = budget;
  } else {
    const qty = wholeIn(input.qty, 1n, BigInt(ORDER_QTY_MAX));
    if (typeof qty === 'bigint') terms.qty = Number(qty);
    else problems.qty = qty;
  }
  if (input.kind === 'gtc') {
    const limit = wholeIn(input.limit, BigInt(PRICE_MIN), BigInt(PRICE_MAX));
    if (typeof limit === 'bigint') terms.limitPriceCoin = Number(limit);
    else problems.limit = limit;
  }
  return Object.keys(problems).length === 0 ? { ok: true, terms } : { ok: false, problems };
}

/** Whether two terms name the same order. */
export function sameTerms(a: OrderTerms, b: OrderTerms): boolean {
  return (
    a.outcome === b.outcome &&
    a.side === b.side &&
    a.timeInForce === b.timeInForce &&
    a.qty === b.qty &&
    a.budgetCoin === b.budgetCoin &&
    a.limitPriceCoin === b.limitPriceCoin
  );
}

/**
 * `POST /markets/:id/quote`'s body: the terms, no account and no request id (the schema is strict).
 * An immediate order sends no limit, so the server starts at 99 or 1 and narrows it by the market's
 * 가격 보호 as the intake would; a GTC order sends its own.
 */
export function quoteBodyOf(terms: OrderTerms): QuoteOrderBody {
  const body: QuoteOrderBody = {
    outcome: terms.outcome,
    side: terms.side,
    timeInForce: terms.timeInForce,
  };
  if (terms.qty !== undefined) body.qty = terms.qty;
  if (terms.budgetCoin !== undefined) body.budgetCoin = terms.budgetCoin;
  if (terms.timeInForce === 'gtc') body.limitPriceCoin = terms.limitPriceCoin;
  return body;
}

/** The terms and the quote 확인 shows, frozen together, and when the quote answered (ms). */
export interface FrozenQuote {
  terms: OrderTerms;
  quote: OrderQuote;
  quotedAt: number;
}

/** A quote no order may be sent on: refused for a reason, or an immediate one filling nothing. */
export function quoteRefused(terms: Pick<OrderTerms, 'timeInForce'>, quote: OrderQuote): boolean {
  return quote.rejectReason !== null || (terms.timeInForce === 'ioc' && quote.filledQty === 0);
}

/**
 * `POST /markets/:id/orders`'s body, from the frozen terms and quote alone — never the fields as
 * they are now. The limit is the quote's `protectedLimitPriceCoin`, the 최대 매수 단가 or 최소 매도
 * 단가 확인 showed (a GTC quote's is the order's own): never wider than what was shown. A refused
 * quote throws: its limit is the 99 or 1 it was asked with (`order-book.ts`), so this is the last
 * lock behind the screen's.
 */
export function placeBodyOf(frozen: FrozenQuote, expectedAccountId: string): PlaceOrderBody {
  if (quoteRefused(frozen.terms, frozen.quote)) {
    throw new Error('A refused quote cannot be sent as an order');
  }
  const body: PlaceOrderBody = {
    outcome: frozen.terms.outcome,
    side: frozen.terms.side,
    timeInForce: frozen.terms.timeInForce,
    limitPriceCoin: frozen.quote.protectedLimitPriceCoin,
    expectedAccountId,
  };
  if (frozen.terms.qty !== undefined) body.qty = frozen.terms.qty;
  if (frozen.terms.budgetCoin !== undefined) body.budgetCoin = frozen.terms.budgetCoin;
  return body;
}

// ---- requests ------------------------------------------------------------------------------

/**
 * One order request this tab sent and has no settled answer for (lib/order-requests.ts keeps it):
 * the id, the body as sent, when, and whether it went once (`first`) or its answer was lost
 * (`unknown`). The same id goes again only with this body.
 *
 * `sendId` names the one POST that keeps it: 주문 제출 and each '같은 요청 다시 보내기' make a new
 * one while the request id stays. A send that outlives its page (left and come back to) can end
 * after the same id went again, and only the send the slot names settles it (ADR-0140 결정 2-5).
 */
export interface PendingOrderRequest {
  requestId: string;
  sendId: string;
  body: PlaceOrderBody;
  savedAt: number;
  phase: 'first' | 'unknown';
}

/** A refusal that writes no row, as the panel words it (lib/order-reasons.ts). */
export interface OrderFailure {
  code: string;
  /** RATE_LIMITED's wait. */
  retryAfterSeconds?: number;
  /** RESTRICTED's end, null for none. */
  restrictedEndsAt?: string | null;
  /** FORBIDDEN for the account on screen not being the cookie's. */
  anotherAccount?: boolean;
  /** ORDER_INTAKE_CLOSED for a market with no 가격 보호 폭 (its IOC only). */
  noWidth?: boolean;
}

/**
 * Whether a kept or shown request was sent by `accountId` (its body's `expectedAccountId`): only
 * then may the account on screen read it back, send it again or drop it. Another account's
 * request stays in its own slot for that account's return (ADR-0140 결정 2-22).
 */
export function requestOwnedBy(
  request: Pick<PendingOrderRequest, 'body'>,
  accountId: string | undefined,
): boolean {
  return accountId !== undefined && request.body.expectedAccountId === accountId;
}

/**
 * Whether the account the panel's state belongs to (`held`) is gone from the screen (`now`): a
 * signed-in account (a string) followed by another one or by no one (null). `undefined` is not
 * known yet — the session or `me` still answering — and changes nothing; a visitor (null) who
 * signs in keeps what was typed, as D3 does (ADR-0140 결정 2-22).
 */
export function panelOwnerChanged(
  held: string | null | undefined,
  now: string | null | undefined,
): boolean {
  return typeof held === 'string' && now !== undefined && now !== held;
}

/**
 * Whether no one on screen (`held` null, a visitor) turned into a signed-in account (`now`): the
 * sign-in that 로그인 안내 asked for, here or in another tab. It ends that step whether or not a
 * draft comes back (D3·D4): what was typed stays, and nothing is sent (ADR-0140 결정 2-12).
 */
export function panelSignedIn(
  held: string | null | undefined,
  now: string | null | undefined,
): boolean {
  return held === null && typeof now === 'string';
}

/**
 * Who holds the 주문 제출 lock (결정 2-4): the account and the request it was taken for. A lock is
 * the account's own — another account's request still waiting for its answer (an account switch
 * in another tab) keeps nothing locked for the account now on screen — and it is let go only by
 * the request that took it, never by an older one's late `finally`.
 */
export interface SendLock {
  account: string;
  requestId: string;
}

/** Whether `lock` keeps `accountId` from sending now. */
export function sendLocked(lock: SendLock | null, accountId: string): boolean {
  return lock !== null && lock.account === accountId;
}

/** The lock once `requestId`'s send has ended: let go only if that request holds it. */
export function sendUnlocked(lock: SendLock | null, requestId: string): SendLock | null {
  return lock !== null && lock.requestId === requestId ? null : lock;
}

/**
 * The panel's account reads for a member (결정 2-11·2-21): `ready` once `me` has answered and the
 * restriction has answered or failed (a failed restriction holds nothing: the server refuses for
 * it anyway); `failed` when `GET /me` failed without ever answering and is not being asked again
 * — said with 다시 시도, never a skeleton for good; `pending` otherwise. A visitor's is `ready`.
 */
export function accountReadView(facts: {
  member: boolean;
  meAnswered: boolean;
  meFailed: boolean;
  meFetching: boolean;
  restrictionSettled: boolean;
}): 'pending' | 'failed' | 'ready' {
  if (!facts.member) return 'ready';
  if (facts.meAnswered) return facts.restrictionSettled ? 'ready' : 'pending';
  return facts.meFailed && !facts.meFetching ? 'failed' : 'pending';
}

export type PlaceOutcome =
  /** No row, and so said: the request is settled and its id dropped. */
  | { next: 'failed'; failure: OrderFailure }
  /** Unknown: read the id back (`GET /me/orders/request/:id`), keeping it. */
  | { next: 'recover' }
  /** The id names an order with other terms: read it back and show it. */
  | { next: 'lookup' };

export function failureOf(error: ApiError): OrderFailure {
  const failure: OrderFailure = { code: error.code };
  const details: unknown = error.details;
  if (error.code === 'RATE_LIMITED' && typeof details === 'object' && details !== null) {
    const seconds = (details as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    if (typeof seconds === 'number') failure.retryAfterSeconds = seconds;
  }
  if (error.code === 'RESTRICTED' && typeof details === 'object' && details !== null) {
    const endsAt = (details as { endsAt?: unknown }).endsAt;
    failure.restrictedEndsAt = typeof endsAt === 'string' ? endsAt : null;
  }
  if (isForAnotherAccount(error)) failure.anotherAccount = true;
  if (error.code === 'ORDER_INTAKE_CLOSED' && noWidthRefusal(error)) failure.noWidth = true;
  return failure;
}

/** ORDER_INTAKE_CLOSED with `priceProtection` named: a market with no width refuses its IOC. */
export function noWidthRefusal(error: unknown): boolean {
  if (!isApiError(error, 'ORDER_INTAKE_CLOSED') || !Array.isArray(error.details)) return false;
  const first: unknown = error.details[0];
  if (typeof first !== 'object' || first === null) return false;
  const path: unknown = (first as { path?: unknown }).path;
  return Array.isArray(path) && path[0] === 'priceProtection';
}

/**
 * What to do with a `POST /orders` that did not answer 200, by what it was and whether the
 * request went for the first time (`phase`; ADR-0140 결정 2-5). An answer that never came, a 5xx,
 * and any answer without the API's envelope (a proxy's or gateway's 408 or 499 as much as its
 * 502: the request may have reached the API before it was cut) are unknown. A DUPLICATE_REQUEST
 * says the id already names an order. Closed intake and NOT_FOUND come after the replay check
 * (`db/orders.ts`), so they settle the request either way. Every other refusal settles a first
 * send only: the guards' 401, Origin 403, onboarding and rate limit, and a restriction and an
 * admin in the transaction, are answered before the id is looked at, so after a lost answer they
 * do not say no order was made.
 */
export function placeOutcomeOf(error: unknown, phase: PendingOrderRequest['phase']): PlaceOutcome {
  if (!isApiError(error) || !error.enveloped || error.status >= 500) {
    return { next: 'recover' };
  }
  if (error.code === 'DUPLICATE_REQUEST') return { next: 'lookup' };
  if (error.code === 'ORDER_INTAKE_CLOSED' || error.code === 'NOT_FOUND') {
    return { next: 'failed', failure: failureOf(error) };
  }
  if (phase === 'unknown') return { next: 'recover' };
  return { next: 'failed', failure: failureOf(error) };
}

/** Which of the account's reads a refusal says is out of date (`authRefreshOf`). */
export interface AuthRefresh {
  /** The session: it ran out (401) or the cookie is another account's (403 `expectedAccountId`). */
  session: boolean;
  /** `me`: another account's cookie, the onboarding gate, or an admin's FORBIDDEN (D13). */
  me: boolean;
}

/**
 * What a refusal says of the session behind it, whatever it says of the order (ADR-0140 결정
 * 2-5·2-22): read again on a first send's settled refusal and on a resend's unknown one alike —
 * a resend refused for a run-out session or another account's cookie is still unknown, and its
 * read-back must not ask `/me/orders/request/:id` with that cookie — and on a read-back's own
 * refusal (order-recovery.tsx). Not an envelope of the API's: nothing.
 */
export function authRefreshOf(error: unknown): AuthRefresh {
  if (!isApiError(error) || !error.enveloped) return { session: false, me: false };
  if (error.code === 'UNAUTHENTICATED') return { session: true, me: false };
  if (isForAnotherAccount(error)) return { session: true, me: true };
  if (error.code === 'ONBOARDING_REQUIRED' || error.code === 'FORBIDDEN') {
    return { session: false, me: true };
  }
  return { session: false, me: false };
}

// ---- the steps ------------------------------------------------------------------------------

/**
 * The panel's steps (ADR-0140 결정 2-2): 입력 (`editing`, the quote is a query beside it), the
 * visitor's 로그인 안내 (`signIn`), 확인 with the frozen quote and its request id, 접수 중, the
 * read-back of a lost answer (`recovering`, `exhausted` after three failed reads), the card of a
 * request not found (`unsent`), and the end: the server's order or a refusal with no row.
 */
export type OrderStep =
  | { name: 'editing' }
  | { name: 'signIn' }
  | {
      name: 'confirm';
      frozen: FrozenQuote;
      requestId: string;
      /** The `Me` 확인 opened for: the body's `expectedAccountId`, never the `me` of the press. */
      accountId: string;
      /** The token of a 다시 견적 in flight; 주문 제출 is off while it runs. */
      requote: string | null;
      requoteFailed: boolean;
      /**
       * The chosen side of the first book read that answered after the quote (D7's baseline), or
       * null until one has; a later read that differs sets `bookChanged`.
       */
      baseline: readonly OrderBookLevel[] | null;
      bookChanged: boolean;
    }
  | { name: 'submitting'; request: PendingOrderRequest }
  | { name: 'recovering'; request: PendingOrderRequest; attempt: string; exhausted: boolean }
  | { name: 'unsent'; request: PendingOrderRequest }
  | { name: 'result'; order: Order; replayed: boolean }
  | { name: 'failed'; failure: OrderFailure };

export interface OrderPanelState {
  input: OrderInput;
  step: OrderStep;
  /** Set by a restore, so the panel says '입력한 주문을 되살렸습니다' until the next edit. */
  restored: boolean;
  /** The mobile sheet below md (`OrderSheetState`): open, and the contract it was opened on. */
  sheet: OrderSheetState;
  /**
   * The step after this one follows a press in this tab (주문 제출, 같은 요청 다시 보내기, 다시
   * 확인), so its card takes the focus; a read-back a page load started does not (결정 2-19).
   */
  outcomeFocus: boolean;
}

export const INITIAL_ORDER_PANEL: OrderPanelState = {
  input: initialOrderInput(),
  step: { name: 'editing' },
  restored: false,
  sheet: INITIAL_ORDER_SHEET,
  outcomeFocus: false,
};

export type OrderAction =
  | { type: 'edit'; patch: Partial<OrderInput> }
  | { type: 'openSheet'; outcome: Outcome }
  /**
   * The sell entry of a holding (#67, ADR-0142; ADR-0135 F6): the contract and 매도 chosen, below
   * md in the sheet (`sheet`), from md up in the column.
   */
  | { type: 'openSell'; outcome: Outcome; sheet: boolean }
  | { type: 'closeSheet' }
  | { type: 'restore'; input: OrderInput; openSheet: boolean }
  | { type: 'signIn' }
  /** The sign-in 로그인 안내 asked for came (`panelSignedIn`). */
  | { type: 'signedIn' }
  | { type: 'openConfirm'; frozen: FrozenQuote; requestId: string; accountId: string }
  | { type: 'back' }
  | { type: 'requoteStart'; token: string }
  | { type: 'requoteDone'; token: string; frozen: FrozenQuote; requestId: string }
  | { type: 'requoteFailed'; token: string }
  | { type: 'requoteRefused'; token: string }
  | { type: 'baseline'; requestId: string; levels: readonly OrderBookLevel[] }
  | { type: 'bookChanged'; requestId: string }
  | { type: 'submit'; request: PendingOrderRequest }
  | { type: 'placed'; requestId: string; order: Order; replayed: boolean }
  | { type: 'placeFailed'; requestId: string; outcome: PlaceOutcome; attempt: string }
  | { type: 'recoverStart'; request: PendingOrderRequest; attempt: string }
  | { type: 'recovered'; attempt: string; order: Order }
  | { type: 'recoverMissed'; attempt: string }
  | { type: 'recoverExhausted'; attempt: string }
  | { type: 'recheck'; attempt: string }
  | { type: 'resend'; request: PendingOrderRequest }
  | { type: 'discard' }
  | { type: 'newOrder' }
  | { type: 'areaGone' }
  /** `to`: the account now on screen, null for none (`panelOwnerChanged`). */
  | { type: 'accountChanged'; to: string | null };

/** Steps that hold a request in flight or unsettled: no edit, contract change or new order. */
export function stepBusy(step: OrderStep): boolean {
  return step.name === 'submitting' || step.name === 'recovering' || step.name === 'unsent';
}

/** The request id the step is waiting on, if any. */
function waitingId(step: OrderStep): string | null {
  return step.name === 'submitting' || step.name === 'recovering' || step.name === 'unsent'
    ? step.request.requestId
    : null;
}

/**
 * The panel's reducer. Ids and tokens come in on the actions (`crypto.randomUUID()` outside), so it
 * stays pure. An answer for a step that is no longer the one it was sent from is dropped: a late
 * quote after 수정, a late refusal after a success.
 */
export function orderPanelReducer(state: OrderPanelState, action: OrderAction): OrderPanelState {
  const { step } = state;
  switch (action.type) {
    case 'edit':
      if (stepBusy(step) || step.name === 'confirm') return state;
      return {
        ...state,
        input: { ...state.input, ...action.patch },
        step: step.name === 'editing' ? step : { name: 'editing' },
        restored: false,
      };
    case 'openSheet': {
      // A press of 'YES 매수' or 'NO 매수': the sheet opens on that contract and buy (the bar's
      // two buttons are buys); a request in flight keeps its terms.
      const sheet = openOrderSheet(action.outcome);
      if (stepBusy(step)) return { ...state, sheet };
      return {
        ...state,
        sheet,
        input: { ...state.input, outcome: action.outcome, side: 'buy' },
        step: step.name === 'result' || step.name === 'failed' ? step : { name: 'editing' },
      };
    }
    case 'openSell': {
      // A holding's '매도' (F6): `openSheet`'s rules with the direction sell — a request in flight
      // keeps its terms and only the sheet opens; 확인 goes back to 입력 on the new choice; a
      // result or a failure stays on screen. The quantity is not filled in: the owner chose the
      // contract and the direction, nothing more.
      const sheet = action.sheet ? openOrderSheet(action.outcome) : state.sheet;
      if (stepBusy(step)) return { ...state, sheet };
      return {
        ...state,
        sheet,
        input: { ...state.input, outcome: action.outcome, side: 'sell' },
        step: step.name === 'result' || step.name === 'failed' ? step : { name: 'editing' },
      };
    }
    case 'closeSheet':
      return state.sheet.open ? { ...state, sheet: closeOrderSheet(state.sheet) } : state;
    case 'restore':
      if (stepBusy(step)) return state;
      return {
        input: action.input,
        step: { name: 'editing' },
        restored: true,
        sheet: action.openSheet ? openOrderSheet(action.input.outcome) : state.sheet,
        outcomeFocus: false,
      };
    case 'signIn':
      return step.name === 'editing' ? { ...state, step: { name: 'signIn' } } : state;
    case 'signedIn':
      // Back to 입력 with what was typed, a draft or none (D3·D4): nothing goes by itself.
      return step.name === 'signIn' ? { ...state, step: { name: 'editing' } } : state;
    case 'openConfirm':
      if (step.name !== 'editing') return state;
      return {
        ...state,
        restored: false,
        step: {
          name: 'confirm',
          frozen: action.frozen,
          requestId: action.requestId,
          accountId: action.accountId,
          requote: null,
          requoteFailed: false,
          baseline: null,
          bookChanged: false,
        },
      };
    case 'back':
      // 수정: the id that was never sent goes with the frozen quote.
      return step.name === 'confirm' || step.name === 'signIn'
        ? { ...state, step: { name: 'editing' } }
        : state;
    case 'requoteStart':
      if (step.name !== 'confirm') return state;
      return { ...state, step: { ...step, requote: action.token, requoteFailed: false } };
    case 'requoteDone':
      if (step.name !== 'confirm' || step.requote !== action.token) return state;
      // A new quote is a new confirmation: a fresh id, so no id is ever sent with two bodies.
      return {
        ...state,
        step: {
          ...step,
          frozen: action.frozen,
          requestId: action.requestId,
          requote: null,
          requoteFailed: false,
          baseline: null,
          bookChanged: false,
        },
      };
    case 'requoteFailed':
      if (step.name !== 'confirm' || step.requote !== action.token) return state;
      return { ...state, step: { ...step, requote: null, requoteFailed: true } };
    case 'requoteRefused':
      // 다시 견적 answered with a quote nothing can be sent on: back to 입력, where its line says
      // why — only from the 확인 that asked, never a 확인 opened since (a late answer).
      if (step.name !== 'confirm' || step.requote !== action.token) return state;
      return { ...state, step: { name: 'editing' } };
    case 'baseline':
      if (step.name !== 'confirm' || step.requestId !== action.requestId) return state;
      if (step.baseline !== null) return state;
      return { ...state, step: { ...step, baseline: action.levels } };
    case 'bookChanged':
      if (step.name !== 'confirm' || step.requestId !== action.requestId) return state;
      if (step.bookChanged) return state;
      return { ...state, step: { ...step, bookChanged: true } };
    case 'submit':
      if (step.name !== 'confirm' || step.requestId !== action.request.requestId) return state;
      return {
        ...state,
        step: { name: 'submitting', request: action.request },
        outcomeFocus: true,
      };
    case 'placed':
      if (waitingId(step) !== action.requestId) return state;
      return { ...state, step: { name: 'result', order: action.order, replayed: action.replayed } };
    case 'placeFailed': {
      if (step.name !== 'submitting' || step.request.requestId !== action.requestId) return state;
      const { outcome } = action;
      if (outcome.next === 'failed') {
        if (outcome.failure.code === 'UNAUTHENTICATED')
          return { ...state, step: { name: 'signIn' } };
        // Another account's cookie: nothing typed for this screen is handed to that account.
        const input = outcome.failure.anotherAccount
          ? initialOrderInput(state.input.outcome)
          : state.input;
        return { ...state, input, step: { name: 'failed', failure: outcome.failure } };
      }
      const request: PendingOrderRequest = { ...step.request, phase: 'unknown' };
      return {
        ...state,
        step: { name: 'recovering', request, attempt: action.attempt, exhausted: false },
      };
    }
    case 'recoverStart':
      if (stepBusy(step) && waitingId(step) !== action.request.requestId) return state;
      return {
        ...state,
        outcomeFocus: false,
        step: {
          name: 'recovering',
          request: action.request,
          attempt: action.attempt,
          exhausted: false,
        },
      };
    case 'recovered':
      if (step.name !== 'recovering' || step.attempt !== action.attempt) return state;
      return { ...state, step: { name: 'result', order: action.order, replayed: true } };
    case 'recoverMissed':
      if (step.name !== 'recovering' || step.attempt !== action.attempt) return state;
      return { ...state, step: { name: 'unsent', request: step.request } };
    case 'recoverExhausted':
      if (step.name !== 'recovering' || step.attempt !== action.attempt) return state;
      return { ...state, step: { ...step, exhausted: true } };
    case 'recheck':
      if (step.name !== 'recovering' || !step.exhausted) return state;
      return {
        ...state,
        step: { ...step, attempt: action.attempt, exhausted: false },
        outcomeFocus: true,
      };
    case 'resend':
      // 같은 요청 다시 보내기: the same id and the same body, as an unknown answer's retry — and a
      // send of its own (`sendId`), which the step holds from here.
      if (step.name !== 'unsent' || step.request.requestId !== action.request.requestId) {
        return state;
      }
      return {
        ...state,
        step: { name: 'submitting', request: action.request },
        outcomeFocus: true,
      };
    case 'discard':
      // '버리기' on the card; and the read-back's own end where no panel can offer 다시 확인
      // (order-recovery.tsx), an exhausted read-back too.
      return step.name === 'unsent' || (step.name === 'recovering' && step.exhausted)
        ? { ...state, step: { name: 'editing' } }
        : state;
    case 'newOrder':
      return step.name === 'result' || step.name === 'failed'
        ? { ...state, step: { name: 'editing' } }
        : state;
    case 'areaGone':
      // The market stopped taking orders under the panel: what was typed or frozen goes; a
      // request in flight is the recovery's to finish (order-recovery.tsx).
      if (stepBusy(step)) return { ...state, sheet: closeOrderSheet(state.sheet) };
      return {
        ...INITIAL_ORDER_PANEL,
        input: initialOrderInput(state.input.outcome),
        sheet: closeOrderSheet(state.sheet),
      };
    case 'accountChanged':
      // A session that ran out under 로그인 안내 — a 401 at 주문 제출 (`placeFailed`), whose refetch
      // then finds no one: the prompt stays, with what was typed, which `send` already kept as the
      // draft the sign-in brings back (D3). Nothing else of the account is in that step — no
      // frozen quote, request or result — and its flags go; another account gets none of it.
      if (action.to === null && step.name === 'signIn') {
        return { ...INITIAL_ORDER_PANEL, input: state.input, step, sheet: state.sheet };
      }
      // Another account (or none) on screen (`panelOwnerChanged`): nothing typed, frozen, sent or
      // ended for the one before is shown to it or sent in its name. A request in flight stays in
      // its sender's slot (order-requests.ts) and its late answer finds no step to land in.
      return { ...INITIAL_ORDER_PANEL, sheet: closeOrderSheet(state.sheet) };
  }
}

// ---- what keeps 주문 확인 off ----------------------------------------------------------------

/**
 * Why 주문 확인 is off, in the order they are told (ADR-0140 결정 2-9): an account that may not
 * order (D13), a market with no 가격 보호 폭 for an IOC (ADR-0135 결과 4), then the quote's own
 * reason — 금액 부족, 호가 없음 (D9), 가격 한도 — and last a sell over the holding (D11). The
 * window between close and the worker's close is the caller's, ahead of all of these.
 */
export type OrderBlockReason =
  | 'admin'
  | 'restricted'
  | 'no_width'
  | 'budget_too_small'
  | 'no_quote'
  | 'price_limit'
  | 'self_trade'
  | 'sell_none'
  | 'insufficient_contracts';

export interface OrderBlockFacts {
  input: OrderInput;
  /** The quote for the input as it is, if one has answered. */
  quote: OrderQuote | undefined;
  /** The quote was refused because the market has no 가격 보호 폭. */
  noWidth: boolean;
  /** The best price the chosen side meets, before a quote has answered (D9). */
  bestOpposite: number | null | undefined;
  /** D13, from `me` and the restriction. */
  account: 'admin' | 'restricted' | null;
  /** The chosen contract's unlocked holding, for a member; undefined for a visitor or unknown. */
  unlockedQty: number | undefined;
}

/** Why an immediate quote's walk stopped short, by the name the screens give it. */
export type QuoteStopReason = 'no_quote' | 'price_limit' | 'self_trade';

/**
 * Why an immediate quote filled less than asked (#67, ADR-0142; out of `orderBlock`, ADR-0140 D9):
 * the quote's refusal when it names 가격 한도 or 자기 체결, else the walk's stop — `price_limit` or
 * `self_trade` (a partial fill that met the holder's own bid is 취소 with no refusal) — and
 * 호가 없음 for every other. The panel's 주문 확인 line and MY's 매도 가능 cell read the same quote
 * through this one mapping, so they never say two things of it.
 */
export function quoteStopReason(quote: Pick<OrderQuote, 'rejectReason' | 'stop'>): QuoteStopReason {
  if (quote.rejectReason === 'price_limit' || quote.rejectReason === 'self_trade') {
    return quote.rejectReason;
  }
  if (quote.stop === 'price_limit' || quote.stop === 'self_trade') return quote.stop;
  return 'no_quote';
}

export function orderBlock(facts: OrderBlockFacts): OrderBlockReason | null {
  const { input, quote } = facts;
  if (facts.account !== null) return facts.account;
  if (input.kind === 'ioc' && facts.noWidth) return 'no_width';
  if (input.kind === 'ioc') {
    if (quote === undefined) {
      // Before a quote: the side's best alone says 호가 없음 (D9). Never budget ÷ price.
      if (facts.bestOpposite === null) return 'no_quote';
    } else if (quote.filledQty === 0) {
      // An immediate quote that fills nothing keeps 확인 off whatever its reason (D9).
      if (quote.rejectReason === 'budget_too_small') return 'budget_too_small';
      return quoteStopReason(quote);
    }
  }
  if (input.side === 'sell' && facts.unlockedQty !== undefined) {
    if (facts.unlockedQty === 0) return 'sell_none';
    const qty = digitsOf(input.qty);
    if (qty !== null && BigInt(qty) > BigInt(facts.unlockedQty)) return 'insufficient_contracts';
  }
  return null;
}

/** The reasons a block offers '지정가로 바꾸기' with. */
export function blockOffersGtc(reason: OrderBlockReason | null): boolean {
  return reason === 'no_quote' || reason === 'price_limit' || reason === 'no_width';
}

/**
 * A buy whose whole lock (`maxSpendCoin`) is above the available Coin: told, never blocked — the
 * balance may be behind another tab's lock, and the server decides (ADR-0112). Null otherwise.
 */
export function coinShortfall(
  quote: OrderQuote | undefined,
  availableCoin: string | undefined,
): { availableCoin: bigint; needCoin: bigint } | null {
  if (quote?.maxSpendCoin == null || availableCoin === undefined) return null;
  const need = parseCoinAmount(quote.maxSpendCoin);
  const available = parseCoinAmount(availableCoin);
  return need > available ? { availableCoin: available, needCoin: need } : null;
}

/** A quote refused for the market's state (closed, paused, not open): the input-closed line. */
export function quoteStatusReason(quote: OrderQuote | undefined): MarketStatusRejectReason | null {
  switch (quote?.rejectReason) {
    case 'not_open_yet':
    case 'paused':
    case 'closed':
      return quote.rejectReason;
    default:
      return null;
  }
}

// ---- a holding's sell entry (#67) -------------------------------------------------------------

/** The query a holding's '매도' in MY opens the market's detail with (ADR-0142, F6). */
export const SELL_INTENT_PARAMS = { order: 'order', contract: 'contract' } as const;

/** `?order=sell&contract=yes|no`: the detail's address for a holding's '매도' (F6). */
export function sellIntentQuery(outcome: Outcome): string {
  const contract = outcome === 'YES' ? 'yes' : 'no';
  return `${SELL_INTENT_PARAMS.order}=sell&${SELL_INTENT_PARAMS.contract}=${contract}`;
}

/**
 * The contract a detail's address asks to sell (`?order=sell&contract=yes|no`), or null: either
 * word in any case, nothing else — a missing or unknown contract, another order or a repeated
 * parameter is no intent. Read once when the panel mounts; the page itself never reads it, so the
 * server's HTML is the same with it or without (ADR-0142).
 */
export function parseSellIntent(params: Pick<URLSearchParams, 'getAll'>): Outcome | null {
  const orders = params.getAll(SELL_INTENT_PARAMS.order);
  const contracts = params.getAll(SELL_INTENT_PARAMS.contract);
  if (orders.length !== 1 || contracts.length !== 1) return null;
  if (orders[0]?.toLowerCase() !== 'sell') return null;
  const contract = contracts[0]?.toLowerCase();
  if (contract === 'yes') return 'YES';
  if (contract === 'no') return 'NO';
  return null;
}

/**
 * The address with the sell intent taken out, the rest of the query and the hash kept: what the
 * panel writes in place once it has read the intent, so a reload or a back does not open it again.
 */
export function withoutSellIntent(pathname: string, search: string, hash = ''): string {
  const params = new URLSearchParams(search);
  params.delete(SELL_INTENT_PARAMS.order);
  params.delete(SELL_INTENT_PARAMS.contract);
  const rest = params.toString();
  return `${pathname}${rest === '' ? '' : `?${rest}`}${hash}`;
}

// ---- the book beside the panel ----------------------------------------------------------------

/** The book side a choice meets: a buy the asks, a sell the bids. */
export function bookSideOf(
  book: OrderBook | undefined,
  outcome: Outcome,
  side: OrderSide,
): readonly OrderBookLevel[] | undefined {
  const contract = book?.contracts.find((c) => c.outcome === outcome);
  if (contract === undefined) return undefined;
  return side === 'buy' ? contract.asks : contract.bids;
}

/** The best price a choice meets (D2): a buy's best ask, a sell's best bid, null for none. */
export function bestPriceOf(
  book: OrderBook | undefined,
  outcome: Outcome,
  side: OrderSide,
): number | null | undefined {
  const contract = book?.contracts.find((c) => c.outcome === outcome);
  if (contract === undefined) return undefined;
  return side === 'buy' ? contract.bestAskCoin : contract.bestBidCoin;
}

/** Whether one side's levels differ, price by price and quantity by quantity (D7). */
export function bookSideChanged(
  before: readonly OrderBookLevel[],
  after: readonly OrderBookLevel[],
): boolean {
  if (before.length !== after.length) return true;
  return before.some(
    (level, i) => level.priceCoin !== after[i]?.priceCoin || level.qty !== after[i]?.qty,
  );
}

/**
 * Whether 입력's chosen side moved since its quote was asked (결정 2-13, `requoteNext`'s (a)):
 * never while the book is not known (`now` undefined: nothing to compare); always while the
 * quote's own baseline is not — a quote asked before the first book answered, or after a book
 * read that failed, may predate the liquidity now there, so it is read again once, and that read
 * records the side it started on; otherwise a deep compare (`bookSideChanged`).
 */
export function sideMovedSinceQuote(
  before: readonly OrderBookLevel[] | undefined,
  now: readonly OrderBookLevel[] | undefined,
): boolean {
  if (now === undefined) return false;
  if (before === undefined) return true;
  return bookSideChanged(before, now);
}

/**
 * D7 in 확인, from a book read: what to tell the reducer, if anything — the baseline once the
 * first read answered after the quote (`answeredAt` > `quotedAt`), then that the side moved.
 * Asked while rendering, so it must answer null once its answer is in the state.
 */
export function bookWatch(
  step: OrderStep,
  book: OrderBook | undefined,
  answeredAt: number,
): OrderAction | null {
  if (step.name !== 'confirm' || book === undefined || answeredAt <= step.frozen.quotedAt) {
    return null;
  }
  const levels = bookSideOf(book, step.frozen.terms.outcome, step.frozen.terms.side);
  if (levels === undefined) return null;
  if (step.baseline === null) return { type: 'baseline', requestId: step.requestId, levels };
  if (!step.bookChanged && bookSideChanged(step.baseline, levels)) {
    return { type: 'bookChanged', requestId: step.requestId };
  }
  return null;
}

/**
 * The least time between the starts of two quote reads a book move asks for (결정 2-13): at most 12
 * a minute, inside the tab's budget of 50 requests a minute (ADR-0140 결과 '주소 버킷').
 */
export const REQUOTE_MIN_GAP_MS = 5_000;

/** How long the panel waits after the last keystroke before it asks for a quote. */
export const QUOTE_DEBOUNCE_MS = 400;

/**
 * A debounce of `delayMs` (`useDebounced`'s timing, apart from React): each `push` drops the wait
 * before it, and `onSettle` gets the last value pushed once none has come for `delayMs` — a burst
 * of keystrokes asks for one quote. `cancel` drops a wait in progress (an unmount).
 */
export function debouncer<T>(
  delayMs: number,
  onSettle: (value: T) => void,
): { push: (value: T) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    push: (value) => {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        onSettle(value);
      }, delayMs);
    },
    cancel,
  };
}

/** What 입력 does about a book that moved under its quote (`requoteNext`). */
export type RequoteNext =
  /** Nothing to read: the side is as quoted, or the panel, the tab or a whole input is missing. */
  | { next: 'none' }
  /** Read the quote again now. */
  | { next: 'now' }
  /** A quote read is in flight: decided again once it ends, never a second read beside it. */
  | { next: 'afterFetch' }
  /** Read it again `ms` from now, when REQUOTE_MIN_GAP_MS since the last read's start has passed. */
  | { next: 'wait'; ms: number };

/**
 * Whether 입력 reads its quote again on a book that moved (ADR-0140 결정 2-13): (a) the chosen side
 * changed, (b) REQUOTE_MIN_GAP_MS has passed since the last quote read STARTED — a keystroke's or a
 * book move's, answered, failed or still running — (c) the panel is on screen, (d) so is the tab,
 * (e) the input is whole, and (f) no quote read is in flight. A move that (b) or (f) alone holds
 * back is not dropped: it waits for the gap's end or the read's end (a trailing read), and is
 * decided again then — so liquidity that comes inside the gap after '호가 없음' still reaches the
 * quote when the book then stops moving. At most 12 book-driven reads a minute, by (b).
 */
export function requoteNext(facts: {
  sideChanged: boolean;
  lastAttemptAt: number | undefined;
  inFlight: boolean;
  now: number;
  panelVisible: boolean;
  tabVisible: boolean;
  inputValid: boolean;
}): RequoteNext {
  if (!facts.sideChanged || !facts.panelVisible || !facts.tabVisible || !facts.inputValid) {
    return { next: 'none' };
  }
  if (facts.inFlight) return { next: 'afterFetch' };
  const ms =
    facts.lastAttemptAt === undefined ? 0 : facts.lastAttemptAt + REQUOTE_MIN_GAP_MS - facts.now;
  return ms <= 0 ? { next: 'now' } : { next: 'wait', ms };
}
