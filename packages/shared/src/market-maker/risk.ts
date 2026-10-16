import { ORDER_SIDES, OUTCOMES, type OrderSide, type Outcome } from '../enums.js';
import { type QuoteLadder, type QuoteLevel } from './ladder.js';
import { type ContractTerms, assertContractTerms } from './terms.js';
import { assertWhole } from './validate.js';

/**
 * The market maker's risk in one market (#128, N01 §5·§7), as ADR-0058 decided it. Pure
 * functions over one market's bot: nothing here reads or writes orders, and the order path
 * (#119) and the bot's posting (#129) call them. All money is `bigint`.
 *
 * - Result PnL (N01 §7): for YES, NO and VOID, the bot's Coin (locked in orders included) plus
 *   what its contracts pay on that result, plus Coin already returned to the vault, less all
 *   Coin put in. A contract's payout is not added to its collateral again.
 * - Worst loss = max(0, −PnL) over the three results.
 * - Reserved PnL (결정 1의 9): for each result, every resting bot order that loses on it fills
 *   and every one that gains does not. No fill order or combination can do worse. Orders whose
 *   cancel is pending count as resting (결정 1의 7).
 * - Utilization = worst loss on holdings ÷ L, in basis points. It sets the stage (결정 1의 8·12):
 *   below the first threshold `normal`, from it `reduce`, from the second `halt`. Posting or
 *   pulling orders does not move it.
 * - Loss limit (결정 1의 10·13, 결정 2): a new order or a fill is allowed when no result's
 *   reserved loss ends above L — or, for a result already above L (L was lowered), when it does
 *   not grow. A fill is cut to what fits and the bot's remainder is cancelled.
 *
 * Risk is per market; nothing offsets one market against another (N01 §5). Nothing here can
 * reset a loss: the inputs are the bot's holdings and orders as they are (N01 §9).
 */

/** The results a market can settle to, VOID included (N03 §6). */
export const RESULT_SCENARIOS = ['YES', 'NO', 'VOID'] as const;
export type ResultScenario = (typeof RESULT_SCENARIOS)[number];
export type ByResult<T> = Readonly<Record<ResultScenario, T>>;

/** 기본 · 축소 · 중단 (N01 §7 초기 시험 정책). */
export const RISK_STAGES = ['normal', 'reduce', 'halt'] as const;
export type RiskStage = (typeof RISK_STAGES)[number];

/** One market's bot: what it holds and what was put in and taken out (N01 §7). */
export interface BotBook {
  /** All Coin the bot holds in this market, the Coin locked in its orders included. */
  readonly coin: bigint;
  /** Contracts held, those locked in sell orders included. */
  readonly yesQty: number;
  readonly noQty: number;
  /** 누적 투입 자금: the allocation A and every addition. */
  readonly invested: bigint;
  /** 이미 금고로 회수한 자금. */
  readonly recovered: bigint;
}

/** A resting order of the bot, or one it is about to place. */
export interface BotOrder {
  readonly outcome: Outcome;
  readonly side: OrderSide;
  readonly priceCoin: number;
  /** The quantity still open. */
  readonly qty: number;
}

/** A live order of the bot as the plan reads it. */
export interface PlanBotOrder extends BotOrder {
  /** A cancel was asked for and has not completed: still live (ADR-0058 결정 1의 7). */
  readonly cancelPending?: boolean;
}

export interface LiveBotOrder extends PlanBotOrder {
  readonly id: string;
}

/** L and the stage policy. The thresholds and the ratio are release settings (결정 1의 12). */
export interface RiskLimits {
  /** 최대 손실 L, in Coin. */
  readonly maxLoss: bigint;
  /** The utilization (basis points of L) from which the stage is `reduce`: 7000 proposed. */
  readonly reduceAtBp: number;
  /** The utilization from which the stage is `halt`: 9000 proposed. */
  readonly haltAtBp: number;
  /** At `reduce`, risk-raising contracts per direction ≤ 기본 물량 × this (bp, ≤ 5000). */
  readonly reduceRatioBp: number;
}

const BP = 10_000n;

