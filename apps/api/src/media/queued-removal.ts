import { type LoggerService } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { ORPHAN_MEDIA_RETRY_SLACK_MINUTES, orphanMediaRetryHours } from '@buddha/shared';
import { type ObjectStorage } from '@buddha/storage';
import { eq, sql } from 'drizzle-orm';
import { LAST_ERROR_MAX_LENGTH, logLine, reasonOf } from './unrecorded-upload.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/*
 * The removal of an object whose row a write has just deleted, through #46's queue of keys the
 * worker removes (`media_deletions`, ADR-0073): the write's transaction queues the key with the
 * row's deletion (`queueRemoval`), so once it commits the key is kept until the store has let the
 * object go — a commit whose after-commit removal never runs (the API stopped) or that the store
 * refuses still leaves it to the worker's `media.orphan_cleanup` — and right after the commit the
 * API tries the removal itself (`removeQueuedObject`), the fast path. Two writes take it: a
 * profile image the member replaced or deleted (#141, `ProfileImageService`, owner decision
 * 2026-10-22, ADR-0079 7-5) and the profile image of an account its member closed (#140,
 * `AccountClosureService`, ADR-0086 7-14).
 */

/**
 * When a queued key is due for the worker after the API's own try: the queue's first wait from
 * now, less its slack — as a refusal on a run of the worker is due again (apps/worker
 * media-orphan-cleanup.ts) — so a run of the worker meanwhile does not race the API's try.
 */
export function firstRetryAt() {
  return sql`now() + make_interval(hours => ${orphanMediaRetryHours(1)}, mins => ${-ORPHAN_MEDIA_RETRY_SLACK_MINUTES})`;
}

/**
 * Queues `storageKey` for removal in the transaction that deleted the row naming it: the write
 * commits with the key queued or not at all. Due for the worker only after `firstRetryAt`. A key is
 * one object's, and a new upload a new key: never queued already (DO NOTHING all the same).
 */
export async function queueRemoval(tx: Tx, storageKey: string): Promise<void> {
  await tx
    .insert(schema.mediaDeletions)
    .values({ storageKey, nextAttemptAt: firstRetryAt() })
    .onConflictDoNothing({ target: schema.mediaDeletions.storageKey });
}

/** What `removeQueuedObject` works with: the service's own database, store and logger. */
export interface QueuedRemovalDeps {
  /** The service's database, after the commit that queued the key — never that transaction. */
  readonly db: Db;
  readonly storage: ObjectStorage;
  readonly logger: Pick<LoggerService, 'error'>;
}

/**
 * Removes the object of a key `queueRemoval` queued, after that write's commit, never inside it: a
 * slow store then holds no row lock and no pooled connection (Postgres ends a session idle in a
 * transaction after 30 seconds), and a commit lost after the object went can never leave a row
 * naming an object without bytes. The key leaves the queue once the object is gone. A store that
 * will not remove it now leaves the key queued, this refusal counted as its first (`attempts` 1,
 * its error kept, due again after the queue's first wait counted from now), and logged — `what`
 * names the object in the line ('a replaced or deleted profile image'); the worker tries it again
 * then, and on every later refusal twice as late, at most daily, until the store lets it go. Each
 * line logs its words and fields as one string, the reasons as plain text (`logLine`·`reasonOf`, as
 * `removeUnrecordedUpload` does): Nest's `Logger` loses an Error's message given as an object.
 * Never throws: the write it follows stands either way.
 */
export async function removeQueuedObject(
  { db, storage, logger }: QueuedRemovalDeps,
  storageKey: string,
  what: string,
): Promise<void> {
  try {
    await storage.delete(storageKey);
  } catch (error) {
    const refusal = reasonOf(error);
    logger.error(
      logLine(`could not remove ${what}; its key stays queued for the worker`, {
        storageKey,
        refusal,
      }),
    );
    await db
      .update(schema.mediaDeletions)
      .set({
        attempts: 1,
        lastError: refusal.slice(0, LAST_ERROR_MAX_LENGTH),
        nextAttemptAt: firstRetryAt(),
      })
      .where(eq(schema.mediaDeletions.storageKey, storageKey))
      .catch((queue: unknown) => {
        // The key is queued either way (the write's transaction); only the count is lost.
        logger.error(
          logLine('could not count a refused removal', {
            storageKey,
            refusal,
            counting: reasonOf(queue),
          }),
        );
      });
    return;
  }
  await db
    .delete(schema.mediaDeletions)
    .where(eq(schema.mediaDeletions.storageKey, storageKey))
    .catch((queue: unknown) => {
      // Left queued, the worker removes it again: the store answers a removal of nothing as done.
      logger.error(
        logLine(`could not unqueue ${what} once removed`, {
          storageKey,
          unqueueing: reasonOf(queue),
        }),
      );
    });
}
