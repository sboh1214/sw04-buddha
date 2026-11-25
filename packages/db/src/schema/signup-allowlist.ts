import { sql } from 'drizzle-orm';
import { check, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt } from './columns.js';

/**
 * 가입 허용 목록 (#330, ADR-0174; owner answers 330-1…330-12): the numbers that may complete the
 * 본인확인 during the closed test (133-7 "미리 넣은 번호만 본인확인 통과, 소셜 가입 포함"). The list
 * applies exactly while it holds a row (330-3): empty, every number passes as before; not empty, a
 * confirmation whose number is not on it is refused after its code matched (`not_listed`, 330-5).
 * Public launch empties it with another admin's approval (330-2), which is also when its rows go
 * (330-4) — no retention period and no release setting of its own.
 *
 * - `phone_hash` is the keyed hash of the number's digits (HMAC-SHA256 under PHONE_HASH_KEY, apps/api
 *   identity/phone-hash.ts, ADR-0071), never the number (330-8): the screen shows an entry's id and
 *   when it was added, nothing else, and the admin record names entry ids only. One row per number.
 *   A key rotation leaves the rows unable to recognise their numbers, as `start_grant_numbers`'.
 * - No memo, no adder (330-10): who added an entry and why is its `signup_allowlist_add` record in
 *   `admin_actions`. Signing up neither removes nor marks an entry (a number that verified is read
 *   from `phone_verifications` when the screen asks), so the list never empties itself (I4).
 * - buddha_app may SELECT, INSERT and DELETE, never UPDATE (migration 0083): an entry is added and
 *   removed, never changed. Every write takes the list's advisory lock first (apps/api
 *   signup-allowlist.service.ts), so two removals cannot empty it between them (I2).
 */
export const signupAllowlist = pgTable(
  'signup_allowlist',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Lower-case hex of HMAC-SHA256(PHONE_HASH_KEY, digits): 64 characters. */
    phoneHash: varchar({ length: 64 }).notNull().unique('signup_allowlist_phone_hash_unique'),
    /** When it was added (the database clock). */
    createdAt: createdAt(),
  },
  (t) => [check('signup_allowlist_phone_hash_check', sql`${t.phoneHash} ~ '^[0-9a-f]{64}$'`)],
);