function assertCoin(name: string, value: bigint, min: bigint): void {
  if (typeof value !== 'bigint' || value < min) {
    throw new RangeError(
      `${name} must be a bigint of at least ${String(min)}, got ${String(value)}`,
    );
  }
}

export function assertBotBook(book: BotBook): void {
  assertCoin('coin', book.coin, 0n);
  assertWhole('yesQty', book.yesQty, 0);
  assertWhole('noQty', book.noQty, 0);
  assertCoin('invested', book.invested, 0n);
  assertCoin('recovered', book.recovered, 0n);
}

export function assertRiskLimits(limits: RiskLimits): void {
  assertCoin('maxLoss', limits.maxLoss, 1n);
  assertWhole('reduceAtBp', limits.reduceAtBp, 0);
  assertWhole('haltAtBp', limits.haltAtBp, limits.reduceAtBp);
  if (limits.haltAtBp > Number(BP)) {
    throw new RangeError(`haltAtBp must be at most ${String(BP)}, got ${String(limits.haltAtBp)}`);
  }
  assertWhole('reduceRatioBp', limits.reduceRatioBp, 0);
  if (limits.reduceRatioBp > 5_000) {
    // N01 §7: at `reduce` the risk-raising quantity is at most half the default.
    throw new RangeError(`reduceRatioBp must be at most 5000, got ${String(limits.reduceRatioBp)}`);
  }
}

/** RangeError unless the order is a known outcome and side, on the price grid, for qty ≥ 1. */
export function assertBotOrder(order: BotOrder, terms: ContractTerms): void {
  if (!OUTCOMES.includes(order.outcome)) {
    throw new RangeError(`outcome must be YES or NO, got ${String(order.outcome)}`);
  }
  if (!ORDER_SIDES.includes(order.side)) {
    throw new RangeError(`side must be buy or sell, got ${String(order.side)}`);
  }
  assertWhole('priceCoin', order.priceCoin, terms.priceMinCoin);
  if (order.priceCoin > terms.priceMaxCoin || order.priceCoin % terms.tickCoin !== 0) {
    throw new RangeError(`priceCoin must be on the price grid, got ${String(order.priceCoin)}`);
  }
  assertWhole('qty', order.qty, 1);
}

/** What one `outcome` contract pays on `result`. */
function payout(outcome: Outcome, result: ResultScenario, terms: ContractTerms): bigint {
  if (result === 'VOID') {
    return BigInt(outcome === 'YES' ? terms.voidPayoutYesCoin : terms.voidPayoutNoCoin);
  }
  return outcome === result ? BigInt(terms.payoutCoin) : 0n;
}

function byResult(f: (result: ResultScenario) => bigint): ByResult<bigint> {
  return { YES: f('YES'), NO: f('NO'), VOID: f('VOID') };
}

/** PnL on each result from what the bot holds now (N01 §7). */
export function resultPnl(book: BotBook, terms: ContractTerms): ByResult<bigint> {
  assertBotBook(book);
  assertContractTerms(terms);
  return byResult(
    (result) =>
      book.coin +
      BigInt(book.yesQty) * payout('YES', result, terms) +
      BigInt(book.noQty) * payout('NO', result, terms) +
      book.recovered -
      book.invested,
  );
}

/** How each result's PnL moves if the whole order fills at its own price. */
export function orderPnlDelta(order: BotOrder, terms: ContractTerms): ByResult<bigint> {
  assertBotOrder(order, terms);
  const qty = BigInt(order.qty);
  const price = BigInt(order.priceCoin);
  return byResult((result) => {
    const perContract = payout(order.outcome, result, terms) - price;
    return qty * (order.side === 'buy' ? perContract : -perContract);
  });
}

/** max(0, −PnL) over the results. */
export function worstLoss(pnl: ByResult<bigint>): bigint {
  return RESULT_SCENARIOS.reduce((worst, result) => {
    const loss = -pnl[result];
    return loss > worst ? loss : worst;
  }, 0n);
}

const add = (a: ByResult<bigint>, b: ByResult<bigint>): ByResult<bigint> =>
  byResult((result) => a[result] + b[result]);

