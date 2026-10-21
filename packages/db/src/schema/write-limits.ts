import { WRITE_LIMIT_ACTIONS } from '@buddha/shared';
import { sql } from 'drizzle-orm';
import { bigserial, check, index, pgTable, varchar } from 'drizzle-orm/pg-core';
import { timestampTz } from './columns.js';

/**
 * 작성 빈도 제한 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 7): one row per write the
 * owner's fixed limits count (WRITE_LIMITS in @buddha/shared) — a new post, a new comment, an edit
 * that changed something, a stored image (a post's or a profile's) — written in the transaction of
 * the write itself (the API's WriteLimitsService), so a write that does not commit is not counted
 * and one that does always is. The limits count these rows, not the posts or the uploads: a post or
 * a comment its author deleted still counts (#45-15), and so does an upload the worker removed
 * unused or a profile image replaced since — their own rows are gone, this one is not.
 *
 * - `phone_hash`: who wrote, as the person (decision 7: per verified number, not per account) —
 *   the keyed hash of the number (ADR-0071, the API's PhoneHasher), the CHECK keeping it the 64
 *   lower-case hex it is. No account column: nothing reads a row by account, and a row carries
 *   nothing about the write but its kind and time, so the table says no more about anybody than
 *   that a number wrote something then.
 * - `action`: WRITE_LIMIT_ACTIONS, held to that list by the CHECK as well.
 * - `created_at`: the database clock the API read after it took the number's lock, so the rows of
 *   one number are in the order their writes committed and a window's count is exact.
 *
 * Kept a day: the longest window is 24 hours, and the worker deletes rows an hour past it
 * (`community.records_purge` — the hour keeps what a count running meanwhile includes). buddha_app
 * inserts, reads and deletes, never rewrites one (migration 0038: no UPDATE).
 */
export const writeLimitEvents = pgTable(
  'write_limit_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    phoneHash: varchar({ length: 64 }).notNull(),
    action: varchar({ length: 8, enum: WRITE_LIMIT_ACTIONS }).notNull(),
    createdAt: timestampTz().defaultNow().notNull(),
  },
  (t) => [
    /** A number's writes of one kind in a window, newest first: the count and the retry time. */
    index('write_limit_events_phone_hash_action_created_at_idx').on(
      t.phoneHash,
      t.action,
      t.createdAt,
    ),
    check('write_limit_events_phone_hash_check', sql`${t.phoneHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'write_limit_events_action_check',
      sql`${t.action} IN ('post', 'comment', 'edit', 'upload')`,
    ),
  ],
);
