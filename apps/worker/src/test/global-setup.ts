// vitest globalSetup: the audit job runs against the shared docker `test` database, so the
// worker migrates it the same way packages/db and apps/api do (advisory-locked, once per run).
import { migrateTestDb } from '@buddha/db/test';

export default migrateTestDb;