/** Only the results an order loses on: min(0, Δ) for each. */
const adverse = (delta: ByResult<bigint>): ByResult<bigint> =>
  byResult((result) => (delta[result] < 0n ? delta[result] : 0n));

/** Holdings PnL plus, for each result, every resting order that loses on it (결정 1의 9). */
export function reservedPnl(
  book: BotBook,
  orders: readonly BotOrder[],
  terms: ContractTerms,
): ByResult<bigint> {
  return orders.reduce(
    (pnl, order) => add(pnl, adverse(orderPnlDelta(order, terms))),
    resultPnl(book, terms),
  );
}

/** The stage for a worst loss on holdings (결정 1의 8·12). */
export function riskStage(holdingsWorstLoss: bigint, limits: RiskLimits): RiskStage {
  assertRiskLimits(limits);
  const used = holdingsWorstLoss * BP;
  if (used >= BigInt(limits.haltAtBp) * limits.maxLoss) return 'halt';
  if (used >= BigInt(limits.reduceAtBp) * limits.maxLoss) return 'reduce';
  return 'normal';
}

export interface BotRisk {
  readonly pnl: ByResult<bigint>;
  readonly worstLoss: bigint;
  readonly reservedPnl: ByResult<bigint>;
  readonly reservedWorstLoss: bigint;
  /** worstLoss ÷ L in basis points, rounded down (above 10000 only once L was lowered). */
  readonly utilizationBp: bigint;
  readonly stage: RiskStage;
}

/** The figures #182 shows and the stage the quotes follow, for one market's bot. */
export function botRisk(
  book: BotBook,
  liveOrders: readonly BotOrder[],
  limits: RiskLimits,
  terms: ContractTerms,
): BotRisk {
  assertRiskLimits(limits);
  const pnl = resultPnl(book, terms);
  const reserved = reservedPnl(book, liveOrders, terms);
  const loss = worstLoss(pnl);
  return {
    pnl,
    worstLoss: loss,
    reservedPnl: reserved,
    reservedWorstLoss: worstLoss(reserved),
    utilizationBp: (loss * BP) / limits.maxLoss,
    stage: riskStage(loss, limits),
  };
}

/**
 * Whether adding `delta`'s adverse part to `reserved` is within L (결정 1의 10, 결정 2): every
 * result it lowers must end at −L or above. A result it does not lower may stay where it is,
 * above L or not.
 */
function withinLimit(
  reserved: ByResult<bigint>,
  delta: ByResult<bigint>,
  maxLoss: bigint,
): boolean {
  return RESULT_SCENARIOS.every(
    (result) => delta[result] >= 0n || reserved[result] + delta[result] >= -maxLoss,
  );
}

export type BotOrderCheck = 'ok' | 'insufficient_coin' | 'insufficient_contracts' | 'loss_limit';

/**
 * The check a new bot order passes before it rests (N01 §7 "새 주문 … 원자적으로 가용 자산·위험
 * 한도를 검사"): Coin for a buy, unlocked contracts for a sell, and the loss limit with every
 * live order (pending cancels included) reserved. The caller runs it in the same transaction
 * as the order.
 */
export function checkBotOrder(
  book: BotBook,
  liveOrders: readonly BotOrder[],
  order: BotOrder,
  limits: RiskLimits,
  terms: ContractTerms,
): BotOrderCheck {
  assertRiskLimits(limits);
  const reserved = reservedPnl(book, liveOrders, terms);
  const delta = orderPnlDelta(order, terms);
  const lockedCoin = liveOrders
    .filter((o) => o.side === 'buy')
    .reduce((sum, o) => sum + BigInt(o.priceCoin) * BigInt(o.qty), 0n);
  const lockedQty = (outcome: Outcome) =>
    liveOrders
      .filter((o) => o.side === 'sell' && o.outcome === outcome)
      .reduce((sum, o) => sum + o.qty, 0);
  if (order.side === 'buy') {
    if (BigInt(order.priceCoin) * BigInt(order.qty) > book.coin - lockedCoin) {
      return 'insufficient_coin';
    }
  } else {
    const held = order.outcome === 'YES' ? book.yesQty : book.noQty;
    if (order.qty > held - lockedQty(order.outcome)) return 'insufficient_contracts';
  }
  return withinLimit(reserved, delta, limits.maxLoss) ? 'ok' : 'loss_limit';
}

