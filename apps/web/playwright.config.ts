import { defineConfig, devices } from '@playwright/test';

/**
 * E2E (PLAN 14): chromium at 375px (mobile) and 1280px (desktop), both projects running every
 * spec — the trade panel and the detail layout differ by viewport, not by spec.
 *
 * The suite needs a whole stack: Postgres, Redis and Mailpit (`pnpm infra:up`), a migrated and
 * SEEDED database (`pnpm db:migrate && pnpm db:seed` — the specs create their own markets, but
 * the first admin and the category rows have no route that could make them), the API on :4000
 * and the web server on :3000. The `webServer` blocks below start the two servers when nothing
 * is listening; the containers and the migrations remain a prerequisite.
 *
 * Playwright does NOT read the repo's root `.env` (Next loads it itself in next.config.ts), so
 * every value below falls back to the same default `.env.example` documents. CI, and a
 * developer who exports them, override through the environment.
 */

/** The web origin under test. */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/** The API origin — the same one the browser dials for the Socket.IO handshake (ADR-0017). */
const apiURL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

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
   * Both servers, because the browser talks to both: the web server for the pages and the API
   * directly for `/ws` (a Next rewrite does not proxy a WebSocket upgrade), so a run with only
   * one of them up fails as "the probability never moved" rather than as "the API is down".
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
  ],
});
