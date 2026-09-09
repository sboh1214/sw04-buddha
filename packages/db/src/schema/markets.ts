import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { categories } from './categories.js';
import { createdAt, timestampTz, updatedAt } from './columns.js';
import {
  marketMechanismEnum,
  marketStatusEnum,
  marketVisibilityEnum,
  outcomeEnum,
} from './enums.js';

/**
 * Binary markets (PLAN 5.2, 6.2). LMSR state (`q_yes`, `q_no`, `liquidity_b`) is stored as
 * `numeric` and read back as strings; only the LMSR engine converts to double, and every P
 * amount is fixed to an integer at that boundary (PLAN 0.2). `visibility`/`group_id` are
 * group-readiness columns without a FK (PLAN 6.3).
 */
export const markets = pgTable(
  'markets',
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: varchar({ length: 80 }).notNull().unique(),
    title: varchar({ length: 120 }).notNull(),
    description: text(),
    /** Resolution criteria. Required for draft -> open (PLAN 0.2). */
    rules: text().notNull(),
    resolutionSource: text(),
    categoryId: integer()
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    imageUrl: text(),
    mechanism: marketMechanismEnum().notNull().default('lmsr'),
    status: marketStatusEnum().notNull().default('draft'),
    visibility: marketVisibilityEnum().notNull().default('public'),
    groupId: uuid(),
    // LMSR state
    liquidityB: numeric({ precision: 18, scale: 6 }).notNull(),
    qYes: numeric({ precision: 24, scale: 10 }).notNull(),
    qNo: numeric({ precision: 24, scale: 10 }).notNull(),
    /** Initial YES probability in basis points, 1..9999. */
    initialProbBp: smallint().notNull(),
    /** Operator's maximum loss, maxLossP(p0, b): ceil(100·b·−ln(min(p0, 1−p0))) — ADR-0027. */
    reserveP: bigint({ mode: 'bigint' }).notNull(),
    // statistics
    /** Displayed YES price 1..99 (PLAN 5.3). */
    lastPrice: smallint().notNull(),
    volumeP: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    tradeCount: integer().notNull().default(0),
    traderCount: integer().notNull().default(0),
    // fees (schema only, PLAN 5.7)
    takerFeeBps: smallint().notNull().default(0),
    settlementFeeBps: smallint().notNull().default(0),
    // schedule / resolution
    openAt: timestampTz(),
    closeAt: timestampTz().notNull(),
    resolvedResult: outcomeEnum(),
    resolvedAt: timestampTz(),
    disputeUntil: timestampTz(),
    settledAt: timestampTz(),
    voidedAt: timestampTz(),
    /**
     * `market_events.id` of the transition that produced `status` (M5, A-M3-19): the ordering
     * key of `market:status` and of the market DTOs. Written by every transition in the same
     * transaction as its event row, under the market's advisory lock, so it is the market's
     * commit order. No FK — market_events is append-only and the id is never reused. Null
     * only for a row written outside the transition paths (a test factory; migration 0011
     * backfills every existing market from its newest transition event).
     */
    statusEventId: bigint({ mode: 'number' }),
    createdBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('markets_status_close_at_idx').on(t.status, t.closeAt),
    index('markets_category_id_status_idx').on(t.categoryId, t.status),
    check('markets_liquidity_b_check', sql`${t.liquidityB} > 0`),
    check(
      'markets_initial_prob_bp_check',
      sql`${t.initialProbBp} >= 1 AND ${t.initialProbBp} <= 9999`,
    ),
    check('markets_last_price_check', sql`${t.lastPrice} >= 1 AND ${t.lastPrice} <= 99`),
    check('markets_reserve_p_check', sql`${t.reserveP} >= 0`),
    check('markets_volume_p_check', sql`${t.volumeP} >= 0`),
    check('markets_trade_count_check', sql`${t.tradeCount} >= 0`),
    check('markets_trader_count_check', sql`${t.traderCount} >= 0`),
    check(
      'markets_fee_bps_check',
      sql`${t.takerFeeBps} BETWEEN 0 AND 10000 AND ${t.settlementFeeBps} BETWEEN 0 AND 10000`,
    ),
  ],
);
