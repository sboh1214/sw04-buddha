import type { LegalDocument } from './document';
import { PRIVACY } from './privacy';
import { REFUND } from './refund';
import { TERMS } from './terms';

/**
 * Every version of the three legal documents that took effect (owner answer 137-2c, #137,
 * ADR-0176): a consent record names the version — the 시행일 — a member agreed to (#57-5), so the
 * text of that version stays readable. `/terms` shows the current version and the list; each
 * version is also at `/terms/<시행일>` (and `/privacy/…`, `/refund/…`), generated at build time.
 *
 * Oldest first; the last one is in force. A revision adds a version and never rewrites one: the
 * version in force is frozen into a module of its own named by its date (`terms-2026-11-28.ts`)
 * as a literal `LegalDocument` — its strings as they read now (`JSON.stringify` of the document),
 * every shared sentence, constant and retention figure written out and only the `{{business
 * facts}}` left as placeholders — and listed here before the new one. A copy of the module that
 * still imported service-facts.ts, copy.ts or POLICY_RETENTION_DAYS would change with them.
 * legal.test.ts pins the words of every listed version (`VERSION_FINGERPRINTS`). The drafts of
 * 2026-10-18 never took effect (their 시행일 was 미정) and are not listed — their text is in the
 * repository's history.
 */
export const LEGAL_DOCUMENT_KINDS = ['terms', 'privacy', 'refund'] as const;
export type LegalDocumentKind = (typeof LEGAL_DOCUMENT_KINDS)[number];

export const LEGAL_VERSIONS: Readonly<
  Record<LegalDocumentKind, readonly [LegalDocument, ...LegalDocument[]]>
> = {
  terms: [TERMS],
  privacy: [PRIVACY],
  refund: [REFUND],
};

/** Each document's address: the current version there, each version under it by its date. */
export const LEGAL_DOCUMENT_PATHS = {
  terms: '/terms',
  privacy: '/privacy',
  refund: '/refund',
} as const satisfies Record<LegalDocumentKind, string>;

/** The 시행일 of a listed version (every listed version has one; the test checks). */
export function effectiveDateOf(doc: LegalDocument): string {
  if (doc.effectiveDate === undefined) throw new Error(`${doc.title}: no 시행일`);
  return doc.effectiveDate;
}

/** The version in force. */
export function currentLegalDocument(kind: LegalDocumentKind): LegalDocument {
  const versions = LEGAL_VERSIONS[kind];
  return versions[versions.length - 1]!;
}

/** The version that took effect on `date`, if one did. */
export function legalDocumentOn(kind: LegalDocumentKind, date: string): LegalDocument | undefined {
  return LEGAL_VERSIONS[kind].find((doc) => doc.effectiveDate === date);
}

/** The address of the version that took effect on `date`. */
export function legalVersionPath(kind: LegalDocumentKind, date: string): string {
  return `${LEGAL_DOCUMENT_PATHS[kind]}/${date}`;
}

/** The `[date]` route's static params: one per listed version, the current one included. */
export function legalVersionParams(kind: LegalDocumentKind): { date: string }[] {
  return LEGAL_VERSIONS[kind].map((doc) => ({ date: effectiveDateOf(doc) }));
}
