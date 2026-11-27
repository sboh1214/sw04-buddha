import { defineConfig } from '@playwright/test';
import base, { e2eReporters } from './playwright.config';

/** Required live-quoting scenario, with a fresh dedicated DB/Redis stack. */
export default defineConfig({
  ...base,
  metadata: { ...base.metadata, marketMakerProfile: 'quotes' },
  grep: /@market-maker-quotes/,
  grepInvert: undefined,
  workers: 1,
  // Its own result file, e2e-results/market-maker.json (#189, ADR-0178).
  reporter: e2eReporters('market-maker'),
});
