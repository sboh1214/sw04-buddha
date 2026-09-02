// vitest globalSetup (vitest.config.ts): migrate the test database once per run.
import { migrateTestDb } from './harness.js';

export default migrateTestDb;
