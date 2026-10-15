import { defineConfig } from 'vitest/config';

// PLAN 14: packages/shared must keep >= 90% coverage; thresholds fail the run when violated.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The fast-check suites (the market maker's ladder and risk, hundreds of runs each) take a
    // fraction of a second here, but under coverage on a CI runner busy with every other
    // package's tasks one took 5.1 s and hit vitest's 5 s default. db, api and worker raise
    // theirs for their own slow cases.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'lcov'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
