import { schema, type Db } from '@buddha/db';
import { ORPHAN_MEDIA_HOURS } from '@buddha/shared';
import { type ObjectStorage } from '@buddha/storage';
import { and, asc, inArray, isNull, lt, sql } from 'drizzle-orm';
import { messageOf } from './scan.js';

/**
 * At most this many uploads per run. Every run is one short transaction and the objects after it;
 * a backlog larger than this (an author who uploaded and walked away, many times) is removed over
 * the next runs, an hour apart.
 */
export const ORPHAN_MEDIA_BATCH = 500;

/** One object the run could not remove from the store: its row is gone already. */
export interface OrphanMediaFailure {
  storageKey: string;
  /** `messageOf(err)`: the job result is JSON. */
  message: string;
  /** The thrown value itself, for the log line. */
  err: unknown;
}

export interface OrphanMediaOutcome {
  /** Uploads whose row this run removed. */
  removed: number;
  /** Of those, the objects the store would not remove (logged; nothing names them any more). */
  failed: number;
  failures: OrphanMediaFailure[];
}

/**
 * `media.orphan_cleanup` (#46, ADR-0073): removes the uploads no post took within
 * ORPHAN_MEDIA_HOURS — an image picked in the editor for a post that was never written — row and
 * object. Hourly (JOB_SCHEDULES).
 *
 * The rows go first, in one transaction that locks them `SKIP LOCKED`: a post being written locks
 * the uploads it takes (`FOR UPDATE`, the API's PostsService), so the run passes over an upload a
 * post is taking right now, and a post that comes for one this run removed finds no upload and is
 * refused (the editor uploads it again) — a post never shows an image whose object is gone. The
 * objects go after the commit; one the store will not remove is logged and left, named by nothing
 * (a stray file, never a broken image).
 *
 * An upload a post took (`attached_at`) is never this job's: a post's history keeps its images,
 * and their removal after the retention period is #184's.
 */
export async function removeOrphanMedia(
  db: Db,
  storage: ObjectStorage,
  batch: number = ORPHAN_MEDIA_BATCH,
): Promise<OrphanMediaOutcome> {
  const { mediaObjects } = schema;
  const removed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: mediaObjects.id, storageKey: mediaObjects.storageKey })
      .from(mediaObjects)
      .where(
        and(
          isNull(mediaObjects.attachedAt),
          lt(mediaObjects.createdAt, sql`now() - make_interval(hours => ${ORPHAN_MEDIA_HOURS})`),
        ),
      )
      .orderBy(asc(mediaObjects.createdAt))
      .limit(batch)
      .for('update', { skipLocked: true });
    if (due.length > 0) {
      await tx.delete(mediaObjects).where(
        inArray(
          mediaObjects.id,
          due.map((row) => row.id),
        ),
      );
    }
    return due;
  });
  const failures: OrphanMediaFailure[] = [];
  for (const { storageKey } of removed) {
    try {
      await storage.delete(storageKey);
    } catch (err) {
      failures.push({ storageKey, message: messageOf(err), err });
    }
  }
  return { removed: removed.length, failed: failures.length, failures };
}
