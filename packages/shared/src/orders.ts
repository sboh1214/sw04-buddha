import * as z from 'zod';
import { coinAmountInputSchema } from './api/coin-amount.js';
import {
  ORDER_BUDGET_MAX_COIN,
  ORDER_QTY_MAX,
  PRICE_MAX,
  PRICE_MIN,
  PRICE_PROTECTION_TICKS_MAX,
  PRICE_PROTECTION_TICKS_MIN,
} from './constants.js';
import {
  CONTRACT_TERMS,
  isContractPrice,
  orderRemainingLock,
  type OrderLock,
  type OrderLockFacts,
} from './contract.js';
import {
  type MarketStatus,
  type OrderCancelReason,
  type OrderRejectReason,
  type OrderSide,
  type OrderStatus,
  type Outcome,
  type TimeInForce,
  orderSideSchema,
  outcomeSchema,
  timeInForceSchema,
} from './enums.js';
import { expectedAccountIdSchema } from './expected-account.js';
import type { MarketTradingFacts } from './order-book.js';
import {
  matchLine,
  matchOrder,
  type BookOrder,
  type IncomingOrder,
  type MatchResult,
  type OrderOwner,
} from './matching.js';

/*
 * 주문 접수 (#119, ADR-0112; ADR-0107 결정 1 #177 2·3·7·8·9·11항, ADR-0111 결정 6): the order a
 * member sends, and the pure rules the intake (@buddha/db orders.ts) runs around #117's matching —
 * the 가격 보호 that narrows an immediate order's limit, the reason a market's status refuses an
 * order with, the state and reasons an order ends in, the lock the intake gives back, a fill's
 * price as one side sees it, and whether a re-sent request is the same order. The market gate
 * and the plan (`intakeMarketGate`, `planIntakeMatch`) are the intake's steps the quote (#179,
 * order-book.ts) runs too. Pure: no clock or I/O; Coin is bigint.
 */

/** A contract price on the tick (`CONTRACT_TERMS`): an integer 1..99. */
const limitPriceSchema = z
  .number()
  .int()
  .min(PRICE_MIN)
  .max(PRICE_MAX)
  .refine(isContractPrice, 'must be a contract price on the tick');

/** One order's quantity: an integer 1..ORDER_QTY_MAX contracts (#177 9항). */
export const orderQtySchema = z.number().int().min(1).max(ORDER_QTY_MAX);

/** A budget order's Coin: an integer 1..ORDER_BUDGET_MAX_COIN, as a decimal string. */
export const orderBudgetSchema = coinAmountInputSchema.refine(
  (coin) => coin >= 1n && coin <= ORDER_BUDGET_MAX_COIN,
  `must be 1 to ${ORDER_BUDGET_MAX_COIN.toString()} Coin`,
);

/**
 * An order's terms as a request sends them, shared by the intake's body and the quote's (#179):
 * the outcome, buy or sell, IOC (즉시 거래) or GTC (지정가), the limit, and either a quantity or a
 * budget (`refineOrderTerms`).
 */
const orderTermsShape = {
  outcome: outcomeSchema,
  side: orderSideSchema,
  timeInForce: timeInForceSchema,
  limitPriceCoin: limitPriceSchema,
  qty: orderQtySchema.optional(),
  budgetCoin: orderBudgetSchema.optional(),
};

/** The fields `refineOrderTerms` reads. */
interface OrderTermsFields {
  side: OrderSide;
  timeInForce: TimeInForce;
  qty?: number | undefined;
  budgetCoin?: bigint | undefined;
}

/** Exactly one of a quantity and a budget, and a budget for an IOC buy only (#177 3항). */
function refineOrderTerms(body: OrderTermsFields, ctx: z.RefinementCtx): void {
  const hasQty = body.qty !== undefined;
  const hasBudget = body.budgetCoin !== undefined;
  if (hasQty === hasBudget) {
    ctx.addIssue({
      code: 'custom',
      path: [hasQty ? 'budgetCoin' : 'qty'],
      message: 'give either a quantity or a budget',
    });
  }
  if (hasBudget && (body.side !== 'buy' || body.timeInForce !== 'ioc')) {
    ctx.addIssue({
      code: 'custom',
      path: ['budgetCoin'],
      message: 'a budget is for an immediate (ioc) buy only',
    });
  }
}

