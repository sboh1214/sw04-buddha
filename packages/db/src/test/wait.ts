/**
 * Lock-wait poll for the packages' concurrency tests — a copy of apps/api's (`test/wait.ts`), which
 * the apps cannot share with this package (PLAN 4.1: db depends on no app).
 */

const POLL_MS = 20;
const LIMIT_MS = 5_000;

/** The slice of a `pg` client the lock poll needs (a PoolClient from `db.$client.connect()`). */
export interface LockPollClient {
  query(text: string): Promise<{ rows: unknown[] }>;
}

/**
 * Polls until `count` other backends of the test database are parked on a heavyweight lock
 * (bounded): how a test that holds a row lock knows the transactions it started have reached
 * their locks, rather than guessing with a sleep. The database is exclusive to the running file
 * (the harness's file lock), so pg_stat_activity shows the wait. Safe inside a transaction: each
 * iteration discards the statistics snapshot first.
 */
export async function waitForLockWaiter(
  client: LockPollClient,
  what: string,
  count = 1,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    await client.query('SELECT pg_stat_clear_snapshot()');
    const { rows } = await client.query(
      `SELECT count(*)::text AS n FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'`,
    );
    if (Number((rows[0] as { n?: string } | undefined)?.n) >= count) return;
    if (Date.now() - started > LIMIT_MS) {
      throw new Error(`${what}: fewer than ${String(count)} backends wait on a lock`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
}
