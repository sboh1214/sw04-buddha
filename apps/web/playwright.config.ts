import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

/**
 * E2E (PLAN 14): chromium at 375px (mobile) and 1280px (desktop), both projects running every
 * spec — the trade panel and the detail layout differ by viewport, not by spec.
 *
 * The suite needs a whole stack: Postgres, Redis and Mailpit (`pnpm infra:up`), a migrated and
 * SEEDED database (`pnpm db:migrate && pnpm db:seed` — the specs create their own markets, but
 * the first admin and the category rows have no route that could make them), the API on :4000,
 * the web server on :3000 and, since M5, the worker. The `webServer` blocks below start the
 * three processes when nothing is listening; the containers and the migrations remain a
 * prerequisite.
 *
 * The repo's root `.env` is read here the way the worker (env.ts) and Next (next.config.ts)
 * read it, so a probe below is aimed at the port the process it waits for actually took —
 * `WORKER_HEALTH_PORT=4200` in `.env` used to leave the probe on 4100 and abort the whole run
 * on the worker's startup timeout. `dotenv` never overrides what is already exported, so CI and
 * a developer's shell still win; a value in neither place falls back to the default
 * `.env.example` documents. Playwright hands `process.env` on to its workers, which is how the
 * specs (helpers.ts) see the same values.
 */
loadEnv({ path: path.join(__dirname, '../../.env'), quiet: true });

/** The web origin under test. */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/** The API origin — the same one the browser dials for the Socket.IO handshake (ADR-0017). */
const apiURL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/**
 * The worker's liveness probe (M5). The settlement spec waits on a `market.finalize` job that
 * only the worker runs, so a stack without one fails as "실현 손익 never appeared" rather than as
 * "no worker" — the probe turns that into a startup timeout with the worker's name on it.
 *
 * `WORKER_HEALTH_PORT=0` is the documented "no listener" (worker env.ts), and a port nothing
 * will ever answer on cannot be probed: the worker entry is left out below, and the settlement
 * specs skip themselves (helpers.ts `workerProbeDisabled`) instead of waiting on a job whose
 * runner the suite cannot see.
 */
const workerHealthPort = process.env.WORKER_HEALTH_PORT ?? '4100';
const workerProbeDisabled = workerHealthPort === '0';
const workerURL = `http://${process.env.WORKER_HOST ?? 'localhost'}:${workerHealthPort}/health`;

/** `nest start` compiles the whole API and `next dev` compiles a route on first request. */
const SERVER_START_MS = 240_000;

/** 가입(Mailpit) → 충전 → 매수 → 포트폴리오 is one test, and it is the longest one. */
const TEST_TIMEOUT_MS = 180_000;

/** Room for a cold-compiled route to answer; the 1s realtime budget is passed per assertion. */
const EXPECT_TIMEOUT_MS = 15_000;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: TEST_TIMEOUT_MS,
  expect: { timeout: EXPECT_TIMEOUT_MS },
  // `github` annotates the failing lines in the PR; the HTML report is what the CI job uploads
  // from apps/web/playwright-report/ (both that folder and test-results/ are gitignored).
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  },
  projects: [
    {
      name: 'mobile-375',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, isMobile: true },
    },
    {
      name: 'desktop-1280',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  /*
   * All three processes, because the specs depend on all three: the web server for the pages,
   * the API directly for `/ws` (a Next rewrite does not proxy a WebSocket upgrade), and since
   * M5 the worker for the close and finalize jobs — so a run with one of them down fails as
   * "the probability never moved" or "실현 손익 never appeared" rather than as "X is down".
   * (The worker entry is the one exception, and only when its probe is switched off — above.)
   *
   * `reuseExistingServer` is true even in CI, deliberately. The CI job builds the app and
   * starts its own `next start` before calling this suite (a dev server would measure Turbopack
   * rather than the product), and `!process.env.CI` would then abort the run on a port that is
   * already in use. What that costs locally is that a stale server is reused silently — restart
   * `pnpm dev` after a change, the way the previous version of this file already assumed.
   *
   * The API probe is `/api/health`, which answers 503 while Postgres or Redis is unreachable
   * (health.controller.ts): a timeout here means the containers are not up, not that the
   * server failed to start. The web probe must use `localhost` and never `127.0.0.1` — on
   * Node 24 `next dev --hostname localhost` binds ::1 only.
   */
  webServer: [
    {
      name: 'api',
      command: 'pnpm --filter api dev',
      url: `${apiURL}/api/health`,
      reuseExistingServer: true,
      timeout: SERVER_START_MS,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      name: 'web',
      command: 'pnpm --filter web dev',
      url: baseURL,
      reuseExistingServer: true,
      timeout: SERVER_START_MS,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    // `pnpm dev` already runs one; this only starts a worker when nothing answers the probe.
    // Two workers on one Redis would share the queues harmlessly, but the second one fails on
    // the health port first (EADDRINUSE), which is the louder and therefore better outcome.
    // With the health listener disabled (`WORKER_HEALTH_PORT=0`) there is no probe to wait on,
    // so no entry at all: the api and web entries are unaffected either way.
    ...(workerProbeDisabled
      ? []
      : [
          {
            name: 'worker',
            command: 'pnpm --filter worker dev',
            url: workerURL,
            reuseExistingServer: true,
            timeout: SERVER_START_MS,
            stdout: 'pipe' as const,
            stderr: 'pipe' as const,
          },
        ]),
  ],
});
