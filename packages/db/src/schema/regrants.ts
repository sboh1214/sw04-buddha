import { desc, sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt } from './columns.js';
import { ledgerEntries } from './ledger.js';

/**
 * 제한적 재지급 (#74, ADR-0155): one row per re-grant given — a refused request leaves none (owner
 * answer 2026-11-21 2: nothing waits). The row's `id` is the grant event id N01 §2 asks for
 * (지급 이벤트 ID); the REGRANT ledger entry refers to it (`ref_type` 'regrant') and is keyed by it
 * (`ledgerKeys.regrant`), and the row names that entry. Written only by `applyRegrant`
 * (@buddha/db), whole at once, after its entry: nothing in it changes later.
 *
 * - `request_id` is the request's `Idempotency-Key`, UNIQUE per account with `user_id` as
 *   `orders.idempotency_key` is: a re-sent request reads its re-grant back, and one account's key
 *   never collides with or probes another's (N01 §9 같은 요청 ID는 한 번만).
 * - `available_before_coin`: the account's available Coin read under its balance lock when it was
 *   granted — the 소진 the threshold was checked against, kept for the admin record.
 * - `created_at` is the grant's instant, its ledger entry's: the wait, the period and the cap are
 *   counted from these rows (`user_id, created_at` index).
 *
 * Kept for good, like the ledger: buddha_app may neither UPDATE nor DELETE (migration 0077), and
 * the account row stays through a withdrawal (RESTRICT, #57-17). Migration 0077's triggers refuse a
 * row of the 운영 마켓메이커 (#115), of a closed account, or one that its own REGRANT entry (this
 * account, this amount, this id, this instant) does not back.
 */
export const regrants = pgTable(
  'regrants',
  {
    /** The grant event id: the REGRANT ledger entry's `ref_id` and key. */
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** The request id (`Idempotency-Key`): unique per account. */
    requestId: text().notNull(),
    /** The Coin given: the release setting's 1회 지급액 when it was given. */
    amountCoin: bigint({ mode: 'bigint' }).notNull(),
    /** The account's available Coin under the lock, before this grant (at most the threshold). */
    availableBeforeCoin: bigint({ mode: 'bigint' }).notNull(),
    /** The REGRANT entry that gave it. */
    ledgerEntryId: bigint({ mode: 'number' })
      .notNull()
      .unique('regrants_ledger_entry_id_unique')
      .references(() => ledgerEntries.id, { onDelete: 'restrict' }),
    /** The grant's instant: its ledger entry's `created_at` (the database clock after the locks). */
    createdAt: createdAt(),
  },
  (t) => [
    unique('regrants_user_id_request_id_unique').on(t.userId, t.requestId),
    check('regrants_amount_coin_check', sql`${t.amountCoin} > 0`),
    check('regrants_available_before_coin_check', sql`${t.availableBeforeCoin} >= 0`),
    /** The shape of an `Idempotency-Key` (@buddha/shared idempotencyKeySchema). */
    check('regrants_request_id_check', sql`${t.requestId} ~ '^[A-Za-z0-9_-]{8,128}$'`),
    /** An account's re-grants, newest first: its wait, period and cap, and its records. */
    index('regrants_user_id_created_at_idx').on(t.userId, desc(t.createdAt)),
    /** Every account's re-grants, newest first: the admin list's keyset. */
    index('regrants_created_at_id_idx').on(desc(t.createdAt), desc(t.id)),
  ],
);
