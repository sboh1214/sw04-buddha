import { marketStatsEventSchema } from '@buddha/shared';
import type { QueryClient } from '@tanstack/react-query';
import type { Market } from './api';
import { MARKETS_KEY, WATCHLIST_PAGES_KEY, marketKey } from './market-keys';
import {
  applyStats,
  applyToPages,
  tickRestartsMarket,
  type MarketPages,
  type Throttle,
} from './market-live';
import { restartQueries } from './query-client';

/** The actual participant-only socket handler, also exercised with a real QueryClient. */
export function handleMarketStats(client: QueryClient, throttle: Throttle, raw: unknown): void {
  const parsed = marketStatsEventSchema.safeParse(raw);
  if (!parsed.success) return;
  const event = parsed.data;
  const key = marketKey(event.marketId);
  const row = client.getQueryCache().find<Market>({ queryKey: key, exact: true });
  client.setQueryData<Market>(key, (held) => applyStats(held, event));
  if (tickRestartsMarket(row?.state, throttle, event.marketId, Date.now())) {
    void restartQueries(client, key);
  }
  for (const queryKey of [MARKETS_KEY, WATCHLIST_PAGES_KEY]) {
    client.setQueriesData<MarketPages>({ queryKey }, (held) =>
      applyToPages(held, (market) => applyStats(market, event)),
    );
  }
  // Rankings remain the server page's order until the next normal snapshot, as for ticks.
}
