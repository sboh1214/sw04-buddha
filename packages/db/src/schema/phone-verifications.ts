import { PHONE_VERIFICATION_SEND_OUTCOMES } from '@buddha/shared';
import { desc, sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  inet,
  pgTable,
  smallint,
  text,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
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
 *   (#57-3), and record the new number's keyed hash for the start Coin too (docs/OPERATIONS.md,
 *   owner decision 2026-10-18). The starting Coin's "once per number" keeps a keyed hash of it in
 *   `start_grant_numbers` (#70, ADR-0071) — computed from this column when needed, never stored
 *   beside it, since a hand edit here could not recompute it — so withdrawal (#140) can delete
 *   this row and the number with it (the one row #140 deletes for 본인확인). Copies of the
 *   number and the real name stay in `phone_verification_codes` all the same, kept as 본인확인
 *   기록 past the withdrawal: the owner made them an exception to ADR-0069 #57-18's immediate
 *   deletion (ADR-0070, owner decision 2026-10-18, second round).
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
 * The SMS codes sent for 본인확인 (ADR-0070), one row per send: the 본인확인 기록 of the account
 * (owner decision 2026-10-18) and the record the owner's fixed limits count (ADR-0069 decision 1
 * #57-3, PHONE_VERIFICATION_LIMITS). The newest row of an account says whether the 60 seconds
 * since its last send have passed; the rows of the last 24 hours, by account, by account and
 * number, by number (how many accounts), by client address and in all, whether a limit is
 * reached. Kept in Postgres so the limits hold across restarts and API instances.
 *
 * - Only the newest row of an account can be confirmed; a new send replaces the code it held. An
 *   older code of the account — among the nine before the newest, however old — is recognised
 *   when typed (`superseded`) and not counted.
 * - `code_hash` is an HMAC of the code under a key derived from the server's secret, bound to the
 *   row's id: the six digits themselves are never stored, and a copy of this table does not give
 *   them away to a million guesses. The API compares in constant time.
 * - `attempts` counts wrong entries: the fifth discards the code (#57-3). `consumed_at` is set by
 *   the confirmation that matched it, in the transaction that writes `phone_verifications`.
 * - `phone` and `real_name` are what the request named; the confirmation copies them over.
 * - `client_ip` is the address the request came from when it names a client — the per-address
 *   rate limit's rule (`isCountableAddress`: not loopback, not a proxy RATE_LIMIT_UNCOUNTED_PEERS
 *   lists; behind Caddy, TRUST_PROXY makes it the visitor's) — and NULL otherwise. Personal data
 *   like the rest of the row, kept with it for the retention period (owner decision 2026-10-18,
 *   second round): no route returns it and nothing logs it.
 * - `send_outcome` (0030) is what the provider said: `unknown` from the insert — the row is
 *   written before the provider is asked — and `accepted` once it took the text. A send whose
 *   answer never came stays `unknown` (SMS_SEND_UNCONFIRMED). Only the admin's send status reads
 *   it (`GET /admin/sms/status`), as counts.
 *
 * Kept, not purged: the rows are the account's 본인확인 기록 (number, real name, code hash, time,
 * address), which the retention job of #184 deletes once the retention period of that kind has
 * passed since the account's withdrawal (ADR-0069 #184); a live account keeps them. So the number,
 * the real name and the address outlive a withdrawal in plain text: the owner made the 본인확인
 * 기록 an exception to ADR-0069 #57-18's immediate deletion (ADR-0070, owner decision 2026-10-18,
 * second round), and #140 deletes only the account's `phone_verifications` row. A send the SMS
 * provider certainly refused is deleted at once (it was never a send) and leaves its time alone
 * in `phone_verification_refused_sends`; one whose outcome is unknown stays, counted and
 * confirmable, since the phone may hold its code. The account FK is CASCADE, but withdrawal keeps
 * the `user` row (the ledger references it), so nothing here goes with a withdrawal by itself
 * (ADR-0070).
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
    /** The client address of the request, when it names one; NULL behind loopback or a proxy. */
    clientIp: inet(),
    /** PHONE_VERIFICATION_SEND_OUTCOMES: `unknown` until the provider took the text. */
    sendOutcome: varchar({ length: 8, enum: PHONE_VERIFICATION_SEND_OUTCOMES })
      .notNull()
      .default('unknown'),
  },
  (t) => [
    /**
     * An account's newest code (the one a confirmation reads), its sends of the last day and the
     * older codes a confirmation recognises (the nine before the newest).
     */
    index('phone_verification_codes_user_id_sent_at_id_idx').on(
      t.userId,
      desc(t.sentAt),
      desc(t.id),
    ),
    /** The sends to one number in the last day, and the accounts they were for. */
    index('phone_verification_codes_phone_sent_at_idx').on(t.phone, t.sentAt),
    /** The service's sends in the last day, and the admin's send status (seven days at most). */
    index('phone_verification_codes_sent_at_idx').on(t.sentAt),
    /** The sends from one client address in the last day. */
    index('phone_verification_codes_client_ip_sent_at_idx').on(t.clientIp, t.sentAt),
    check('phone_verification_codes_attempts_check', sql`${t.attempts} >= 0`),
    check('phone_verification_codes_expiry_check', sql`${t.expiresAt} > ${t.sentAt}`),
    check(
      'phone_verification_codes_send_outcome_check',
      sql`${t.sendOutcome} IN ('accepted', 'unknown')`,
    ),
  ],
);

/**
 * The 본인확인 sends the SMS provider certainly refused (SMS_SEND_FAILED, ADR-0070): the time of
 * each, and nothing else — no account, number, name or address — so the admin's send status
 * (`GET /admin/sms/status`, owner decision 2026-10-18, second round) can count them while the
 * refused send itself is deleted from `phone_verification_codes` (it was never a send, so no limit
 * counts it, and no personal data of it is kept).
 *
 * The status reads seven Korean calendar days at most, so each refusal also deletes the rows older
 * than eight days (`REFUSED_SENDS_KEPT_DAYS`, apps/api): about a week's worth while refusals keep
 * coming. Nothing else deletes them, so once refusals stop (the provider's keys work) the last
 * ones stay until the next refusal — a time each, outside the seven days the status reads.
 * buddha_app keeps SELECT, INSERT and DELETE; migration 0030 revokes UPDATE (a refusal's time
 * never changes).
 */
export const phoneVerificationRefusedSends = pgTable(
  'phone_verification_refused_sends',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    /** The database clock of the send the provider refused, as its row in the sends had it. */
    attemptedAt: timestampTz().notNull(),
  },
  (t) => [
    /** The status's windows, and the purge of the rows older than eight days. */
    index('phone_verification_refused_sends_attempted_at_idx').on(t.attemptedAt),
  ],
);