/**
 * How much of a resting bot order may fill now (N01 §7 "각 체결은 원자적으로 … 검사", 결정 1의
 * 13): the most of `requestedQty` after which, with the order's remainder cancelled, no result's
 * reserved loss ends above L, or grows if it is already above L (결정 2). The caller fills that
 * much, cancels the bot's remainder and lets the incoming order go on to the next quote.
 * `otherLiveOrders` are the bot's other live orders. A properly reserved order always fills in
 * full; less only after L was lowered or a reservation was wrong.
 */
export function maxBotFillQty(
  book: BotBook,
  otherLiveOrders: readonly BotOrder[],
  order: BotOrder,
  requestedQty: number,
  limits: RiskLimits,
  terms: ContractTerms,
): number {
  assertRiskLimits(limits);
  assertBotOrder(order, terms);
  assertWhole('requestedQty', requestedQty, 0);
  const base = reservedPnl(book, otherLiveOrders, terms);
  const perContract = orderPnlDelta({ ...order, qty: 1 }, terms);
  let fill = Math.min(requestedQty, order.qty);
  for (const result of RESULT_SCENARIOS) {
    const step = perContract[result];
    if (step >= 0n) continue;
    const room = base[result] + limits.maxLoss;
    const fits = room <= 0n ? 0n : room / -step;
    if (fits < BigInt(fill)) fill = Number(fits);
  }
  return fill;
}

/** The two directions of supply: `yesBids` push the YES price down, `noBids` push it up. */
export type QuoteDirection = 'yesBids' | 'noBids';

/** The ladder trimmed to the stage, L and the Coin (결정 1의 6·11, 결정 2, ADR-0058). */
export interface PlannedQuotes {
  readonly stage: RiskStage;
  /**
   * Some result's reserved loss — holdings and pending cancels — is past L. Then only quotes
   * that do not raise the worst loss on holdings are planned, whatever the stage (결정 2).
   */
  readonly overLimit: boolean;
  /** The direction the Coin went to first; its orders are placed first (결정 1의 6). */
  readonly first: QuoteDirection;
  readonly yesBids: readonly QuoteLevel[];
  readonly noBids: readonly QuoteLevel[];
}

const DIRECTION_OUTCOME: Readonly<Record<QuoteDirection, Outcome>> = {
  yesBids: 'YES',
  noBids: 'NO',
};

/**
 * The direction an order adds supply to: buying YES and selling NO push the YES price down
 * (`yesBids`), buying NO and selling YES push it up (`noBids`).
 */
function directionOf(order: BotOrder): QuoteDirection {
  return (order.outcome === 'YES') === (order.side === 'buy') ? 'yesBids' : 'noBids';
}

const unitsOf = (levels: readonly QuoteLevel[]): number[] =>
  levels.flatMap((level) => Array.from({ length: level.qty }, () => level.priceCoin));

function levelsOf(prices: readonly number[]): QuoteLevel[] {
  const levels: { priceCoin: number; qty: number }[] = [];
  for (const priceCoin of prices) {
    const last = levels.at(-1);
    if (last?.priceCoin === priceCoin) last.qty += 1;
    else levels.push({ priceCoin, qty: 1 });
  }
  return levels;
}

/** One contract on a direction's fill path: the bid it stands at and what filling it does. */
interface PathUnit {
  readonly bidCoin: number;
  readonly delta: ByResult<bigint>;
}

/**
 * Pending cancels as contracts on their direction's path, in the order they would fill: higher
 * bids first, input (time) order on a tie. A sell stands where a bid of P − price would.
 */
