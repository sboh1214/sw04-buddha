import { sql } from 'drizzle-orm';

/** Anything that can run a statement inside the current transaction (a drizzle `tx` or `Db`). */
export interface StatementExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

/**
 * The two statements every writer of market state runs first, shared by apps/api (trades,
 * admin transitions) and apps/worker (close, finalize) so the two cannot drift — PLAN 4.1 lets
 * both apps depend on this package and forbids them depending on each other, which is why they
 * live here rather than beside the API's transaction code. Neither throws a framework error:
 * the API wraps `clockTimestamp` to answer INTERNAL, the worker fails the job.
 */

/**
 * Serialises every writer of one market (PLAN 0.2): trades, open, close, resolve, void and
 * finalize all take `pg_advisory_xact_lock(hashtext(market_id))` first, so the LMSR state, the
 * statistics and the status machine are only ever changed by one transaction at a time.
 * Transaction-scoped: released at COMMIT or ROLLBACK, never earlier, and it waits (does not
 * fail) when another transaction holds it.
 *
 * Always call this on the transaction handle (`tx`), never on the pooled `db`: a session-level
 * call on a pooled connection would lock some other connection than the one doing the work.
 *
 * The key is the id's canonical text (`::uuid::text`, lower-case however it was written), so
 * two spellings of one market can never take two locks — every request-supplied uuid is
 * lower-cased at the boundary already (@buddha/shared api/uuid.ts), and this makes the lock
 * itself hold the rule for any caller (a job, a script). A string that is not a uuid fails
 * loudly (22P02) instead of locking a phantom key.
 */
export async function lockMarket(tx: StatementExecutor, marketId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext((${marketId})::uuid::text))`);
}

/**
 * `clock_timestamp()` as the database sees it right now — not `now()`, which is the
 * transaction start and stands still while the transaction waits on a lock. Read it AFTER the
 * last lock a transaction queues on: the rows it then writes (ledger `created_at`,
 * `updated_at`, ticks, realtime `ts`) sort after whatever committed while it waited, so the
 * ledger's `(created_at, id)` order agrees with its `balance_after_p` chain and a client that
 * keeps the newest event by `ts` keeps the newest balance (ADR-0027, A-M3-21).
 *
 * Returned at the millisecond precision every timestamptz column is declared with — as epoch
 * millis, so no driver-side date parser is involved (drizzle's node-postgres session replaces
 * the driver's timestamptz parser, so a raw `execute` would hand back the wire text).
 */
export async function clockTimestamp(tx: StatementExecutor): Promise<Date> {
  const result = await tx.execute(
    sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS ms`,
  );
  const rows = (result as { rows?: { ms?: unknown }[] }).rows;
  const ms = Number(rows?.[0]?.ms);
  if (!Number.isSafeInteger(ms)) {
    throw new Error('clock_timestamp() returned no value');
  }
  return new Date(ms);
}
