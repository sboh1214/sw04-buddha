import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { categories } from './categories.js';
import { createdAt, timestampTz, updatedAt } from './columns.js';
import { marketStatusEnum, marketVisibilityEnum, outcomeEnum } from './enums.js';

/**
 * Binary markets (PLAN 5.2, 6.2). A market holds no pricing-engine state: the direct AMM's
 * columns and `mechanism` were dropped with it (#125, migration 0017), and the CLOB's own shape
 * is #119's. `visibility`/`group_id` are group-readiness columns without a FK (PLAN 6.3).
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
    status: marketStatusEnum().notNull().default('draft'),
    visibility: marketVisibilityEnum().notNull().default('public'),
    groupId: uuid(),
    // statistics
    /**
     * YES price 1..99 of the last fill (PLAN 5.3). NULL until the first fill — '체결 없음'
     * (N02 §5) — and the CHECK below passes a NULL, as every SQL CHECK does.
     */
    lastPrice: smallint(),
    volumeCoin: bigint({ mode: 'bigint' })
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
    /**
     * `GET /markets?sort=newest` (신규, ADR-0065): the actual open time, latest first, under a
     * status filter — `(coalesce(open_at, '-infinity') DESC, id DESC)`, which is `open_at DESC
     * NULLS LAST` written as a value a row-comparison cursor can page across (market-order.ts).
     * The expression is the index key, spelled exactly as the query spells it, so the keyset
     * predicate is an Index Cond like every other list's (A-M3-10, ADR-0039). Status-leading
     * because the home always filters on `open` (ADR-0061 decision 1, item 13).
     *
     * The volume order's `(status, volume_coin DESC, id DESC)` went with that order (ADR-0065,
     * migration 0024): nothing reads it until #132 brings the order back, and while it stood
     * every fill's `volume_coin` update had to write it (no HOT update on an indexed column).
     * 추천 orders by a 24-hour SUM no index can hold; its lateral reads
     * `fills_market_id_created_at_idx`.
     */
    index('markets_status_open_at_id_idx').on(
      t.status,
      sql`coalesce(${t.openAt}, '-infinity'::timestamptz) DESC`,
      desc(t.id),
    ),
    /**
     * `GET /admin/markets`, whose `status` filter is OPTIONAL, ordered `(created_at DESC,
     * id DESC)`.
     *
     * Its own index rather than a `(status, created_at DESC, id DESC)` one, and the plan is the
     * reason: a leading column that is not constrained cannot yield an index-ordered scan, so
     * with only the status-leading index the unfiltered admin list falls back to
     * `Seq Scan + top-N Sort` — measured at 1626 ms on 2M rows against 0.10 ms here. It served
     * the public `newest` too while that order was `created_at` (ADR-0039 decision 3); since
     * ADR-0065 `newest` is the open time and has its own index above.
     */
    index('markets_created_at_id_idx').on(desc(t.createdAt), desc(t.id)),
    check('markets_last_price_check', sql`${t.lastPrice} >= 1 AND ${t.lastPrice} <= 99`),
    check('markets_volume_coin_check', sql`${t.volumeCoin} >= 0`),
    check('markets_trade_count_check', sql`${t.tradeCount} >= 0`),
    check('markets_trader_count_check', sql`${t.traderCount} >= 0`),
    check(
      'markets_fee_bps_check',
      sql`${t.takerFeeBps} BETWEEN 0 AND 10000 AND ${t.settlementFeeBps} BETWEEN 0 AND 10000`,
    ),
  ],
);
