/**
 * The version each consent item is at (#58: `CONSENT_DOCUMENTS` in @buddha/shared), for the specs'
 * API-level onboarding (helpers.ts `agreeThroughApi`). Plain data on purpose: Playwright runs the
 * specs straight from source and only TYPE-imports @buddha/shared, so a spec never depends on that
 * package having been built. src/lib/consent.test.ts holds these to the shared table, so a new
 * version fails the unit tests before it fails a whole e2e run.
 */
export const E2E_CONSENT_VERSIONS = {
  terms: 'draft-2026-10-18',
  privacy: 'draft-2026-10-18',
  age: 'draft-2026-10-18',
  marketing: 'draft-2026-10-18',
} as const;
