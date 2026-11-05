import { CONTRACT_TERMS, isContractPrice, pairPrices } from './contract.js';
import {
  ORDER_SIDES,
  OUTCOMES,
  TIME_IN_FORCES,
  type OrderSide,
  type Outcome,
  type TimeInForce,
} from './enums.js';
import { assertWhole } from './market-maker/validate.js';

/*
 * 매칭 규칙 (#117, ADR-0111; ADR-0107 결정 1 #177 3·4·5·7·8·11·12항, 결정 2 #73 11항; N01 §4·§8;
 * D17): which resting orders an incoming order meets, in what order, at what price and how many,
 * and why it stopped. The order intake (#119) runs it under the market lock on the market's whole
 * live book and records what it plans through #118's two fill processes (`fillProcessInput`); the
 * public quote, best price and depth (#179) run the same walk as a dry run with no owner, so a
 * quote on an unchanged book equals the fill (#179), and the simulation (#71) and scenarios
 * (#131) run it on an in-memory book with each order's real owner (`bookAfterMatch`). Pure: no
 * clock, randomness or I/O, inputs never mutated; Coin is bigint, quantities and prices
 * safe-integer numbers.
 *
 * One line per incoming order: a buy of X walks the resting sells of X at their price and the
 * resting buys of the opposite outcome at payout − their price (환산: the pair they would mint
 * together), merged by price then original arrival; a sell of X walks the buys of X only (no
 * cross-sell). A fill is at the resting order's price, never past the incoming limit, and the
 * walk stops — keeping what it filled — at the first entry it cannot take: none left, beyond the
 * limit, beyond the budget, or of the incoming owner's self-trade group. Users and the 운영
 * 마켓메이커 match by the same rules; the self-trade group is the only place an account's kind
 * enters (`sameSelfTradeGroup`).
 */

/**
 * What a fill is (#118's two processes): `trade` moves existing contracts from a seller to a
 * buyer of the same outcome; `pair_mint` turns a buy of each outcome into a new pair. No burn:
 * sells never meet the opposite outcome (#177 4항, N01 §4).
 */
export const MATCH_FILL_KINDS = ['trade', 'pair_mint'] as const;
export type MatchFillKind = (typeof MATCH_FILL_KINDS)[number];

/**
 * Why a walk stopped (#177 7·8항): `filled` the whole quantity; `budget_spent` the budget cannot
 * buy the next contract (금액 부족 with no fill, else 전량 체결); `no_quote` no opposite entry left
 * (호가 부족, also when the bot is not quoting); `price_limit` the next entry is beyond the limit
 * (가격 한도); `self_trade` the next entry is the incoming owner's group's (자기 체결).
 */
export const MATCH_STOPS = [
  'filled',
  'budget_spent',
  'no_quote',
  'price_limit',
  'self_trade',
] as const;
export type MatchStop = (typeof MATCH_STOPS)[number];

/** Who owns an order, as the self-trade rule reads it (#177 5항, #73 11항). */
export interface OrderOwner {
  readonly id: string;
  /**
   * Whether the account is a person's, from the one rule only (`isHumanAccountType`, or
   * `isHumanAccountSql` / `isHumanAccountTypeSql` in @buddha/db).
   */
  readonly human: boolean;
}

/** A live resting order (대기·부분 체결) of one market. A budget order never rests. */
export interface BookOrder {
  readonly id: string;
  readonly owner: OrderOwner;
  readonly outcome: Outcome;
  readonly side: OrderSide;
  /** Its limit, which is the price it fills at (N01 §4). */
  readonly priceCoin: number;
  /** qty − filled, at least 1. */
  readonly remainingQty: number;
  /**
   * The server's arrival order: a unique safe integer, lower is earlier, set at insert and kept
   * when the order is partly filled (#119's key; never `created_at` or the id).
   */
  readonly arrival: number;
}

