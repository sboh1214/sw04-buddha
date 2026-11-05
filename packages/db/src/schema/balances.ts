import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, text } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { updatedAt } from './columns.js';
import { ledgerAccounts } from './ledger-accounts.js';

/**
 * Coin balances: one row per ledger account (#116, ADR-0109), born with it at 0 by migration
 * 0060's trigger. Invariant (PLAN 5.6): `ledger_coin` is the account's ledger sum — Coin in minus
 * Coin out, its latest event's total after — and changes only with a `ledger_entries` row in the
 * same transaction (`recordLedgerEntry`, @buddha/db; 0060's deferred triggers check it at COMMIT);
 * available_coin + locked_coin moves only together with it (0060's `balances_keep_ledger_gap`, at
 * every UPDATE), so the two are equal unless an owner-level write made them differ — an account
 * that then keeps its difference and still takes its events (ADR-0107 결정 2 #73 10항) until #93's
 * 대사 정정 closes it. `locked_coin` holds live orders' locks (#118, ADR-0110), which move Coin
 * between the two buckets of one account (`lockCoin`, `releaseCoin`) and are no ledger event
 * (ADR-0107 결정 2 #73 1항 주문 잠금).
 * buddha_app may UPDATE the three amounts and `updated_at` only, and never INSERT or DELETE a row.
 */
export const balances = pgTable(
  'balances',
  {
    accountId: bigint({ mode: 'number' })
      .primaryKey()
      .references(() => ledgerAccounts.id, { onDelete: 'restrict' }),
    /**
     * The owner of a `user` ledger account, copied once when the row is born (null for every
     * other kind), so a person's balance is read by account id as before.
     */
    userId: text()
      .unique('balances_user_id_unique')
      .references(() => user.id, { onDelete: 'cascade' }),
    // drizzle-kit cannot serialise a 0n default into its snapshot; sql`0` emits DEFAULT 0.
    availableCoin: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    lockedCoin: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /**
     * The account's total as its ledger says (Coin in minus Coin out by its events — the
     * `ledger_account_last_after` of its latest event), moved with the bucket by every event.
     */
    ledgerCoin: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('balances_available_coin_check', sql`${t.availableCoin} >= 0`),
    check('balances_locked_coin_check', sql`${t.lockedCoin} >= 0`),
    check('balances_ledger_coin_check', sql`${t.ledgerCoin} >= 0`),
  ],
);
