/** One market the scan gave up on: the per-market function rejected, and the loop moved on. */
export interface ScanFailure {
  marketId: string;
  /** `messageOf(err)` — a string, as the job result is JSON. */
  message: string;
  /** The thrown value itself, for the log line (a stack, a Postgres error code). */
  err: unknown;
}

export interface ScanOutcome<Result> {
  /** In candidate order, the failures left out. */
  results: Result[];
  failed: number;
  failures: ScanFailure[];
}

/** node-postgres's DatabaseError, as far as `messageOf` reads it: `code` is the SQLSTATE. */
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
 * What a failure says — the scan's result, the step's `last_error`, the log: `err.message` for
 * a thrown Error, `String(err)` otherwise, led by the driver's SQLSTATE and message when
 * Postgres refused a statement. drizzle-orm 0.45 throws every failed query as DrizzleQueryError,
 * whose message is `Failed query: <sql>\nparams: <params>`, and keeps the driver error in
 * `cause` (apps/api pg-error.ts unwraps it for the same reason): without the lead a database
 * failure reads as the SQL it ran, and the SETTLEMENT_STEP_ERROR_MAX cut of `last_error` can
 * drop the reason altogether. So `40P01 deadlock detected — Failed query: update "positions" …`;
 * a plain Error reads exactly as its message. The cause chain is followed a bounded few links.
 */
export function messageOf(err: unknown): string {
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

/**
 * Runs the per-market function over a scan's candidates one at a time, each failure caught
 * and recorded instead of thrown. The isolation the scans promise ("one market's failure never
 * holds the others") is only true with the catch: the candidate list is ordered by deadline
 * (or judgement time), so a market whose transaction rejects on every attempt (a winning holder
 * with no balance row, a resolved row with no result) is the FIRST candidate of every later
 * run, and an uncaught rejection there means no market due after it is ever reached by the
 * safety net — the exact case the scan exists for. Sequential on purpose: the scans are the
 * bounded single-job fallback of PLAN 5.5, and one market lock at a time keeps a stuck run's
 * blast radius at one transaction.
 *
 * Never throws for a per-market rejection; the caller (jobs/index.ts) logs each failure and
 * returns the count with the job result, so a poisoned market is visible in the log every
 * minute without taking the scan down with it.
 */
export async function runScan<Result>(
  due: readonly string[],
  run: (marketId: string) => Promise<Result>,
): Promise<ScanOutcome<Result>> {
  const results: Result[] = [];
  const failures: ScanFailure[] = [];
  for (const marketId of due) {
    try {
      results.push(await run(marketId));
    } catch (err) {
      failures.push({ marketId, message: messageOf(err), err });
    }
  }
  return { results, failed: failures.length, failures };
}
