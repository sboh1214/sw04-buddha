/**
 * Order and fill test helpers (#119, ADR-0112). `createOrder` and `createFillRecord` write
 * `orders` and `fills` rows as the intake leaves them — every CHECK and trigger of migration 0062
 * holds — under the market lock, and move no asset: no balance, lock, position or ledger entry
 * changes there, and no market statistic: only the intake writes those (#121, market-stats.ts). A
 * test that needs the assets too records them against the fill (`mintTestPairs`, `spendCoin` in
 * ledger.ts), or goes through the intake itself (`placeTestOrder`), and reads the books back with
 * `checkOrderInvariants` and the statistics with `checkMarketStats`.
 */
import { randomUUID } from 'node:crypto';
import {
  CONTRACT_TERMS,
  ORDER_ACCEPTING_SETTING,
  ORDER_QTY_MAX,
  ORDER_RATE_LIMIT_SETTING,
  PAYOUT_PER_CONTRACT_COIN,
  PRICE_PROTECTION_TICKS_SETTING,
  isLiveOrderStatus,
  type FillKind,
  type OrderCancelReason,
  type OrderRejectReason,
  type OrderSide,
  type OrderStatus,
  type Outcome,
  type TimeInForce,
} from '@buddha/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { closeMarketAtClose, type CloseMarketAtCloseResult } from '../market-close.js';
import {
  cancelLockedOrders,
  cancelOrder,
  lockAccountOrders,
  type CancelledOrders,
  type CancelOrderResult,
  type OrderCancelProcessReason,
} from '../order-cancel.js';
import {
  placeOrder,
  type FillRow,
  type OrderRow,
  type PlaceOrderInput,
  type PlaceOrderResult,
} from '../orders.js';
import { fills, markets, orders, profiles, user } from '../schema/index.js';
import { clockTimestamp, lockMarket } from '../tx-helpers.js';
import { contractBook } from './contracts.js';
import { TEST_PRICE_PROTECTION_TICKS, createUser, setReleaseSetting } from './factories.js';
import { ledgerSupply } from './ledger.js';

export type { FillRow, OrderRow };

/** The reasons a market's status rejects an order with, before any width is read. */
const MARKET_REASONS: readonly OrderRejectReason[] = ['not_open_yet', 'paused', 'closed'];

export interface CreateOrderInput {
  marketId: string;
  /** The owner. Default: a fresh member. */
  userId?: string;
  /** Default 'YES'. */
  outcome?: Outcome;
  /** Default 'buy'. */
  side?: OrderSide;
  /** Default 'gtc'. */
  timeInForce?: TimeInForce;
  /** The confirmed limit. Default 50. */
  limitPriceCoin?: number;
  /** Default the confirmed limit (an IOC order with no reference). */
  protectedLimitPriceCoin?: number;
  /** IOC only. Default null. */
  referencePriceCoin?: number | null;
  /**
   * IOC only. Default TEST_PRICE_PROTECTION_TICKS, null for a market-status reject; always null
   * for GTC.
   */
  protectionTicks?: number | null;
  /** Default 1, or null with a budget. */
  qty?: number | null;
  /** An IOC buy's budget. Default null. */
  budgetCoin?: bigint | null;
  /** Default 0. */
  filledQty?: number;
  /** Default filledQty × the protected limit. */
  filledAmountCoin?: bigint;
  /** Default 'open' for GTC, 'rejected' for IOC. */
  status?: OrderStatus;
  /** Default: 'no_quote' for a rejected order, else null. */
  rejectReason?: OrderRejectReason | null;
  /** Default: for a cancelled order 'by_owner' (GTC) or 'ioc_remainder' (IOC), else null. */
  cancelReason?: OrderCancelReason | null;
  /** The request id. Default: a fresh uuid. */
  requestId?: string;
  /** Default: the database clock (and the end, for an ended order). */
  createdAt?: Date;
  /** Default: budget − filled Coin, null without a budget. A CHECK test's override only. */
  unspentCoin?: bigint | null;
  /** Default: null for a live order, else its creation. A CHECK test's override only. */
  endedAt?: Date | null;
}

