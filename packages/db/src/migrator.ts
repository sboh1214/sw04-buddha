import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, createDb } from './client.js';

/** packages/db/drizzle: SQL files + meta/_journal.json committed by `pnpm db:generate`. */
export const migrationsFolder = fileURLToPath(new URL('../drizzle/', import.meta.url));

/**
 * Applies pending migrations from packages/db/drizzle using the migration role.
 * Bookkeeping lives in drizzle.__drizzle_migrations (same table drizzle-kit migrate uses),
 * so the CLI and this function are interchangeable.
 *
 * Also used by integration tests to prepare the `test` profile database (PLAN 14).
 */
export async function runMigrations(migrateUrl: string): Promise<void> {
  const db = createDb(migrateUrl, { max: 1, applicationName: 'buddha-migrate' });
  try {
    await migrate(db, {
      migrationsFolder,
      migrationsTable: '__drizzle_migrations',
      migrationsSchema: 'drizzle',
    });
  } finally {
    await closeDb(db);
  }
}
