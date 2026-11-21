import type { Metadata } from 'next';
import { copy } from '@/copy';
import { requireMySession } from '@/lib/my.server';
import { MyNotifications } from './my-notifications';

export const metadata: Metadata = { title: `${copy.myNotifications} | ${copy.appName}` };

/**
 * `/my/notifications`: MY's 알림 tab (#16; #53, ADR-0157) — the member's inbox, newest first, read
 * by pressing a notification or '모두 읽음'. Gated on every navigation to it (`requireMySession`,
 * which brings a visitor back here after the login) and under the onboarding gate like every MY
 * tab. The list is personal (PRIVATE_DATA `notifications`) and fetched after hydration like every
 * MY list.
 */
export default async function MyNotificationsPage() {
  await requireMySession();
  return <MyNotifications />;
}