/**
 * Inserts one order row in a given state, consistent with migration 0062's CHECKs — a GTC buy of
 * one YES at 50 resting (`open`) by default — under the market lock, with its arrival key from the
 * sequence. Holds no lock: a test of the lock rule takes it itself (`lockForOrder`), or goes
 * through the intake. For reads, eligibility and closure tests that need an order and no intake.
 * A live row of it has no lock to give back, so never let a cancel or an expiry meet it (#178: an
 * owner's cancel, a pause but `ledger_failure`, a pause's end, a restriction's approval, a closure;
 * #120: the close, `closeTestMarket` — the release throws): use `placeTestOrder` there.
 */
export async function createOrder(db: Db, input: CreateOrderInput): Promise<OrderRow> {
  const userId = input.userId ?? (await createUser(db)).user.id;
  const timeInForce = input.timeInForce ?? 'gtc';
  const budgetCoin = input.budgetCoin ?? null;
  const qty = input.qty !== undefined ? input.qty : budgetCoin === null ? 1 : null;
  const status = input.status ?? (timeInForce === 'gtc' ? 'open' : 'rejected');
  const limitPrice = input.limitPriceCoin ?? 50;
  const protectedLimitPrice = input.protectedLimitPriceCoin ?? limitPrice;
  const rejectReason =
    input.rejectReason !== undefined
      ? input.rejectReason
      : status === 'rejected'
        ? 'no_quote'
        : null;
  const cancelReason =
    input.cancelReason !== undefined
      ? input.cancelReason
      : status === 'cancelled'
        ? timeInForce === 'gtc'
          ? 'by_owner'
          : 'ioc_remainder'
        : null;
  const protectionTicks =
    timeInForce === 'gtc'
      ? null
      : input.protectionTicks !== undefined
        ? input.protectionTicks
        : rejectReason !== null && MARKET_REASONS.includes(rejectReason)
          ? null
          : TEST_PRICE_PROTECTION_TICKS;
  const filledQty = input.filledQty ?? 0;
  const filledAmountCoin =
    input.filledAmountCoin ?? BigInt(filledQty) * BigInt(protectedLimitPrice);
  return db.transaction(async (tx) => {
    await lockMarket(tx, input.marketId);
    const at =
      input.createdAt ??
      (await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`)).rows[0]!.now;
    const [row] = await tx
      .insert(orders)
      .values({
        userId,
        marketId: input.marketId,
        outcome: input.outcome ?? 'YES',
        side: input.side ?? 'buy',
        timeInForce,
        limitPrice,
        protectedLimitPrice,
        referencePrice: timeInForce === 'gtc' ? null : (input.referencePriceCoin ?? null),
        protectionTicks,
        qty,
        budgetCoin,
        filledQty,
        filledAmountCoin,
        unspentCoin:
          input.unspentCoin !== undefined
            ? input.unspentCoin
            : budgetCoin === null
              ? null
              : budgetCoin - filledAmountCoin,
        status,
        rejectReason,
        cancelReason,
        idempotencyKey: input.requestId ?? randomUUID(),
        createdAt: new Date(at),
        endedAt:
          input.endedAt !== undefined
            ? input.endedAt
            : isLiveOrderStatus(status)
              ? null
              : new Date(at),
      })
      .returning();
    return row!;
  });
}

export interface CreateFillRecordInput {
  marketId: string;
  /** The incoming order's owner. */
  incomingOwnerId: string;
  /** The resting order's owner; another account, and not two non-person accounts. */
  restingOwnerId: string;
  /** The incoming order's outcome and side. Default 'YES', 'buy'. */
  outcome?: Outcome;
  side?: OrderSide;
  /**
   * Default: a buy mints a pair (the resting order a buy of the other outcome), a sell trades (a
   * resting buy of the same outcome). A trade buy meets a resting sell.
   */
  kind?: FillKind;
  /** The incoming contract's price per contract, 1..99. Default 50. */
  priceCoin?: number;
  /** Default 1. */
  qty?: number;
  /** The orders' and the fill's instant. Default: the database clock. */
  createdAt?: Date;
}

export interface FillRecord {
  fill: FillRow;
  incoming: OrderRow;
  resting: OrderRow;
}

/**
 * One match as the intake records it, in one transaction under the market lock: the resting GTC
 * order (live, its price the fill's), the incoming IOC order in its end state (전량 체결, its
 * reference the fill's price and the test width), the fill — both owners and their account types,
 * the price, the YES price and the amount (price × qty) — and the resting order then filled. No
 * asset and no market statistic moves (#121: the intake's alone; pair with `createMarket`'s
 * statistics when a read needs both). `String(fill.id)` is the key a test's ledger events of the
 * fill use.
 */
export async function createFillRecord(db: Db, input: CreateFillRecordInput): Promise<FillRecord> {
  const outcome = input.outcome ?? 'YES';
  const side = input.side ?? 'buy';
  const kind = input.kind ?? (side === 'buy' ? 'pair_mint' : 'trade');
  const priceCoin = input.priceCoin ?? 50;
  const qty = input.qty ?? 1;
  if (kind === 'pair_mint' && side !== 'buy') throw new Error('createFillRecord: a mint is buys');
  const payout = CONTRACT_TERMS.payoutCoin;
  const resting =
    kind === 'pair_mint'
      ? { outcome: outcome === 'YES' ? ('NO' as const) : ('YES' as const), side: 'buy' as const }
      : { outcome, side: side === 'buy' ? ('sell' as const) : ('buy' as const) };
  const restingPrice = kind === 'pair_mint' ? payout - priceCoin : priceCoin;
  return db.transaction(async (tx) => {
    await lockMarket(tx, input.marketId);
    const at =
      input.createdAt ??
      (await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`)).rows[0]!.now;
    const [restingOrder] = await tx
      .insert(orders)
      .values({
        userId: input.restingOwnerId,
        marketId: input.marketId,
        ...resting,
        timeInForce: 'gtc',
        limitPrice: restingPrice,
        protectedLimitPrice: restingPrice,
        qty,
        status: 'open',
        idempotencyKey: randomUUID(),
        createdAt: new Date(at),
      })
      .returning();
    const [incomingOrder] = await tx
      .insert(orders)
      .values({
        userId: input.incomingOwnerId,
        marketId: input.marketId,
        outcome,
        side,
        timeInForce: 'ioc',
        limitPrice: priceCoin,
        protectedLimitPrice: priceCoin,
        referencePrice: priceCoin,
        protectionTicks: TEST_PRICE_PROTECTION_TICKS,
        qty,
        filledQty: qty,
        filledAmountCoin: BigInt(priceCoin) * BigInt(qty),
        status: 'filled',
        idempotencyKey: randomUUID(),
        createdAt: new Date(at),
        endedAt: new Date(at),
      })
      .returning();
    const typeOf = async (id: string) =>
      (await tx.select({ type: user.accountType }).from(user).where(eq(user.id, id)))[0]!.type;
    const [fill] = await tx
      .insert(fills)
      .values({
        marketId: input.marketId,
        kind,
        incomingOrderId: incomingOrder!.id,
        restingOrderId: restingOrder!.id,
        incomingOwnerId: input.incomingOwnerId,
        restingOwnerId: input.restingOwnerId,
        incomingAccountType: await typeOf(input.incomingOwnerId),
        restingAccountType: await typeOf(input.restingOwnerId),
        outcome,
        side,
        qty,
        priceCoin,
        yesPriceCoin: outcome === 'YES' ? priceCoin : payout - priceCoin,
        amountCoin: BigInt(priceCoin) * BigInt(qty),
        createdAt: new Date(at),
      })
      .returning();
    const [restingFilled] = await tx
      .update(orders)
      .set({
        filledQty: qty,
        filledAmountCoin: BigInt(restingPrice) * BigInt(qty),
        status: 'filled',
        endedAt: new Date(at),
      })
      .where(eq(orders.id, restingOrder!.id))
      .returning();
    return { fill: fill!, incoming: incomingOrder!, resting: restingFilled! };
  });
}

