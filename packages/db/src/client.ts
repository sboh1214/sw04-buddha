import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.js';

/** Drizzle database handle bound to the buddha schema and a node-postgres Pool. */
export type Db = NodePgDatabase<typeof schema> & { $client: Pool };

export interface CreateDbOptions {
  /** Maximum pooled connections. Default 10; use 1 for one-off scripts. */
  max?: number;
  /** Shown as application_name in pg_stat_activity. */
  applicationName?: string;
  /**
   * Server-side guard for transactions that hold pg_advisory_xact_lock (PLAN 0.2):
   * a session idle inside a transaction longer than this is killed by Postgres.
   * Milliseconds; default 30_000.
   */
  idleInTransactionTimeoutMs?: number;
  /** Receives errors emitted by idle pooled clients (default: console.error). */
  onPoolError?: (error: Error) => void;
}

/**
 * Creates a Drizzle instance on top of a node-postgres Pool.
 *
 * - apps use DATABASE_URL (role buddha_app)
 * - migrations use DATABASE_MIGRATE_URL (role buddha_migrate), see migrator.ts
 *
 * `casing: "snake_case"` must match drizzle.config.ts.
 */
export function createDb(url: string, options: CreateDbOptions = {}): Db {
  const pool = new Pool({
    connectionString: url,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'buddha',
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 30_000,
  });
  // Without a listener an error on an idle client crashes the process.
  pool.on('error', options.onPoolError ?? ((error) => console.error('[db] pool error', error)));
  return drizzle({ client: pool, schema, casing: 'snake_case' });
}

/** Drains the pool. Call on application shutdown and at the end of scripts. */
export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}
