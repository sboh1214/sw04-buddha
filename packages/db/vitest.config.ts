import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    // Integration tests share the docker `test` profile database (PLAN 14): migrate it once,
    // then run files one at a time (see src/test/harness.ts for the cross-package lock).
    globalSetup: ['./src/test/global-setup.ts'],
    fileParallelism: false,
    // seed.test.ts spawns the seed CLI (node + tsx + a fresh pool + scrypt) up to twice per
    // case, which is far past vitest's 5 s default on a cold runner. apps/api raises these
    // for the same reason.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