export interface CreateFillSeriesInput {
  marketId: string;
  /** The incoming order's owner: a person (a fill has one, `fills_check`). */
  incomingOwnerId: string;
  /** The resting orders' owner, another account. */
  restingOwnerId: string;
  /** One fill of one YES each, in this order (ids follow it): its instant and its YES price. */
  points: readonly { at: Date; yesPriceCoin: number }[];
}

/**
 * A price history of many fills for the chart and the 24-hours-ago reads (#121: the history is
 * `fills`), written set-based in one transaction under the market lock: one resting YES sell GTC
 * per distinct price (live, `ORDER_QTY_MAX` contracts), one incoming YES buy IOC after them (전량
 * 체결, protected limit 99), then every point as a one-contract trade fill at its price and instant
 * in one INSERT … SELECT. Every row passes 0062's CHECKs and `fills_check`. A read fixture: the
 * orders' filled amounts do not add up and no asset or statistic moves, so never pair it with
 * `checkOrderInvariants` or `checkMarketStats`. Up to `ORDER_QTY_MAX` points; returns the fills in
 * point order.
 */
export async function createFillSeries(db: Db, input: CreateFillSeriesInput): Promise<FillRow[]> {
  const { marketId, points } = input;
  if (points.length === 0) return [];
  if (points.length > ORDER_QTY_MAX) throw new RangeError('createFillSeries: too many points');
  const prices = [...new Set(points.map((point) => point.yesPriceCoin))];
  for (const price of prices) {
    if (!Number.isInteger(price) || price < 1 || price > 99) {
      throw new RangeError(`createFillSeries: ${String(price)} is no contract price`);
    }
  }
  return db.transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const first = new Date(Math.min(...points.map((point) => point.at.getTime())));
    const resting = await tx
      .insert(orders)
      .values(
        prices.map((price) => ({
          userId: input.restingOwnerId,
          marketId,
          outcome: 'YES' as const,
          side: 'sell' as const,
          timeInForce: 'gtc' as const,
          limitPrice: price,
          protectedLimitPrice: price,
          qty: ORDER_QTY_MAX,
          status: 'open' as const,
          idempotencyKey: randomUUID(),
          createdAt: first,
        })),
      )
      .returning({ id: orders.id, price: orders.protectedLimitPrice });
    const amount = points.reduce((sum, point) => sum + BigInt(point.yesPriceCoin), 0n);
    const [incoming] = await tx
      .insert(orders)
      .values({
        userId: input.incomingOwnerId,
        marketId,
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        limitPrice: 99,
        protectedLimitPrice: 99,
        protectionTicks: TEST_PRICE_PROTECTION_TICKS,
        qty: points.length,
        filledQty: points.length,
        filledAmountCoin: amount,
        status: 'filled',
        idempotencyKey: randomUUID(),
        createdAt: first,
        endedAt: first,
      })
      .returning();
    const restingIds = JSON.stringify(Object.fromEntries(resting.map((r) => [r.price, r.id])));
    const listed = JSON.stringify(
      points.map((point) => ({ at: point.at.toISOString(), price: point.yesPriceCoin })),
    );
    // One statement: the point list in order (WITH ORDINALITY), each joined to its price's order.
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO fills (market_id, kind, incoming_order_id, resting_order_id, incoming_owner_id,
                         resting_owner_id, incoming_account_type, resting_account_type, outcome,
                         side, qty, price_coin, yes_price_coin, amount_coin, created_at)
      SELECT ${marketId}, 'trade', ${incoming!.id},
             (${restingIds}::jsonb ->> (p.point ->> 'price'))::uuid,
             ${input.incomingOwnerId}, ${input.restingOwnerId},
             (SELECT u.account_type FROM "user" u WHERE u.id = ${input.incomingOwnerId}),
             (SELECT u.account_type FROM "user" u WHERE u.id = ${input.restingOwnerId}),
             'YES', 'buy', 1, (p.point ->> 'price')::smallint, (p.point ->> 'price')::smallint,
             (p.point ->> 'price')::bigint, (p.point ->> 'at')::timestamptz
      FROM jsonb_array_elements(${listed}::jsonb) WITH ORDINALITY AS p(point, ord)
      ORDER BY p.ord
      RETURNING id`);
    const ids = rows.map((row) => Number(row.id));
    return tx.select().from(fills).where(inArray(fills.id, ids)).orderBy(asc(fills.id));
  });
}

/**
 * A price and a quantity whose product is `amountCoin` (price 1..99, qty 1..ORDER_QTY_MAX): the
 * highest such price. Throws when there is none (above 99 × ORDER_QTY_MAX, or no divisor fits).
 */
export function priceAndQtyOf(amountCoin: bigint): { priceCoin: number; qty: number } {
  for (let price = CONTRACT_TERMS.priceMaxCoin; price >= CONTRACT_TERMS.priceMinCoin; price -= 1) {
    if (amountCoin % BigInt(price) === 0n) {
      const qty = amountCoin / BigInt(price);
      if (qty >= 1n && qty <= BigInt(ORDER_QTY_MAX)) return { priceCoin: price, qty: Number(qty) };
    }
  }
  throw new Error(`no contract price and quantity make ${amountCoin.toString()} Coin`);
}

export interface OpenOrderIntakeInput {
  /** The admin the settings are recorded under. */
  adminId: string;
  /** `order.rate_limit` as a test value. Default: left as it is (undecided after a reset). */
  rateLimit?: number;
  /** `order.price_protection_ticks` as a test value. Default: left as it is. */
  widthTicks?: number;
}

/**
 * Opens order intake as the test environment does (ADR-0107 결정 3, the e2e global setup): the
 * release setting `order.accepting` set to `true` with the status 시험값, and optionally the order
 * rate limit and the width default. A reset empties `release_settings`, which closes it again.
 */
export async function openOrderIntake(db: Db, input: OpenOrderIntakeInput): Promise<void> {
  const set = (key: string, value: unknown) =>
    setReleaseSetting(db, { adminId: input.adminId, key, status: 'test', value });
  await set(ORDER_ACCEPTING_SETTING.key, true);
  if (input.rateLimit !== undefined) await set(ORDER_RATE_LIMIT_SETTING.key, input.rateLimit);
  if (input.widthTicks !== undefined) {
    await set(PRICE_PROTECTION_TICKS_SETTING.key, input.widthTicks);
  }
}

export interface PlaceTestOrderInput extends Partial<
  Omit<PlaceOrderInput, 'marketId' | 'ownerId'>
> {
  marketId: string;
  ownerId: string;
}

/**
 * Places an order through the real intake (`placeOrder`, its own transaction): a person's, or
 * the 운영 마켓메이커's. Defaults: a fresh request id, a GTC buy of one YES at 50 — `qty` 1
 * unless a `budgetCoin` is given (then an IOC buy). Intake must be open (`openOrderIntake`).
 */
export async function placeTestOrder(
  db: Db,
  input: PlaceTestOrderInput,
): Promise<PlaceOrderResult> {
  const budgetCoin = input.budgetCoin ?? null;
  return db.transaction((tx) =>
    placeOrder(tx, {
      requestId: input.requestId ?? randomUUID(),
      outcome: input.outcome ?? 'YES',
      side: input.side ?? 'buy',
      timeInForce: input.timeInForce ?? (budgetCoin === null ? 'gtc' : 'ioc'),
      limitPriceCoin: input.limitPriceCoin ?? 50,
      qty: input.qty !== undefined ? input.qty : budgetCoin === null ? 1 : null,
      budgetCoin,
      marketId: input.marketId,
      ownerId: input.ownerId,
    }),
  );
}

/**
 * Moves `marketId`'s 거래 마감 시각 to `at` (default a minute ago) with a raw write, as the clock
 * passing it would: the market keeps its status, so an OPEN one is past its close before the
 * worker's transition (#120). The scheduled open is cleared (the minute-grain CHECK
 * `utcMinute(scheduled_open_at) < utcMinute(close_at)`); `at` must stay at or before the scheduled
 * judgement (the other CHECK — every factory market's is days ahead). A market with a rule version
 * takes it as a supplement does (`buddha.rule_supplement`, migration 0053's guard).
 */
export async function passMarketClose(
  db: Db,
  marketId: string,
  at: Date = new Date(Date.now() - 60_000),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('buddha.rule_supplement', ${marketId}, true)`);
    await tx
      .update(markets)
      .set({ closeAt: at, scheduledOpenAt: null })
      .where(eq(markets.id, marketId));
  });
}

