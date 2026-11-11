import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { timestampTz } from './columns.js';
import { markets } from './markets.js';

/** Operational observation only. Immutable economic completion stays in market_maker_recalls. */
export const marketMakerRecallAttempts = pgTable(
  'market_maker_recall_attempts',
  {
    marketId: uuid()
      .primaryKey()
      .references(() => markets.id, { onDelete: 'restrict' }),
    attempts: integer().notNull(),
    state: varchar({ length: 16 }).$type<'waiting' | 'failed' | 'completed'>().notNull(),
    reason: text(),
    lastAttemptAt: timestampTz().notNull(),
    lastFailureAt: timestampTz(),
    lastFailureReason: text(),
  },
  (t) => [
    check('market_maker_recall_attempts_count_check', sql`${t.attempts} > 0`),
    check(
      'market_maker_recall_attempts_state_check',
      sql`${t.state} IN ('waiting','failed','completed')`,
    ),
    check(
      'market_maker_recall_attempts_reason_check',
      sql`(${t.state}='completed' AND ${t.reason} IS NULL) OR (${t.state}='waiting' AND ${t.reason} IS NOT NULL AND ${t.reason} IN ('ledger_hold','treasury_capacity')) OR (${t.state}='failed' AND ${t.reason} IS NOT NULL AND ${t.reason} IN ('books_inconsistent','recall_inconsistent','execution_failed'))`,
    ),
    check(
      'market_maker_recall_attempts_failure_check',
      sql`(${t.lastFailureAt} IS NULL AND ${t.lastFailureReason} IS NULL) OR (${t.lastFailureAt} IS NOT NULL AND ${t.lastFailureReason} IS NOT NULL AND ${t.lastFailureReason} IN ('books_inconsistent','recall_inconsistent','execution_failed'))`,
    ),
  ],
);
