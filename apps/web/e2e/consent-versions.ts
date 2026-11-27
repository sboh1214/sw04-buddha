/**
 * The version each consent item is at (#58: `CONSENT_DOCUMENTS` in @buddha/shared), for the specs'
 * API-level onboarding (helpers.ts `agreeThroughApi`). Plain data on purpose: Playwright runs the
 * specs straight from source and only TYPE-imports @buddha/shared, so a spec never depends on that
 * package having been built. src/lib/consent.test.ts holds these to the shared table, so a new
 * version fails the unit tests before it fails a whole e2e run.
 *
 * The terms and the privacy item are at the 시행일 of #137's revision (`LEGAL_FIRST_EFFECTIVE_DATE`,
 * ADR-0176); the age check and the marketing text are unchanged, still at their first version.
 */
export const E2E_CONSENT_VERSIONS = {
  terms: '2026-11-28',
  privacy: '2026-11-28',
  age: 'draft-2026-10-18',
  marketing: 'draft-2026-10-18',
} as const;
