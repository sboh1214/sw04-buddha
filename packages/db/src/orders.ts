import {
  idempotencyKeySchema,
  intakeMarketGate,
  marketTradingRejectReason,
  intakeRemainderRelease,
  isContractPrice,
  isLiveOrderStatus,
  isOrderIntakeOpen,
  fillProcessInput,
  orderIntakeLock,
  ORDER_ACCEPTING_SETTING,
  ORDER_BUDGET_MAX_COIN,
  ORDER_QTY_MAX,
  planIntakeMatch,
  RELEASE_SETTINGS,
  requestTermsEqual,
  restingStateAfterFill,
  type AccountType,
  type BookOrder,
  type MarketFillStats,
  type MarketTradingFacts,
  type OrderLock,
  type OrderLockFacts,
  type OrderRejectReason,
  type OrderSide,
  type Outcome,
  type MatchFill,
  type OrderOwner,
  type ReleaseSettingsRegistry,
  type TimeInForce,
} from '@buddha/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { isHumanAccountTypeSql } from './account-types.js';
import type { Db } from './client.js';
import {
  applyPairMintFill,
  applyTradeFill,
  lockForOrder,
  lockOrderHolders,
  releaseForOrder,
  type PositionRow,
} from './contracts.js';
import type { BalanceRow, LedgerEntryRow } from './ledger.js';
import { newHumanParticipants, recordFillStats } from './market-stats.js';
import { getReleaseSetting } from './release-settings.js';
import { balances, fills, markets, orders, positions, user } from './schema/index.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

/*
 * 주문 접수와 체결 (#119, ADR-0112; ADR-0107 결정 1 #177 2·3·7·8·9·11·12·15항, 결정 3 '주문 접수', 결정 5 #119 rows;
 * ADR-0110 결정 4·8, ADR-0111 결정 6): the one writer of `fills` and of `orders` beside the cancel
 * (order-cancel.ts, #178 and the expiry #120), which ends live orders (order-writes.test.ts). One
 * intake runs in its caller's transaction — the API's for a member, after the checks that write no
 * row (the address and account rate limits, onboarding, `assertCanTrade`, the admin role, the shown
 * account), and the bot runtime's (M10 #129) for the 운영 마켓메이커 — and either writes nothing (the
 * request was answered before, intake is closed, no such public market) or writes the order once in
 * its final state of the intake, with every fill it made and, when it filled, the market's
 * statistics (#121, market-stats.ts: their one writer).
 *
 * Every writer of `orders` or `fills` holds the market's `lockMarket` (the arrival key is drawn
 * under it, and `fills_check` reads both orders by key trusting it). The lock order of an intake
 * (ADR-0112 10-16): (the API's: the caller's own profile FOR KEY SHARE, `assertCanTrade`) →
 * `lockMarket` (the API takes it before this call, to read the role under it; taken again here,
 * which holds nothing new) → (the API's: that profile FOR SHARE with its role) → the request lock
 * (its own advisory lock space) → the market row and the live book → every owner's Coin account at
 * once (`lockOrderHolders`) → positions under the market lock → the clock. Nothing an order holds
 * while it waits on a market lock is a lock a role grant waits for, and no global admin-roles lock
 * is taken. Coin and contracts move only through contracts.ts; this module writes no balance,
 * position or ledger entry.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Db | Tx;

export type OrderRow = typeof orders.$inferSelect;
export type FillRow = typeof fills.$inferSelect;

/** What a member (or the bot runtime) asks for: the terms a request id names. */
export interface PlaceOrderInput {
  /** The owner: a person, or the 운영 마켓메이커 (its holder is the market's 마켓메이커 자금). */
  ownerId: string;
  marketId: string;
  /** The request id (`Idempotency-Key`), unique per owner: `orders.idempotency_key`. */
  requestId: string;
  outcome: Outcome;
  side: OrderSide;
  timeInForce: TimeInForce;
  /** The confirmed limit, 1..99 — every order has one, a budget order too (#177 2항). */
  limitPriceCoin: number;
  /** 1..ORDER_QTY_MAX contracts; null exactly for a budget order. */
  qty: number | null;
  /** An IOC buy's budget, 1..ORDER_BUDGET_MAX_COIN Coin (#177 3항); null for any other order. */
  budgetCoin: bigint | null;
}

