// vitest globalSetup: migrate the shared test database once per run (advisory-locked, so a
// concurrent packages/db test run is safe). Skips with a warning when TEST_* are unset,
// except under CI=true where every TEST_* value is mandatory (ADR-0022): the API suites also
// need Redis, which packages/db's migrator does not check.
import { migrateTestDb } from '@buddha/db/test';

export default async function globalSetup(): Promise<void> {
  await migrateTestDb();
  if (process.env.CI && !process.env.TEST_REDIS_URL) {
    throw new Error('[test] TEST_REDIS_URL is required in CI (ADR-0022)');
  }
}
