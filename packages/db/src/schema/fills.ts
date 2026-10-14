import { desc, sql } from 'drizzle-orm';
import { bigint, bigserial, check, index, integer, pgTable, uuid } from 'drizzle-orm/pg-core';
import { createdAt } from './columns.js';
import { counterpartyTypeEnum, orderSideEnum, outcomeEnum } from './enums.js';
import { markets } from './markets.js';
import { orders } from './orders.js';

/** Executions (PLAN 5.4). Each matches an order against a resting one (#119 writes them). */
export const fills = pgTable(
  'fills',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    counterpartyType: counterpartyTypeEnum().notNull(),
    counterpartyOrderId: uuid().references(() => orders.id, { onDelete: 'restrict' }),
    outcome: outcomeEnum().notNull(),
    side: orderSideEnum().notNull(),
    qty: integer().notNull(),
    /** Total P paid (buy) or received (sell). */
    amountP: bigint({ mode: 'bigint' }).notNull(),
    /** Average price in basis points: amount_p * 100 / qty. */
    priceAvgBp: integer().notNull(),
    feeP: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    createdAt: createdAt(),
  },
  (t) => [
    index('fills_market_id_created_at_idx').on(t.marketId, desc(t.createdAt)),
    index('fills_order_id_idx').on(t.orderId),
    check('fills_qty_check', sql`${t.qty} > 0`),
    check('fills_amount_p_check', sql`${t.amountP} >= 0`),
    check('fills_price_avg_bp_check', sql`${t.priceAvgBp} BETWEEN 0 AND 10000`),
    check('fills_fee_p_check', sql`${t.feeP} >= 0`),
    check(
      'fills_counterparty_check',
      sql`${t.counterpartyType} = 'order' AND ${t.counterpartyOrderId} IS NOT NULL`,
    ),
  ],
);
