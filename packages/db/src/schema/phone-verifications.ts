import { desc, sql } from 'drizzle-orm';
import { check, index, pgTable, smallint, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { timestampTz, updatedAt } from './columns.js';

/**
 * 본인확인 (#183, ADR-0070): the accounts that proved a mobile number by typing back the SMS code
 * sent to it, one row per account, written only by the confirmation that matched a code. A row
 * here is what "this account is verified" means wherever the server asks (`isPhoneVerified`,
 * src/phone-verification.ts): the onboarding (#58), the starting Coin (#70) and the admin grant
 * (ADR-0056 decision 1-11) all read it. It replaced ADR-0043's `user_contacts`, whose unverified
 * rows migration 0028 dropped with the table (D4: nothing is carried over).
 *
 * - `phone` is UNIQUE: one live account per number (ADR-0069 decision 1, #57-1). The constraint,
 *   not a read before the write, is what holds it when two accounts confirm the same number at
 *   once; the CHECK keeps it the digits `phoneSchema` (@buddha/shared) yields, so two spellings of
 *   one number cannot pass as two. The member cannot change it; operators do it here by hand
 *   (#57-3). A keyed hash of it is what the starting Coin's "once per number" will keep (#70), so
 *   withdrawal (#140) can delete this row and the number with it.
 * - `real_name` is what the member gave with the number, editable in MY 설정 (#57-3).
 *
 * CASCADE like `profiles`: personal data goes with the account, and nothing references it.
 * buddha_app keeps every privilege of the defaults: the real name changes in place, and the row
 * goes when the account does.
 */
export const phoneVerifications = pgTable(
  'phone_verifications',
  {
    userId: text()
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Digits only, e.g. 01012345678. */
    phone: varchar({ length: 11 }).notNull().unique(),
    realName: varchar({ length: 30 }).notNull(),
    /** The database clock of the confirmation that matched the code. */
    verifiedAt: timestampTz().defaultNow().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [check('phone_verifications_phone_check', sql`${t.phone} ~ '^01[016789][0-9]{7,8}$'`)],
);

/**
 * The SMS codes sent for 본인확인 (ADR-0070), one row per send, which is also the record the
 * owner's fixed limits count (ADR-0069 decision 1 #57-3, PHONE_VERIFICATION_LIMITS): the newest
 * row of an account says whether the 60 seconds since its last send have passed, and the rows of
 * the last 24 hours, by account and by number, whether ten were sent already. Kept in Postgres so
 * the limits hold across restarts and API instances.
 *
 * - Only the newest row of an account can be confirmed; a new send replaces the code it held.
 * - `code_hash` is an HMAC of the code under a key derived from the server's secret, bound to the
 *   row's id: the six digits themselves are never stored, and a copy of this table does not give
 *   them away to a million guesses. The API compares in constant time.
 * - `attempts` counts wrong entries: the fifth discards the code (#57-3). `consumed_at` is set by
 *   the confirmation that matched it, in the transaction that writes `phone_verifications`.
 * - `phone` and `real_name` are what the request named; the confirmation copies them over.
 *
 * Transient: a row older than the 24-hour window counts for nothing, and the API deletes those
 * whenever it sends (so a row lasts until the next send by any account after its 24 hours). A
 * send the SMS provider certainly refused is deleted at once (it was never a send); one whose
 * outcome is unknown stays, counted and confirmable, since the phone may hold its code. The
 * account FK is CASCADE, but withdrawal keeps the `user` row (the ledger references it), so the
 * withdrawal of #140 must delete these rows — the number and the real name — itself (ADR-0070).
 */
export const phoneVerificationCodes = pgTable(
  'phone_verification_codes',
  {
    /** Chosen by the API before the insert: the HMAC binds the code to it. */
    id: uuid().primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Digits only: the number the code was texted to. */
    phone: varchar({ length: 11 }).notNull(),
    realName: varchar({ length: 30 }).notNull(),
    /** Lower-case hex of the HMAC-SHA256 (64 characters). */
    codeHash: varchar({ length: 64 }).notNull(),
    /** The database clock of the send: the resend interval and the daily windows read it. */
    sentAt: timestampTz().defaultNow().notNull(),
    expiresAt: timestampTz().notNull(),
    attempts: smallint().notNull().default(0),
    consumedAt: timestampTz(),
  },
  (t) => [
    /** An account's newest code (the one a confirmation reads) and its sends of the last day. */
    index('phone_verification_codes_user_id_sent_at_id_idx').on(
      t.userId,
      desc(t.sentAt),
      desc(t.id),
    ),
    /** The sends to one number in the last day, whichever accounts asked. */
    index('phone_verification_codes_phone_sent_at_idx').on(t.phone, t.sentAt),
    /** The rows past the 24-hour window, which every send deletes. */
    index('phone_verification_codes_sent_at_idx').on(t.sentAt),
    check('phone_verification_codes_attempts_check', sql`${t.attempts} >= 0`),
    check('phone_verification_codes_expiry_check', sql`${t.expiresAt} > ${t.sentAt}`),
  ],
);