export interface PlaceOrderOptions {
  /**
   * The registry `order.accepting` is read through (apps/api passes its injected one, as
   * `ReleaseSettingsService` does). Default RELEASE_SETTINGS.
   */
  registry?: ReleaseSettingsRegistry;
}

/**
 * What an intake changed that a person's screen follows, for the caller to publish after COMMIT
 * (ADR-0112: `user:balance` and `user:position`; the 운영 마켓메이커 has no screen and is left out).
 */
export interface PlaceOrderTouched {
  /**
   * Each person with a ledger entry in this processing — the incoming owner or a resting one —
   * its balance at the end and the last of its entries here (the event's ordering key). A change
   * of locks alone (an order that rested or was refused) records no entry and is not listed.
   */
  balances: { userId: string; balance: BalanceRow; entry: LedgerEntryRow }[];
  /** Each person's position row a fill or a sell lock wrote, as it stands at the end. */
  positions: PositionRow[];
}

export type PlaceOrderResult =
  /**
   * A new order: taken (resting, filled, cancelled) or rejected with its reason. `stats` is the
   * market's statistics after its fills (`market:tick`, #121), null when it filled nothing.
   */
  | {
      kind: 'placed';
      order: OrderRow;
      fills: FillRow[];
      stats: MarketFillStats | null;
      touched: PlaceOrderTouched;
    }
  /** The request id named an order before, with the same terms: that order as it stands now. */
  | { kind: 'replayed'; order: OrderRow }
  /** The request id named an order before with other terms (DUPLICATE_REQUEST). */
  | { kind: 'conflict' }
  /**
   * Nothing written: intake is closed (`order.accepting` not `true`, ORDER_INTAKE_CLOSED), or an
   * immediate order meets a market with no 가격 보호 폭 (a market submitted before #119's deploy,
   * until an admin enters one through the after-open change).
   */
  | { kind: 'closed'; why: 'intake' | 'price_protection' }
  /** No such market, or one not public yet (DRAFT, REVIEW): nothing written (NOT_FOUND). */
  | { kind: 'not_found' };

/** A live resting order as the book read gives it: the matcher's entry and its owner's type. */
export interface LiveBookOrder extends BookOrder {
  /** Copied onto the fill (never compared here: `owner.human` is the rule's answer). */
  readonly accountType: AccountType;
}

/** RangeError for terms no member request can carry (the body schema refuses them first). */
function assertOrderTerms(input: PlaceOrderInput): void {
  if (input.ownerId === '' || input.marketId === '') {
    throw new RangeError('an order names its owner and its market');
  }
  if (!idempotencyKeySchema.safeParse(input.requestId).success) {
    throw new RangeError(`request id ${JSON.stringify(input.requestId)} is not a request id`);
  }
  if (!isContractPrice(input.limitPriceCoin)) {
    throw new RangeError(`the limit must be a contract price, got ${String(input.limitPriceCoin)}`);
  }
  if ((input.qty === null) === (input.budgetCoin === null)) {
    throw new RangeError('an order has a quantity or a budget, exactly one');
  }
  if (input.qty !== null && !(Number.isInteger(input.qty) && input.qty >= 1)) {
    throw new RangeError(`qty must be a positive integer, got ${String(input.qty)}`);
  }
  if (input.qty !== null && input.qty > ORDER_QTY_MAX) {
    throw new RangeError(`qty ${String(input.qty)} is above ${String(ORDER_QTY_MAX)}`);
  }
  if (input.budgetCoin !== null) {
    if (input.budgetCoin < 1n || input.budgetCoin > ORDER_BUDGET_MAX_COIN) {
      throw new RangeError(`a budget of ${String(input.budgetCoin)} Coin is out of range`);
    }
    if (input.side !== 'buy' || input.timeInForce !== 'ioc') {
      throw new RangeError('a budget order is an immediate (ioc) buy (#177 3항)');
    }
  }
}

