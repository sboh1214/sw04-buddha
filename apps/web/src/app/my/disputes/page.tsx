import type { Metadata } from 'next';
import { copy } from '@/copy';
import { requireMySession } from '@/lib/my.server';
import { MyDisputes } from './my-disputes';

export const metadata: Metadata = { title: `${copy.myDisputes} | ${copy.appName}` };

/**
 * `/my/disputes`: MY '판정 이의' (#175, ADR-0104; ADR-0093 decision 1 #173 item 7: 처리 결과와 사유는
 * 제출자에게 보인다), a MY sub-page and not a tab, as 내 제안 (ADR-0089) — linked from MY 설정 and
 * the submission screen. Under MY's layout, so the tab bar is drawn with no tab current, and gated
 * on every navigation to it (`requireMySession`, which brings a visitor back here after the login).
 * Exempt from the onboarding gate (`ONBOARDING_EXEMPT_PATHS`): a 철회 needs a session alone, as a
 * proposal's. The list is personal — only the submitter and the operators see a dispute's links
 * and reason (#173 item 13) — and fetched after hydration like every MY list.
 */
export default async function MyDisputesPage() {
  await requireMySession();
  return <MyDisputes />;
}
