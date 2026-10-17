import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // Playwright specs live in e2e/ and are run by `pnpm --filter web test:e2e`, not vitest.
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    environment: 'node',
    passWithNoTests: true,
    // The source-scanning guards (excluded-features.test.ts, the formatKst guard in
    // lib/time-zone.test.ts) read every file under src/ and take 5–10s on a loaded CI runner,
    // past vitest's 5s default — the reason shared, db and worker raised theirs (3fb6ebf).
    testTimeout: 30_000,
  },
});
