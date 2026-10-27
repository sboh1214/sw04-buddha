import { type LoggerService } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { type ObjectStorage } from '@buddha/storage';

/** `media_deletions.last_error` keeps this much of a refusal, as the worker's retries do. */
export const LAST_ERROR_MAX_LENGTH = 1_000;

/**
 * What a failure says, for the log and `last_error`: its message, led by its cause's when it has
 * one (drizzle's "Failed query: …" wraps the driver's error, which says what went wrong).
 */
export function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
  return cause === undefined ? message : `${cause} — ${message}`;
}

/**
 * One log line, its words then its fields as JSON — Nest's `Logger` takes a string (an object
 * would lose an Error's message), as the memory admission's lines do (`nestAdmissionLogger`).
 */
export function logLine(message: string, fields: Record<string, unknown>): string {
  return `${message} ${JSON.stringify(fields)}`;
}

/** What `removeUnrecordedUpload` works with: the service's own database, store and logger. */
export interface UnrecordedUploadDeps {
  /**
   * The service's database — never the transaction the row failed in: the key is queued in a
   * transaction of its own, which that one's failure (or its rollback) cannot take back.
   */
  readonly db: Db;
  readonly storage: ObjectStorage;
  readonly logger: Pick<LoggerService, 'warn' | 'error'>;
}

/**
 * Removes the object of an upload the API stored but whose row it could not write (ADR-0073
 * 9-45). Every upload writes its object before its row, so a row never names an object that is
 * not there, and every one calls this when its row fails, then fails with the row's error: a
 * post's image (`MediaService.uploadPostImage`) and, from #141, a profile image
 * (`ProfileImageService.replace`). Call it after the row's transaction has ended, never inside it.
 *
 * No row names the object, so when the store refuses the removal (a transient S3 error, say) its
 * key is queued for the worker's retries instead (`media_deletions` — due from the next hourly run
 * on, this refusal counted as the first): dropped, the key would be lost and the private upload
 * would stay in the store for good. The queueing is its own transaction and only does its best:
 * when it fails too (most likely the database that failed the row), the key is in the error log
 * with both failures, for an operator to remove. Never throws.
 */
export async function removeUnrecordedUpload(
  { db, storage, logger }: UnrecordedUploadDeps,
  storageKey: string,
): Promise<void> {
  let refusal: string;
  try {
    await storage.delete(storageKey);
    return;
  } catch (refused) {
    refusal = reasonOf(refused);
  }
  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.mediaDeletions).values({
        storageKey,
        attempts: 1,
        lastError: refusal.slice(0, LAST_ERROR_MAX_LENGTH),
      });
    });
  } catch (failed) {
    logger.error(
      logLine('could not remove an unrecorded upload, nor queue its key', {
        storageKey,
        refusal,
        queueing: reasonOf(failed),
      }),
    );
    return;
  }
  logger.warn(
    logLine('could not remove an unrecorded upload; queued its key', { storageKey, refusal }),
  );
}
