import type { Metadata } from 'next';
import { copy } from '@/copy';
import { LegalVersionView } from '@/legal/legal-version-view';
import { currentLegalDocument } from '@/legal/versions';

export const metadata: Metadata = { title: `${copy.legalTermsTitle} | ${copy.appName}` };

/**
 * `/terms` 이용약관 (ADR-0044): the version in force, with the versions that took effect (#137,
 * ADR-0176). Public and static, prerendered at build time.
 */
export default function TermsPage() {
  return <LegalVersionView kind="terms" document={currentLegalDocument('terms')} />;
}
