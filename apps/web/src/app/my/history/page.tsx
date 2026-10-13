import type { Metadata } from 'next';
import { copy } from '@/copy';
import { requireMySession } from '@/lib/my.server';
import { MyHistory } from '../portfolio';

export const metadata: Metadata = { title: `${copy.myHistory} | ${copy.appName}` };

/**
 * `/my/history`: MY's 거래·정산 이력 tab (#16). Gated on every navigation to it
 * (`requireMySession`); the layout draws the tabs.
 */
export default async function MyHistoryPage() {
  await requireMySession();
  return <MyHistory />;
}
