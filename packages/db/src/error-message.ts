/** node-postgres's DatabaseError, as far as `errorMessageOf` reads it: `code` is the SQLSTATE. */
interface DriverError {
  code: string;
  message: string;
}

function isDriverError(value: unknown): value is DriverError {
  if (typeof value !== 'object' || value === null) return false;
  const { code, message } = value as { code?: unknown; message?: unknown };
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && typeof message === 'string';
}

/**
 * What a failure says — a worker scan's result, the step's `last_error`, the log, the operator
 * retry's failure record (#145, ADR-0163): `err.message` for a thrown Error, `String(err)`
 * otherwise, led by the driver's SQLSTATE and message when Postgres refused a statement.
 * drizzle-orm 0.45 throws every failed query as DrizzleQueryError, whose message is `Failed query:
 * <sql>\nparams: <params>`, and keeps the driver error in `cause` (apps/api pg-error.ts unwraps it
 * for the same reason): without the lead a database failure reads as the SQL it ran, and the
 * SETTLEMENT_STEP_ERROR_MAX cut of `last_error` can drop the reason altogether. So `40P01 deadlock
 * detected — Failed query: update "positions" …`; a plain Error reads exactly as its message. The
 * cause chain is followed a bounded few links. Moved from the worker's scan.ts unchanged (the
 * worker re-exports it as `messageOf`), so a message written by either app reads the same.
 */
export function errorMessageOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  let link = err;
  for (let depth = 0; depth < 4 && typeof link === 'object' && link !== null; depth += 1) {
    if (isDriverError(link)) {
      // A driver error thrown as itself (no wrapper) carries the message already.
      return link === err ? `${link.code} ${message}` : `${link.code} ${link.message} — ${message}`;
    }
    link = 'cause' in link ? link.cause : undefined;
  }
  return message;
}

/** The SQLSTATE of the first driver error on `err`'s cause chain (the same walk), if any. */
export function sqlStateOf(err: unknown): string | undefined {
  let link = err;
  for (let depth = 0; depth < 4 && typeof link === 'object' && link !== null; depth += 1) {
    if (isDriverError(link)) return link.code;
    link = 'cause' in link ? link.cause : undefined;
  }
  return undefined;
}