/**
 * The close at `close_at` as the worker runs it (`closeMarketAtClose`, #120), in its own
 * transaction: OPEN or PAUSED → CLOSED with every live order ended 만료 (a held market's kept), or
 * a skip. The market must be due (`passMarketClose`, or a close already past). Publishes nothing.
 */
export async function closeTestMarket(db: Db, marketId: string): Promise<CloseMarketAtCloseResult> {
  return db.transaction((tx) => closeMarketAtClose(tx, marketId));
}

export interface CancelTestOrderInput {
  ownerId: string;
  orderId: string;
  /** Default `by_owner` (the member's own cancel). */
  reason?: OrderCancelProcessReason;
}

/** One order's cancel by its owner (`cancelOrder`, #178), in its own transaction. */
export async function cancelTestOrder(
  db: Db,
  input: CancelTestOrderInput,
): Promise<CancelOrderResult> {
  return db.transaction((tx) =>
    cancelOrder(tx, {
      ownerId: input.ownerId,
      orderId: input.orderId,
      reason: input.reason ?? 'by_owner',
    }),
  );
}

/**
 * An account's batch cancel (#178) as the restriction's approval and the closure run it, in its
 * own transaction: the person's profile FOR UPDATE first (`lockAccountOrders`' precondition),
 * the batch's locks, the clock, then `cancelLockedOrders` with `reason` at that instant.
 */
