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
    hookTimeout: 30_000,
  },
});