function pendingPath(
  direction: QuoteDirection,
  pendingCancelOrders: readonly BotOrder[],
  terms: ContractTerms,
): PathUnit[] {
  return pendingCancelOrders
    .filter((order) => directionOf(order) === direction)
    .flatMap((order) => {
      const unit: PathUnit = {
        bidCoin: order.side === 'buy' ? order.priceCoin : terms.payoutCoin - order.priceCoin,
        delta: orderPnlDelta({ ...order, qty: 1 }, terms),
      };
      return Array.from({ length: order.qty }, () => unit);
    })
    .sort((a, b) => b.bidCoin - a.bidCoin);
}

/**
 * Trims a quote ladder (#127) to what the bot may post (#128). `liveOrders` are all the bot's live
 * orders in this market; those whose cancel is pending stay live and the others are what the plan
 * replaces. Each direction is walked along the path its contracts would fill in, best price first:
 *
 * - Pending cancels stay live (결정 1의 7). They take their place on the path by price (ahead of
 *   a new contract at the same price, being older), count toward 기본 물량 — so the direction
 *   posts that many fewer — and their Coin and reserved loss are spent.
 * - A new contract is priced at the curve position it would actually fill at: the n-th contract
 *   on the path, pending ones included, takes the ladder's n-th price. So pending cancels ahead
 *   of it push it down the curve and the bot never bids above the curve for its new orders.
 * - A contract raises the risk when filling it after everything ahead on the path would raise
 *   the worst loss on holdings (결정 1의 10). At `reduce` the path holds at most
 *   기본 물량 × ratio such contracts, pending ones counted: those ahead of a new contract by what
 *   they do, those behind it as raising. At `halt`, or while some result's reserved loss — with
 *   every live order — is past L (결정 2), no new one. Contracts that lower the risk stay
 *   (결정 1의 11).
 * - Every new contract is reserved; one that would take a result's reserved loss past L — or
 *   further past a lowered L — is not posted (결정 1의 10, 결정 2).
 * - The Coin goes first to the direction whose best contract lowers the worst loss (or raises it
 *   least; YES on a tie), best price first, so the far levels go first (결정 1의 6).
 *
 * A direction ends at the first new contract it may not post. `reconcileBotQuotes` sets the live
 * orders not pending a cancel against the plan; the ones it cancels stay live until the cancel
 * completes, and each order the bot places still passes `checkBotOrder` against everything live
 * at that moment.
 */
export function planBotQuotes(
  ladder: QuoteLadder,
  book: BotBook,
  liveOrders: readonly PlanBotOrder[],
  quantity: number,
  limits: RiskLimits,
  terms: ContractTerms,
): PlannedQuotes {
  assertWhole('quantity', quantity, 1);
  const pendingCancelOrders = liveOrders.filter((o) => o.cancelPending === true);
  const risk = botRisk(book, pendingCancelOrders, limits, terms);
  // 결정 2: the reserved loss is the book's, with every live order (결정 1의 9).
  const overLimit = worstLoss(reservedPnl(book, liveOrders, terms)) > limits.maxLoss;
  // 결정 1의 11: 기본 물량 × the ratio at `reduce`, none at `halt`; 결정 2: none past L.
  const raiseBudget = overLimit
    ? 0
    : {
        normal: quantity,
        reduce: Math.floor((quantity * limits.reduceRatioBp) / Number(BP)),
        halt: 0,
      }[risk.stage];
  let reserved = risk.reservedPnl;
  let freeCoin =
    book.coin -
    pendingCancelOrders
      .filter((o) => o.side === 'buy')
      .reduce((sum, o) => sum + BigInt(o.priceCoin) * BigInt(o.qty), 0n);

  const unitDelta = (direction: QuoteDirection, priceCoin: number) =>
    orderPnlDelta({ outcome: DIRECTION_OUTCOME[direction], side: 'buy', priceCoin, qty: 1 }, terms);
  /** How much the first contract of a direction moves the worst loss on holdings. */
  const firstRise = (direction: QuoteDirection): bigint => {
    const first = ladder[direction][0];
    if (first === undefined) return 0n;
    return worstLoss(add(risk.pnl, unitDelta(direction, first.priceCoin))) - risk.worstLoss;
  };
  const order: QuoteDirection[] =
    firstRise('noBids') < firstRise('yesBids') ? ['noBids', 'yesBids'] : ['yesBids', 'noBids'];

  const planned: Record<QuoteDirection, number[]> = { yesBids: [], noBids: [] };
  for (const direction of order) {
    const curve = unitsOf(ladder[direction]);
    const waiting = pendingPath(direction, pendingCancelOrders, terms);
    let pnl = risk.pnl;
    let raised = 0;
    let next = 0; // the next pending contract on the path
    for (let position = 0; ; position++) {
      const priceCoin = curve[position];
      const ahead = waiting[next];
      if (ahead !== undefined && (priceCoin === undefined || ahead.bidCoin >= priceCoin)) {
        const after = add(pnl, ahead.delta);
        if (worstLoss(after) > worstLoss(pnl)) raised += 1;
        pnl = after;
        next += 1;
        continue;
      }
      // Every pending contract counts toward 기본 물량, wherever it stands on the path.
      if (priceCoin === undefined || planned[direction].length + waiting.length >= quantity) break;
      const delta = unitDelta(direction, priceCoin);
      const after = add(pnl, delta);
      const raises = worstLoss(after) > worstLoss(pnl);
      // The pending contracts still behind may raise the risk when they fill: count them so.
      if (raises && raised + (waiting.length - next) >= raiseBudget) break;
      if (!withinLimit(reserved, delta, limits.maxLoss)) break;
      if (BigInt(priceCoin) > freeCoin) break;
      planned[direction].push(priceCoin);
      if (raises) raised += 1;
      pnl = after;
      reserved = add(reserved, adverse(delta));
      freeCoin -= BigInt(priceCoin);
    }
  }
  return {
    stage: risk.stage,
    overLimit,
    first: order[0]!,
    yesBids: levelsOf(planned.yesBids),
    noBids: levelsOf(planned.noBids),
  };
}

