import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { copy } from '@/copy';
import { LegalVersionView } from '@/legal/legal-version-view';
import { legalDocumentOn, legalVersionParams } from '@/legal/versions';

export const metadata: Metadata = { title: `${copy.legalRefundTitle} | ${copy.appName}` };

/** Only the versions listed (versions.ts): any other date is not found, never rendered. */
export const dynamicParams = false;

export function generateStaticParams(): { date: string }[] {
  return legalVersionParams('refund');
}

/**
 * `/refund/<시행일>`: one version of the document as it took effect (owner answer 137-2c, #137,
 * ADR-0176), the current one included. Prerendered at build time, one page per version.
 */
export default async function RefundVersionPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  const document = legalDocumentOn('refund', date) ?? notFound();
  return <LegalVersionView kind="refund" document={document} />;
}
