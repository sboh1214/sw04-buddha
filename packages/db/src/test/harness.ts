/**
 * Integration-test harness for the docker `test` profile database (PLAN 14).
 *
 * Roles mirror production: migrations run as buddha_migrate (TEST_DATABASE_MIGRATE_URL), the
 * code under test runs as buddha_app (TEST_DATABASE_URL). TRUNCATE is an owner privilege, so
 * `reset()` also goes through the migrate role.
 *
 * Every package that runs integration tests shares one database, and Turbo runs package test
 * tasks in parallel. Two locks keep them from interfering:
 *  - `migrateTestDb()` (vitest globalSetup) serialises migration runs with pg_advisory_lock.
 *  - `connectTestDb()` holds a session-level advisory lock for the lifetime of the test file,
 *    so files (from any package or worker) run one at a time against the shared database.
 *
 * TEST_* variables never fall back to DATABASE_URL: a test run must not touch the dev DB.
 */
import { Client } from 'pg';
import { closeDb, createDb, type Db } from '../client.js';
import { loadRootEnv } from '../env.js';
import { runMigrations } from '../migrator.js';
import { WIPE_PUBLIC_TABLES_SQL } from '../wipe.js';

const MIGRATE_LOCK_KEY = 'buddha:test-db:migrate';
const FILE_LOCK_KEY = 'buddha:test-db:file';

export interface TestDbUrls {
  appUrl: string;
  migrateUrl: string;
}

/** null when the test profile is not configured (tests then skip themselves). */
export function testDbUrls(): TestDbUrls | null {
  loadRootEnv();
  const appUrl = process.env.TEST_DATABASE_URL;
  const migrateUrl = process.env.TEST_DATABASE_MIGRATE_URL;
  return appUrl && migrateUrl ? { appUrl, migrateUrl } : null;
}

export const hasTestDb = (): boolean => testDbUrls() !== null;

/**
 * vitest `globalSetup`: applies pending migrations to the test database once per run.
 * Safe to call concurrently from several packages (advisory lock). Under CI=true a missing
 * configuration is an error rather than a silent skip.
 */
export async function migrateTestDb(): Promise<void> {
  const urls = testDbUrls();
  if (!urls) {
    if (process.env.CI) throw new Error('[test-db] TEST_DATABASE_URL is required in CI');
    console.warn('[test-db] TEST_DATABASE_URL not set; integration tests will be skipped');
    return;
  }
  const lock = new Client({
    connectionString: urls.migrateUrl,
    application_name: 'buddha-test-lock',
  });
  try {
    await lock.connect();
  } catch (error) {
    throw new Error(
      '[test-db] cannot reach the test database (' +
        String(error) +
        '). Start it with "docker compose --profile test up -d postgres-test redis-test" ' +
        'or unset TEST_DATABASE_URL to skip the integration tests.',
      { cause: error },
    );
  }
  try {
    await lock.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATE_LOCK_KEY]);
    await runMigrations(urls.migrateUrl);
    await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATE_LOCK_KEY]);
  } finally {
    await lock.end();
  }
}

export interface TestDb {
  /** Application-role handle (buddha_app): pass this to the code under test and factories. */
  db: Db;
  /**
   * Truncates every table in schema `public` (RESTART IDENTITY) with the statement migrations
   * 0017 and 0048 and deploy/reset-db.sh run (wipe.ts). Call in beforeEach.
   */
  reset(): Promise<void>;
  /** Releases the file lock and closes both connections. Call in afterAll. */
  close(): Promise<void>;
}

/** Opens the harness for one test file. Throws when the test profile is not configured. */
export async function connectTestDb(): Promise<TestDb> {
  const urls = testDbUrls();
  if (!urls) throw new Error('TEST_DATABASE_URL / TEST_DATABASE_MIGRATE_URL are not set');

  const admin = new Client({
    connectionString: urls.migrateUrl,
    application_name: 'buddha-test-admin',
  });
  await admin.connect();
  await admin.query('SELECT pg_advisory_lock(hashtext($1))', [FILE_LOCK_KEY]);
  const db = createDb(urls.appUrl, { max: 5, applicationName: 'buddha-test' });

  return {
    db,
    async reset() {
      await admin.query(WIPE_PUBLIC_TABLES_SQL);
    },
    async close() {
      await closeDb(db);
      await admin.query('SELECT pg_advisory_unlock(hashtext($1))', [FILE_LOCK_KEY]);
      await admin.end();
    },
  };
}
