import { CONTRACT_TERMS, orderIntakeLock } from './contract.js';
import {
  OUTCOMES,
  type MarketStatus,
  type OrderCancelReason,
  type OrderRejectReason,
  type OrderSide,
  type OrderStatus,
  type Outcome,
  type TimeInForce,
} from './enums.js';
import { assertWhole } from './market-maker/validate.js';
import {
  matchLine,
  type BookOrder,
  type MatchLineEntry,
  type MatchStop,
  type OrderOwner,
} from './matching.js';
import { intakeMarketGate, planIntakeMatch, type QuoteOrderBody } from './orders.js';

/*
 * 공개 호가와 견적 (#179, ADR-0114; ADR-0107 결정 1 #177 2·3·4·10·12·15항, 결정 2 #73 15항, 결정 4
 * #179, 결정 5 '#179·#119'; ADR-0111 결정 8·11): the public book of one market, the quote of an
 * order on it and the sellable figures of a holding, all built on #117's line and walk — the
 * depth is `matchLine` grouped by price, the quote is the intake's own gate and plan
 * (`intakeMarketGate`, `planIntakeMatch`) with no owner — so a quote on an unchanged book is the
 * fill the intake makes. Aggregates only: no order, owner, arrival, account type or fill row
 * leaves these functions. Pure: no clock or I/O; Coin is bigint.
 */

/** One price level of one side: the price in the contract and the summed remaining quantity. */
export interface BookLevel {
  readonly priceCoin: number;
  readonly qty: number;
}

/** One contract's book (#177 4항, N02 §2·§5). */
export interface ContractDepth {
  readonly outcome: Outcome;
  /**
   * What a buyer of `outcome` meets: its direct sells and the converted buys of the other
   * outcome (payout − their price), merged into one quantity per price, cheapest first —
   * `matchLine(book, outcome, 'buy')` grouped. No source split.
   */
  readonly asks: readonly BookLevel[];
  /** What a seller of `outcome` meets: its direct buys only, highest first (no cross-sell). */
  readonly bids: readonly BookLevel[];
  /** The 최우선 매도 호가, `asks[0]`; null is '호가 없음'. */
  readonly bestAskCoin: number | null;
  /** The 최우선 매수 호가, `bids[0]`; null is '호가 없음'. */
  readonly bestBidCoin: number | null;
}

/**
 * A line's levels (ADR-0111 결정 11): the entries of one sorted line that share a price, summed.
 * `matchLine` lists each original order at most once per line, so each counts once here.
 */
export function bookLevels(line: readonly MatchLineEntry[]): BookLevel[] {
  const levels: { priceCoin: number; qty: number }[] = [];
  for (const entry of line) {
    const last = levels.at(-1);
    if (last?.priceCoin === entry.priceCoin) last.qty += entry.order.remainingQty;
    else levels.push({ priceCoin: entry.priceCoin, qty: entry.order.remainingQty });
  }
  return levels;
}

/**
 * One contract's book: every level of each side (at most 99), never truncated — how many the
 * screen shows is #122's. A converted level exists only because a real opposite buy rests: no
 * value is a complement of a same-contract price (`100 − bid`), and no field sums both views of
 * one order. RangeError on a malformed book.
 */
export function contractDepth(book: readonly BookOrder[], outcome: Outcome): ContractDepth {
  const asks = bookLevels(matchLine(book, outcome, 'buy'));
  const bids = bookLevels(matchLine(book, outcome, 'sell'));
  return {
    outcome,
    asks,
    bids,
    bestAskCoin: asks[0]?.priceCoin ?? null,
    bestBidCoin: bids[0]?.priceCoin ?? null,
  };
}

/** Both contracts' books, YES then NO (`OUTCOMES`). An empty book is '호가 없음' everywhere. */
export function bookDepth(book: readonly BookOrder[]): ContractDepth[] {
  return OUTCOMES.map((outcome) => contractDepth(book, outcome));
}

/**
 * What the intake, the quote and the public book read of the market: its status, its 가격 보호 폭
 * (null: none entered), its 거래 마감 시각 and the DB clock of the read, so
 * `marketTradingRejectReason` refuses an OPEN market from its `close_at` on before the worker's
 * transition (#120, ADR-0114 10-16: every builder carries both).
 */
export interface MarketTradingFacts {
  readonly status: MarketStatus;
  /** A persistent market reconciliation hold blocks trading until an approved recovery. */
  readonly ledgerHeld?: boolean;
  readonly widthTicks: number | null;
  /** The market's 거래 마감 시각 as stored now (a supplement only extends it, ADR-0093 #172 14항). */
  readonly closeAt: Date;
  /** The DB clock of the read: the snapshot's (book, quote), or the intake's under its locks. */
  readonly now: Date;
}

