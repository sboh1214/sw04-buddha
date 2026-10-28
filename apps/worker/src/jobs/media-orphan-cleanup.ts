import { schema, type Db } from '@buddha/db';
import {
  ORPHAN_MEDIA_HOURS,
  ORPHAN_MEDIA_RETRY_SLACK_MINUTES,
  orphanMediaRetryHours,
} from '@buddha/shared';
import { type ObjectStorage } from '@buddha/storage';
import { and, asc, eq, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { messageOf } from './scan.js';

/**
 * At most this many uploads queued, and this many objects tried, per run. Every run is one short
 * transaction and the objects after it; a backlog larger than this (an author who uploaded and
 * walked away, many times, or a store that refused for a while) is worked through over the next
 * runs, an hour apart.
 */
export const ORPHAN_MEDIA_BATCH = 500;

// The retry schedule of `media_deletions` (ORPHAN_MEDIA_RETRY_*, `orphanMediaRetryHours`) lives in
// @buddha/shared beside ORPHAN_MEDIA_HOURS: the API's ProfileImageService queues the replaced or
// deleted profile image's key (#141, ADR-0079) and, when the store refuses its own first try,
// counts that refusal on the same schedule. Re-exported here, where the job and its spec name it.
export {
  ORPHAN_MEDIA_RETRY_FIRST_HOURS,
  ORPHAN_MEDIA_RETRY_MAX_HOURS,
  ORPHAN_MEDIA_RETRY_SLACK_MINUTES,
  orphanMediaRetryHours,
} from '@buddha/shared';

/** One object the store would not remove this run: its key stays queued for a later run. */
export interface OrphanMediaFailure {
  storageKey: string;
  /** Refusals so far, this one included. */
  attempts: number;
  /** `messageOf(err)`: the job result is JSON. */
  message: string;
  /** The thrown value itself, for the log line. */
  err: unknown;
}

export interface OrphanMediaRun {
  /** At most this many uploads queued, and this many objects tried (ORPHAN_MEDIA_BATCH). */
  batch?: number;
  /**
   * When the run is: the database's clock, read once as the run starts (`now()`). The age of an
   * upload, which keys are due and when a refused one is due again are all counted from it. A test
   * passes its own, to run on the hour it means.
   */
  at?: Date;
}

export interface OrphanMediaOutcome {
  /** Uploads whose row this run removed, their keys queued for removal from the store. */
  queued: number;
  /** Objects this run removed from the store (their keys are no longer queued). */
  removed: number;
  /** Of the objects this run tried, those the store refused (kept queued, logged). */
  failed: number;
  failures: OrphanMediaFailure[];
  /** Keys still queued after the run — refused ones waiting for their next try, and any backlog. */
  pending: number;
}

/**
 * `media.orphan_cleanup` (#46, ADR-0073): removes the uploads no post — nor notice, #138 — took
 * within ORPHAN_MEDIA_HOURS — an image picked in the editor for a post that was never written —
 * row and object. Hourly (JOB_SCHEDULES).
 *
 * 1. The rows go first, in one transaction that locks them `SKIP LOCKED`: a post being written
 *    locks the uploads it takes (`FOR UPDATE`, the API's PostsService), so the run passes over an
 *    upload a post is taking right now, and a post that comes for one this run removed finds no
 *    upload and is refused (the editor uploads it again) — a post never shows an image whose
 *    object is gone. The same transaction queues each row's object key (`media_deletions`), so the
 *    key — which nothing else names once the row is gone — is never lost before the store has
 *    removed its object.
 * 2. Then the queued keys that are due, longest due first: the store removes the object and only
 *    then the key leaves the queue. One the store refuses stays queued, with its refusal count, its
 *    error and when to try again (`orphanMediaRetryHours` from the run's start, less
 *    ORPHAN_MEDIA_RETRY_SLACK_MINUTES), and is logged; the run goes on with the rest and does not
 *    fail. A key whose object is already gone is removed all the same (the store answers a
 *    removal of nothing as done), so a run that stopped between the store and the queue repeats
 *    harmlessly.
 *
 * An upload a post or a notice took (`attached_at`) is never this job's: a post's history keeps
 * its images, and their removal after the retention period is #184's; a notice's history keeps
 * its images as well, with no retention period (owner decision 2026-10-21, ADR-0077).
 * NoticesService locks the uploads it takes the same way. Nor is a profile image (#141): it is
 * attached from the transaction that stores it (a CHECK of `media_objects`), and the member's
 * replacement or deletion removes it at once (the API's ProfileImageService) — its key queued here
 * in that write's transaction and tried by the API right after, so a key the store refused then is
 * one more key step 2 tries again, whatever wrote it (owner decision 2026-10-22, ADR-0079).
 */
export async function removeOrphanMedia(
  db: Db,
  storage: ObjectStorage,
  { batch = ORPHAN_MEDIA_BATCH, at }: OrphanMediaRun = {},
): Promise<OrphanMediaOutcome> {
  const { mediaDeletions, mediaObjects } = schema;
  const runAt = at ?? (await databaseNow(db));
  const queued = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: mediaObjects.id, storageKey: mediaObjects.storageKey })
      .from(mediaObjects)
      .where(
        and(
          isNull(mediaObjects.attachedAt),
          lt(
            mediaObjects.createdAt,
            sql`${runAt}::timestamptz - make_interval(hours => ${ORPHAN_MEDIA_HOURS})`,
          ),
        ),
      )
      .orderBy(asc(mediaObjects.createdAt))
      .limit(batch)
      .for('update', { skipLocked: true });
    if (due.length > 0) {
      // Due from this run on (the run's time — `now()` here would be later than the run's, and
      // the select below would leave the key to the next run). A key already queued (a row that
      // named a key twice — the key is UNIQUE, so never) is left as it is.
      await tx
        .insert(mediaDeletions)
        .values(due.map(({ storageKey }) => ({ storageKey, nextAttemptAt: runAt })))
        .onConflictDoNothing({ target: mediaDeletions.storageKey });
      await tx.delete(mediaObjects).where(
        inArray(
          mediaObjects.id,
          due.map((row) => row.id),
        ),
      );
    }
    return due.length;
  });

  const tries = await db
    .select({ storageKey: mediaDeletions.storageKey, attempts: mediaDeletions.attempts })
    .from(mediaDeletions)
    .where(lte(mediaDeletions.nextAttemptAt, runAt))
    .orderBy(asc(mediaDeletions.nextAttemptAt), asc(mediaDeletions.storageKey))
    .limit(batch);
  let removed = 0;
  const failures: OrphanMediaFailure[] = [];
  for (const { storageKey, attempts } of tries) {
    try {
      await storage.delete(storageKey);
    } catch (err) {
      const refused = attempts + 1;
      const message = messageOf(err);
      await db
        .update(mediaDeletions)
        .set({
          attempts: refused,
          nextAttemptAt: sql`${runAt}::timestamptz + make_interval(hours => ${orphanMediaRetryHours(refused)}, mins => ${-ORPHAN_MEDIA_RETRY_SLACK_MINUTES})`,
          lastError: message.slice(0, 1_000),
        })
        .where(eq(mediaDeletions.storageKey, storageKey));
      failures.push({ storageKey, attempts: refused, message, err });
      continue;
    }
    await db.delete(mediaDeletions).where(eq(mediaDeletions.storageKey, storageKey));
    removed += 1;
  }
  const [left] = await db.select({ count: sql<number>`count(*)::int` }).from(mediaDeletions);
  return { queued, removed, failed: failures.length, failures, pending: left?.count ?? 0 };
}

/** The database's clock now (`now()`): what a run counts its hours from. */
async function databaseNow(db: Db): Promise<Date> {
  const { rows } = await db.execute<{ now: Date | string }>(sql`select now() as now`);
  return new Date(rows[0]!.now);
}
