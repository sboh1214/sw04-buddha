import { applySell, type PositionState } from './accounting.js';
import { PAYOUT_PER_CONTRACT_COIN, PRICE_MAX, PRICE_MIN, TICK_COIN } from './constants.js';
import type { OrderSide, OrderStatus, Outcome } from './enums.js';

/*
 * 완전 담보 계약 (#118, ADR-0110; ADR-0107 결정 1 #177 1·3·7항, 결정 2 #73 1·12·15항): the contract
 * values every market trades with, and the pure rules the asset engine (@buddha/db contracts.ts),
 * the order intake (#119), the matching (#117), the cancel and expiry (#178, #120) and the
 * reconciliation (#93) share — a pair's two prices, the lock an order takes and still holds, the
 * better-price difference released at a fill, and the books of the 운영 마켓메이커's pair burn.
 */

/**
 * The contract values: what a contract pays, the price grid and VOID's split. The market maker
 * computes with them as inputs (ADR-0058 결정 2), so `assertContractTerms` (market-maker/terms.ts)
 * checks any other grid it is handed.
 */
export interface ContractTerms {
  /** Coin a winning contract pays, and the collateral of a YES·NO pair (N01 §3). */
  readonly payoutCoin: number;
  /** The price step in Coin (N01 §3). */
  readonly tickCoin: number;
  /** The lowest and highest order price in Coin (N01 §3). */
  readonly priceMinCoin: number;
  readonly priceMaxCoin: number;
  /** What one YES and one NO contract pay on VOID (N03 §6); together they are the payout. */
  readonly voidPayoutYesCoin: number;
  readonly voidPayoutNoCoin: number;
}

/**
 * The approved contract values (ADR-0107 결정 1 #177 1항; VOID ADR-0093 #173 9항): a whole contract
 * paying 100 Coin — also the collateral of one YES·NO pair — a 1 Coin tick, prices 1–99 Coin, and
 * VOID paying 50 to each of YES and NO. One code constant for every market: no release setting, and
 * no value of a market or of a rule version (the rules area shows VOID from here, #23 ADR-0097).
 * Built from the primitives of constants.ts, which the zod DTOs, the accounting and the SQL copies
 * (the 1–99 of `orders_limit_price_check` and `markets_last_price_check`) use. Changing it takes a
 * new ADR and a code change of all of those, and never while any market holds unsettled contracts.
 */
export const CONTRACT_TERMS: ContractTerms = {
  payoutCoin: Number(PAYOUT_PER_CONTRACT_COIN),
  tickCoin: TICK_COIN,
  priceMinCoin: PRICE_MIN,
  priceMaxCoin: PRICE_MAX,
  voidPayoutYesCoin: 50,
  voidPayoutNoCoin: 50,
};

/** Whether `priceCoin` is a contract price: whole Coin on the tick inside PRICE_MIN..PRICE_MAX. */
export function isContractPrice(priceCoin: number): boolean {
  return (
    Number.isInteger(priceCoin) &&
    priceCoin >= PRICE_MIN &&
    priceCoin <= PRICE_MAX &&
    priceCoin % TICK_COIN === 0
  );
}

/**
 * A pair's two prices (N01 §4): YES pays `yesPriceCoin`, NO the rest of the payout, so the two
 * fund exactly one pair's collateral. RangeError unless both are contract prices.
 */
export function pairPrices(yesPriceCoin: number): Record<Outcome, number> {
  const noPriceCoin = CONTRACT_TERMS.payoutCoin - yesPriceCoin;
  if (!isContractPrice(yesPriceCoin) || !isContractPrice(noPriceCoin)) {
    throw new RangeError(
      `a pair's YES price must be a contract price, got ${String(yesPriceCoin)}`,
    );
  }
  return { YES: yesPriceCoin, NO: noPriceCoin };
}

function assertQty(qty: number): void {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new RangeError(`qty must be a positive integer, got ${String(qty)}`);
  }
}

/**
 * (limit − price) × qty: what a buy locked beyond what a fill at `priceCoin` costs — the
 * better-price difference of a trade fill, or a pair mint's excess limit (N01 §4: a YES buy at
 * 65 meeting a NO buy at 40 pays 60, and 5 goes back). RangeError when the price is above the
 * limit, either is not a contract price, or qty is not a positive integer.
 */
export function priceImprovementCoin(
  limitPriceCoin: number,
  priceCoin: number,
  qty: number,
): bigint {
  if (!isContractPrice(limitPriceCoin) || !isContractPrice(priceCoin)) {
    throw new RangeError(
      `prices must be contract prices, got ${String(limitPriceCoin)} and ${String(priceCoin)}`,
    );
  }
  assertQty(qty);
  if (priceCoin > limitPriceCoin) {
    throw new RangeError(
      `a fill at ${String(priceCoin)} is above the limit ${String(limitPriceCoin)}`,
    );
  }
  return BigInt(limitPriceCoin - priceCoin) * BigInt(qty);
}

/**
 * The statuses of an order that still rests in the book and holds its lock: 대기 and 부분 체결
 * (ADR-0107 결정 1 #177 7항). Every other status has ended, and an ended order holds nothing.
 */
export const LIVE_ORDER_STATUSES = [
  'open',
  'partially_filled',
] as const satisfies readonly OrderStatus[];

