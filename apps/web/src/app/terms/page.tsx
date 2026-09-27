import type { Metadata } from 'next';
import { copy } from '@/copy';
import { LegalDocumentView } from '@/legal/legal-document-view';
import { TERMS } from '@/legal/terms';

export const metadata: Metadata = { title: `${copy.legalTermsTitle} | ${copy.appName}` };

/** `/terms` 이용약관 (ADR-0044): public and static, prerendered at build time. */
export default function TermsPage() {
  return <LegalDocumentView document={TERMS} testId="legal-terms" />;
}
