import type { Metadata } from 'next';
import { copy } from '@/copy';
import { ComingSoonTab } from '../coming-soon';

export const metadata: Metadata = { title: `${copy.myNotifications} | ${copy.appName}` };

/** `/my/notifications`: MY's 알림 tab (#16), 준비 중 until its own issue fills it. */
export default function MyNotificationsPage() {
  return <ComingSoonTab title={copy.myNotifications} testId="my-notifications" />;
}
