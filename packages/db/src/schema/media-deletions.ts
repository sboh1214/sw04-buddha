import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, varchar } from 'drizzle-orm/pg-core';
import { timestampTz } from './columns.js';

/**
 * 지울 저장소 객체 (#46, ADR-0073 decision 6): the key of every object the store still holds after
 * its `media_objects` row went, until the store has removed it. The worker's orphan clean-up
 * (`media.orphan_cleanup`) moves an upload no post took here and deletes its row in one
 * transaction, then removes the object and only then this row — so the key, which nothing else
 * names once the upload's row is gone, is never lost before the store has let the object go. A
 * removal the store refuses leaves the row, retried on later runs (`next_attempt_at`, backing off
 * up to a day, counted from the start of the run it was refused on) with its last error kept for
 * the log; a run never gives a key up.
 *
 * - `storage_key`: the object's key (`post-images/<id>.<ext>`, OBJECT_KEY_PATTERN in
 *   @buddha/storage), one row per key.
 * - `queued_at`: when the row was queued (the upload's row went then).
 * - `attempts`: removals the store refused so far (0 until one fails).
 * - `next_attempt_at`: when a run may try again — at first the time of the run that queued it (a
 *   moment before `queued_at`), after a refusal that run's time and the backoff, less a few minutes
 *   (ORPHAN_MEDIA_RETRY_SLACK_MINUTES in the worker).
 * - `last_error`: the store's last refusal, for the log and an operator; NULL until one.
 *
 * Nothing but the worker reads it; no row names an account (the key is the upload's random id).
 */
export const mediaDeletions = pgTable(
  'media_deletions',
  {
    storageKey: varchar({ length: 160 }).primaryKey(),
    queuedAt: timestampTz().defaultNow().notNull(),
    attempts: integer().default(0).notNull(),
    nextAttemptAt: timestampTz().defaultNow().notNull(),
    lastError: text(),
  },
  (t) => [
    check('media_deletions_attempts_check', sql`${t.attempts} >= 0`),
    /** The worker's scan: the removals due, longest due first. */
    index('media_deletions_next_attempt_at_idx').on(t.nextAttemptAt),
  ],
);
