// Timing helpers for the integration suites: bounded polls instead of guessed sleeps.

import { clockTimestamp, type StatementExecutor } from '@buddha/db';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const POLL_MS = 20;
const LIMIT_MS = 5_000;

/** Polls until `received` holds `count` messages (bounded), so a lost publish fails loudly. */
export async function waitForMessages(
  received: unknown[],
  count: number,
  what: string,
): Promise<void> {
  const started = Date.now();
  while (received.length < count) {
    if (Date.now() - started > LIMIT_MS) {
      throw new Error(`${what}: ${String(received.length)} of ${String(count)} received`);
    }
    await sleep(POLL_MS);
  }
}

/** The slice of a `pg` client the lock poll needs (a PoolClient from `db.$client.connect()`). */
export interface LockPollClient {
  query(text: string): Promise<{ rows: unknown[] }>;
}

/**
 * Polls until another backend of the test database is parked on a heavyweight lock (bounded):
 * how a test that holds a row or advisory lock knows the request it dispatched has reached
 * that lock, rather than guessing with a sleep. The database is exclusive to the running
 * suite (the packages/db file lock) and every connection uses one role, so pg_stat_activity
 * shows the wait.
 *
 * Safe to call on a client that is inside a transaction (one holding a row lock): Postgres
 * freezes pg_stat_activity at its first read within a transaction and answers every later
 * read from that snapshot, so a poll that started before the request reached the lock would
 * never see it arrive. Each iteration discards the snapshot first.
 */
export async function waitForLockWaiter(client: LockPollClient, what: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    await client.query('SELECT pg_stat_clear_snapshot()');
    const { rows } = await client.query(
      `SELECT count(*)::text AS n FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'`,
    );
    if (Number((rows[0] as { n?: string } | undefined)?.n) > 0) return;
    if (Date.now() - started > LIMIT_MS) {
      const { rows: others } = await client.query(
        `SELECT state, wait_event_type, wait_event, left(query, 120) AS query
           FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()`,
      );
      throw new Error(
        `${what}: no backend is waiting on a lock; others: ${JSON.stringify(others)}`,
      );
    }
    await sleep(POLL_MS);
  }
}

const MINUTE_MS = 60_000;

/**
 * The start (epoch ms) of the database clock's current minute, read at least a second into it and
 * five seconds before its end — sleeping into the next minute otherwise (six seconds at most) — so
 * the few requests a test makes right after fall in that same minute. For the limits that hold
 * to the clock's whole minutes (#183, ADR-0070: the ones shared with other accounts).
 */
export async function currentClockMinute(db: StatementExecutor): Promise<number> {
  for (;;) {
    const clock = (await clockTimestamp(db)).getTime();
    const into = clock % MINUTE_MS;
    if (into >= 1_000 && into <= 55_000) return clock - into;
    await sleep(into < 1_000 ? 1_100 - into : MINUTE_MS + 1_100 - into);
  }
}
