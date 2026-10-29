import type { Metadata } from 'next';
import { copy } from '@/copy';
import { requireMySession } from '@/lib/my.server';
import { AccountClosure } from './account-closure';

export const metadata: Metadata = { title: `${copy.closureTitle} | ${copy.appName}` };

/**
 * `/my/settings/closure`: 탈퇴 (#140, ADR-0086), opened from MY 설정's last card. Under MY 설정, so
 * the 설정 tab stays the current one. Gated on every navigation to it (`requireMySession`); the
 * confirmation reads the member's balance and refusals after hydration like every MY screen
 * (nothing of them is in the HTML).
 */
export default async function AccountClosurePage() {
  await requireMySession();
  return <AccountClosure />;
}
