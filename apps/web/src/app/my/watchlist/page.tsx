import type { Metadata } from 'next';
import { copy } from '@/copy';
import { ComingSoonTab } from '../coming-soon';

export const metadata: Metadata = { title: `${copy.myWatchlist} | ${copy.appName}` };

/** `/my/watchlist`: MY's 관심 시장 tab (#16), 준비 중 until its own issue fills it. */
export default function MyWatchlistPage() {
  return <ComingSoonTab title={copy.myWatchlist} testId="my-watchlist" />;
}
