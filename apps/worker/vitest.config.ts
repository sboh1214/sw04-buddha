import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    // Integration tests share the docker `test` profile database (PLAN 14) with packages/db
    // and apps/api: migrate once per run, then one file at a time (cross-package lock).
    globalSetup: ['./src/test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    // `beforeAll` waits for the cross-package file lock (harness.ts) while api and db files run
    // on the same database, so under `pnpm test` it can sit for the length of those suites —
    // minutes, not seconds. CI gives each package a job and a database of its own
    // (.github/workflows/ci.yml), so nothing waits there.
    hookTimeout: 600_000,
  },
});
