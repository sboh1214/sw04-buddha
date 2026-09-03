import { defineConfig, devices } from '@playwright/test';

/**
 * E2E (PLAN 14): chromium at 375px (mobile) and 1280px (desktop). Not wired into CI until M4.
 * Expects a running stack: `pnpm infra:up`, `pnpm db:migrate`, then `pnpm dev` (web :3000
 * rewriting /api/* to api :4000), or set E2E_BASE_URL to another web origin.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
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
});
