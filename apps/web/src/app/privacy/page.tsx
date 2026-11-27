import type { Metadata } from 'next';
import { copy } from '@/copy';
import { LegalVersionView } from '@/legal/legal-version-view';
import { currentLegalDocument } from '@/legal/versions';

export const metadata: Metadata = { title: `${copy.legalPrivacyTitle} | ${copy.appName}` };

/**
 * `/privacy` 개인정보처리방침 (ADR-0044): the version in force, with the versions that took effect (#137,
 * ADR-0176). Public and static, prerendered at build time.
 */
export default function PrivacyPage() {
  return <LegalVersionView kind="privacy" document={currentLegalDocument('privacy')} />;
}
