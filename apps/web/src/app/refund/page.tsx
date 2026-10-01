import type { Metadata } from 'next';
import { copy } from '@/copy';
import { LegalDocumentView } from '@/legal/legal-document-view';
import { REFUND } from '@/legal/refund';

export const metadata: Metadata = { title: `${copy.legalRefundTitle} | ${copy.appName}` };

/** `/refund` 환불정책 (ADR-0042, ADR-0044): public and static, prerendered at build time. */
export default function RefundPage() {
  return <LegalDocumentView document={REFUND} testId="legal-refund" />;
}