/**
 * `POST /markets/:id/orders` (a member, onboarded; the request id is the `Idempotency-Key`
 * header, the market the path): the outcome, buy or sell, IOC (즉시 거래) or GTC (지정가), the
 * limit — every order carries one, a budget order too, so no order is a market order (#177 2항;
 * an immediate order's limit is then narrowed by the market's 가격 보호 폭 at intake,
 * `protectedLimit`) — and either a quantity (1..ORDER_QTY_MAX contracts) or, for an IOC buy
 * only, a Coin budget (#177 3항), and the account the screen shows (ADR-0092). Unknown fields are
 * refused: there is no amend and no partial cancel (#177 9항) — a change is a cancel (#178) and a
 * new order.
 */
export const placeOrderBodySchema = z
  .object({ ...orderTermsShape, expectedAccountId: expectedAccountIdSchema })
  .strict()
  .superRefine(refineOrderTerms)
  .meta({ id: 'PlaceOrderBody' });
export type PlaceOrderBody = z.infer<typeof placeOrderBodySchema>;

/**
 * `POST /markets/:id/quote` (#179, public: ADR-0107 결정 4 '비로그인 견적'): the intake's terms
 * with no account and no request id — a quote names no one and is never taken. An immediate
 * order's limit is optional (#177 2항 '즉시 매도는 수량만 입력한다'): left out it is 99 for a buy
 * and 1 for a sell, and the market's 가격 보호 narrows it as the intake would. A GTC order rests at
 * its own limit, so it must send one.
 */
export const quoteOrderBodySchema = z
  .object({ ...orderTermsShape, limitPriceCoin: limitPriceSchema.optional() })
  .strict()
  .superRefine((body, ctx) => {
    refineOrderTerms(body, ctx);
    if (body.timeInForce === 'gtc' && body.limitPriceCoin === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['limitPriceCoin'],
        message: 'a GTC order rests at its limit, so it needs one',
      });
    }
  })
  .meta({ id: 'QuoteOrderBody' });
export type QuoteOrderBody = z.infer<typeof quoteOrderBodySchema>;

/** A market's 가격 보호 폭 in ticks: PRICE_PROTECTION_TICKS_MIN..PRICE_PROTECTION_TICKS_MAX. */
export const priceProtectionTicksSchema = z
  .number()
  .int()
  .min(PRICE_PROTECTION_TICKS_MIN)
  .max(PRICE_PROTECTION_TICKS_MAX);

export interface ProtectedLimitInput {
  side: OrderSide;
  timeInForce: TimeInForce;
  /** The confirmed limit the member sent. */
  limitPriceCoin: number;
  /**
   * The best opposite entry at intake in the incoming contract (`matchLine(book, outcome,
   * side)[0]?.priceCoin`, the converted supply included); null when there is none.
   */
  referencePriceCoin: number | null;
  /** The market's width in ticks; null only for a GTC order, which never uses it. */
  widthTicks: number | null;
}

/**
 * The limit the intake matches, locks and records with (#177 2항): a GTC order's is its own; an
 * IOC order's is narrowed to the reference ± the width — a buy to min(limit, reference + width,
 * 99), a sell to max(limit, reference − width, 1) — never widened, so a limit of 99 sent through
 * the API is not a market order. With no reference nothing is narrowed (and nothing fills: 호가
 * 부족). RangeError when a price or the width is malformed, or an IOC order has no width.
 */
export function protectedLimit(input: ProtectedLimitInput): number {
  const { side, timeInForce, limitPriceCoin, referencePriceCoin, widthTicks } = input;
  if (!isContractPrice(limitPriceCoin)) {
    throw new RangeError(`the limit must be a contract price, got ${String(limitPriceCoin)}`);
  }
  if (referencePriceCoin !== null && !isContractPrice(referencePriceCoin)) {
    throw new RangeError(
      `the reference must be a contract price, got ${String(referencePriceCoin)}`,
    );
  }
  if (timeInForce === 'gtc') return limitPriceCoin;
  if (widthTicks === null || !priceProtectionTicksSchema.safeParse(widthTicks).success) {
    throw new RangeError(`an immediate order needs a width in ticks, got ${String(widthTicks)}`);
  }
  if (referencePriceCoin === null) return limitPriceCoin;
  const width = widthTicks * CONTRACT_TERMS.tickCoin;
  return side === 'buy'
    ? Math.min(limitPriceCoin, referencePriceCoin + width, CONTRACT_TERMS.priceMaxCoin)
    : Math.max(limitPriceCoin, referencePriceCoin - width, CONTRACT_TERMS.priceMinCoin);
}

