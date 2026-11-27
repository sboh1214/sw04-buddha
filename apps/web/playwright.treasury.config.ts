import { defineConfig } from '@playwright/test';
import base, { e2eReporters } from './playwright.config';

/** Required no-funds scenario: no market opening, allocation or mint from another suite. */
export default defineConfig({
  ...base,
  metadata: { ...base.metadata, marketMakerProfile: 'treasury' },
  grep: /@isolated-treasury/,
  grepInvert: undefined,
  workers: 1,
  // Its own result file, e2e-results/treasury.json (#189, ADR-0178).
  reporter: e2eReporters('treasury'),
});
