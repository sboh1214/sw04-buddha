import { START_GRANT_NUMBER_SOURCES } from '@buddha/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, timestampTz } from './columns.js';
import { ledgerEntries } from './ledger.js';

/**
 * 시작 지급 (#70, ADR-0071): an account's start grant — paid, waiting for its amount, or cancelled
 * — one row per account, ever (ADR-0069 decision 1 #57-1, decision 4 #70). The row's `id` is the
 * grant event id N01 §2 asks for (지급 이벤트 ID), and the START_GRANT ledger entry points at it
 * (`ref_type` 'start_grant'). The numbers it counts for are `start_grant_numbers`, below: one or
 * more per grant.
 *
 * - `user_id` is UNIQUE: an account gets one start grant, whatever happens to its number later,
 *   and a cancelled one is not replaced. RESTRICT like the ledger: the account row stays through
 *   a withdrawal (#57-17).
 * - Pending until paid or cancelled. Paid: `amount_coin`, `ledger_entry_id` and `granted_at`, all
 *   null while it waits — the release setting `grant.start_coin` has no value — and all set by the
 *   one transaction that pays it (the CHECK). The amount is read in that transaction, so a changed
 *   value applies to the grants paid after the change only (#57-2). Cancelled: `cancelled_at`,
 *   set when the account withdraws while it waits (owner decision 2026-10-18, `cancelStartGrant`)
 *   — never with the payment's three (the CHECK). The row stays as history.
 *
 * The constraints are what make the grant happen once when calls repeat or race: a second row for
 * the same account cannot be inserted, a number is held by one grant at a time
 * (`start_grant_numbers`), and paying takes the row lock and pays only a pending row. buddha_app
 * may not DELETE (migration 0031), and triggers keep the rest: a row is inserted pending only and
 * holds its number by the end of its transaction, and the only UPDATEs are pending → granted by
 * this grant's own START_GRANT entry and pending → cancelled, which frees its numbers. The record
 * of a number is never lost or rewritten by the app, and no row says "paid" without its entry.
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
    /** When the account became eligible and the grant was recorded (the database clock). */
    createdAt: createdAt(),
    /** The Coin paid, read from the release setting when it was paid; null unless paid. */
    amountCoin: bigint({ mode: 'bigint' }),
    /** The START_GRANT entry that paid it; null unless paid. */
    ledgerEntryId: bigint({ mode: 'number' })
      .unique('start_grants_ledger_entry_id_unique')
      .references(() => ledgerEntries.id, { onDelete: 'restrict' }),
    /** The paying transaction's clock, the ledger entry's `created_at`; null unless paid. */
    grantedAt: timestampTz(),
    /** The cancelling transaction's clock (a withdrawal while it waited); null unless cancelled. */
    cancelledAt: timestampTz(),
  },
  (t) => [
    check(
      'start_grants_paid_check',
      sql`(${t.grantedAt} IS NULL) = (${t.amountCoin} IS NULL) AND (${t.grantedAt} IS NULL) = (${t.ledgerEntryId} IS NULL)`,
    ),
    check('start_grants_amount_coin_check', sql`${t.amountCoin} > 0`),
    /** Paid or cancelled, never both. */
    check('start_grants_settled_check', sql`${t.grantedAt} IS NULL OR ${t.cancelledAt} IS NULL`),
    /** The worker's scan of the grants still waiting, oldest first. */
    index('start_grants_pending_created_at_idx')
      .on(t.createdAt)
      .where(sql`${t.grantedAt} IS NULL AND ${t.cancelledAt} IS NULL`),
  ],
);

/**
 * The numbers that received the start Coin (ADR-0069 #57-18 '시작 Coin을 받은 번호' 기록, #70,
 * ADR-0071): one row per number and the grant it counts for — the number the account had when the
 * grant was recorded (`source` 'grant'), and any number an operator later gave the account by
 * hand and recorded too (`operator`, owner decision 2026-10-18, docs/OPERATIONS.md). A grant's
 * numbers stand for it, paid or waiting: a new account that verifies one of them gets nothing.
 *
 * - `phone_hash` is a keyed hash of the digits (HMAC-SHA256 under PHONE_HASH_KEY, apps/api
 *   identity/phone-hash.ts), never the number, so the row outlives the number: withdrawal (#140)
 *   deletes the number from `phone_verifications` and leaves this row (#57-17·#57-18).
 * - One live row per number (`start_grant_numbers_phone_hash_live_idx`, UNIQUE among the rows not
 *   released): whichever account verifies it, a number counts for one grant at a time. A row is
 *   released (`released_at`, the grant's `cancelled_at`) only by its grant's cancellation, which
 *   releases them all (migration 0031's trigger): a number whose grant never paid is free again
 *   for the next account (owner decision 2026-10-18). A released row stays as history.
 * - One `grant` row per grant (`start_grant_numbers_grant_id_source_grant_idx`); a grant holds it
 *   from its own transaction on (0031's deferred check). Any number of `operator` rows.
 * - The key is (`grant_id`, `phone_hash`): a grant records a number once.
 *
 * buddha_app may not DELETE; the triggers of migration 0031 let a row be inserted live for a grant
 * that is not cancelled and changed only by its release.
 */
export const startGrantNumbers = pgTable(
  'start_grant_numbers',
  {
    /** Lower-case hex of HMAC-SHA256(PHONE_HASH_KEY, digits): 64 characters. */
    phoneHash: varchar({ length: 64 }).notNull(),
    grantId: uuid()
      .notNull()
      .references(() => startGrants.id, { onDelete: 'restrict' }),
    /** START_GRANT_NUMBER_SOURCES: the grant's own number, or one an operator recorded later. */
    source: varchar({ length: 8, enum: START_GRANT_NUMBER_SOURCES }).notNull(),
    /** When it was recorded (the database clock). */
    createdAt: createdAt(),
    /** Its grant's `cancelled_at`, once the cancellation freed the number; null while it holds it. */
    releasedAt: timestampTz(),
  },
  (t) => [
    primaryKey({ columns: [t.grantId, t.phoneHash] }),
    uniqueIndex('start_grant_numbers_phone_hash_live_idx')
      .on(t.phoneHash)
      .where(sql`${t.releasedAt} IS NULL`),
    uniqueIndex('start_grant_numbers_grant_id_source_grant_idx')
      .on(t.grantId)
      .where(sql`${t.source} = 'grant'`),
    check('start_grant_numbers_phone_hash_check', sql`${t.phoneHash} ~ '^[0-9a-f]{64}$'`),
    check('start_grant_numbers_source_check', sql`${t.source} IN ('grant', 'operator')`),
  ],
);
