import {
  type MarketStatus,
  ORDER_QTY_MAX,
  type OrderSide,
  type Outcome,
  type PAmount,
  QUOTE_VALUE_MAX_LENGTH,
  type QuoteMode,
  TRADE_MIN_SHARES,
  parsePAmount,
  quoteBodySchema,
  slippageGuard,
} from '@buddha/shared';
import { copy } from '@/copy';
import {
  type Market,
  type QuoteBody,
  type QuoteResult,
  type TradeBody,
  isApiError,
  validationField,
} from './api';

/**
 * The 매수/매도 panel as one state machine (design 3). The inputs below are the only mutable
 * state; everything else the screen shows — what to quote, what phase it is in, what the
 * button does, what a refusal says — is derived here by a pure function.
 *
 * Why not inside the component: `apps/web` runs vitest under `environment: 'node'` with no
 * jsdom, so a decision left in a component is a decision no unit test can reach. For the same
 * reason `now` is a parameter and never `Date.now()` (the `isClosingSoon(market, now)` idiom),
 * which also keeps the SSR and the first client render byte-identical.
 *
 * No policy is restated here: the request bounds come from `quoteBodySchema` and the slippage
 * headroom from `slippageGuard`, both in @buddha/shared, so the web cannot drift from what the
 * API enforces (PLAN 11.5).
 */

// ---- inputs -------------------------------------------------------------------------

export interface TradeInputs {
  side: OrderSide;
  outcome: Outcome;
  mode: QuoteMode;
  /** Digits only, as the field holds them: contracts in mode 'shares', P in mode 'spend'. */
  value: string;
}

/** 예를 P 금액으로 사는 것이 기본 흐름 (PLAN 11.1-2). */
export const INITIAL_TRADE_INPUTS: TradeInputs = {
  side: 'buy',
  outcome: 'YES',
  mode: 'spend',
  value: '',
};

/**
 * Switching to 매도 also forces mode 'shares': `quoteBodySchema`'s first refine rejects
 * spend + sell naming `mode` (there is no answer to "sell for at most N P"), so the toggle is
 * hidden on that tab rather than left to fail. Either direction clears the value — "10 to
 * sell" and "10 to buy" are different intents, and the held cap only applies to one of them.
 */
export function setSide(inputs: TradeInputs, side: OrderSide): TradeInputs {
  return side === 'sell'
    ? { ...inputs, side, mode: 'shares', value: '' }
    : { ...inputs, side, value: '' };
}

/** The value is KEPT: comparing 예 and 아니오 at the same amount is the core interaction. */
export function setOutcome(inputs: TradeInputs, outcome: Outcome): TradeInputs {
  return { ...inputs, outcome };
}

/** P and contracts are different units, so the number on screen cannot carry over. */
export function setMode(inputs: TradeInputs, mode: QuoteMode): TradeInputs {
  return { ...inputs, mode, value: '' };
}

export function setValue(inputs: TradeInputs, raw: string): TradeInputs {
  return { ...inputs, value: normaliseValue(raw) };
}

/**
 * What the amount field holds after a keystroke or a paste: digits only, no leading zeros, at
 * most QUOTE_VALUE_MAX_LENGTH of them. `inputMode="numeric"` is a keyboard hint and not a
 * filter — a paste arrives verbatim — and the length is the bound `quoteBodySchema` checks
 * before it turns the string into a BigInt.
 *
 * Zeros are stripped only while a digit follows, so a lone '0' survives: it is a number the
 * user typed, and the view answers it with 금액은 1P 이상… instead of swallowing the keystroke.
 */
function normaliseValue(raw: string): string {
  return raw
    .replace(/\D/g, '')
    .replace(/^0+(?=\d)/, '')
    .slice(0, QUOTE_VALUE_MAX_LENGTH);
}

// ---- request builders ---------------------------------------------------------------

