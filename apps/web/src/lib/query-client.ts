import { QueryClient, isServer, replaceEqualDeep } from '@tanstack/react-query';
import { type Market, type Position, isApiError } from './api';
import { MARKETS_KEY, MARKET_KEY, POSITIONS_KEY } from './market-keys';
import { type MarketPages, joinMarket, joinMarketPages, joinPositions } from './market-live';

function makeQueryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        // Do not refetch immediately on mount; the realtime socket patches the caches with
        // setQueryData instead (PLAN 11.5: an event must not become a request).
        staleTime: 30 * 1000,
        retry: (failureCount, error) => {
          // 4xx never fixes itself by retrying (401 in particular must fail fast).
          if (isApiError(error) && error.status < 500) return false;
          return failureCount < 2;
        },
      },
    },
  });
  // Ordering is enforced on EVERY write to a market, not only in the socket handler: a value
  // written by `setQueryData` and a value answered by a queryFn both route through
  // `replaceData`, which hands a function-valued `structuralSharing` both sides. The
  // race this fixes has nothing to do with sockets — refetchOnWindowFocus and
  // refetchOnReconnect are on, so a refetch that started before a trade and lands after it
  // would roll the probability backwards on its own.
  //
  // Query defaults match by key PREFIX, so `['market']` covers `['market', <any id>]` and
  // never `['markets', filters]` (element-wise comparison; 'market' !== 'markets'), and the
  // two registrations below stay disjoint — market-keys.test.ts pins that. Hydration is the
  // one write that bypasses this path (it sets the query state directly) and carries its own
  // `dataUpdatedAt` guard. `replaceEqualDeep` restores reference equality wherever the join
  // rebuilt an equal subtree, so an untouched list page does not re-render; it is re-exported
  // by @tanstack/react-query, the only specifier that resolves here (node_modules is
  // isolated and query-core is not a direct dependency of apps/web). The casts are the price
  // of query-core typing both sides `unknown`.
  client.setQueryDefaults(MARKET_KEY, {
    structuralSharing: (held, incoming) =>
      replaceEqualDeep(held, joinMarket(held as Market | undefined, incoming as Market)),
  });
  client.setQueryDefaults(MARKETS_KEY, {
    structuralSharing: (held, incoming) =>
      replaceEqualDeep(
        held,
        joinMarketPages(held as MarketPages | undefined, incoming as MarketPages),
      ),
  });
  // The same duty for the account's own rows, and for the same reason: `applyPositionEvent`
  // orders `user:position` events by `version`, but a `GET /me/positions` answer went in raw,
  // so a fetch that left before another tab's trade landed after the event and rolled the row
  // back — a stale 매도 ceiling on the detail and stale 평가손익 on /portfolio, with nothing
  // scheduled to correct either. `['positions']` covers `['positions', 'open']` and
  // `['positions', 'settled']` by prefix and never reaches `['orders']`.
  client.setQueryDefaults(POSITIONS_KEY, {
    structuralSharing: (held, incoming) =>
      replaceEqualDeep(held, joinPositions(held as Position[] | undefined, incoming as Position[])),
  });
  return client;
}

let browserQueryClient: QueryClient | undefined;

/**
 * TanStack Query SSR pattern: a fresh client per server request, one lazily created
 * singleton in the browser (so React suspending during the first render cannot discard it).
 */
export function getQueryClient(): QueryClient {
  if (isServer) return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
