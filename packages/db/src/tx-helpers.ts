import { sql, type SQL } from 'drizzle-orm';
import { TransactionBusyError } from './transaction-retry.js';

/** Anything that can run a statement inside the current transaction (a drizzle `tx` or `Db`). */
export interface StatementExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

/**
 * The two statements every writer of market state runs first, shared by apps/api (admin
 * transitions) and apps/worker (open, close, resolve, finalize) so the two cannot drift — PLAN
 * 4.1 lets both apps depend on this package and forbids them depending on each other, which is
 * why they live here rather than beside the API's transaction code. Neither throws a framework
 * error: the API wraps `clockTimestamp` to answer INTERNAL, the worker fails the job.
 */

/**
 * The advisory key of a market's lock: a 32-bit hash of its canonical id, so two markets can
 * share one (`lockMarkets` orders by it).
 */
const marketLockKey = (marketId: SQL) => sql`hashtext((${marketId})::uuid::text)`;

/**
 * Serialises every writer of one market (PLAN 0.2): open, close, judge, resolve and finalize all
 * take `pg_advisory_xact_lock(hashtext(market_id))` first, and so must whatever fills orders
 * (#119), so the statistics and the status machine are only ever changed by one transaction at a
 * time.
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
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${marketLockKey(sql`${marketId}`)})`);
}

/**
 * `lockMarket` for every market one processing touches (an account's cancels across markets,
 * #178/#143; ADR-0110 결정 4), taken in ascending order of the lock KEY — never of the id. The
 * key is a 32-bit hash, so two markets can share one, and ids in order are not keys in order:
 * with hashtext(A) = hashtext(C), "A then B" and "B then C" take the same two keys in opposite
 * orders and wait in a circle (40P01). One statement works out the distinct keys in order (a
 * key two markets share once), and each is taken in turn. Call it before any balance row, on the
 * transaction handle; a market locked again later (`lockMarket` inside a contracts.ts call) is a
 * no-op.
 */
export async function lockMarkets(
  tx: StatementExecutor,
  marketIds: readonly string[],
  options: { wait?: 'wait' | 'nowait' } = {},
): Promise<void> {
  if (marketIds.length === 0) return;
  const listed = sql.join(
    marketIds.map((id) => sql`(${id})`),
    sql`, `,
  );
  const result = await tx.execute(sql`
    SELECT k.key::text AS key
    FROM (
      SELECT DISTINCT ${marketLockKey(sql.raw('m.id'))} AS key FROM (VALUES ${listed}) AS m(id)
    ) AS k
    ORDER BY k.key`);
  const rows = (result as { rows?: { key?: unknown }[] }).rows ?? [];
  // The int4 key, as `lockMarket` takes it (widened to the bigint form the same way).
  for (const { key } of rows) {
    if (options.wait === 'nowait') {
      const result = await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(${String(key)}::int) AS locked`,
      );
      if (!(result as { rows: { locked: boolean }[] }).rows[0]?.locked)
        throw new TransactionBusyError();
    } else await tx.execute(sql`SELECT pg_advisory_xact_lock(${String(key)}::int)`);
  }
}

/**
 * Serialises the work that depends on who is an admin (#171), shared by the API and the seed:
 * a grant or revoke takes it `exclusive` (its "is the actor still an admin", "would fewer than
 * two remain" and "is there any admin yet" checks then see every earlier change), and a decision
 * on a two-person request takes it `shared` (the decider's role cannot be revoked between its
 * check and the decision's commit). Transaction-scoped and waiting, like `lockMarket`; call it
 * on the transaction handle.
 *
 * Migration 0021's `approval_requests_lock_admin_roles` trigger takes the same key shared, as SQL
 * (`hashtext('buddha:admin_roles')`), before every UPDATE of a two-person request: the key is
 * spelled in both places and must not change in one only.
 */
export async function lockAdminRoles(
  tx: StatementExecutor,
  mode: 'exclusive' | 'shared',
): Promise<void> {
  await tx.execute(
    mode === 'exclusive'
      ? sql`SELECT pg_advisory_xact_lock(hashtext('buddha:admin_roles'))`
      : sql`SELECT pg_advisory_xact_lock_shared(hashtext('buddha:admin_roles'))`,
  );
}

/** A role grant must never wait while holding an incomplete profile/market/asset lock set. */
export async function tryLockAdminRoles(tx: StatementExecutor): Promise<void> {
  const result = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtext('buddha:admin_roles')) AS locked`,
  );
  if (!(result as { rows: { locked: boolean }[] }).rows[0]?.locked)
    throw new TransactionBusyError();
}

/**
 * `clock_timestamp()` as the database sees it right now — not `now()`, which is the
 * transaction start and stands still while the transaction waits on a lock. Read it AFTER the
 * last lock a transaction queues on: the rows it then writes (ledger `created_at`,
 * `updated_at`, ticks, realtime `ts`) sort after whatever committed while it waited, so the
 * ledger's `(created_at, id)` order agrees with its totals-after chain and a client that
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
