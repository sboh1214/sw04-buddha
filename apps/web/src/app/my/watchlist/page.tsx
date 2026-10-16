import type { Metadata } from 'next';
import { copy } from '@/copy';
import { requireMySession } from '@/lib/my.server';
import { MyWatchlist } from './watchlist';

export const metadata: Metadata = { title: `${copy.myWatchlist} | ${copy.appName}` };

/**
 * `/my/watchlist`: MY's 관심 시장 tab (#16, filled by #89). Gated on every navigation to it
 * (`requireMySession`); the layout draws the tabs, and the list is fetched after hydration like
 * every MY list (nothing of it is in the HTML).
 */
export default async function MyWatchlistPage() {
  await requireMySession();
  return <MyWatchlist />;
}
