import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    // Integration tests share the docker `test` profile database (PLAN 14): migrate it once,
    // then run files one at a time (see src/test/harness.ts for the cross-package lock).
    globalSetup: ['./src/test/global-setup.ts'],
    fileParallelism: false,
  },
});