interface IncomingBase {
  /**
   * null: only a quote (#179's anonymous or dry-run quote) — no self-trade check, never applied.
   * A simulation or scenario run (#71, #131) passes each order's real owner, so the self-trade
   * stop and the non-person bundle hold as in #119 (#73 11항).
   */
  readonly owner: OrderOwner | null;
  readonly outcome: Outcome;
  /** The limit as #119 narrowed it (#177 2항). The matcher never widens it. */
  readonly limitPriceCoin: number;
}

/**
 * The order being matched: a quantity order (GTC or IOC), or the IOC Coin-amount buy of #177
 * 3항, which spends at most its budget within its price limit.
 */
export type IncomingOrder =
  | (IncomingBase & {
      readonly side: OrderSide;
      readonly timeInForce: TimeInForce;
      readonly qty: number;
      readonly budgetCoin: null;
    })
  | (IncomingBase & {
      readonly side: 'buy';
      readonly timeInForce: 'ioc';
      readonly qty: null;
      readonly budgetCoin: bigint;
    });

/** One entry of the line an incoming order walks. */
export interface MatchLineEntry {
  readonly order: BookOrder;
  readonly kind: MatchFillKind;
  /** Its price in the incoming contract: its own, or payout − its price for an opposite buy. */
  readonly priceCoin: number;
}

export interface MatchFill {
  readonly kind: MatchFillKind;
  readonly restingOrderId: string;
  readonly restingOwnerId: string;
  readonly qty: number;
  /** Per contract in the incoming contract: paid (buy) or received (sell); the budget's spend. */
  readonly priceCoin: number;
  /** The resting order's own price (the fill price, N01 §4; a pair mint's resting leg price). */
  readonly restingPriceCoin: number;
  /** The YES price the fill records (#177 11항): a pair mint's one price; a NO trade's 100 − p. */
  readonly yesPriceCoin: number;
  /** priceCoin × qty: the fill's amount and its volume (#177 12항: incoming price × qty). */
  readonly amountCoin: bigint;
  /** What the resting order has left after this fill (0 → 전량 체결, else 부분 체결). */
  readonly restingRemainingQty: number;
}

export interface MatchResult {
  /**
   * In walk order; at most one per resting order. Never public: a row is one resting order's
   * size and place, and `restingPriceCoin` against `priceCoin` tells its kind (#177 4항). A
   * public quote (#179) sends only this result's totals.
   */
  readonly fills: readonly MatchFill[];
  readonly filledQty: number;
  /** Σ amountCoin: paid by a buy, received by a sell. */
  readonly amountCoin: bigint;
  readonly stop: MatchStop;
  /** 'rest': a GTC remainder rests at its limit. 'cancel': it ends. 'none': nothing is left. */
  readonly remainder: 'none' | 'rest' | 'cancel';
  /** qty − filledQty for a quantity order; null for a budget order. */
  readonly remainingQty: number | null;
  /** budget − amountCoin for a budget order (#119 releases and records it); null otherwise. */
  readonly unspentCoin: bigint | null;
  /** The distinct resting owners of the fills in walk order, for `lockOrderHolders`. */
  readonly counterpartyOwnerIds: readonly string[];
}

/** One buyer of a fill: structurally @buddha/db `BuyLeg`. */
export interface FillBuyLeg {
  readonly ownerId: string;
  readonly limitPriceCoin: number | null;
}

/**
 * Which of #118's processes a fill calls, and its argument without `marketId`, `fillId` (#119's
 * fill row) and `at`: `applyTradeFill` or `applyPairMintFill`.
 */
export type FillProcessInput =
  | {
      readonly process: 'trade';
      readonly input: {
        readonly outcome: Outcome;
        readonly qty: number;
        readonly priceCoin: number;
        readonly buyer: FillBuyLeg;
        readonly sellerId: string;
      };
    }
  | {
      readonly process: 'pair_mint';
      readonly input: {
        readonly qty: number;
        readonly yesPriceCoin: number;
        readonly yes: FillBuyLeg;
        readonly no: FillBuyLeg;
      };
    };

/**
 * Whether two owners are one self-trade group (#177 5항, #73 11항, ADR-0108 결과 5): the same
 * account, or two accounts that are not a person's — every such account (today the one 운영
 * 마켓메이커, any later one too) is one bundle, so bot-to-bot fills never happen. The matcher's
 * only rule that tells accounts apart (N01 §5·§8).
 */
