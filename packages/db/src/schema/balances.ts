import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, text } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { updatedAt } from './columns.js';

/**
 * Point balances. Invariant (PLAN 0.2/5.6): every change happens in the same transaction as a
 * `ledger_entries` INSERT, and available_p + locked_p == SUM(ledger_entries.amount_p).
 * `locked_p` is reserved for limit orders (always 0 in the MVP). Rows are created by the
 * "user" trigger (migration 0002) with both amounts at 0.
 */
export const balances = pgTable(
  'balances',
  {
    userId: text()
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    // drizzle-kit cannot serialise a 0n default into its snapshot; sql`0` emits DEFAULT 0.
    availableP: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    lockedP: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('balances_available_p_check', sql`${t.availableP} >= 0`),
    check('balances_locked_p_check', sql`${t.lockedP} >= 0`),
  ],
);