/**
 * The reasons a market's status gives (`marketRejectReason`): 개장 전, 일시 중단 and 마감. The public
 * book (#179) names one when the market takes no order.
 */
export const MARKET_STATUS_REJECT_REASONS = [
  'not_open_yet',
  'paused',
  'closed',
] as const satisfies readonly OrderRejectReason[];
export type MarketStatusRejectReason = (typeof MARKET_STATUS_REJECT_REASONS)[number];

/**
 * Why a market's status refuses a new order with a rejected row and no fill (ADR-0107 결정 5
 * '#119 OPEN이 아닌 시장', ADR-0093 #173 3항): SCHEDULED 개장 전, PAUSED 일시 중단, CLOSED and every
 * later status 마감 (a CANCELLED market too); OPEN null — it takes orders, with or without a
 * quoting bot. A DRAFT or REVIEW market is not public: the caller answers NOT_FOUND before it asks
 * (RangeError here). It reads the status alone: whether a market takes orders now is
 * `marketTradingRejectReason`, which adds the `close_at` check of an OPEN market (#120).
 */
export function marketRejectReason(status: MarketStatus): MarketStatusRejectReason | null {
  switch (status) {
    case 'draft':
    case 'review':
      throw new RangeError(`a ${status} market is not public: no order reaches it`);
    case 'scheduled':
      return 'not_open_yet';
    case 'open':
      return null;
    case 'paused':
      return 'paused';
    case 'closed':
    case 'provisional':
    case 'resolved':
    case 'settling':
    case 'settled':
    case 'cancelled':
      return 'closed';
  }
}

/**
 * Why a public market takes no order now, or null when it does (#179, ADR-0114 결정 2·3): the one
 * check the intake's gate (`intakeMarketGate`, so the quote too) and the public book
 * (`orderBookOf`, and the API's read of the live book) share, so the book shows no level where
 * the intake and the quote refuse. The status first (`marketRejectReason`: a SCHEDULED or PAUSED
 * market keeps its own reason past its close), then the `close_at` refusal of an OPEN market
 * (#120, ADR-0115): 'closed' from `close_at` on by the read's DB clock (`now >= closeAt`, the
 * worker's, the burn's and the pause's boundary), before the worker's transition — so the book,
 * the quote and the intake agree in that window (ADR-0107 결정 5 '#120 개장 뒤 거래 마감 시각 변경':
 * the close_at as stored then and the server's clock only). It and its three callers
 * (`intakeMarketGate`, `orderBookOf`, `quoteOrder`) take the one `MarketTradingFacts`
 * (`readMarketTradingFacts`, `placeOrder`'s own read). RangeError for a DRAFT or REVIEW market:
 * the caller answered NOT_FOUND first.
 */
export function marketTradingRejectReason(
  market: MarketTradingFacts,
): MarketStatusRejectReason | null {
  const reason = marketRejectReason(market.status);
  if (reason !== null) return reason;
  // An OPEN market from its close_at on, by the DB clock, before the worker's transition (#120).
  if (market.closeAt.getTime() <= market.now.getTime()) return 'closed';
  return market.ledgerHeld ? 'paused' : null;
}

/** What the intake's market gate answers: a rejected order with its reason, or nothing taken. */
export type IntakeMarketRefusal =
  { kind: 'reject'; reason: OrderRejectReason } | { kind: 'closed'; why: 'price_protection' };

/**
 * The intake's market gate (ADR-0112 결정 4 steps 4–5), in its order; null = go on: a market that
 * takes no order now rejects the order with its reason (`marketTradingRejectReason`, the check the
 * public book shares), and an immediate order meets a market with no 가격 보호 폭 as `closed`
 * (nothing written; a GTC order never uses the width). It holds only refusals of the market
 * alone, so the public quote (#179, no account) follows them: the `close_at` refusal (#120) is in
 * `marketTradingRejectReason`, so the book follows too. Per-account refusals (#143's role-revoke
 * reason, #93's account hold) stay in `placeOrder` beside the asset lock, where a quote can differ
 * from the fill. RangeError for a DRAFT or REVIEW market: the caller answered NOT_FOUND first.
 */
export function intakeMarketGate(
  market: MarketTradingFacts,
  timeInForce: TimeInForce,
): IntakeMarketRefusal | null {
  const reason = marketTradingRejectReason(market);
  if (reason !== null) return { kind: 'reject', reason };
  if (timeInForce === 'ioc' && market.widthTicks === null) {
    return { kind: 'closed', why: 'price_protection' };
  }
  return null;
}

