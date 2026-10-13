import type { Metadata } from 'next';
import { copy } from '@/copy';
import { MyPositions } from '../portfolio';

export const metadata: Metadata = { title: `${copy.myPositions} | ${copy.appName}` };

/** `/my/positions`: MY's 보유 계약 tab (#16). The layout gates the session and draws the tabs. */
export default function MyPositionsPage() {
  return <MyPositions />;
}
