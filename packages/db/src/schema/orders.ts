import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, timestampTz, updatedAt } from './columns.js';
import {
  orderCancelReasonEnum,
  orderRejectReasonEnum,
  orderSideEnum,
  orderStatusEnum,
  outcomeEnum,
  timeInForceEnum,
} from './enums.js';
import { markets } from './markets.js';

/** The live states (대기·부분 체결) as SQL, `LIVE_ORDER_STATUSES` of @buddha/shared. */
const LIVE = sql.raw(`('open', 'partially_filled')`);

/**
 * Orders (#119, ADR-0112; ADR-0107 결정 1 #177 2·3·7·8·9항, ADR-0111 결정 6·8): every order the intake
 * took — a person's or the 운영 마켓메이커's, resting, filled, ended or rejected — written only by
 * @buddha/db orders.ts and order-cancel.ts (the cancel #178, and the expiry #120 that the close and
 * a non-held early close call as `expireLockedOrders`) under the market lock (`lockMarket`,
 * order-writes.test.ts). A rejected order (a market, asset or quote reason) is a row with its
 * request id and reason; a refusal that writes no row is an error. Inserted in its final state of
 * the intake, then updated in place while it rests:
 * `orders_keep_record` (migration 0062) freezes its terms, moves its status forward only, grows its
 * filled amounts only and refuses DELETE — the history is the row and its fills. The lock an order
 * holds is `orderRemainingLock` (@buddha/shared contract.ts) over these columns
 * (`orderLockFactsOf`), with no stored copy (#118, ADR-0110): the balance's `locked_coin` and the
 * position's `locked_qty` sum the live orders' locks. No personal probability or belief (N04 §5),
 * no account type (the fill records both sides'), no rule version (ADR-0107 결정 5).
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** The owner: a person, or the 운영 마켓메이커 (its holder is the market's 마켓메이커 자금). */
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    outcome: outcomeEnum().notNull(),
    side: orderSideEnum().notNull(),
    /** IOC 즉시 거래 or GTC 지정가: no default, every order says which. */
    timeInForce: timeInForceEnum().notNull(),
    /** The confirmed limit the member sent, 1..99 (every order has one, a budget order too). */
    limitPrice: smallint().notNull(),
    /**
     * The limit the intake matched, locked and rests at: a GTC order's own; an IOC order's narrowed
     * to the reference ± the width (`protectedLimit`, #177 2항), never wider than `limit_price`.
     */
    protectedLimitPrice: smallint().notNull(),
    /** IOC: the best opposite entry at intake (1..99); null with none, for GTC, or not reached. */
    referencePrice: smallint(),
    /** IOC: the market's 가격 보호 폭 the intake used (1..98); null for GTC or a market reject. */
    protectionTicks: smallint(),
    /** A quantity order's contracts, 1..1,000,000; null exactly for a budget order. */
    qty: integer(),
    /** A budget order's Coin, 1..1,000,000 (an IOC buy only, #177 3항); null otherwise. */
    budgetCoin: bigint({ mode: 'bigint' }),
    /** Contracts filled (whatever the order kind: `hasMarketFill` reads `> 0`). */
    filledQty: integer().notNull().default(0),
    /** Σ its own price × qty over its fills: paid by a buy, received by a sell. */
    filledAmountCoin: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** A budget order's budget minus what it spent, given back at its end; null otherwise. */
    unspentCoin: bigint({ mode: 'bigint' }),
    status: orderStatusEnum().notNull(),
    /** Set exactly when `status` is `rejected` (거절). */
    rejectReason: orderRejectReasonEnum(),
    /** Set exactly when `status` is `cancelled` (취소 완료). */
    cancelReason: orderCancelReasonEnum(),
    /**
     * The request id (`Idempotency-Key`), unique per account like `payments.idempotency_key`
     * (migration 0009): a re-sent request reads its order back, and one account's key can never
     * collide with or probe another's.
     */
    idempotencyKey: text().notNull(),
    /**
     * The server's arrival order (ADR-0111 9-2): drawn at INSERT under the market lock, so within a
     * market it is the order of intake; the time priority of the book (`BookOrder.arrival`), kept
     * when the order is partly filled. Never `created_at` (ties inside a transaction) or `id`.
     */
    arrivalSeq: bigint({ mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    /** The intake's instant (the database clock of its transaction). */
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** When it left the live states; null while it rests. */
    endedAt: timestampTz(),
  },
  (t) => [
    // Per account, so one user's key can never collide with or probe another's (as payments).
    uniqueIndex('orders_user_id_idempotency_key_unique').on(t.userId, t.idempotencyKey),
    uniqueIndex('orders_arrival_seq_unique').on(t.arrivalSeq),
    // The book: a market's live orders in arrival order (the intake's read under the market lock).
    index('orders_market_live_idx')
      .on(t.marketId, t.arrivalSeq)
      .where(sql`${t.status} IN ${LIVE}`),
    // An account's live orders (the cancel at a restriction or a closure, #178; the
    // reconciliation, #93).
    index('orders_user_live_idx')
      .on(t.userId)
      .where(sql`${t.status} IN ${LIVE}`),
    index('orders_user_id_arrival_seq_idx').on(t.userId, desc(t.arrivalSeq)),
    index('orders_market_id_user_id_idx').on(t.marketId, t.userId),
    check('orders_limit_price_check', sql`${t.limitPrice} BETWEEN 1 AND 99`),
    check('orders_protected_limit_price_check', sql`${t.protectedLimitPrice} BETWEEN 1 AND 99`),
    check('orders_reference_price_check', sql`${t.referencePrice} BETWEEN 1 AND 99`),
    check('orders_protection_ticks_check', sql`${t.protectionTicks} BETWEEN 1 AND 98`),
    check('orders_qty_check', sql`${t.qty} BETWEEN 1 AND 1000000`),
    check('orders_budget_coin_check', sql`${t.budgetCoin} BETWEEN 1 AND 1000000`),
    /**
     * A quantity or a budget, never both (#177 3항): a budget order is an IOC buy whose budget is
     * what it spent plus what it gave back.
     */
    check(
      'orders_size_check',
      sql`(${t.qty} IS NULL) <> (${t.budgetCoin} IS NULL)
        AND (${t.budgetCoin} IS NULL OR (${t.side} = 'buy' AND ${t.timeInForce} = 'ioc'))
        AND (${t.budgetCoin} IS NULL) = (${t.unspentCoin} IS NULL)
        AND (${t.budgetCoin} IS NULL
             OR (${t.unspentCoin} >= 0 AND ${t.filledAmountCoin} + ${t.unspentCoin} = ${t.budgetCoin}))`,
    ),
    check(
      'orders_filled_check',
      sql`${t.filledQty} >= 0 AND (${t.qty} IS NULL OR ${t.filledQty} <= ${t.qty})
        AND ${t.filledAmountCoin} >= 0 AND (${t.filledQty} = 0) = (${t.filledAmountCoin} = 0)`,
    ),
    /**
     * 가격 보호 (#177 2항): a GTC order keeps its own limit and records no reference or width; an
     * IOC order records the width it used — none only when the market's status rejected it before
     * — and its protected limit is its own (no reference) or the narrowed one.
     */
    check(
      'orders_protection_check',
      sql`CASE ${t.timeInForce}
        WHEN 'gtc' THEN ${t.protectedLimitPrice} = ${t.limitPrice}
          AND ${t.referencePrice} IS NULL AND ${t.protectionTicks} IS NULL
        ELSE CASE WHEN ${t.protectionTicks} IS NULL
          THEN ${t.referencePrice} IS NULL AND ${t.protectedLimitPrice} = ${t.limitPrice}
            AND ${t.rejectReason} IS NOT NULL
            AND ${t.rejectReason}::text IN ('not_open_yet', 'paused', 'closed', 'ledger_hold', 'admin_role_revoked')
          ELSE (${t.referencePrice} IS NULL AND ${t.protectedLimitPrice} = ${t.limitPrice})
            OR (${t.side} = 'buy' AND ${t.protectedLimitPrice}
                = LEAST(${t.limitPrice}, ${t.referencePrice} + ${t.protectionTicks}, 99))
            OR (${t.side} = 'sell' AND ${t.protectedLimitPrice}
                = GREATEST(${t.limitPrice}, ${t.referencePrice} - ${t.protectionTicks}, 1))
          END
        END`,
    ),
    /**
     * The six states (#177 7·8항, ADR-0111 결정 6): a live order is a resting GTC quantity order
     * with no reason and no end; 전량 체결 filled every contract (a budget order: at least one);
     * 취소 완료 has its cancel reason and left contracts unfilled, an IOC one after a fill; 만료 is a
     * GTC order's; 거절 has its reason and no fill. Every ended order has its end.
     */
    check(
      'orders_status_check',
      sql`CASE ${t.status}
        WHEN 'open' THEN ${t.filledQty} = 0
        WHEN 'partially_filled' THEN ${t.qty} IS NOT NULL AND ${t.filledQty} > 0
          AND ${t.filledQty} < ${t.qty}
        WHEN 'filled' THEN CASE WHEN ${t.qty} IS NULL THEN ${t.filledQty} >= 1
          ELSE ${t.filledQty} = ${t.qty} END
        WHEN 'cancelled' THEN (${t.qty} IS NULL OR ${t.filledQty} < ${t.qty})
          AND (${t.timeInForce} = 'gtc' OR ${t.filledQty} >= 1)
        WHEN 'expired' THEN ${t.timeInForce} = 'gtc' AND ${t.qty} IS NOT NULL
          AND ${t.filledQty} < ${t.qty}
        ELSE ${t.filledQty} = 0
        END
        AND (${t.status} = 'rejected') = (${t.rejectReason} IS NOT NULL)
        AND (${t.status} = 'cancelled') = (${t.cancelReason} IS NOT NULL)
        AND (${t.status} IN ${LIVE}) = (${t.endedAt} IS NULL)
        AND (${t.status} NOT IN ${LIVE} OR (${t.timeInForce} = 'gtc' AND ${t.qty} IS NOT NULL))`,
    ),
    check(
      'orders_reason_check',
      sql`(${t.rejectReason} IS DISTINCT FROM 'budget_too_small' OR ${t.budgetCoin} IS NOT NULL)
        AND (${t.cancelReason} IS DISTINCT FROM 'ioc_remainder' OR ${t.timeInForce} = 'ioc')`,
    ),
  ],
);
