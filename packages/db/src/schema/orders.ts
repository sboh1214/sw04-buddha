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
import { createdAt, updatedAt } from './columns.js';
import {
  orderSideEnum,
  orderStatusEnum,
  orderTypeEnum,
  outcomeEnum,
  timeInForceEnum,
} from './enums.js';
import { markets } from './markets.js';

/**
 * CLOB-ready order log (PLAN 6.2, 16). The MVP only writes `type='market'` orders that are
 * filled by the AMM inside the trade transaction (PLAN 5.4 step 6).
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    outcome: outcomeEnum().notNull(),
    side: orderSideEnum().notNull(),
    type: orderTypeEnum().notNull(),
    /** 1..99, limit orders only. */
    limitPrice: smallint(),
    qty: integer().notNull(),
    filledQty: integer().notNull().default(0),
    status: orderStatusEnum().notNull(),
    timeInForce: timeInForceEnum().notNull().default('ioc'),
    /**
     * The client's `Idempotency-Key` (PLAN 5.4), unique per account like
     * `payments.idempotency_key` (migration 0009; before it the key was unique across every
     * user, so client-minted keys could collide with, or probe, another account's). There is
     * no Redis response cache: a replay is rebuilt from this row, its fill and its ledger
     * entry, which already hold the answer and never expire (ADR-0027, M3 design 3.3).
     */
    idempotencyKey: text().notNull(),
    // slippage guards (PLAN 5.3)
    maxCostP: bigint({ mode: 'bigint' }),
    minProceedsP: bigint({ mode: 'bigint' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('orders_user_id_created_at_idx').on(t.userId, desc(t.createdAt)),
    index('orders_market_id_status_idx').on(t.marketId, t.status),
    // Per account, so one user's key can never collide with or probe another's (as payments).
    uniqueIndex('orders_user_id_idempotency_key_unique').on(t.userId, t.idempotencyKey),
    check('orders_qty_check', sql`${t.qty} > 0`),
    check('orders_filled_qty_check', sql`${t.filledQty} >= 0 AND ${t.filledQty} <= ${t.qty}`),
    check(
      'orders_limit_price_check',
      sql`${t.limitPrice} IS NULL OR ${t.limitPrice} BETWEEN 1 AND 99`,
    ),
    check(
      'orders_type_limit_price_check',
      sql`(${t.type} = 'limit') = (${t.limitPrice} IS NOT NULL)`,
    ),
  ],
);