export function sameSelfTradeGroup(a: OrderOwner, b: OrderOwner): boolean {
  return a.id === b.id || (!a.human && !b.human);
}

// ---- validation: a RangeError is a caller's bug, never a member-facing reason ------------------

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

function assertOwner(owner: OrderOwner, humanById: Map<string, boolean>): void {
  if (!isNonEmptyString(owner.id)) throw new RangeError('an owner needs a non-empty id');
  if (typeof owner.human !== 'boolean') {
    throw new RangeError(`owner ${owner.id}'s human must be a boolean`);
  }
  const known = humanById.get(owner.id);
  if (known !== undefined && known !== owner.human) {
    throw new RangeError(`owner ${owner.id} is given as a person and as not a person`);
  }
  humanById.set(owner.id, owner.human);
}

function assertBook(book: readonly BookOrder[], humanById: Map<string, boolean>): void {
  const ids = new Set<string>();
  const arrivals = new Set<number>();
  for (const order of book) {
    if (!isNonEmptyString(order.id)) throw new RangeError('a book order needs a non-empty id');
    if (ids.has(order.id)) throw new RangeError(`book order ${order.id} is given twice`);
    ids.add(order.id);
    assertOwner(order.owner, humanById);
    if (!OUTCOMES.includes(order.outcome)) {
      throw new RangeError(`book order ${order.id} has no outcome ${String(order.outcome)}`);
    }
    if (!ORDER_SIDES.includes(order.side)) {
      throw new RangeError(`book order ${order.id} has no side ${String(order.side)}`);
    }
    if (!isContractPrice(order.priceCoin)) {
      throw new RangeError(
        `book order ${order.id}'s price must be a contract price, got ${String(order.priceCoin)}`,
      );
    }
    assertWhole('remainingQty', order.remainingQty, 1);
    assertWhole('arrival', order.arrival, 0);
    if (arrivals.has(order.arrival)) {
      throw new RangeError(`arrival ${String(order.arrival)} is given twice`);
    }
    arrivals.add(order.arrival);
  }
}

function assertIncoming(incoming: IncomingOrder, humanById: Map<string, boolean>): void {
  if (incoming.owner !== null) assertOwner(incoming.owner, humanById);
  if (!OUTCOMES.includes(incoming.outcome)) {
    throw new RangeError(`no outcome ${String(incoming.outcome)}`);
  }
  if (!ORDER_SIDES.includes(incoming.side))
    throw new RangeError(`no side ${String(incoming.side)}`);
  if (!TIME_IN_FORCES.includes(incoming.timeInForce)) {
    throw new RangeError(`no time in force ${String(incoming.timeInForce)}`);
  }
  if (!isContractPrice(incoming.limitPriceCoin)) {
    throw new RangeError(
      `the limit must be a contract price, got ${String(incoming.limitPriceCoin)}`,
    );
  }
  if (incoming.budgetCoin === null) {
    assertWhole('qty', incoming.qty, 1);
    return;
  }
  if (incoming.qty !== null) throw new RangeError('an order has a quantity or a budget, not both');
  if (typeof incoming.budgetCoin !== 'bigint' || incoming.budgetCoin < 1n) {
    throw new RangeError(`a budget must be a positive bigint, got ${String(incoming.budgetCoin)}`);
  }
  if (incoming.side !== 'buy' || incoming.timeInForce !== 'ioc') {
    throw new RangeError('a budget order is an IOC buy (#177 3항)');
  }
}

// ---- the line -----------------------------------------------------------------------------------