/** An order's terms as a quote takes them: the intake's, an immediate order's limit optional. */
export interface QuoteTerms {
  readonly outcome: Outcome;
  readonly side: OrderSide;
  readonly timeInForce: TimeInForce;
  /** null: an immediate order sent no limit — 99 for a buy, 1 for a sell. A GTC order has one. */
  readonly limitPriceCoin: number | null;
  /** A quantity order's contracts; null exactly for a budget order. */
  readonly qty: number | null;
  /** An IOC buy's budget (#177 3항); null for any other order. */
  readonly budgetCoin: bigint | null;
}

/** The quote's terms from its body (`quoteOrderBodySchema`): absent fields as null. */
export function quoteTermsOf(body: QuoteOrderBody): QuoteTerms {
  return {
    outcome: body.outcome,
    side: body.side,
    timeInForce: body.timeInForce,
    limitPriceCoin: body.limitPriceCoin ?? null,
    qty: body.qty ?? null,
    budgetCoin: body.budgetCoin ?? null,
  };
}

/**
 * A quote's figures (#177 10·12항, #73 15항): the totals of the intake's walk, never its fill rows,
 * resting orders, reference or width (ADR-0111 결과 '#179'). The average is
 * `filledAmountCoin ÷ filledQty` (#177 12항: the quote's own; none when nothing fills), and the
 * fee is 0 (#73 15항), so neither is a figure here.
 */
export interface OrderQuoteFigures {
  /**
   * The limit the intake would match with: an immediate buy's 최대 매수 단가 or sell's 최소 매도
   * 단가 (`protectedLimit`, #177 2항), a GTC order's own. Sent as the order's limit, the intake
   * narrows nothing more on an unchanged book.
   */
  readonly protectedLimitPriceCoin: number;
  /** The contracts that fill at once. */
  readonly filledQty: number;
  /** What they cost (a buy) or bring (a sell). */
  readonly filledAmountCoin: bigint;
  /** A quantity order's qty − filledQty (rests for a GTC, ends for an IOC); a budget's null. */
  readonly remainingQty: number | null;
  /** A budget order's budget − what it spends, never spent (#177 3항); a quantity order's null. */
  readonly unspentCoin: bigint | null;
  /**
   * A buy's whole lock at intake (`orderIntakeLock` at the protected limit): limit × qty for a
   * quantity buy, a GTC's resting part included, or the budget. A sell's null (it locks
   * contracts), and so is a buy the market's status refused (the gate's rejected row locks
   * nothing). A buy the walk rejects (호가 부족, 가격 한도, 금액 부족) still shows the lock the
   * intake takes and releases — the basis of its balance check.
   */
  readonly maxSpendCoin: bigint | null;
  /** Why the walk stopped (`matchOrder`); null when the market's status refused the order. */
  readonly stop: MatchStop | null;
  /** The state the order would end its intake in (`orderEndState`), or `rejected`. */
  readonly status: OrderStatus;
  readonly rejectReason: OrderRejectReason | null;
  readonly cancelReason: OrderCancelReason | null;
}

/** A quote, or `closed`: an immediate order on a market with no width (as the intake answers). */
export type QuoteAnswer =
  | { readonly kind: 'quoted'; readonly figures: OrderQuoteFigures }
  | { readonly kind: 'closed'; readonly why: 'price_protection' };

/**
 * The quote of an order on `book`, the market's whole live book (#179; ADR-0111 결정 8: the
 * quote is `matchOrder` with no owner), in the intake's order: the market's gate
 * (`intakeMarketGate`: a market not OPEN answers a rejected order with its reason and nothing
 * filled, an immediate order on a market with no width `closed`), then the intake's plan
 * (`planIntakeMatch`: the reference, the protected limit, the walk and the end state). It leaves
 * out what is not the public book's — the request id, `order.accepting` (a closed intake still
 * quotes, ADR-0107 결정 3) and the assets (the public quote holds no personal data, 결정 4) —
 * so it differs from the fill only there, when `owner`'s own group stops the walk, when the
 * book changed, or when the market's own facts changed on an unchanged book (an admin's width
 * change, which publishes nothing; a pause; `close_at` passing — that refusal is in
 * `marketTradingRejectReason`, which the gate and the public book share, #120). `owner` null for
 * the public quote; a member's own (`sellableOf`) to show their self-trade stop. RangeError for a
 * DRAFT or REVIEW market (the caller answers NOT_FOUND), a GTC order with no limit, or malformed
 * terms or book.
 */