export interface BotQuoteChanges {
  /** Live orders to cancel, whole or in part (`qty` is how much). */
  readonly cancel: readonly { readonly id: string; readonly qty: number }[];
  /** Buy orders to place. */
  readonly place: readonly BotOrder[];
}

/**
 * The orders that do not fit a plan (#128 "줄이거나 취소할 봇 대기 주문") and the ones to add.
 * `liveOrders` are the bot's live orders in time priority; those whose cancel is pending are left
 * alone (they are on their way out, and the plan already counted them). At a planned price
 * the earlier ones are kept first, the excess is cancelled from the later ones, and what the
 * plan still lacks is placed. Orders at other prices and any sell order are cancelled.
 *
 * `place` lists the plan's first direction first, best price first in each, which is the order
 * the plan gave the Coin out in (결정 1의 6). #129 cancels (#178), then places in that order. A
 * placement that `checkBotOrder` refuses — the Coin of a cancel not yet done is still locked —
 * ends its direction there, so no farther level goes in ahead of a nearer one.
 */
export function reconcileBotQuotes(
  plan: Pick<PlannedQuotes, 'first' | 'yesBids' | 'noBids'>,
  liveOrders: readonly LiveBotOrder[],
): BotQuoteChanges {
  const cancel: { id: string; qty: number }[] = [];
  const place: BotOrder[] = [];
  const directions: QuoteDirection[] =
    plan.first === 'noBids' ? ['noBids', 'yesBids'] : ['yesBids', 'noBids'];
  for (const direction of directions) {
    const outcome = DIRECTION_OUTCOME[direction];
    const wanted = new Map(plan[direction].map((level) => [level.priceCoin, level.qty]));
    for (const order of liveOrders) {
      if (order.outcome !== outcome || order.cancelPending === true) continue;
      const left = order.side === 'buy' ? (wanted.get(order.priceCoin) ?? 0) : 0;
      const keep = Math.min(left, order.qty);
      if (keep > 0) wanted.set(order.priceCoin, left - keep);
      if (keep < order.qty) cancel.push({ id: order.id, qty: order.qty - keep });
    }
    for (const [priceCoin, qty] of wanted) {
      if (qty > 0) place.push({ outcome, side: 'buy', priceCoin, qty });
    }
  }
  return { cancel, place };
}
