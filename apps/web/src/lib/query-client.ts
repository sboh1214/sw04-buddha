import { QueryClient, isServer, replaceEqualDeep } from '@tanstack/react-query';
import { type Market, type Position, isApiError } from './api';
import { MARKETS_KEY, MARKET_KEY, POSITIONS_KEY, TICKS_KEY } from './market-keys';
import { type MarketPages, joinMarket, joinMarketPages, joinPositions } from './market-live';
import { type CachedSeries, joinSeries } from './ticks';

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
  // And the chart's series, for the third time and the same reason: `appendTickToSeries` orders
  // the socket's ticks by `ts`, but a REST answer went in raw, so a refetch that left before a
  // trade pulled the right edge back to the old probability — while the header, which has
  // `joinMarket` above, kept the new one. Two readings of one trade, disagreeing on one screen.
  // Ordering here is by `tradeCount`, like the three joins above; it was briefly the answer's
  // own clock, which is not a watermark over committed rows (ticks.ts says why).
  client.setQueryDefaults(TICKS_KEY, {
    structuralSharing: (held, incoming) =>
      replaceEqualDeep(
        held,
        joinSeries(held as CachedSeries | undefined, incoming as CachedSeries),
      ),
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

/**
 * Cancels every query under `queryKey` that has answered NOTHING yet, so the invalidation that
 * follows issues a REQUEST rather than a subscription to the one already in flight.
 *
 * Here rather than beside either caller because both of this app's private-cache writers need
 * it and neither owns it: the trade answer (`applyTradeResult`, use-trade.ts) in the tab that
 * traded, and the socket's `user:position` handler (realtime-provider.tsx) in every OTHER tab
 * of the same account, which never runs the trade path at all.
 *
 * `invalidateQueries` restarts a running fetch only where the query already holds data:
 * `refetchQueries` passes `cancelRefetch`, and query-core honours it under
 * `if (this.state.data !== undefined && fetchOptions?.cancelRefetch)` — otherwise it hands
 * back the RUNNING promise (`Query.fetch`). So a trade answered while the account's FIRST
 * `GET /me/positions`, `GET /me` or `GET /me/orders` was still in flight vanished: the seeds
 * decline an absent entry (`mergePosition` and the `Me` updater both answer undefined, which
 * is what keeps a logged-out tab from gaining session state), and the invalidation then waited
 * on the very request that left BEFORE the trade — so a pre-trade `[]` landed and the new row,
 * the new balance and the new order were all missing from the screen until an unrelated
 * refetch happened by.
 *
 * A cancel leaves the retryer `rejected`, which is what lets the next `fetch()` start a second
 * request instead of taking the dedupe branch.
 *
 * The `data === undefined` predicate is what keeps this from COSTING an answer, and the case it
 * saves is not the obvious one. For a MOUNTED list holding rows it changes nothing — the
 * invalidation's own `cancelRefetch` was going to cancel and restart that refetch anyway. An
 * UNMOUNTED one mid-refetch is the one that pays: `cancelQueries` reverts it to the rows it held
 * before, and an `active` invalidation then declines to restart what nobody is watching — so the
 * answer already on the wire is thrown away and the stale row stands until the list is mounted
 * again. The predicate leaves it alone to land (query-client.test.ts pins both halves).
 */
export function cancelFirstFetch(queryClient: QueryClient, queryKey: readonly unknown[]): void {
  void queryClient.cancelQueries({
    queryKey,
    predicate: (query) => query.state.data === undefined,
  });
}

/**
 * Cancel whatever has answered nothing, then ask again — and never one without the other.
 *
 * The two halves are a PAIR, which is why they are one function rather than two lines at each
 * call site. A cancel with no invalidation behind it strands the query on `pending` with
 * nothing left fetching (the hazard `applyBalanceEvent` grew its own `refetch` kind to avoid),
 * and an invalidation with no cancel in front of it subscribes to the request already running
 * instead of issuing one — which is the whole bug above. Written apart, either half could be
 * removed and every test would stay green.
 *
 * `refetchType` is left at its default `'active'` (query-core `invalidateQueries`), so only
 * mounted observers ask again and the rest merely go stale — PLAN 11.5's "refetch 남발 금지".
 */
export function restartQueries(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): Promise<void> {
  cancelFirstFetch(queryClient, queryKey);
  return queryClient.invalidateQueries({ queryKey });
}

/** What a section that renders a LIST can say about the query behind it. */
export type ListView = 'pending' | 'failed' | 'stale' | 'ready';

/**
 * Which of the four a list section is in — and `stale` is the one the screens kept missing.
 *
 * THE HAZARD: query-core reports a failure two different ways, and a ladder written on
 * `isLoadingError` alone collapses one of them into `ready`. A FIRST fetch that exhausts its
 * retries has no data and answers `isLoadingError` — the ladders caught that. A refetch that
 * fails after data exists answers `isRefetchError` instead, KEEPS the rows, and was rendered as
 * an ordinary list with nothing to say it had stopped being refreshed (measured: `isLoadingError
 * false, isRefetchError true, rows kept`).
 *
 * That silence costs differently per screen and both are real. 보유 포지션 shows a holding whose
 * membership refresh failed — a void or a settlement asks for both lists (`applyPositionEvent`
 * answers `refetch` when the row must MOVE), so a failed one leaves the row in 보유 포지션, out of
 * 정산 이력, and inside 총 평가 금액 where it no longer belongs. 체결 내역 shows a list one row
 * short, and there the refetch is the ONLY path a new fill can arrive by: `market:trade` carries
 * no `amountP`, so it is deliberately never merged into the cache.
 *
 * `stale` is deliberately NOT `failed`: the rows are real and the last answer is worth keeping on
 * screen — dropping a screenful because one refresh failed loses more than the staleness costs,
 * which is the reading `market-list.tsx` already takes. It is the caller's job to render the rows
 * AND say so, with a way back.
 *
 * `pending` is checked first because a query refetching after a failure reports both.
 */
export function listView(query: {
  isPending: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
}): ListView {
  if (query.isPending) return 'pending';
  if (query.isLoadingError) return 'failed';
  return query.isRefetchError ? 'stale' : 'ready';
}
