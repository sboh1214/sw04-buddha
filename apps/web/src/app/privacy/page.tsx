import type { Metadata } from 'next';
import { copy } from '@/copy';
import { LegalDocumentView } from '@/legal/legal-document-view';
import { PRIVACY } from '@/legal/privacy';

export const metadata: Metadata = { title: `${copy.legalPrivacyTitle} | ${copy.appName}` };

/** `/privacy` 개인정보처리방침 (ADR-0044): public and static, prerendered at build time. */
export default function PrivacyPage() {
  return <LegalDocumentView document={PRIVACY} testId="legal-privacy" />;
}