/** How the incoming order ends its intake (ADR-0111 결정 6). */
export interface OrderEndState {
  status: OrderStatus;
  rejectReason: OrderRejectReason | null;
  cancelReason: OrderCancelReason | null;
  /** A budget order's budget minus what it spent, released and recorded; null for any other. */
  unspentCoin: bigint | null;
}

/**
 * The state and reasons the intake records for the incoming order from its match (ADR-0111 결정 6,
 * ADR-0107 결정 1 #177 3·7·8항): every contract filled → 전량 체결; a budget that cannot buy the
 * next contract → 전량 체결 with its unspent Coin, or 거절 '금액 부족' when it bought none; nothing
 * left opposite or the next entry beyond the limit → a GTC order rests (대기, or 부분 체결 after a
 * fill), an immediate one ends — 거절 '호가 부족' or '가격 한도' with no fill, else 취소 완료 '즉시
 * 거래 잔량'; the next entry the owner's own group's → every order ends, a GTC one too (#177 7항) —
 * 거절 '자기 체결' with no fill, else 취소 완료 '자기 체결'.
 */
export function orderEndState(incoming: IncomingOrder, result: MatchResult): OrderEndState {
  const filled = result.filledQty > 0;
  const unspentCoin = incoming.budgetCoin === null ? null : result.unspentCoin;
  const ended = (
    status: OrderStatus,
    rejectReason: OrderRejectReason | null = null,
    cancelReason: OrderCancelReason | null = null,
  ): OrderEndState => ({ status, rejectReason, cancelReason, unspentCoin });
  switch (result.stop) {
    case 'filled':
      return ended('filled');
    case 'budget_spent':
      return filled ? ended('filled') : ended('rejected', 'budget_too_small');
    case 'no_quote':
    case 'price_limit':
      if (result.remainder === 'rest') return ended(filled ? 'partially_filled' : 'open');
      return filled ? ended('cancelled', null, 'ioc_remainder') : ended('rejected', result.stop);
    case 'self_trade':
      return filled ? ended('cancelled', null, 'self_trade') : ended('rejected', 'self_trade');
  }
}

/** An order's terms as the intake matches them: no owner and no request id. */
export interface OrderTerms {
  outcome: Outcome;
  side: OrderSide;
  timeInForce: TimeInForce;
  /** The confirmed limit, 1..99 (an immediate order's is narrowed, `protectedLimit`). */
  limitPriceCoin: number;
  /** A quantity order's contracts; null exactly for a budget order. */
  qty: number | null;
  /** An IOC buy's budget (#177 3항); null for any other order. */
  budgetCoin: bigint | null;
}

/** What the intake plans on a book (`planIntakeMatch`). */
export interface IntakeMatchPlan {
  /** An immediate order's 최우선 반대 호가 (`matchLine(book, outcome, side)[0]`); GTC null. */
  referencePriceCoin: number | null;
  /** An immediate order's width, the market's; GTC null (as the order row records). */
  widthTicks: number | null;
  /** The limit it matches, locks and records with (`protectedLimit`). */
  protectedLimitPriceCoin: number;
  /** The order the matcher walked: `owner` as given, null for a quote. */
  incoming: IncomingOrder;
  /** `matchOrder` over the whole book. */
  result: MatchResult;
  /** `orderEndState(incoming, result)`. */
  end: OrderEndState;
}

/**
 * The intake's plan on the market's whole live book (ADR-0112 결정 4 steps 6 and 8, #177 2항): the
 * reference an immediate order reads (the converted supply included, the own resting order too),
 * its limit narrowed by the width (`protectedLimit`), the match (#117 `matchOrder`) and the end
 * state (`orderEndState`). The intake (@buddha/db `placeOrder`) runs it with the order's owner
 * under the market lock, and the quote (#179) with no owner on a snapshot, so a quote on an
 * unchanged book is the fill unless the owner's own group stops it. A trim of the 운영
 * 마켓메이커's quantities (#128) is not inherited: each caller reads its own book, so #128 trims
 * it before this in both (the intake's `readLiveBook`, the quote's `readPublicBook`); only a
 * per-fill bot cap from the bot's positions (ADR-0111 결정 8) may leave the quote above the fill.
 * RangeError for an immediate order with no width (the gate answered first) and for malformed
 * terms or a malformed book.
 */
