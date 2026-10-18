import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, timestampTz } from './columns.js';
import { ledgerEntries } from './ledger.js';

/**
 * 시작 지급 (#70, ADR-0071): one row per verified mobile number that was granted its start Coin, or
 * is waiting for it (ADR-0069 decision 1 #57-1·#57-18, decision 4 #70). The row's `id` is the
 * grant event id N01 §2 asks for (지급 이벤트 ID), and the START_GRANT ledger entry points at it
 * (`ref_type` 'start_grant').
 *
 * - `phone_hash` is UNIQUE: the number gets its start Coin once, whichever account verifies it. It
 *   is a keyed hash of the digits (HMAC-SHA256 under PHONE_HASH_KEY, apps/api identity/phone-hash.ts),
 *   never the number, so this row outlives the number: withdrawal (#140) deletes the number from
 *   `phone_verifications` and leaves this row as the record of "a number that received the start
 *   Coin", and a new account verifying the same number gets nothing (#57-17·#57-18).
 * - `user_id` is UNIQUE: an account gets one start grant, whatever happens to its number later.
 *   RESTRICT like the ledger: the account row stays through a withdrawal (#57-17).
 * - Pending until paid: `amount_coin`, `ledger_entry_id` and `granted_at` are all null while the
 *   release setting `grant.start_coin` has no value, and all set by the one transaction that pays
 *   it (the CHECK). The amount is read in that transaction, so a changed value applies to the grants
 *   paid after the change only (#57-2).
 *
 * The constraints are what make the grant happen once when calls repeat or race: a second row for
 * the same account or number cannot be inserted, and paying takes the row lock and pays only a
 * pending row. buddha_app may not DELETE (migration 0031), and two triggers keep the rest: a row
 * is inserted pending only (`start_grants_start_pending`), and the only UPDATE is pending →
 * granted by this grant's own START_GRANT entry (`start_grants_keep_record`). The record of a
 * number is never lost or rewritten by the app, and no row says "paid" without its entry.
 */
export const startGrants = pgTable(
  'start_grants',
  {
    /** The grant event id: the START_GRANT ledger entry's `ref_id`. */
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .unique('start_grants_user_id_unique')
      .references(() => user.id, { onDelete: 'restrict' }),
    /** Lower-case hex of HMAC-SHA256(PHONE_HASH_KEY, digits): 64 characters. */
    phoneHash: varchar({ length: 64 }).notNull().unique('start_grants_phone_hash_unique'),
    /** When the account became eligible and the number was recorded (the database clock). */
    createdAt: createdAt(),
    /** The Coin paid, read from the release setting when it was paid; null while pending. */
    amountCoin: bigint({ mode: 'bigint' }),
    /** The START_GRANT entry that paid it; null while pending. */
    ledgerEntryId: bigint({ mode: 'number' })
      .unique('start_grants_ledger_entry_id_unique')
      .references(() => ledgerEntries.id, { onDelete: 'restrict' }),
    /** The paying transaction's clock, the ledger entry's `created_at`; null while pending. */
    grantedAt: timestampTz(),
  },
  (t) => [
    check(
      'start_grants_paid_check',
      sql`(${t.grantedAt} IS NULL) = (${t.amountCoin} IS NULL) AND (${t.grantedAt} IS NULL) = (${t.ledgerEntryId} IS NULL)`,
    ),
    check('start_grants_amount_coin_check', sql`${t.amountCoin} > 0`),
    check('start_grants_phone_hash_check', sql`${t.phoneHash} ~ '^[0-9a-f]{64}$'`),
    /** The worker's scan of the grants still waiting, oldest first. */
    index('start_grants_pending_created_at_idx')
      .on(t.createdAt)
      .where(sql`${t.grantedAt} IS NULL`),
  ],
);