/**
 * The order lock rule's facts of a row (`OrderLockFacts`, @buddha/shared contract.ts): its
 * protected limit — what it locked and rests at — and, for a budget order, no limit (it locks its
 * budget). `orderRemainingLock(orderLockFactsOf(row))` is what a live order still holds: the
 * cancel (#178) and the expiry (#120) release it, the reconciliation (#93) sums it.
 */
export function orderLockFactsOf(row: OrderRow): OrderLockFacts {
  return {
    side: row.side,
    outcome: row.outcome,
    limitPriceCoin: row.budgetCoin === null ? row.protectedLimitPrice : null,
    qty: row.qty,
    filledQty: row.filledQty,
    budgetCoin: row.budgetCoin,
    live: isLiveOrderStatus(row.status),
  };
}

/** The order `ownerId`'s request id named, or null (another account's id is never read). */
export async function findOrderByRequest(
  executor: Reader,
  ownerId: string,
  requestId: string,
): Promise<OrderRow | null> {
  const [row] = await executor
    .select()
    .from(orders)
    .where(and(eq(orders.userId, ownerId), eq(orders.idempotencyKey, requestId)))
    .limit(1);
  return row ?? null;
}

/**
 * The live book of `marketId` (ADR-0111 결과 5): every resting order (대기·부분 체결), in arrival
 * order, as the matcher reads it — its protected limit as its price, qty − filled as its remaining,
 * `arrival_seq` as its arrival, and whether its owner is a person (the one rule,
 * `is_human_account_type`). The whole book, never filtered by a limit: the intake reads it under
 * `lockMarket` (so it is the book the fills meet); a quote (#179) or a bot check (#128) may read
 * it without and get a snapshot — the public reads (#179, order-book.ts `readPublicBook`) read it
 * in a REPEATABLE READ READ ONLY snapshot without `lockMarket`.
 */
export async function readLiveBook(executor: Reader, marketId: string): Promise<LiveBookOrder[]> {
  const rows = await executor
    .select({
      id: orders.id,
      ownerId: orders.userId,
      human: isHumanAccountTypeSql(user.accountType),
      accountType: user.accountType,
      outcome: orders.outcome,
      side: orders.side,
      priceCoin: orders.protectedLimitPrice,
      qty: orders.qty,
      filledQty: orders.filledQty,
      arrival: orders.arrivalSeq,
    })
    .from(orders)
    .innerJoin(user, eq(user.id, orders.userId))
    .where(and(eq(orders.marketId, marketId), inArray(orders.status, ['open', 'partially_filled'])))
    .orderBy(asc(orders.arrivalSeq));
  return rows.map((row) => ({
    id: row.id,
    owner: { id: row.ownerId, human: row.human },
    accountType: row.accountType,
    outcome: row.outcome,
    side: row.side,
    priceCoin: row.priceCoin,
    // A live order is a quantity order (orders_status_check).
    remainingQty: row.qty! - row.filledQty,
    arrival: row.arrival,
  }));
}

/**
 * An order's owner as the matcher reads it — its id and the rule's answer (`OrderOwner`) — and its
 * type, or null when unknown: the intake's incoming owner, and the holder whose sellable figures
 * (#179) walk like their own immediate sell.
 */
export async function ownerOf(
  executor: Reader,
  ownerId: string,
): Promise<{ id: string; human: boolean; accountType: AccountType } | null> {
  const [row] = await executor
    .select({
      id: user.id,
      human: isHumanAccountTypeSql(user.accountType),
      accountType: user.accountType,
    })
    .from(user)
    .where(eq(user.id, ownerId));
  return row ?? null;
}

/**
 * The request lock: one owner's request id at a time, so a re-sent request waits for the first and
 * then reads its order. Taken after `lockMarket`, by every caller. The two-key form is a lock space
 * of its own, apart from the one-key market and admin-role locks: a hash collision can only make
 * two requests wait for each other, never join a cycle with those. The unique index
 * (`orders_user_id_idempotency_key_unique`) stays the backstop.
 */