export async function cancelTestAccountOrders(
  db: Db,
  ownerId: string,
  reason: OrderCancelProcessReason,
): Promise<CancelledOrders & { at: Date }> {
  return db.transaction(async (tx) => {
    await tx.select().from(profiles).where(eq(profiles.userId, ownerId)).for('update');
    const locked = await lockAccountOrders(tx, ownerId);
    const at = await clockTimestamp(tx);
    return { ...(await cancelLockedOrders(tx, locked, { reason, at })), at };
  });
}

/**
 * Every live order's lock against what its holder holds locked (ADR-0110 결정 4, ADR-0112): one
 * row per Coin account — a person's own, or a market's 마켓메이커 자금 — whose `locked_coin` is not
 * the sum of its live quantity buys' protected limit × (qty − filled), and per position whose
 * `locked_qty` is not the sum of its live sells' qty − filled. No row: every lock is an order's.
 * Read-only; docs/OPERATIONS.md '주문 접수' carries it for operators.
 */
export const ORDER_LOCKS_CHECK_SQL = `SELECT 'coin' AS lock, a.kind::text AS holder, a.owner_id, a.market_id,
       b.locked_coin::text AS locked,
       coalesce(sum(o.protected_limit_price::bigint * (o.qty - o.filled_qty)), 0)::text AS live
FROM ledger_accounts a
JOIN balances b ON b.account_id = a.id
LEFT JOIN orders o ON o.status IN ('open', 'partially_filled') AND o.side = 'buy'
  AND o.user_id = a.owner_id AND (a.kind = 'user' OR o.market_id = a.market_id)
WHERE a.kind IN ('user', 'market_maker_funds')
GROUP BY a.id, a.kind, a.owner_id, a.market_id, b.locked_coin
HAVING b.locked_coin <> coalesce(sum(o.protected_limit_price::bigint * (o.qty - o.filled_qty)), 0)
UNION ALL
SELECT 'contracts', p.outcome::text, p.user_id, p.market_id, p.locked_qty::text,
       coalesce(sum(o.qty - o.filled_qty), 0)::text
FROM positions p
LEFT JOIN orders o ON o.status IN ('open', 'partially_filled') AND o.side = 'sell'
  AND o.user_id = p.user_id AND o.market_id = p.market_id AND o.outcome = p.outcome
GROUP BY p.user_id, p.market_id, p.outcome, p.locked_qty
HAVING p.locked_qty <> coalesce(sum(o.qty - o.filled_qty), 0)
ORDER BY 1, 3, 4, 2;
`;