export function planIntakeMatch(
  book: readonly BookOrder[],
  terms: OrderTerms,
  widthTicks: number | null,
  owner: OrderOwner | null,
): IntakeMatchPlan {
  const isIoc = terms.timeInForce === 'ioc';
  const referencePriceCoin = isIoc
    ? (matchLine(book, terms.outcome, terms.side)[0]?.priceCoin ?? null)
    : null;
  const width = isIoc ? widthTicks : null;
  const protectedLimitPriceCoin = protectedLimit({
    side: terms.side,
    timeInForce: terms.timeInForce,
    limitPriceCoin: terms.limitPriceCoin,
    referencePriceCoin,
    widthTicks: width,
  });
  let incoming: IncomingOrder;
  if (terms.budgetCoin === null) {
    if (terms.qty === null) throw new RangeError('an order has a quantity or a budget');
    incoming = {
      owner,
      outcome: terms.outcome,
      side: terms.side,
      timeInForce: terms.timeInForce,
      limitPriceCoin: protectedLimitPriceCoin,
      qty: terms.qty,
      budgetCoin: null,
    };
  } else {
    if (terms.qty !== null) throw new RangeError('an order has a quantity or a budget, not both');
    if (terms.side !== 'buy' || !isIoc) {
      throw new RangeError('a budget order is an immediate (ioc) buy (#177 3항)');
    }
    incoming = {
      owner,
      outcome: terms.outcome,
      side: 'buy',
      timeInForce: 'ioc',
      limitPriceCoin: protectedLimitPriceCoin,
      qty: null,
      budgetCoin: terms.budgetCoin,
    };
  }
  const result = matchOrder(book, incoming);
  return {
    referencePriceCoin,
    widthTicks: width,
    protectedLimitPriceCoin,
    incoming,
    result,
    end: orderEndState(incoming, result),
  };
}

/** A resting order's state after a fill: 전량 체결 with nothing left, else 부분 체결. */
export function restingStateAfterFill(remainingQty: number): 'filled' | 'partially_filled' {
  if (!Number.isInteger(remainingQty) || remainingQty < 0) {
    throw new RangeError(
      `remainingQty must be a non-negative integer, got ${String(remainingQty)}`,
    );
  }
  return remainingQty === 0 ? 'filled' : 'partially_filled';
}

/**
 * The lock the intake gives back at its end (ADR-0110 결과 5, #177 3항): `facts` are the incoming
 * order's at intake (its protected limit, `filledQty` 0), whose `orderIntakeLock` it took. Each
 * fill consumed its part (and released its better price, contracts.ts), so what is left is a
 * quantity order's `orderRemainingLock` after `result.filledQty` and a budget order's unspent
 * Coin. A GTC remainder that rests keeps it (nothing given back); every other end gives it all
 * back.
 */
export function intakeRemainderRelease(facts: OrderLockFacts, result: MatchResult): OrderLock {
  if (result.remainder === 'rest') {
    return orderRemainingLock({ ...facts, filledQty: 0, live: false });
  }
  if (facts.budgetCoin !== null) {
    if (result.unspentCoin === null) throw new RangeError('a budget order ends with unspent Coin');
    return { kind: 'coin', amountCoin: result.unspentCoin };
  }
  return orderRemainingLock({ ...facts, filledQty: result.filledQty, live: true });
}

/**
 * A fill's price per contract as one of its sides holds it (#177 11·15항): fills record the YES
 * price, so a NO holder's is the payout minus it.
 */
export function ownFillPrice(outcome: Outcome, yesPriceCoin: number): number {
  return outcome === 'YES' ? yesPriceCoin : CONTRACT_TERMS.payoutCoin - yesPriceCoin;
}

/** The terms a request id names: what a re-sent request must repeat to read its order back. */
export interface OrderRequestTerms {
  marketId: string;
  outcome: Outcome;
  side: OrderSide;
  timeInForce: TimeInForce;
  /** The confirmed limit the member sent (not the protected one). */
  limitPriceCoin: number;
  qty: number | null;
  budgetCoin: bigint | null;
}

/**
 * Whether a re-sent request is the order its request id already named: the same market and the
 * same terms. Then the answer is that order as it stands now, and nothing is written; otherwise
 * DUPLICATE_REQUEST (ADR-0112).
 */
export function requestTermsEqual(a: OrderRequestTerms, b: OrderRequestTerms): boolean {
  return (
    a.marketId === b.marketId &&
    a.outcome === b.outcome &&
    a.side === b.side &&
    a.timeInForce === b.timeInForce &&
    a.limitPriceCoin === b.limitPriceCoin &&
    a.qty === b.qty &&
    a.budgetCoin === b.budgetCoin
  );
}
