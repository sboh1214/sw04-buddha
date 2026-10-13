import type { Metadata } from 'next';
import { copy } from '@/copy';
import { MyHistory } from '../portfolio';

export const metadata: Metadata = { title: `${copy.myHistory} | ${copy.appName}` };

/** `/my/history`: MY's 거래·정산 이력 tab (#16). The layout gates the session and draws the tabs. */
export default function MyHistoryPage() {
  return <MyHistory />;
}