export function isLiveOrderStatus(status: OrderStatus): boolean {
  return (LIVE_ORDER_STATUSES as readonly OrderStatus[]).includes(status);
}

/** What an order holds locked: Coin of its holder's account, or contracts of one outcome. */
export type OrderLock =
  { kind: 'coin'; amountCoin: bigint } | { kind: 'contracts'; outcome: Outcome; qty: number };

/**
 * The facts of an order the lock rule reads. Today's `orders` row maps onto it; #119 adds the
 * budget when it reshapes the table, and its own rule for `live`.
 */
export interface OrderLockFacts {
  side: OrderSide;
  outcome: Outcome;
  /** A quantity buy's limit price; null for a sell and for a Coin-amount buy. */
  limitPriceCoin: number | null;
  /** The ordered quantity; null only for a Coin-amount (budget) buy. */
  qty: number | null;
  filledQty: number;
  /** The whole budget of an IOC Coin-amount buy (#177 3항); null for any other order. */
  budgetCoin: bigint | null;
  /** Whether the order still rests and holds its lock (`isLiveOrderStatus`, or #119's rule). */
  live: boolean;
}

function assertLockFacts(order: OrderLockFacts): void {
  if (!Number.isInteger(order.filledQty) || order.filledQty < 0) {
    throw new RangeError(
      `filledQty must be a non-negative integer, got ${String(order.filledQty)}`,
    );
  }
  if (order.budgetCoin !== null) {
    if (order.side !== 'buy' || order.qty !== null || order.limitPriceCoin !== null) {
      throw new RangeError('a budget is a Coin-amount buy, with no quantity or limit');
    }
    if (order.budgetCoin < 1n) {
      throw new RangeError(`a budget must be positive, got ${String(order.budgetCoin)}`);
    }
    return;
  }
  if (order.qty === null) throw new RangeError('an order with no budget needs a quantity');
  assertQty(order.qty);
  if (order.filledQty > order.qty) {
    throw new RangeError(`filledQty ${String(order.filledQty)} is above qty ${String(order.qty)}`);
  }
  if (order.side === 'buy') {
    if (order.limitPriceCoin === null || !isContractPrice(order.limitPriceCoin)) {
      throw new RangeError('a quantity buy locks at its limit, which must be a contract price');
    }
  } else if (order.limitPriceCoin !== null && !isContractPrice(order.limitPriceCoin)) {
    throw new RangeError('a sell limit must be a contract price');
  }
}

/**
 * The lock an order takes at intake (N01 §4; ADR-0107 결정 1 #177 3항): a quantity buy its limit ×
 * qty Coin, a Coin-amount buy its whole budget, a sell its qty contracts of its outcome. No fee
 * (#73 15항). RangeError on malformed facts (a budget on a sell, a buy with neither a budget nor
 * a limit and qty).
 */
export function orderIntakeLock(order: OrderLockFacts): OrderLock {
  assertLockFacts(order);
  if (order.budgetCoin !== null) return { kind: 'coin', amountCoin: order.budgetCoin };
  const qty = order.qty!;
  return order.side === 'buy'
    ? { kind: 'coin', amountCoin: BigInt(order.limitPriceCoin!) * BigInt(qty) }
    : { kind: 'contracts', outcome: order.outcome, qty };
}

/**
 * The lock a live order still holds — the rule #119 keeps and #93 reconciles (ADR-0107 결정 2 #73
 * 1항, 결정 1 #177 3항, fee 0 #73 15항): a live quantity buy limit × (qty − filledQty) Coin, a live
 * sell qty − filledQty contracts; a Coin-amount buy, or an order that is not live, nothing (an IOC
 * ends in its own processing, and every better-price difference is released at its fill). So an
 * account's locked Coin is the sum over its live buys, and a position's locked contracts the sum
 * over its live sells.
 */
export function orderRemainingLock(order: OrderLockFacts): OrderLock {
  assertLockFacts(order);
  const zero: OrderLock =
    order.side === 'buy'
      ? { kind: 'coin', amountCoin: 0n }
      : { kind: 'contracts', outcome: order.outcome, qty: 0 };
  if (!order.live || order.budgetCoin !== null) return zero;
  const remaining = order.qty! - order.filledQty;
  return order.side === 'buy'
    ? { kind: 'coin', amountCoin: BigInt(order.limitPriceCoin!) * BigInt(remaining) }
    : { kind: 'contracts', outcome: order.outcome, qty: remaining };
}

/**
 * The 운영 마켓메이커's pair burn on its two position rows (ADR-0107 결정 2 #73 12항): `qty` leave
 * each side as a sell whose proceeds are what VOID pays that side (`CONTRACT_TERMS`
 * voidPayoutYesCoin·voidPayoutNoCoin × qty), so the two realize together qty × payout minus the
 * cost they release. RangeError when qty is not a positive integer or above either side's qty.
 */
export function applyPairBurn(
  yes: PositionState,
  no: PositionState,
  qty: number,
): Record<Outcome, PositionState> {
  assertQty(qty);
  return {
    YES: applySell(yes, qty, BigInt(CONTRACT_TERMS.voidPayoutYesCoin) * BigInt(qty)),
    NO: applySell(no, qty, BigInt(CONTRACT_TERMS.voidPayoutNoCoin) * BigInt(qty)),
  };
}
