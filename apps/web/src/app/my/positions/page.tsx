import type { Metadata } from 'next';
import { copy } from '@/copy';
import { requireMySession } from '@/lib/my.server';
import { MyPositions } from '../portfolio';

export const metadata: Metadata = { title: `${copy.myPositions} | ${copy.appName}` };

/**
 * `/my/positions`: MY's 보유 계약 tab (#16). Gated on every navigation to it (`requireMySession`); the
 * layout draws the tabs.
 */
export default async function MyPositionsPage() {
  await requireMySession();
  return <MyPositions />;
}
