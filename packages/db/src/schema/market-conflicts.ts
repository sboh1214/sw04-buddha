import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { adminActions } from './admin-actions.js';
import { user } from './auth.js';
import { markets } from './markets.js';

/** An immutable, admin-only declaration. Historical fills remain in orders, without backfill. */
export const marketConflictDeclarations = pgTable(
  'market_conflict_declarations',
  {
    id: uuid().primaryKey().defaultRandom(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    reason: text().notNull(),
    declaredAt: timestamp({ withTimezone: true, precision: 3 }).notNull(),
    adminActionId: uuid()
      .notNull()
      .references(() => adminActions.id, { onDelete: 'restrict' }),
  },
  (t) => [
    unique('market_conflict_declarations_market_user_unique').on(t.marketId, t.userId),
    unique('market_conflict_declarations_action_unique').on(t.adminActionId),
    check(
      'market_conflict_declarations_reason_check',
      sql`char_length(btrim(${t.reason})) BETWEEN 1 AND 500`,
    ),
  ],
);
