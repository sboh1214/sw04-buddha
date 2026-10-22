import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, varchar } from 'drizzle-orm/pg-core';
import { timestampTz } from './columns.js';

/**
 * 지울 저장소 객체 (#46, ADR-0073 decision 6): the key of every object the store still holds with
 * no `media_objects` row naming it, until the store has removed it. The worker's orphan clean-up
 * (`media.orphan_cleanup`) moves an upload no post took here and deletes its row in one
 * transaction, then removes the object and only then this row — so the key, which nothing else
 * names once the upload's row is gone, is never lost before the store has let the object go. The
 * API queues one too: an upload whose object it stored but whose row it could not write, when
 * the store refused to remove that object right away (`removeUnrecordedUpload` in apps/api, which
 * every upload that stores its object before its row calls, ADR-0073 9-45). A removal the store
 * refuses leaves the row, retried on later runs (`next_attempt_at`, backing off up to a day,
 * counted from the start of the run it was refused on) with its last error kept for the log; a
 * run never gives a key up. A member's replaced or deleted profile image (#141, ADR-0079) comes
 * here the same way: the API's ProfileImageService queues its key in the write that removes its
 * row, tries the store at once after the commit — taking the key out once the object is gone, or
 * counting the refusal as the first — and leaves the rest to the same runs (owner decision
 * 2026-10-22).
 *
 * - `storage_key`: the object's key (`post-images/<id>.<ext>`, or `profile-images/<id>.<ext>`;
 *   OBJECT_KEY_PATTERN in @buddha/storage), one row per key.
 * - `queued_at`: when the row was queued (the upload's row went then, or the API's removal of
 *   its object was refused just before).
 * - `attempts`: removals the store refused so far (0 until one fails; 1 from the API, whose own
 *   removal was refused).
 * - `next_attempt_at`: when a run may try again — at first the time of the run that queued it (a
 *   moment before `queued_at`; an unrecorded upload's from the API: `queued_at`, so the next run),
 *   after a refusal that run's time and the backoff, less a few minutes
 *   (ORPHAN_MEDIA_RETRY_SLACK_MINUTES in @buddha/shared). A profile image's key is due after the
 *   first wait from its queueing, and from the API's refusal when its own try was refused.
 * - `last_error`: the store's last refusal, for the log and an operator; NULL until one.
 *
 * Only the worker reads it, and the API writes only the keys of the uploads it could not record
 * and of the profile images it replaced or deleted; no row names an account (the key is the
 * upload's random id).
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
