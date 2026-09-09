/** One market the scan gave up on: the per-market function rejected, and the loop moved on. */
export interface ScanFailure {
  marketId: string;
  /** `err.message` for a thrown Error, `String(err)` otherwise — the job result is JSON. */
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs the per-market function over a scan's candidates one at a time, each failure caught
 * and recorded instead of thrown. The isolation the scans promise ("one market's failure never
 * holds the others") is only true with the catch: the candidate list is ordered by deadline,
 * so a market whose transaction rejects on every attempt (a winning holder with no balance
 * row, a resolving row with no result) is the FIRST candidate of every later run, and an
 * uncaught rejection there means no market due after it is ever reached by the safety net —
 * the exact case the scan exists for. Sequential on purpose: the scans are the bounded
 * single-job fallback of PLAN 5.5, and one market lock at a time keeps a stuck run's blast
 * radius at one transaction.
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
