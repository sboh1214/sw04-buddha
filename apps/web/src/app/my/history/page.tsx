import type { Metadata } from 'next';
import { copy } from '@/copy';
import { fetchMarketServer } from '@/lib/api.server';
import {
  type HistorySearchParams,
  historyFiltersFromSearchParams,
  historyMarketTitle,
} from '@/lib/my-history';
import { requireMySession } from '@/lib/my.server';
import { HistoryScreen } from './history-screen';

export const metadata: Metadata = { title: `${copy.myHistory} | ${copy.appName}` };

/**
 * `/my/history`: MY's 거래·정산 이력 tab (#16; the three lists and their filters since #124,
 * ADR-0143). Gated on every navigation to it (`requireMySession`); the layout draws the tabs.
 *
 * The address is normalised ONCE, here, and handed down (the home's rule) — the client never
 * derives the filters a second time. No row of the history is read on the server: the lists are
 * the account's own, read in the browser with its cookie. The one thing read here is the public
 * title of the market `?market=` names, for the filter's chip; a read that failed, or a market
 * that is not public, leaves the chip saying '고른 시장' (`historyMarketTitle`).
 */
export default async function MyHistoryPage({
  searchParams,
}: {
  searchParams: Promise<HistorySearchParams>;
}) {
  await requireMySession();
  const filters = historyFiltersFromSearchParams(await searchParams);
  const marketTitle = await historyMarketTitle(filters.market, fetchMarketServer);
  return <HistoryScreen filters={filters} marketTitle={marketTitle} />;
}