export function quoteOrder(
  book: readonly BookOrder[],
  market: MarketTradingFacts,
  terms: QuoteTerms,
  owner: OrderOwner | null,
): QuoteAnswer {
  if (terms.limitPriceCoin === null && terms.timeInForce === 'gtc') {
    throw new RangeError('a GTC order rests at its limit, so its quote needs one');
  }
  const limitPriceCoin =
    terms.limitPriceCoin ??
    (terms.side === 'buy' ? CONTRACT_TERMS.priceMaxCoin : CONTRACT_TERMS.priceMinCoin);
  const refusal = intakeMarketGate(market, terms.timeInForce);
  if (refusal?.kind === 'closed') return refusal;
  if (refusal?.kind === 'reject') {
    // The intake's rejected row: nothing filled, matched or locked, the limit as sent.
    return {
      kind: 'quoted',
      figures: {
        protectedLimitPriceCoin: limitPriceCoin,
        filledQty: 0,
        filledAmountCoin: 0n,
        remainingQty: terms.qty,
        unspentCoin: terms.budgetCoin,
        maxSpendCoin: null,
        stop: null,
        status: 'rejected',
        rejectReason: refusal.reason,
        cancelReason: null,
      },
    };
  }
  const plan = planIntakeMatch(book, { ...terms, limitPriceCoin }, market.widthTicks, owner);
  const { result, end } = plan;
  const maxSpend =
    terms.side === 'buy'
      ? orderIntakeLock({
          side: 'buy',
          outcome: terms.outcome,
          limitPriceCoin: terms.budgetCoin === null ? plan.protectedLimitPriceCoin : null,
          qty: terms.qty,
          filledQty: 0,
          budgetCoin: terms.budgetCoin,
          live: true,
        })
      : null;
  return {
    kind: 'quoted',
    figures: {
      protectedLimitPriceCoin: plan.protectedLimitPriceCoin,
      filledQty: result.filledQty,
      filledAmountCoin: result.amountCoin,
      remainingQty: result.remainingQty,
      unspentCoin: end.unspentCoin,
      maxSpendCoin: maxSpend?.kind === 'coin' ? maxSpend.amountCoin : null,
      stop: result.stop,
      status: end.status,
      rejectReason: end.rejectReason,
      cancelReason: end.cancelReason,
    },
  };
}

/** One position row of a holder as the sellable figures read it (a missing row is 0 and 0). */
export interface HoldingFacts {
  readonly outcome: Outcome;
  /** `positions.qty`: the contracts held. */
  readonly qty: number;
  /** `positions.locked_qty`: the part in the holder's resting sells (#118). */
  readonly lockedQty: number;
}

/** A holding's 매도 가능액 (#177 15항, N02 §8): owner only. */
export interface SellableFigures {
  readonly outcome: Outcome;
  /** The contracts held. */
  readonly qty: number;
  /** The part in resting sells, shown apart and never quoted (#177 15항). */
  readonly restingSellQty: number;
  /** qty − restingSellQty: what an immediate sell may offer now. */
  readonly unlockedQty: number;
  /**
   * An IOC sell of `unlockedQty` with no limit sent — 1, narrowed to max(best bid − width, 1)
   * (#177 2항). 'Only part possible' is `filledQty < unlockedQty`, its `stop` the why:
   * `price_limit` the rest of the bids lie below the limit, `no_quote` no bid is left,
   * `self_trade` the holder's own bid. null when nothing is unlocked or the market takes no
   * immediate order (no width).
   */
  readonly quote: OrderQuoteFigures | null;
}

/**
 * The sellable figures of one holding (#177 15항 '매도 가능액': the unlocked quantity quoted like
 * an immediate sell with 가격 보호), with the holder as the walk's owner (ADR-0111 결정 8: #179
 * decides), so a member's figure is their own immediate sell's, a stop at their own bid
 * included. The unlocked quantity may pass ORDER_QTY_MAX: it is quoted in one walk, and
 * splitting the sale is #67's. RangeError for a malformed holding, market or book.
 */
export function sellableOf(
  book: readonly BookOrder[],
  market: MarketTradingFacts,
  holding: HoldingFacts,
  owner: OrderOwner,
): SellableFigures {
  if (!OUTCOMES.includes(holding.outcome)) {
    throw new RangeError(`no outcome ${String(holding.outcome)}`);
  }
  assertWhole('qty', holding.qty, 0);
  assertWhole('lockedQty', holding.lockedQty, 0);
  if (holding.lockedQty > holding.qty) {
    throw new RangeError(
      `lockedQty ${String(holding.lockedQty)} is above qty ${String(holding.qty)}`,
    );
  }
  const unlockedQty = holding.qty - holding.lockedQty;
  const answer =
    unlockedQty === 0
      ? null
      : quoteOrder(
          book,
          market,
          {
            outcome: holding.outcome,
            side: 'sell',
            timeInForce: 'ioc',
            limitPriceCoin: null,
            qty: unlockedQty,
            budgetCoin: null,
          },
          owner,
        );
  return {
    outcome: holding.outcome,
    qty: holding.qty,
    restingSellQty: holding.lockedQty,
    unlockedQty,
    quote: answer?.kind === 'quoted' ? answer.figures : null,
  };
}