/**
 * Every market whose statistics are not what its fills say (#121, ADR-0116; ADR-0107 결정 1 #177
 * 11–13항): `last_price`/`last_fill_at` against the YES price and the time of its last fill by
 * (`created_at`, `id`), `volume_coin` against Σ `amount_coin`, `trade_count` against its fills,
 * `trader_count` against the distinct owners on either side whose copied account type is a
 * person's (ADR-0112 결정 6). A market with no fill must read null, null, 0, 0, 0. No row: every
 * statistic is its fills'. Read-only; docs/OPERATIONS.md '시장 통계' carries it for operators, and
 * #132 recounts with it once it leaves abnormal fills out.
 */
export const MARKET_STATS_CHECK_SQL = `WITH totals AS (
  SELECT market_id, sum(amount_coin) AS volume, count(*)::int AS trades
  FROM fills GROUP BY market_id
), last AS (
  SELECT DISTINCT ON (market_id) market_id, yes_price_coin, created_at
  FROM fills ORDER BY market_id, created_at DESC, id DESC
), people AS (
  SELECT market_id, count(DISTINCT owner_id)::int AS traders
  FROM (SELECT market_id, incoming_owner_id AS owner_id FROM fills
        WHERE is_human_account_type(incoming_account_type)
        UNION ALL
        SELECT market_id, resting_owner_id FROM fills
        WHERE is_human_account_type(resting_account_type)) AS sides
  GROUP BY market_id
)
SELECT m.id AS market_id,
       m.last_price, l.yes_price_coin AS fills_last_price,
       m.last_fill_at, l.created_at AS fills_last_fill_at,
       m.volume_coin::text AS volume_coin, coalesce(t.volume, 0)::text AS fills_volume_coin,
       m.trade_count, coalesce(t.trades, 0) AS fills_trade_count,
       m.trader_count, coalesce(p.traders, 0) AS fills_trader_count
FROM markets m
LEFT JOIN totals t ON t.market_id = m.id
LEFT JOIN last l ON l.market_id = m.id
LEFT JOIN people p ON p.market_id = m.id
WHERE m.last_price IS DISTINCT FROM l.yes_price_coin
   OR m.last_fill_at IS DISTINCT FROM l.created_at
   OR m.volume_coin <> coalesce(t.volume, 0)
   OR m.trade_count <> coalesce(t.trades, 0)
   OR m.trader_count <> coalesce(p.traders, 0)
ORDER BY m.id;
`;

