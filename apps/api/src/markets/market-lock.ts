import { sql } from 'drizzle-orm';
import type { StatementExecutor } from '../infra/db/clock.js';

/**
 * Serialises every writer of one market (PLAN 0.2): trades, open, close and void all take
 * `pg_advisory_xact_lock(hashtext(market_id))` first, so the LMSR state, the statistics and
 * the status machine are only ever changed by one transaction at a time. Transaction-scoped:
 * released at COMMIT or ROLLBACK, never earlier, and it waits (does not fail) when another
 * transaction holds it.
 *
 * Always call this on the transaction handle (`tx`), never on the pooled `db`: a session-level
 * call on a pooled connection would lock some other connection than the one doing the work.
 *
 * The key is the id's canonical text (`::uuid::text`, lower-case however it was written), so
 * two spellings of one market can never take two locks — every request-supplied uuid is
 * lower-cased at the boundary already (api/uuid.ts), and this makes the lock itself hold the
 * rule for any caller (an M5 job, say). A string that is not a uuid fails loudly (22P02)
 * instead of locking a phantom key.
 */
export async function lockMarket(tx: StatementExecutor, marketId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext((${marketId})::uuid::text))`);
}