function lineOf(book: readonly BookOrder[], outcome: Outcome, side: OrderSide): MatchLineEntry[] {
  const entries: MatchLineEntry[] = [];
  for (const order of book) {
    if (side === 'buy') {
      if (order.outcome === outcome && order.side === 'sell') {
        entries.push({ order, kind: 'trade', priceCoin: order.priceCoin });
      } else if (order.outcome !== outcome && order.side === 'buy') {
        entries.push({
          order,
          kind: 'pair_mint',
          priceCoin: CONTRACT_TERMS.payoutCoin - order.priceCoin,
        });
      }
    } else if (order.outcome === outcome && order.side === 'buy') {
      entries.push({ order, kind: 'trade', priceCoin: order.priceCoin });
    }
  }
  // Better price first — the lowest for a buy, the highest for a sell — then original arrival,
  // across both kinds (#177 4항, N01 §4). Arrivals are unique, so the order is total.
  const better = side === 'buy' ? 1 : -1;
  return entries.sort(
    (a, b) => better * (a.priceCoin - b.priceCoin) || a.order.arrival - b.order.arrival,
  );
}

/**
 * The line a buy or a sell of `outcome` walks, best first (#177 4항, N01 §4): for a buy the
 * resting sells of `outcome` (`trade`) and the resting buys of the opposite outcome at payout −
 * their price (`pair_mint`), by ascending price then arrival; for a sell the resting buys of
 * `outcome` only, by descending price then arrival. Each resting order is in it at most once, and
 * only real orders are in it (never a complement of same-contract bids), so a depth, best price
 * or fillable quantity built from one line counts each order once (#177 4항 중복). Its first
 * entry is the 최우선 반대 호가 #119's price protection reads (#177 2항); an empty line is '호가
 * 없음' (#179). RangeError on a malformed book.
 */
export function matchLine(
  book: readonly BookOrder[],
  outcome: Outcome,
  side: OrderSide,
): readonly MatchLineEntry[] {
  assertBook(book, new Map());
  if (!OUTCOMES.includes(outcome)) throw new RangeError(`no outcome ${String(outcome)}`);
  if (!ORDER_SIDES.includes(side)) throw new RangeError(`no side ${String(side)}`);
  return lineOf(book, outcome, side);
}

// ---- the walk -----------------------------------------------------------------------------------

function fillOf(incoming: IncomingOrder, entry: MatchLineEntry, qty: number): MatchFill {
  const yesPriceCoin =
    incoming.outcome === 'YES' ? entry.priceCoin : CONTRACT_TERMS.payoutCoin - entry.priceCoin;
  return {
    kind: entry.kind,
    restingOrderId: entry.order.id,
    restingOwnerId: entry.order.owner.id,
    qty,
    priceCoin: entry.priceCoin,
    restingPriceCoin: entry.order.priceCoin,
    // pairPrices asserts the pair: both prices on the grid, summing to the payout.
    yesPriceCoin: pairPrices(yesPriceCoin).YES,
    amountCoin: BigInt(entry.priceCoin) * BigInt(qty),
    restingRemainingQty: entry.order.remainingQty - qty,
  };
}

/**
 * Matches `incoming` against `book`, the market's whole live book read under the market lock
 * (#119; never a book already filtered by the limit, which would turn 가격 한도 into 호가 부족). It
 * walks `matchLine` and at each entry stops, in this order, when:
 *
 * 1. a quantity order has nothing left (`filled`), or a budget has nothing left
 *    (`budget_spent`);
 * 2. no entry is left (`no_quote`);
 * 3. the entry is beyond the limit (`price_limit`);
 * 4. a budget cannot pay the entry's price (`budget_spent`: #177 3항 '다음 1계약을 살 수 없을
 *    때까지');
 * 5. the entry is the incoming owner's self-trade group's (`self_trade`; skipped for a quote).
 *
 * Otherwise it takes as much of the entry as the quantity or the budget allows, at the entry's
 * price. An entry is left only when it is used up, so a budget that buys part of one stops on it
 * at step 4, and one resting order gets at most one fill. Every stop is final: the line is sorted,
 * and the own order is never skipped to reach a later one (#177 5항). The fills made stay and the
 * own resting order is untouched.
 *
 * The remainder: nothing after `filled` or `budget_spent`; cancelled after `self_trade`, also for
 * a GTC (#177 7항); after `no_quote` or `price_limit` an IOC's is cancelled and a GTC's rests at
 * its limit — so a GTC rests only when the whole opposite line is beyond its limit, and the book
 * after a match is never crossed. #119 derives the order's state, reason and cancel reason from
 * the stop, the remainder and the fill count (ADR-0111). Exactly two parameters: no option widens
 * the limit or skips a check. RangeError on a malformed book or order.
 */
