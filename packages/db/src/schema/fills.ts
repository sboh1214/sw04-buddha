import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt } from './columns.js';
import { accountTypeEnum, fillKindEnum, orderSideEnum, outcomeEnum } from './enums.js';
import { markets } from './markets.js';
import { orders } from './orders.js';

/**
 * Fills (#119, ADR-0112; ADR-0107 결정 1 #177 11·12·15항): one row per match the intake made — an
 * incoming order against one resting order, at the resting order's price. A pair mint is one fill
 * with one YES price (11항); every fill the server recorded is valid. Written only by @buddha/db
 * orders.ts, before the asset move that names it (`String(id)` is the key of its ledger events),
 * and never changed: `fills_check` proves it against both orders and `fills_keep_record` refuses
 * UPDATE and DELETE (migration 0062). Both owners and their account types are recorded at the
 * write for the operators' and the metrics' reads (#20 '사람이 낀 체결', #121) and never leave in
 * a response: the public fill (`Fill`) and an owner's own fill (`MyFill`) name no counterparty
 * (ADR-0107 결정 5 '#179·#119'). No rule version (결정 5) and no personal probability (N04 §5).
 */
export const fills = pgTable(
  'fills',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    kind: fillKindEnum().notNull(),
    /** The order that came in and walked the book. */
    incomingOrderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    /** The resting order it met (a live GTC order that arrived before it). */
    restingOrderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    incomingOwnerId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    restingOwnerId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** Copied from `user.account_type` at the write; never in a response. */
    incomingAccountType: accountTypeEnum().notNull(),
    restingAccountType: accountTypeEnum().notNull(),
    /** The incoming order's outcome and side (the fill's direction). */
    outcome: outcomeEnum().notNull(),
    side: orderSideEnum().notNull(),
    qty: integer().notNull(),
    /** Per contract in the incoming contract: its fill price (`MatchFill.priceCoin`). */
    priceCoin: smallint().notNull(),
    /** The YES price the fill records (#177 11·15항): the price for YES, 100 − it for NO. */
    yesPriceCoin: smallint().notNull(),
    /** price_coin × qty: paid or received by the incoming order, and the volume (#177 12항). */
    amountCoin: bigint({ mode: 'bigint' }).notNull(),
    /** Always 0 (ADR-0107 결정 2 #73 15항); #91 relaxes `fills_fee_coin_check`. */
    feeCoin: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** The intake's instant. */
    createdAt: createdAt(),
  },
  (t) => [
    index('fills_market_id_created_at_idx').on(t.marketId, desc(t.createdAt)),
    index('fills_incoming_order_id_idx').on(t.incomingOrderId),
    index('fills_resting_order_id_idx').on(t.restingOrderId),
    // An owner's own fills, newest first, from either side (`GET /me/fills`).
    index('fills_incoming_owner_id_id_idx').on(t.incomingOwnerId, desc(t.id)),
    index('fills_resting_owner_id_id_idx').on(t.restingOwnerId, desc(t.id)),
    check('fills_qty_check', sql`${t.qty} BETWEEN 1 AND 1000000`),
    check('fills_price_coin_check', sql`${t.priceCoin} BETWEEN 1 AND 99`),
    check(
      'fills_yes_price_coin_check',
      sql`${t.yesPriceCoin} = CASE ${t.outcome} WHEN 'YES' THEN ${t.priceCoin} ELSE 100 - ${t.priceCoin} END`,
    ),
    check('fills_amount_coin_check', sql`${t.amountCoin} = ${t.priceCoin}::bigint * ${t.qty}`),
    check('fills_fee_coin_check', sql`${t.feeCoin} = 0`),
    // A pair mint is two buys; the incoming one is a buy too. Two orders of two owners.
    check('fills_kind_check', sql`${t.kind} <> 'pair_mint' OR ${t.side} = 'buy'`),
    check(
      'fills_orders_check',
      sql`${t.incomingOrderId} <> ${t.restingOrderId} AND ${t.incomingOwnerId} <> ${t.restingOwnerId}`,
    ),
  ],
);
