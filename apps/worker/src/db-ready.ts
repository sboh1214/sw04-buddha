import { type Logger } from 'pino';

/**
 * Upper bound on the sleep between probes (ms). It is deliberately the same figure as
 * `createDb`'s `connectionTimeoutMillis` (5s, packages/db/client.ts), so a sleep never outlasts
 * the failure it is waiting on. Linear growth rather than BullMQ's `Math.exp` backoff
 * (queues.ts): this POLLS a dependency, it does not reconnect a socket, and the shape matches
 * `createPublisherRedis`'s `Math.min(times * 200, 2_000)`.
 */
export const DB_READY_MAX_DELAY_MS = 5_000;

export function dbReadyDelayMs(attempt: number): number {
  return Math.min(attempt * 500, DB_READY_MAX_DELAY_MS);
}

/**
 * Blocks until `probe` answers once — the worker's proof that Postgres is actually reachable,
 * which nothing in its boot path had before (`createDb` only CONSTRUCTS a pool; node-postgres
 * connects on first checkout, so `waitUntilReady` and `upsertJobScheduler` proved Redis and
 * nothing else).
 *
 * NEVER REJECTS, and has no attempt ceiling. That is the whole contract, and it is the policy
 * this worker already applies to its other hard dependency: with Redis down, BullMQ's
 * `retryStrategy` (queues.ts) always answers a number, so `waitUntilReady()` parks rather than
 * throwing and `/health` keeps saying 503 `starting` until Redis returns. A one-shot query that
 * rejected would instead unwind to `main()`'s `catch` and `process.exit(1)`, taking the health
 * port down with it — the refused connection main.ts binds the listener early to PREVENT — and
 * nothing in this repo would restart it (no worker service in the compose file, a bare `&` in
 * CI, `tsx watch` does not re-exec on exit). Whoever is waiting owns the bound instead: CI polls
 * 60 × 2s per url, Playwright's `webServer` gives 240s.
 *
 * No `Promise.race` bound around the probe, for the reason the API's own client records: a raced
 * probe settles the caller without cancelling the connect, so each timeout holds a pool slot —
 * on a `max: 4` pool that is self-inflicted exhaustion. One probe is ever in flight, and
 * `createDb` already bounds an attempt (`connectionTimeoutMillis` 5s, `query_timeout` 30s).
 *
 * `delayMs` and `sleep` are injected for the tests only, the way `createPublisherRedis` takes
 * its bounds (realtime.ts): apps/worker has no test for `main.ts` (queues.ts says so where
 * `BULLMQ_REDIS_OPTIONS` was hoisted for the same reason), so the decision lives here where a
 * node test with no database can execute it.
 */
export async function waitForDb(
  probe: () => Promise<unknown>,
  options: {
    logger: Logger;
    delayMs?: (attempt: number) => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ attempts: number }> {
  const delayMs = options.delayMs ?? dbReadyDelayMs;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await probe();
      return { attempts: attempt };
    } catch (err) {
      const waitMs = delayMs(attempt);
      options.logger.warn({ err, attempt, waitMs }, 'database not ready, retrying');
      await sleep(waitMs);
    }
  }
}
