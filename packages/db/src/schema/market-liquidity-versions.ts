import { MAX_COIN_AMOUNT, ORDER_QTY_MAX } from '@buddha/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  doublePrecision,
  integer,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { timestampTz } from './columns.js';
import { markets } from './markets.js';

/** Permanent explicit configuration. The current pointer may advance only in DRAFT. */
export const marketLiquidityVersions = pgTable(
  'market_liquidity_versions',
  {
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    version: integer().notNull(),
    budgetCoin: bigint({ mode: 'bigint' }).notNull(),
    maxLossCoin: bigint({ mode: 'bigint' }).notNull(),
    b: doublePrecision().notNull(),
    levels: bigint({ mode: 'number' }).notNull(),
    quantity: integer().notNull(),
    safetyTicks: bigint({ mode: 'number' }).notNull(),
    reason: text().notNull(),
    createdBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestampTz().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.marketId, t.version] }),
    check('market_liquidity_versions_version_check', sql`${t.version} >= 1`),
    check(
      'market_liquidity_versions_coin_check',
      sql`${t.budgetCoin} BETWEEN 1 AND ${sql.raw(String(MAX_COIN_AMOUNT))} AND ${t.maxLossCoin} BETWEEN 1 AND ${t.budgetCoin}`,
    ),
    check(
      'market_liquidity_versions_b_check',
      sql`${t.b} > 0 AND ${t.b} < 'Infinity'::float8 AND 1.0 / ${t.b} < 'Infinity'::float8 AND 100.0 * ${t.b} < 'Infinity'::float8`,
    ),
    check(
      'market_liquidity_versions_ladder_check',
      sql`${t.levels} BETWEEN 1 AND 9007199254740991 AND ${t.quantity} BETWEEN 1 AND ${sql.raw(String(ORDER_QTY_MAX))} AND ${t.safetyTicks} BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      'market_liquidity_versions_reason_check',
      sql`length(btrim(${t.reason})) BETWEEN 1 AND 500`,
    ),
  ],
);
