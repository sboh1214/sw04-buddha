import { clockTimestamp as dbClockTimestamp, type StatementExecutor } from '@buddha/db';
import { AppError } from '../../common/errors/app-error.js';

export type { StatementExecutor };

/**
 * `clock_timestamp()` as the database sees it right now — not `now()`, which is the
 * transaction start and stands still while the transaction waits on a lock. Read it AFTER the
 * last lock a transaction queues on: the rows it then writes (ledger `created_at`,
 * `updated_at`, ticks, realtime `ts`) sort after whatever committed while it waited, so the
 * ledger's `(created_at, id)` order agrees with its `balance_after_coin` chain and a client that
 * keeps the newest event by `ts` keeps the newest balance.
 *
 * The statement itself lives in @buddha/db (tx-helpers.ts) since M5, because the worker's
 * close and finalize transactions follow the same rule and PLAN 4.1 forbids it importing this
 * app; this wrapper only turns the plain failure into the API's INTERNAL envelope.
 */
export async function clockTimestamp(tx: StatementExecutor): Promise<Date> {
  try {
    return await dbClockTimestamp(tx);
  } catch (error) {
    throw new AppError('INTERNAL', {
      message: 'clock_timestamp() returned no value',
      cause: error,
    });
  }
}

/**
 * `clock`, or 1 ms after `previous` when the clock has not passed it: an instant strictly after
 * the write it follows, whichever way the database clock moved since. The clock has millisecond
 * precision, so a write right behind another can read that instant again, or an earlier one
 * should the clock step back. Role changes (each after the last one) and approval decisions
 * (each after its request) keep their order this way, as the seed's second grant does.
 */
export function strictlyAfter(clock: Date, previous: Date | null | undefined): Date {
  if (previous == null) return clock;
  return new Date(Math.max(clock.getTime(), previous.getTime() + 1));
}