/** The five statistics of a market as `markets` holds them (#121, market-stats.ts writes them). */
export async function marketStatsOf(db: Db, marketId: string) {
  const [row] = await db
    .select({
      lastPrice: markets.lastPrice,
      lastFillAt: markets.lastFillAt,
      volumeCoin: markets.volumeCoin,
      tradeCount: markets.tradeCount,
      traderCount: markets.traderCount,
    })
    .from(markets)
    .where(eq(markets.id, marketId));
  if (row === undefined) throw new Error(`marketStatsOf: no market ${marketId}`);
  return row;
}

/** `marketStatsOf` a market nobody has filled in: '체결 없음' (N02 §5). */
export const NO_MARKET_STATS = {
  lastPrice: null,
  lastFillAt: null,
  volumeCoin: 0n,
  tradeCount: 0,
  traderCount: 0,
} as const;

/**
 * `MARKET_STATS_CHECK_SQL` as buddha_app, as a list of what breaks (empty when every market's
 * statistics are its fills'). Apart from `checkOrderInvariants`: fill fixtures (`createFillRecord`,
 * `createFillSeries`) write fills with no statistic on purpose.
 */
export async function checkMarketStats(db: Db): Promise<string[]> {
  const { rows } = await db.$client.query(MARKET_STATS_CHECK_SQL);
  return rows.map((row) => `market stats ${JSON.stringify(row)}`);
}

