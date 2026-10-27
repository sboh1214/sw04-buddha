import { defineConfig } from 'vitest/config';

// Decorator support: Vite 8 (oxc) reads `experimentalDecorators` and
// `emitDecoratorMetadata` from tsconfig.json, so no SWC plugin is needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    // Per worker: map TEST_* onto DATABASE_URL/REDIS_URL, fixed auth secret, unreachable SMTP.
    setupFiles: ['src/test/setup-env.ts'],
    // Once per run: migrate the shared test database (packages/db harness, advisory lock).
    globalSetup: ['src/test/global-setup.ts'],
    // Integration suites share one database: run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
    // `beforeAll` waits for the cross-package file lock (packages/db harness) while the db and
    // worker suites run on the same database, so under `pnpm test` it can sit for the length of
    // those suites — minutes, not seconds. CI gives each package a job and a database of its own
    // (.github/workflows/ci.yml), so nothing waits there.
    hookTimeout: 600_000,
  },
});