export function matchOrder(book: readonly BookOrder[], incoming: IncomingOrder): MatchResult {
  const humanById = new Map<string, boolean>();
  assertBook(book, humanById);
  assertIncoming(incoming, humanById);

  const line = lineOf(book, incoming.outcome, incoming.side);
  const budget = incoming.budgetCoin;
  const isBuy = incoming.side === 'buy';
  const fills: MatchFill[] = [];
  let filledQty = 0;
  let qtyLeft = incoming.qty ?? 0;
  let budgetLeft = budget ?? 0n;
  let index = 0;
  let stop: MatchStop;
  for (;;) {
    if (budget === null ? qtyLeft === 0 : budgetLeft < BigInt(CONTRACT_TERMS.priceMinCoin)) {
      stop = budget === null ? 'filled' : 'budget_spent';
      break;
    }
    const entry = line[index];
    if (entry === undefined) {
      stop = 'no_quote';
      break;
    }
    if (
      isBuy ? entry.priceCoin > incoming.limitPriceCoin : entry.priceCoin < incoming.limitPriceCoin
    ) {
      stop = 'price_limit';
      break;
    }
    if (budget !== null && budgetLeft < BigInt(entry.priceCoin)) {
      stop = 'budget_spent';
      break;
    }
    if (incoming.owner !== null && sameSelfTradeGroup(incoming.owner, entry.order.owner)) {
      stop = 'self_trade';
      break;
    }
    // A budget's count may pass 2^53 and round, but then it is above the remaining (a safe
    // integer) and the min takes the remaining; below it the count is exact.
    const affordable = budget === null ? qtyLeft : Number(budgetLeft / BigInt(entry.priceCoin));
    const take = Math.min(entry.order.remainingQty, affordable);
    // A quantity order's total is at most its own qty; a budget's sums resting quantities, which
    // are each safe but may not be together. Refuse rather than report a rounded total that
    // disagrees with the fills and the book after them.
    if (!Number.isSafeInteger(filledQty + take)) {
      throw new RangeError('The filled quantity passes the safe-integer range');
    }
    const fill = fillOf(incoming, entry, take);
    fills.push(fill);
    filledQty += take;
    qtyLeft -= take;
    budgetLeft -= fill.amountCoin;
    if (take === entry.order.remainingQty) index += 1;
  }

  const amountCoin = fills.reduce((sum, fill) => sum + fill.amountCoin, 0n);
  let remainder: MatchResult['remainder'];
  if (stop === 'filled' || stop === 'budget_spent') remainder = 'none';
  else if (stop === 'self_trade' || incoming.timeInForce === 'ioc') remainder = 'cancel';
  else remainder = 'rest';
  return {
    fills,
    filledQty,
    amountCoin,
    stop,
    remainder,
    remainingQty: budget === null ? qtyLeft : null,
    unspentCoin: budget === null ? null : budgetLeft,
    counterpartyOwnerIds: [...new Set(fills.map((fill) => fill.restingOwnerId))],
  };
}

/**
 * A planned fill as the argument of #118's process it calls (ADR-0110 결과 5: matching picks the
 * process; #119 adds `marketId`, `fillId` — its fill row's id — and `at`):
 *
 * - `trade` for a buy: the incoming owner buys at the resting sell's price, from its limit
 *   (the better-price difference goes back at the fill), from the resting owner;
 * - `trade` for a sell: the resting buyer buys at its own price (nothing to give back) from the
 *   incoming owner;
 * - `pair_mint`: the incoming leg on its outcome, the resting leg on the other at its own price;
 *   the YES price is the fill's one price (#177 11항), and the incoming leg's excess limit goes
 *   back (N01 §4: 65 − 60 = 5).
 *
 * The incoming leg of a budget order has no limit: its difference stays in the budget lock until
 * #119 releases `unspentCoin` (ADR-0110 결정 5). RangeError for a quote (no owner: never applied),
 * a pair mint on a sell, or a malformed order.
 */