/**
 * The intake's invariants over the whole database, as a list of what breaks them (empty when all
 * hold): every lock is a live order's (`ORDER_LOCKS_CHECK_SQL`); per market unsettled YES = NO
 * and its collateral = pairs × payout; Coin carried = minted − burned and held = carried; and
 * every order's filled amounts are the sums of its fills (an incoming order's at its incoming
 * price, a resting one's at its own).
 */
export async function checkOrderInvariants(db: Db): Promise<string[]> {
  const breaks: string[] = [];
  const { rows: locks } = await db.$client.query(ORDER_LOCKS_CHECK_SQL);
  for (const row of locks) breaks.push(`lock ${JSON.stringify(row)}`);
  const marketIds = (
    await db.execute<{ id: string }>(
      sql`SELECT DISTINCT market_id AS id FROM positions
          UNION SELECT market_id FROM ledger_accounts WHERE kind = 'market_collateral'`,
    )
  ).rows.map((row) => row.id);
  for (const marketId of marketIds) {
    const book = await contractBook(db, marketId);
    if (
      book.yes !== book.no ||
      book.collateralCoin !== BigInt(book.yes) * PAYOUT_PER_CONTRACT_COIN
    ) {
      breaks.push(
        `market ${marketId}: ${JSON.stringify({ ...book, collateralCoin: String(book.collateralCoin) })}`,
      );
    }
  }
  const supply = await ledgerSupply(db);
  if (
    supply.carriedCoin !== supply.mintedCoin - supply.burnedCoin ||
    supply.heldCoin !== supply.carriedCoin
  ) {
    breaks.push(
      `supply ${JSON.stringify(supply, (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v))}`,
    );
  }
  const { rows: amounts } = await db.$client.query(`
    SELECT o.id, o.filled_qty, o.filled_amount_coin::text AS amount,
           coalesce(sum(f.qty), 0)::int AS fill_qty,
           coalesce(sum(CASE WHEN f.incoming_order_id = o.id THEN f.amount_coin
                             ELSE o.protected_limit_price::bigint * f.qty END), 0)::text AS fill_amount
    FROM orders o
    LEFT JOIN fills f ON f.incoming_order_id = o.id OR f.resting_order_id = o.id
    GROUP BY o.id
    HAVING o.filled_qty <> coalesce(sum(f.qty), 0)
        OR o.filled_amount_coin <> coalesce(sum(CASE WHEN f.incoming_order_id = o.id
             THEN f.amount_coin ELSE o.protected_limit_price::bigint * f.qty END), 0)`);
  for (const row of amounts) breaks.push(`order ${JSON.stringify(row)}`);
  return breaks;
}
