import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** Required no-funds scenario: no market opening, allocation or mint from another suite. */
export default defineConfig({
  ...base,
  metadata: { ...base.metadata, marketMakerProfile: 'treasury' },
  grep: /@isolated-treasury/,
  grepInvert: undefined,
  workers: 1,
});