/**
 * Whether a trade may be attempted at all. Gated on `closeAt` and not only on `status`:
 * A-M3-31 keeps a seeded market `open` past its close time and the server answers
 * MARKET_CLOSED, so a status-only check would offer a panel that cannot trade. Advisory —
 * `assertTradable` decides on the database clock (`clockTimestamp`, A-M3-16).
 *
 * An unparseable `closeAt` is not treated as closed: the API would still accept the trade, and
 * refusing it here would be the web inventing a refusal the server does not make.
 */
export function isTradable(market: Pick<Market, 'status' | 'closeAt'>, now: number): boolean {
  if (market.status !== 'open') return false;
  const closeAt = Date.parse(market.closeAt);
  return Number.isNaN(closeAt) || closeAt > now;
}

/**
 * The `POST /quotes` body, or `undefined` when the inputs are not askable yet. The bounds are
 * `quoteBodySchema`'s and are never restated: digits, the mode's range, spend + sell. Its
 * `uuidSchema` lower-cases the id, which is also what makes the quote's query key canonical
 * for an id that reached the screen in another case (A-M3-29).
 */
export function quoteRequest(
  marketId: string,
  inputs: TradeInputs,
  tradable: boolean,
): QuoteBody | undefined {
  if (!tradable) return undefined;
  const parsed = quoteBodySchema.safeParse({
    marketId,
    outcome: inputs.outcome,
    side: inputs.side,
    mode: inputs.mode,
    value: inputs.value,
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * The `POST /trades` body as it goes on the wire — `components['schemas']['TradeBody']`, whose
 * P amounts are decimal strings. Never built with `tradeBodySchema.parse`: that schema's
 * `maxCostP` is a bigint after `pAmountInputSchema`'s transform and `JSON.stringify` throws on
 * one. `undefined` when the quote buys nothing (A-M3-1: a spend below one contract answers
 * `shares: 0`), which `tradeBodySchema` would refuse anyway.
 *
 * The two guard fields are mutually exclusive by construction because `slippageGuard` returns
 * exactly one of them per side, so the four refines at `market.ts:238-253` cannot fire.
 */
export function tradeRequest(a: {
  marketId: string;
  inputs: TradeInputs;
  quote: QuoteResult;
  accountId: string;
}): TradeBody | undefined {
  if (a.quote.shares < TRADE_MIN_SHARES) return undefined;
  return {
    marketId: a.marketId,
    outcome: a.inputs.outcome,
    side: a.inputs.side,
    shares: a.quote.shares,
    expectedAccountId: a.accountId,
    ...tradeGuard(a.inputs, parsePAmount(a.quote.amountP)),
  };
}

/**
 * The slippage guard for these inputs, shared by the wire body and the summary line that
 * discloses it, so the number the user reads is the number that is sent. In spend mode the
 * user's own typed budget is the cap: "never charge me more than the number I typed" holds
 * exactly.
 */
function tradeGuard(
  inputs: TradeInputs,
  amountP: bigint,
): { maxCostP: PAmount } | { minProceedsP: PAmount } {
  // Only a value the field actually holds is a budget: `parsePAmount('')` is 0n, which would
  // cap every spend-mode buy at the schema's 1P floor.
  const budgetP =
    inputs.mode === 'spend' && inputs.value !== '' ? parsePAmount(inputs.value) : undefined;
  return slippageGuard(inputs.side, amountP, budgetP);
}

// ---- the view -----------------------------------------------------------------------

export interface TradeSummary {
  shares: number;
  priceAvgBp: number;
  amountP: bigint;
  /**
   * Buy only — a sell quote answers `maxPayoutP: '0'` (there is no payout leg), so this and
   * `profitP` are rows the renderer shows when `guardKind === 'maxCost'` and hides otherwise.
   */
  maxPayoutP: bigint;
  /** `maxPayoutP - amountP`: what the contracts pay if they resolve YES, less what they cost. */
  profitP: bigint;
  priceAfterBp: number;
  /** The guard as an absolute amount — nothing about the tolerance is hidden (PLAN 11.1-3). */
  guardP: bigint;
  guardKind: 'maxCost' | 'minProceeds';
  /** The market moved under this quote: dim the numbers, never block the trade. */
  stale: boolean;
}

/** The numbers the summary rows render, all bigint — a P amount is never a `number`. */
export function tradeSummary(
  inputs: TradeInputs,
  quote: QuoteResult,
  stale: boolean,
): TradeSummary {
  const amountP = parsePAmount(quote.amountP);
  const maxPayoutP = parsePAmount(quote.maxPayoutP);
  const guard = tradeGuard(inputs, amountP);
  return {
    shares: quote.shares,
    priceAvgBp: quote.priceAvgBp,
    amountP,
    maxPayoutP,
    profitP: maxPayoutP - amountP,
    priceAfterBp: quote.priceAfterBp,
    guardP: parsePAmount('maxCostP' in guard ? guard.maxCostP : guard.minProceedsP),
    guardKind: inputs.side === 'buy' ? 'maxCost' : 'minProceeds',
    stale,
  };
}

export type TradePanelView =
  | { kind: 'not_open'; status: MarketStatus }
  | { kind: 'past_close' }
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'no_position' }
  | { kind: 'quote_failed'; message: string }
  | { kind: 'quoting' }
  | { kind: 'too_small' }
  | { kind: 'submitting'; summary: TradeSummary }
  | { kind: 'reconfirm'; summary: TradeSummary; previousAmountP: bigint }
  | { kind: 'session_pending'; summary: TradeSummary }
  | { kind: 'anonymous'; summary: TradeSummary }
  | { kind: 'over_position'; summary: TradeSummary; heldQty: number }
  | { kind: 'short'; summary: TradeSummary; shortfallP: bigint }
  | { kind: 'ready'; summary: TradeSummary; body: TradeBody };

export interface TradePanelInput {
  market: Pick<Market, 'id' | 'status' | 'closeAt'>;
  inputs: TradeInputs;
  /** `undefined` while the quote is pending AND while it is placeholder data (design 4.1). */
  quote: QuoteResult | undefined;
  /**
   * The amount `quote` was ASKED for: the debounced value the quote's key carries, which the
   * field runs up to `QUOTE_DEBOUNCE_MS` ahead of. The pair is checked here rather than assumed
   * by the caller because both the summary's guard and the wire body read `inputs.value` as the
   * trader's budget, so pricing the typed value against an answer for another one sends a trade
   * nobody saw: in mode 'shares' the OLD contract count with a guard from the old cost, and in
   * mode 'spend' a `maxCostP` clamped under the quote's own `amountP`, which the API answers
   * with PRICE_MOVED for a price that never moved.
   */
  quotedValue: string;
  quoteError: unknown;
  /** `market.dataUpdatedAt > quote.dataUpdatedAt`: the price moved under the shown numbers. */
  stale: boolean;
  accountId: string | undefined;
  /** The session is still loading: not anonymous, but `expectedAccountId` is not known yet. */
  sessionPending: boolean;
  availableP: bigint | undefined;
  /** Contracts held of this (market, outcome); `undefined` while unknown, which never blocks. */
  heldQty: number | undefined;
  submitting: boolean;
  /** The amount that was pressed on, when the server answered PRICE_MOVED. */
  reconfirmFrom: bigint | undefined;
  now: number;
}

/**
 * The panel's phase. The ORDER of the checks is the design, so each step below is a test case:
 * a hopeless sell is refused before it costs a round trip, an unaskable amount before any
 * error is consulted, and the money checks after the phase checks so a submit in flight never
 * flickers into 충전하기.
 */
export function tradePanelView(input: TradePanelInput): TradePanelView {
  const { market, inputs, quote } = input;

  // 1-2. The market itself. `past_close` is separate from `not_open` because the status is
  // still `open` (A-M3-31) and 마감 is what the user must be told.
  if (market.status !== 'open') return { kind: 'not_open', status: market.status };
  if (!isTradable(market, input.now)) return { kind: 'past_close' };

  // 3-4. The amount. An empty field is not an error — it is the resting state.
  if (inputs.value === '') return { kind: 'empty' };
  if (quoteRequest(market.id, inputs, true) === undefined) {
    const message = inputs.mode === 'shares' ? copy.errTradeShares : copy.errTradeAmount;
    return { kind: 'invalid', message };
  }

  // 5. Before quoting: selling nothing has no price worth asking for.
  if (inputs.side === 'sell' && input.heldQty === 0) return { kind: 'no_position' };

  // 6-8. The quote. `stale` deliberately does not appear here: a busy market would otherwise
  // become unbuyable. It dims the summary and drives the throttled re-quote instead.
  if (input.quoteError !== undefined && input.quoteError !== null) {
    return { kind: 'quote_failed', message: quoteErrorMessage(input.quoteError) };
  }
  // An answer for an amount the field has typed past prices nothing on this screen: `quoting`
  // is the only phase in which the summary, the disclosed guard and the wire body below are
  // one intent, so the debounced value catching up is what re-opens the button.
  if (quote === undefined || input.quotedValue !== inputs.value) return { kind: 'quoting' };
  if (quote.shares < TRADE_MIN_SHARES) return { kind: 'too_small' };

  const summary = tradeSummary(inputs, quote, input.stale);

  // 9-10. Phases that own the button before any pre-flight check does.
  if (input.submitting) return { kind: 'submitting', summary };
  if (input.reconfirmFrom !== undefined) {
    return { kind: 'reconfirm', summary, previousAmountP: input.reconfirmFrom };
  }
  if (input.sessionPending) return { kind: 'session_pending', summary };
  if (input.accountId === undefined) return { kind: 'anonymous', summary };

  // 11-12. The pre-flight checks the server repeats under its own locks. The summary stays on
  // screen through both: the user still learns what those contracts are worth, and the amount
  // is never clamped mid-typing.
  if (inputs.side === 'sell' && input.heldQty !== undefined && quote.shares > input.heldQty) {
    return { kind: 'over_position', summary, heldQty: input.heldQty };
  }
  if (
    inputs.side === 'buy' &&
    input.availableP !== undefined &&
    summary.amountP > input.availableP
  ) {
    return { kind: 'short', summary, shortfallP: summary.amountP - input.availableP };
  }

  // 13. `shares` was checked at step 8, so the builder's own guard cannot fire here; falling
  // back to `too_small` keeps the union total without a non-null assertion.
  const body = tradeRequest({ marketId: market.id, inputs, quote, accountId: input.accountId });
  return body === undefined ? { kind: 'too_small' } : { kind: 'ready', summary, body };
}

// ---- the button ---------------------------------------------------------------------

export type TradeCta =
  | { kind: 'submit'; amountP: bigint }
  | { kind: 'reconfirm' }
  | { kind: 'pending' }
  | { kind: 'login' }
  | { kind: 'charge'; shortfallP: bigint }
  | { kind: 'disabled' };

/**
 * What the one button does. `pending` covers both a submit in flight and a session still
 * loading, so the button only ever goes `loading` and never disappears (the `useCharge().ready`
 * precedent — no layout shift). An anonymous visitor never sees 충전하기: their next step is
 * logging in, and the balance behind the shortfall is not theirs yet.
 */
export function tradeCta(view: TradePanelView): TradeCta {
  switch (view.kind) {
    case 'ready':
      return { kind: 'submit', amountP: view.summary.amountP };
    case 'reconfirm':
      return { kind: 'reconfirm' };
    case 'submitting':
    case 'session_pending':
      return { kind: 'pending' };
    case 'anonymous':
      return { kind: 'login' };
    case 'short':
      return { kind: 'charge', shortfallP: view.shortfallP };
    default:
      return { kind: 'disabled' };
  }
}

// ---- refusals -----------------------------------------------------------------------

/**
 * The message for a refused trade (design 5.5), shaped like `transitionErrorMessage`. Every
 * row also has a cache correction in `useTrade.onError`, and the view then re-derives from the
 * corrected cache — so there is exactly one code path that renders 충전하기 and one that
 * renders 마감, whether the shortfall was seen before the request or after it.
 *
 * Two rows are not what they look like: a trade's DUPLICATE_REQUEST carries no `details` (it
 * comes from `replay()`, which compares the stored terms — a concurrent twin is replayed, not
 * refused), and FORBIDDEN is two different failures told apart by the field it names —
 * `expectedAccountId` means the cookie belongs to another account, anything else is CSRF.
 */
export function tradeErrorMessage(error: unknown): string {
  if (isApiError(error, 'PRICE_MOVED')) return copy.tradeReconfirm;
  if (isApiError(error, 'INSUFFICIENT_BALANCE')) return copy.errTradeBalance;
  if (isApiError(error, 'INSUFFICIENT_POSITION')) return copy.errTradePosition;
  if (isApiError(error, 'MARKET_CLOSED')) return copy.errTradeClosed;
  if (isApiError(error, 'MARKET_NOT_OPEN')) return copy.errMarketNotOpen;
  if (isApiError(error, 'DUPLICATE_REQUEST')) return copy.errTradeDuplicate;
  if (isApiError(error, 'NOT_FOUND')) return copy.errTradeNotFound;
  if (isApiError(error, 'FORBIDDEN')) {
    return validationField(error) === 'expectedAccountId' ? copy.sessionChanged : copy.errUnknown;
  }
  if (isApiError(error, 'UNAUTHENTICATED')) return copy.errUnauthenticated;
  if (isApiError(error, 'VALIDATION_ERROR')) {
    // `shares` is the engine's own ceiling (the RangeError out of applyBuy). Any other field —
    // `Idempotency-Key` included — means the client built a body it should not have.
    return validationField(error) === 'shares' ? copy.errTradeSharesMax : copy.errUnknown;
  }
  return copy.errUnknown;
}

/**
 * The message under a failed quote. `POST /quotes` is public and its body was built by
 * `quoteRequest`, so the only refusals that say anything to the user are the market's own:
 * `requirePublicAt` answers NOT_FOUND, `assertTradable` MARKET_NOT_OPEN or MARKET_CLOSED on
 * the database clock a moment before the panel's own `now` check would have caught it.
 */
export function quoteErrorMessage(error: unknown): string {
  if (isApiError(error, 'MARKET_CLOSED')) return copy.errTradeClosed;
  if (isApiError(error, 'MARKET_NOT_OPEN')) return copy.errMarketNotOpen;
  if (isApiError(error, 'NOT_FOUND')) return copy.errTradeNotFound;
  return copy.errTradeQuote;
}

/**
 * What 최대 fills in, or `undefined` when there is no ceiling to offer.
 *
 * A sell is capped by the contracts actually held AND by `ORDER_QTY_MAX`, the per-ORDER
 * ceiling `sharesSchema` enforces (@buddha/shared market.ts). Those two are not the same
 * number: a position accumulates across orders up to `POSITION_QTY_MAX` (INT4_MAX), so an
 * account that bought past a million contracts pressed 최대 and got a quantity the schema
 * refuses — `quoteRequest` answers undefined, `tradePanelView` falls to `invalid`, and the
 * chip that exists to fill in a VALID amount left the panel unable to quote or submit, with
 * 계약 수를 확인해 주세요 under a number the panel itself had written. Selling out then took
 * as many presses as it takes orders, which is the truth the chip should have offered in the
 * first place.
 *
 * A spend-mode buy is capped by the available balance; the P ceiling is the schema's amount
 * bound, which the field length already holds. Buying a COUNT has no ceiling this side of a
 * quote, so the chip is absent there rather than disabled — and the value still goes through
 * `setValue`, which is the only thing that bounds what a keystroke may write.
 */
export function maxValueFor(a: {
  inputs: TradeInputs;
  heldQty: number | undefined;
  availableP: bigint | undefined;
}): string | undefined {
  if (a.inputs.side === 'sell') {
    const held = a.heldQty;
    if (held === undefined || held <= 0) return undefined;
    return String(Math.min(held, ORDER_QTY_MAX));
  }
  if (a.inputs.mode !== 'spend') return undefined;
  const available = a.availableP;
  return available === undefined || available <= 0n ? undefined : available.toString();
}
