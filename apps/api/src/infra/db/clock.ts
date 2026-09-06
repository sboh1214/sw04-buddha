import { sql } from 'drizzle-orm';
import { AppError } from '../../common/errors/app-error.js';

/** Anything that can run a statement inside the current transaction (a drizzle `tx`). */
export interface StatementExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

/**
 * `clock_timestamp()` as the database sees it right now — not `now()`, which is the
 * transaction start and stands still while the transaction waits on a lock. Read it AFTER
 * the last lock a transaction queues on: the rows it then writes (ledger `created_at`,
 * `updated_at`, ticks, realtime `ts`) sort after whatever committed while it waited, so the
 * ledger's `(created_at, id)` order agrees with its `balance_after_p` chain and a client that
 * keeps the newest event by `ts` keeps the newest balance.
 *
 * Returned at the millisecond precision every timestamptz column is declared with — as epoch
 * millis, so no driver-side date parser is involved.
 */
export async function clockTimestamp(tx: StatementExecutor): Promise<Date> {
  const result = await tx.execute(
    sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS ms`,
  );
  const rows = (result as { rows?: { ms?: unknown }[] }).rows;
  const ms = Number(rows?.[0]?.ms);
  if (!Number.isSafeInteger(ms)) {
    throw new AppError('INTERNAL', { message: 'clock_timestamp() returned no value' });
  }
  return new Date(ms);
}