async function lockRequest(tx: Tx, ownerId: string, requestId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('buddha:order_request'), hashtext(${ownerId} || ':' || ${requestId}))`,
  );
}

const zeroLock = (lock: OrderLock): boolean =>
  lock.kind === 'coin' ? lock.amountCoin === 0n : lock.qty === 0;

/** The people among an intake's owners: the incoming one and each resting one its fills meet. */
function humanOwnersOf(
  owner: OrderOwner,
  planned: readonly MatchFill[],
  restingById: ReadonlyMap<string, LiveBookOrder>,
): string[] {
  const ids = new Set<string>();
  if (owner.human) ids.add(owner.id);
  for (const fill of planned) {
    const resting = restingById.get(fill.restingOrderId)!.owner;
    if (resting.human) ids.add(resting.id);
  }
  return [...ids];
}

/**
 * 주문 접수 (#119): takes one order in `input.marketId` for `input.ownerId`, in the caller's
 * transaction (ADR-0112). In order:
 *
 * 1. `lockMarket` (the caller may hold it already), the request lock, then the request id: an
 *    order it named before is answered as it stands now (`replayed`), or `conflict` when the terms
 *    differ — before any other answer, so a lost answer can be read back while intake is closed;
 * 2. `order.accepting` not `true` → `closed` (ADR-0107 결정 3: the 운영 마켓메이커 too);
 * 3. the market: none, DRAFT or REVIEW → `not_found`; any status but OPEN, or an OPEN market
 *    whose `close_at` has come by the DB clock read after the locks so far (#120) → a rejected
 *    order '개장 전', '일시 중단' or '마감' with nothing locked (`marketTradingRejectReason`);
 * 4. an immediate order on a market with no width → `closed` (a GTC order never uses it) — 3
 *    and 4 are `intakeMarketGate`;
 * 5. the live book; an immediate order's limit narrowed to the best opposite entry ± the market's
 *    width (`protectedLimit`, #177 2항 — the own resting order counts as the reference too), the
 *    match (#117 `matchOrder`, two arguments) and its end state — `planIntakeMatch`. The quote
 *    (#179, order-book.ts) runs the same gate and plan on a snapshot, with no owner;
 * 6. every owner the match meets locked at once (`lockOrderHolders`), the market's close again
 *    at the fill instant read after it (a rejected order '마감', nothing locked — no fill carries
 *    an instant at or past `close_at`, #120), then the order's intake lock (`orderIntakeLock` at
 *    the protected limit, a budget whole): a shortfall → a rejected order '잔액 부족' or '보유량
 *    부족', nothing filled;
 * 7. the order in its end state (`orderEndState`: ADR-0111 결정 6), then each fill in walk order —
 *    its row first (its id keys the ledger events, migration 0062 binds them), #118's process, the
 *    resting order's fill — and the lock left over released (`intakeRemainderRelease`: an IOC
 *    remainder, a budget's unspent Coin, a self-trade stop; a resting GTC order keeps it);
 * 8. when it filled, the market's statistics once for the intake (#121, `recordFillStats`), with
 *    the people new to the market read before step 7's first write (`newHumanParticipants`).
 *
 * A rejected order is a row with its request id and reason (#177 7항); `replayed`, `conflict`,
 * `closed` and `not_found` write nothing, so the request id stays free. A contract process that
 * does not apply exactly as planned throws, and the caller's transaction rolls the whole intake
 * back. RangeError for terms the body schema refuses; the database refuses an admin's order
 * (`orders_refuse_admin_owner`), which the API answers FORBIDDEN first.
 */
export async function placeOrder(
  tx: Tx,
  input: PlaceOrderInput,
  options: PlaceOrderOptions = {},
): Promise<PlaceOrderResult> {
  assertOrderTerms(input);
  const { ownerId, marketId } = input;

  // The market's lock first, then the request's: one order for every caller (the API holds the
  // market's already, ADR-0112 10-16; a second `pg_advisory_xact_lock` of it does not wait).
  await lockMarket(tx, marketId);
  await lockRequest(tx, ownerId, input.requestId);
  const earlier = await findOrderByRequest(tx, ownerId, input.requestId);
  if (earlier !== null) {
    const same = requestTermsEqual(
      {
        marketId: earlier.marketId,
        outcome: earlier.outcome,
        side: earlier.side,
        timeInForce: earlier.timeInForce,
        limitPriceCoin: earlier.limitPrice,
        qty: earlier.qty,
        budgetCoin: earlier.budgetCoin,
      },
      input,
    );
    return same ? { kind: 'replayed', order: earlier } : { kind: 'conflict' };
  }

  const accepting = await getReleaseSetting(
    tx,
    options.registry ?? RELEASE_SETTINGS,
    ORDER_ACCEPTING_SETTING,
  );
  if (!isOrderIntakeOpen(accepting)) return { kind: 'closed', why: 'intake' };

  // Every writer of a market's status or `close_at` holds its `lockMarket`, so the row read now
  // stays as it is; the DB clock is read after it, after every lock taken so far.
  const [row] = await tx
    .select({
      status: markets.status,
      widthTicks: markets.priceProtectionTicks,
      closeAt: markets.closeAt,
    })
    .from(markets)
    .where(eq(markets.id, marketId));
  if (!row || row.status === 'draft' || row.status === 'review') {
    return { kind: 'not_found' };
  }
  const market: MarketTradingFacts = { ...row, now: await clockTimestamp(tx) };

  /** The order's row values all its paths share. */
  const terms = {
    userId: ownerId,
    marketId,
    outcome: input.outcome,
    side: input.side,
    timeInForce: input.timeInForce,
    limitPrice: input.limitPriceCoin,
    qty: input.qty,
    budgetCoin: input.budgetCoin,
    idempotencyKey: input.requestId,
  };
  const insertOrder = async (values: Partial<typeof orders.$inferInsert>) => {
    const [row] = await tx
      .insert(orders)
      .values({
        ...terms,
        protectedLimitPrice: input.limitPriceCoin,
        status: 'rejected',
        ...values,
      })
      .returning();
    return row!;
  };
  const rejected = async (
    reason: OrderRejectReason,
    at: Date,
    protection: {
      protectedLimitPrice: number;
      referencePrice: number | null;
      ticks: number | null;
    },
  ): Promise<PlaceOrderResult> => {
    const order = await insertOrder({
      protectedLimitPrice: protection.protectedLimitPrice,
      referencePrice: protection.referencePrice,
      protectionTicks: protection.ticks,
      unspentCoin: input.budgetCoin,
      rejectReason: reason,
      createdAt: at,
      updatedAt: at,
      endedAt: at,
    });
    return {
      kind: 'placed',
      order,
      fills: [],
      stats: null,
      touched: { balances: [], positions: [] },
    };
  };

  // A refusal of the market alone records the limit as sent, no reference and no width: the
  // gate's row and the fill instant's '마감' row have one shape.
  const gateProtection = {
    protectedLimitPrice: input.limitPriceCoin,
    referencePrice: null,
    ticks: null,
  };
  // The market gate the quote (#179) runs too: its `marketTradingRejectReason` (the status, and
  // the `close_at` of an OPEN market by the clock, #120) is the check the public book shares; the
  // row records the instant judged. Per-account refusals (#143's role-revoke reason, #93's account
  // hold) need the owner, which the public quote has not, so they go below beside the asset lock,
  // not into the gate.
  const refusal = intakeMarketGate(market, input.timeInForce);
  if (refusal?.kind === 'closed') return refusal;
  if (refusal?.kind === 'reject') return rejected(refusal.reason, market.now, gateProtection);

  const owner = await ownerOf(tx, ownerId);
  if (owner === null) throw new RangeError(`account ${ownerId} does not exist`);
  // #128 trims the 운영 마켓메이커's quantities on this book before matching, and the quote's
  // book (apps/api OrderBookService) the same way: a trim here alone parts the quote from the fill.
  const book = await readLiveBook(tx, marketId);
  // The reference, the protected limit, the match and the end state: the quote's plan too.
  const plan = planIntakeMatch(book, input, market.widthTicks, {
    id: owner.id,
    human: owner.human,
  });
  const { incoming, result, end } = plan;
  const protectedLimitPrice = plan.protectedLimitPriceCoin;
  const referencePrice = plan.referencePriceCoin;
  const widthTicks = plan.widthTicks;
  const protection = { protectedLimitPrice, referencePrice, ticks: widthTicks };

  // Every owner's Coin account before the first lock, release or fill (ADR-0110 결정 4): the
  // last lock that can wait, so the clock is read after it.
  await lockOrderHolders(tx, marketId, [ownerId, ...result.counterpartyOwnerIds]);
  const at = await clockTimestamp(tx);
  // The close again at the fill instant (#120, ADR-0115): the gate's clock came before
  // `lockOrderHolders`, which can wait on another market's intake, and no order or fill may carry
  // an instant at or past `close_at`. Only 'closed' can answer here (the status cannot change under
  // the market lock), and nothing is locked yet.
  const late = marketTradingRejectReason({ ...market, now: at });
  if (late !== null) return rejected(late, at, gateProtection);
  const facts: OrderLockFacts = {
    side: input.side,
    outcome: input.outcome,
    limitPriceCoin: input.budgetCoin === null ? protectedLimitPrice : null,
    qty: input.qty,
    filledQty: 0,
    budgetCoin: input.budgetCoin,
    live: true,
  };
  const locked = await lockForOrder(tx, { marketId, ownerId, lock: orderIntakeLock(facts), at });
  if (!locked.locked) return rejected(locked.reason, at, protection);
  const touchedPositions = new Map<string, string>();
  const touchPosition = (userId: string, outcome: Outcome) =>
    touchedPositions.set(`${userId}:${outcome}`, userId);
  if (locked.position !== null) touchPosition(ownerId, input.outcome);

  const restingById = new Map(book.map((resting) => [resting.id, resting]));
  // #121: who among this intake's people fills in this market for the first time, read before the
  // order and the resting orders record their fills (the `hasMarketFill` basis, market-stats.ts).
  const newParticipants =
    result.fills.length === 0
      ? 0
      : await newHumanParticipants(
          tx,
          marketId,
          humanOwnersOf({ id: owner.id, human: owner.human }, result.fills, restingById),
        );

  const order = await insertOrder({
    protectedLimitPrice,
    referencePrice,
    protectionTicks: widthTicks,
    filledQty: result.filledQty,
    filledAmountCoin: result.amountCoin,
    unspentCoin: end.unspentCoin,
    status: end.status,
    rejectReason: end.rejectReason,
    cancelReason: end.cancelReason,
    createdAt: at,
    updatedAt: at,
    endedAt: isLiveOrderStatus(end.status) ? null : at,
  });

  const lastEntry = new Map<string, LedgerEntryRow>();
  const noteEntry = (userId: string, entry: LedgerEntryRow) => {
    const before = lastEntry.get(userId);
    if (before === undefined || before.id < entry.id) lastEntry.set(userId, entry);
  };
  const made: FillRow[] = [];
  for (const planned of result.fills) {
    const resting = restingById.get(planned.restingOrderId)!;
    const [fill] = await tx
      .insert(fills)
      .values({
        marketId,
        kind: planned.kind,
        incomingOrderId: order.id,
        restingOrderId: resting.id,
        incomingOwnerId: ownerId,
        restingOwnerId: resting.owner.id,
        incomingAccountType: owner.accountType,
        restingAccountType: resting.accountType,
        outcome: input.outcome,
        side: input.side,
        qty: planned.qty,
        priceCoin: planned.priceCoin,
        yesPriceCoin: planned.yesPriceCoin,
        amountCoin: planned.amountCoin,
        createdAt: at,
      })
      .returning();
    made.push(fill!);
    const fillId = String(fill!.id);
    const call = fillProcessInput(incoming, planned);
    if (call.process === 'trade') {
      const done = await applyTradeFill(tx, { marketId, fillId, at, ...call.input });
      if (done.outcome !== 'filled') throw new Error(`fill ${fillId} was recorded before`);
      noteEntry(call.input.buyer.ownerId, done.entry);
      noteEntry(call.input.sellerId, done.entry);
      touchPosition(call.input.buyer.ownerId, call.input.outcome);
      touchPosition(call.input.sellerId, call.input.outcome);
    } else {
      const done = await applyPairMintFill(tx, { marketId, fillId, at, ...call.input });
      if (done.outcome !== 'minted') throw new Error(`fill ${fillId} was recorded before`);
      noteEntry(call.input.yes.ownerId, done.entries.YES);
      noteEntry(call.input.no.ownerId, done.entries.NO);
      touchPosition(call.input.yes.ownerId, 'YES');
      touchPosition(call.input.no.ownerId, 'NO');
    }
    const restingStatus = restingStateAfterFill(planned.restingRemainingQty);
    await tx
      .update(orders)
      .set({
        filledQty: sql`${orders.filledQty} + ${planned.qty}`,
        filledAmountCoin: sql`${orders.filledAmountCoin} + ${BigInt(planned.restingPriceCoin) * BigInt(planned.qty)}`,
        status: restingStatus,
        updatedAt: at,
        endedAt: restingStatus === 'filled' ? at : null,
      })
      .where(eq(orders.id, resting.id));
  }

  const release = intakeRemainderRelease(facts, result);
  if (!zeroLock(release)) {
    await releaseForOrder(tx, { marketId, ownerId, lock: release, at });
  }

  const stats =
    made.length === 0
      ? null
      : await recordFillStats(tx, { marketId, fills: made, newParticipants });

  return {
    kind: 'placed',
    order,
    fills: made,
    stats,
    touched: await touchedOf(tx, marketId, lastEntry, touchedPositions),
  };
}

/**
 * Whether an intake changed the market's live book, so its public book changed (#179: the caller
 * publishes `market:book` after COMMIT): a new order that rests, or any fill (a resting order
 * filled or partly filled). A rejected order, an immediate one that filled nothing, and the
 * answers that write nothing (`replayed`, `conflict`, `closed`, `not_found`) change nothing.
 * `market:trade` and `market:tick` follow the result's `fills` and `stats` (#121).
 */
export function placeOrderChangedBook(result: PlaceOrderResult): boolean {
  return (
    result.kind === 'placed' && (result.fills.length > 0 || isLiveOrderStatus(result.order.status))
  );
}

/** The persons' balances and positions an intake changed, read at its end. */
async function touchedOf(
  tx: Tx,
  marketId: string,
  lastEntry: Map<string, LedgerEntryRow>,
  touchedPositions: Map<string, string>,
): Promise<PlaceOrderTouched> {
  const touched: PlaceOrderTouched = { balances: [], positions: [] };
  const named = [...new Set([...lastEntry.keys(), ...touchedPositions.values()])];
  if (named.length === 0) return touched;
  // The 운영 마켓메이커 has no screen to follow (the one rule tells it apart).
  const people = new Set(
    (
      await tx
        .select({ id: user.id })
        .from(user)
        .where(and(inArray(user.id, named), isHumanAccountTypeSql(user.accountType)))
    ).map((row) => row.id),
  );
  const withEntries = [...lastEntry.keys()].filter((id) => people.has(id)).sort();
  if (withEntries.length > 0) {
    const rows = await tx.select().from(balances).where(inArray(balances.userId, withEntries));
    for (const balance of rows) {
      touched.balances.push({
        userId: balance.userId!,
        balance,
        entry: lastEntry.get(balance.userId!)!,
      });
    }
  }
  const owners = [...new Set(touchedPositions.values())].filter((id) => people.has(id));
  if (owners.length > 0) {
    const rows = await tx
      .select()
      .from(positions)
      .where(and(eq(positions.marketId, marketId), inArray(positions.userId, owners)));
    touched.positions = rows.filter((row) => touchedPositions.has(`${row.userId}:${row.outcome}`));
  }
  return touched;
}
