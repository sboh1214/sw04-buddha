import type { Metadata } from 'next';
import { copy } from '@/copy';
import { requireMySession } from '@/lib/my.server';
import { MyProposals } from './my-proposals';

export const metadata: Metadata = { title: `${copy.myProposals} | ${copy.appName}` };

/**
 * `/my/proposals`: 내 제안 (#77, ADR-0089), a MY sub-page and not a tab (ADR-0069 decision 4 #77
 * 위치: no ninth tab, linked from the MY summary and 설정). Under MY's layout, so the tab bar is
 * drawn with no tab current (`isMyTabCurrent`), and gated on every navigation to it
 * (`requireMySession`, which brings a visitor back here after the login). The list is personal —
 * only the proposer and the operators see a proposal — and fetched after hydration like every MY
 * list.
 */
export default async function MyProposalsPage() {
  await requireMySession();
  return <MyProposals />;
}
