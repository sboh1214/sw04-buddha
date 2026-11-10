import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** Required live-quoting scenario, with a fresh dedicated DB/Redis stack. */
export default defineConfig({
  ...base,
  metadata: { ...base.metadata, marketMakerProfile: 'quotes' },
  grep: /@market-maker-quotes/,
  grepInvert: undefined,
  workers: 1,
});
