'use client';

import {
  type QueryClient,
  focusManager,
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { type Market, type OrderBook, api, unwrap } from '@/lib/api';
import { settlementPollInterval } from '@/lib/market-admin';
import {
  type MarketFilters,
  type MarketSearch,
  marketBookKey,
  marketKey,
  marketSearchKey,
  marketsKey,
  publicListQuery,
  relatedMarketsKey,
  relatedMarketsQuery,
  searchListQuery,
} from '@/lib/market-keys';
import { type MarketPage } from '@/lib/market-live';
import {
  DEFAULT_TICK_RANGE,
  LIVE_REFRESH_MS,
  type TickRange,
  ticksQueryOptions,
} from '@/lib/ticks';
import { useMarketFills as useMarketFillsQuery } from './use-admin-markets';

/**
 * The public market screens' reads (PLAN 11.4-11.5): the home list, the detail row, its price
 * series, its fills and its book.
 *
 * Not one query key is declared here. `lib/market-keys.ts` owns them all because the server
 * components seed the cache under those keys, and a server component cannot take a key from a
 * hook module — every export of a `'use client'` module is a client reference, which throws when
 * it is called during the server render. `lib/ticks.ts` owns the series query for the same kind
 * of reason: the module that merges a live `market:tick` into a held series must also be the one
 * that asked for it.
 *
 * What is left is the wiring, and the query-option factories are exported APART from the hooks so
 * that wiring can be tested — a component cannot be executed in this app's test runner (the rule
 * stated in use-admin-markets.ts).
 */

/**
 * One filtered page of `GET /markets`, in the `{ items, nextCursor }` shape that
 * `fetchMarketsPageServer` (api.server.ts) also answers — the SSR prefetch and this queryFn have
 * to produce interchangeable pages, because they write the same key.
 *
 * `initialPageParam` is `undefined as string | undefined` rather than a literal, and that is what
 * lets the dehydrated payload hydrate: the first page is the one fetched with NO cursor, so the
 * page params the server dehydrated (`[undefined]`) are the params this query would have used,
 * and the pages are picked up instead of refetched (decision-ssr-hydration §8).
 * `getNextPageParam` maps the wire's `nextCursor: null` onto `undefined` so the page param stays
 * `string | undefined` from the server render to the last 더 보기.
 *
 * The filter object IS the key: it is normalised once, on the server (`filtersFromSearchParams`),
 * and handed to the client as a prop, so no second entry can exist for one URL. `keepPreviousData`
 * keeps the cards that are on screen while the next category or order loads (admin-markets.tsx:
 * 59-77).
 */
export function marketsInfiniteQueryOptions(filters: MarketFilters) {
  return {
    queryKey: marketsKey(filters),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<MarketPage> => {
      // The same query the server twin sends (`publicListQuery`), so the two cannot drift.
      const { data, meta } = unwrap(
        await api.GET('/api/v1/markets', {
          params: { query: publicListQuery(filters, pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: MarketPage) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  };
}

/** The home list. Rows are `MarketSummary`, which is everything a card draws. */
export function useMarkets(filters: MarketFilters) {
  return useInfiniteQuery(marketsInfiniteQueryOptions(filters));
}

/**
 * The search screen's results (#15, ADR-0066): `GET /markets` with the term, the status (every
 * public one unless one is picked), the category and the order, one page per 더 보기, in the home
 * list's page shape so the same grid, card and socket reducers serve it (`['markets', 'search',
 * …]` sits under the home's root, market-keys.ts).
 *
 * The search page reads the first page on the server too (`fetchMarketSearchPageServer`, the
 * same request through `searchListQuery`, so the two produce interchangeable pages under one key)
 * and seeds it only when it holds a card (`seedsSearchResults`, owner decision 2026-10-16,
 * ADR-0066). Otherwise this reads it in the browser, so the first load's three outcomes are the
 * browser's own to show and to retry: the skeleton, '검색 결과가 없습니다.', and a failure that is
 * never read as no results (N02 §3). No `keepPreviousData`: a new term or filter is a new search,
 * and its own loading state is what says so, where held cards would show the last search's
 * results under the new term.
 */
export function marketSearchInfiniteQueryOptions(search: MarketSearch) {
  return {
    queryKey: marketSearchKey(search),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<MarketPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/markets', {
          params: { query: searchListQuery(search, pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: MarketPage) => last.nextCursor ?? undefined,
  };
}

export function useMarketSearch(search: MarketSearch) {
  return useInfiniteQuery(marketSearchInfiniteQueryOptions(search));
}

/**
 * A detail's 관련 시장 (#65, ADR-0068): `GET /markets/:id/related`, the markets an admin linked to
 * this one, in 추천 order, one page per 더 보기 — the home list's page shape, so the home's grid,
 * card and socket reducers serve it (`['markets', 'related', id]` sits under the home's root,
 * market-keys.ts). The detail page reads the first page on the server with the same request
 * (`fetchRelatedMarketsPageServer`) and dehydrates it, so the first paint costs no request; a
 * read that failed there is read here, and the section shows its own failure.
 */
export function relatedMarketsInfiniteQueryOptions(marketId: string) {
  const id = marketId.toLowerCase();
  return {
    queryKey: relatedMarketsKey(id),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<MarketPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/markets/{id}/related', {
          params: { path: { id }, query: relatedMarketsQuery(pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: MarketPage) => last.nextCursor ?? undefined,
  };
}

export function useRelatedMarkets(marketId: string) {
  return useInfiniteQuery(relatedMarketsInfiniteQueryOptions(marketId));
}

/**
 * One market (`GET /markets/:idOrSlug`), keyed AND requested by the canonical lower-cased uuid —
 * never by the slug the URL carried (A-M3-29). The server component resolves the slug to the row
 * and passes `market.id`, so the entry this screen reads is the entry a `market:tick` (which
 * names its market by uuid) and the ticks/fills routes all write.
 *
 * The path parameter is lower-cased along with the key: a uuid is accepted in either case and the
 * API answers with the row's own lower-case id, so sending it as typed would leave the request
 * and the cache entry naming the same market by two different strings.
 */
export function marketQueryOptions(marketId: string) {
  const id = marketId.toLowerCase();
  return {
    queryKey: marketKey(id),
    queryFn: async (): Promise<Market> =>
      unwrap(await api.GET('/api/v1/markets/{idOrSlug}', { params: { path: { idOrSlug: id } } }))
        .data,
    // A failed payout writes its step after SETTLING without a new status event. Read it while
    // visible, every five seconds until completion, so the public delay flag cannot stay stale.
    refetchInterval: (query: { state: { data: Market | undefined } }) =>
      settlementPollInterval(query.state.data),
  };
}

export function useMarket(marketId: string) {
  return useQuery(marketQueryOptions(marketId));
}

/**
 * MY's holdings' market row (`useHoldings`, #67, ADR-0142 결정 2-22): the detail's entry and request
 * (`marketQueryOptions`), with two OBSERVER options of its own — the detail watching the same entry
 * keeps its poll and its focus re-read.
 *
 * - No poll. The 5-second read of a 판정 완료·지급 중 market (`settlementPollInterval`) is for the
 *   detail's payout-delay record (ADR-0121), which MY never draws: a holding's badge reads only
 *   `judgementDelayed`·`disputeUnderReview` (`holdingDisplay`), and settlement reaches the holder as
 *   `user:position`. Kept, it added 12 requests a minute per such holding to a steady 10.
 * - A focus re-read only where it can change what is shown (`holdingMarketRefetchOnFocus`).
 */
export function holdingMarketQueryOptions(marketId: string) {
  return {
    ...marketQueryOptions(marketId),
    refetchInterval: false as const,
    refetchOnWindowFocus: holdingMarketRefetchOnFocus,
  };
}

/**
 * Whether a held market's row is read again when the window regains focus (ADR-0142 결정 2-22):
 * when there is no row or its read failed, and when it is 거래 마감 or 잠정 결과 — the two statuses
 * whose label moves with time alone ('판정 지연' `readsJudgementDelayed`, '이의 검토 중'
 * `readsDisputeUnderReview`). Any other row's price, time, trade count and status key come with the
 * `GET /me/positions` that focus re-reads anyway, and `markToLiveMarket` takes the later of the two
 * (by trade count and status key), so the money figures are as fresh as before. Still subject to
 * `staleTime`, as every focus re-read.
 */
export function holdingMarketRefetchOnFocus(query: {
  state: { data: Market | undefined; status: string };
}): boolean {
  const { data, status } = query.state;
  if (data === undefined || status === 'error') return true;
  return data.status === 'closed' || data.status === 'provisional';
}

/**
 * The detail's 5-minute re-read of an open market's row (ADR-0139 결정 2-3): `lastPrice24hAgo`
 * moves with time and no event carries it. A fixed timer, NOT a `refetchInterval`: query-core
 * re-arms an observer's interval on every write to its query (`onQueryUpdate` →
 * `#updateTimers`), so a `market:tick` landing more often than every five minutes pushed the
 * read back forever and the badge kept its first baseline (#64 review).
 *
 * Only the ACTIVE entry is asked — the detail's own observer — and a hidden tab reads nothing,
 * as `refetchIntervalInBackground: false` did. A read already in flight is joined, not
 * cancelled. Answers the cleanup.
 */
export function scheduleMarketBaselineRefresh(
  queryClient: QueryClient,
  marketId: string,
): () => void {
  const queryKey = marketQueryOptions(marketId).queryKey;
  const timer = setInterval(() => {
    if (!focusManager.isFocused()) return;
    void queryClient.refetchQueries(
      { queryKey, exact: true, type: 'active' },
      { cancelRefetch: false },
    );
  }, LIVE_REFRESH_MS);
  return () => clearInterval(timer);
}

/** `scheduleMarketBaselineRefresh` while `open` (거래 중): keyed on the flag, not the row. */
export function useMarketBaselineRefresh(marketId: string, open: boolean): void {
  const queryClient = useQueryClient();
  useEffect(
    () => (open ? scheduleMarketBaselineRefresh(queryClient, marketId) : undefined),
    [queryClient, marketId, open],
  );
}

/**
 * The probability chart's series (a `PriceSeries`, not a bare point array — the window and the
 * stride the server chose are what a live tick is merged against). Thin on purpose: `ticks.ts`
 * owns the key, the window and the resolution, and the detail page seeds the default range under
 * that same key, so the first paint draws without a request.
 */
export function useMarketTicks(marketId: string, range: TickRange = DEFAULT_TICK_RANGE) {
  return useQuery(ticksQueryOptions(marketId, range));
}

/**
 * Newest 20 fills, anonymous (`GET /markets/:id/fills`). No cursor and no `meta`, so there is no
 * 더 보기 — the route answers one page by design.
 *
 * It delegates to the declaration the admin detail already uses rather than repeating it: the key
 * is SHARED between the two screens, and two declarations of one key mean two query functions, of
 * which whichever observer mounts last owns the fetch (the reason `useLinkedAccounts` lives in
 * use-me.ts). `enabled` defaults to true because a market that reached a public route is public
 * — a draft or one in review is NOT_FOUND there (ADR-0093 decision 1, item 12) — while the admin
 * caller still gates its own (`isPublicMarketStatus`).
 */
export function usePublicMarketFills(marketId: string, enabled = true) {
  return useMarketFillsQuery(marketId, enabled);
}

/**
 * The shorter name the market components may import; both resolve to the one declaration above,
 * and it is spelled like the admin hook because it is the admin hook.
 */
export { usePublicMarketFills as useMarketFills };

/**
 * One market's public book (`GET /markets/:id/book`, #179, ADR-0114), the detail's 호가창 (#122,
 * ADR-0138) and the order panel's (#66), keyed and requested by the canonical lower-cased uuid:
 * the `market:book` signal names the row's own id, and the realtime provider restarts this key
 * on it, on `market:status` and on a resnapshot. One declaration of the key, so one queryFn.
 *
 * Not seeded on the server: the book is read in the browser, at hydration, and the window
 * before the tab joins the market's room is the one the provider accepts for ticks and statuses
 * (ADR-0138). The default `staleTime` keeps a focus re-read behind that.
 *
 * Read again on every mount, fresh or not: a tab that left the detail left the market's room, so
 * a `market:book`·`market:status` sent while it was away never reached this key, and a return
 * inside the `staleTime` would otherwise draw the book from before it left — under a status the
 * server has seeded anew (ADR-0138 decision 2-1). A first mount has no data to keep, so only a
 * return costs one more GET.
 */
export function orderBookQueryOptions(marketId: string) {
  const id = marketId.toLowerCase();
  return {
    queryKey: marketBookKey(id),
    queryFn: async (): Promise<OrderBook> =>
      unwrap(await api.GET('/api/v1/markets/{id}/book', { params: { path: { id } } })).data,
    refetchOnMount: 'always' as const,
  };
}

export function useOrderBook(marketId: string) {
  return useQuery(orderBookQueryOptions(marketId));
}

/**
 * Active categories in display order (`GET /categories`) for the header's category row, the
 * home headline and the sub-category sidebar. Public, and
 * re-exported for the same reason the fills are delegated: `CATEGORIES_QUERY_KEY` is one key, so
 * it deserves one query function.
 */
export { useCategories } from './use-admin-markets';