export function fillProcessInput(incoming: IncomingOrder, fill: MatchFill): FillProcessInput {
  assertIncoming(incoming, new Map());
  const { owner } = incoming;
  if (owner === null) throw new RangeError('a quote has no owner and is never applied');
  const incomingLeg: FillBuyLeg = {
    ownerId: owner.id,
    limitPriceCoin: incoming.budgetCoin === null ? incoming.limitPriceCoin : null,
  };
  const restingLeg: FillBuyLeg = {
    ownerId: fill.restingOwnerId,
    limitPriceCoin: fill.restingPriceCoin,
  };
  if (fill.kind === 'trade') {
    const isBuy = incoming.side === 'buy';
    return {
      process: 'trade',
      input: {
        outcome: incoming.outcome,
        qty: fill.qty,
        priceCoin: fill.restingPriceCoin,
        buyer: isBuy ? incomingLeg : restingLeg,
        sellerId: isBuy ? fill.restingOwnerId : owner.id,
      },
    };
  }
  if (incoming.side !== 'buy') throw new RangeError('a sell never mints a pair (no cross-sell)');
  const yesIncoming = incoming.outcome === 'YES';
  return {
    process: 'pair_mint',
    input: {
      qty: fill.qty,
      yesPriceCoin: fill.yesPriceCoin,
      yes: yesIncoming ? incomingLeg : restingLeg,
      no: yesIncoming ? restingLeg : incomingLeg,
    },
  };
}

/**
 * The book after `result` (#71's simulation, #131's scenarios and the tests; #119's book is the
 * DB): used-up resting orders leave, partly filled ones keep their arrival and so their place
 * (N01 §4), and a GTC remainder that rests is added at its limit with `rest`'s id and arrival.
 * `rest` is read only when `result.remainder` is 'rest'. RangeError on a malformed book, a fill
 * of an order not in it or beyond its remaining, a resting remainder with no owner or no `rest`,
 * or a `rest` id or arrival already in the book.
 */
export function bookAfterMatch(
  book: readonly BookOrder[],
  incoming: IncomingOrder,
  result: MatchResult,
  rest?: { readonly id: string; readonly arrival: number },
): BookOrder[] {
  const humanById = new Map<string, boolean>();
  assertBook(book, humanById);
  assertIncoming(incoming, humanById);
  const filled = new Map<string, number>();
  for (const fill of result.fills) {
    filled.set(fill.restingOrderId, (filled.get(fill.restingOrderId) ?? 0) + fill.qty);
  }
  const after: BookOrder[] = [];
  for (const order of book) {
    const qty = filled.get(order.id) ?? 0;
    filled.delete(order.id);
    if (qty > order.remainingQty) {
      throw new RangeError(`order ${order.id} cannot fill ${String(qty)} of its remaining`);
    }
    if (qty < order.remainingQty) after.push({ ...order, remainingQty: order.remainingQty - qty });
  }
  const [unknownId] = filled.keys();
  if (unknownId !== undefined) {
    throw new RangeError(`a fill names order ${unknownId}, which is not in the book`);
  }
  if (result.remainder !== 'rest') return after;
  if (incoming.owner === null) throw new RangeError('a quote never rests');
  if (rest === undefined) throw new RangeError('a resting remainder needs its id and arrival');
  if (book.some((order) => order.id === rest.id || order.arrival === rest.arrival)) {
    throw new RangeError(`the remainder's id or arrival is already in the book`);
  }
  after.push({
    id: rest.id,
    owner: incoming.owner,
    outcome: incoming.outcome,
    side: incoming.side,
    priceCoin: incoming.limitPriceCoin,
    remainingQty: result.remainingQty as number,
    arrival: rest.arrival,
  });
  // The appended order is checked like every other (its id, arrival and quantity).
  assertBook(after, new Map());
  return after;
}
