'use client';

import {
  type QueryClient,
  focusManager,
  hashKey,
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { MARKET_IDS_MAX } from '@buddha/shared';
import { useEffect } from 'react';
import { type Market, type OrderBook, api, unwrap } from '@/lib/api';
import { settlementPollInterval } from '@/lib/market-admin';
import {
  type MarketFilters,
  type MarketSearch,
  holdingMarketsKey,
  marketBookKey,
  marketKey,
  marketSearchKey,
  marketsKey,
  publicListQuery,
  relatedMarketsKey,
  relatedMarketsQuery,
  searchListQuery,
} from '@/lib/market-keys';
import {
  type MarketPage,
  type MarketPages,
  chunkIds,
  forgetHoldingReads,
  holdingChunkStaleTime,
  noteHoldingRead,
} from '@/lib/market-live';
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
 * The held market ids as MY reads them (#300, ADR-0147): lower-cased, distinct, sorted, in
 * chunks of `MARKET_IDS_MAX` — one `holdingMarketsKey` entry, and one request, per chunk. Sorted
 * so the order the groups are drawn in (the latest change first) never makes a new entry.
 */
export function holdingMarketChunks(marketIds: readonly string[]): string[][] {
  const ids = [...new Set(marketIds.map((id) => id.toLowerCase()))].sort();
  return chunkIds(ids, MARKET_IDS_MAX);
}

/**
 * MY's holdings' market rows (`useHoldings`, #300, ADR-0147): `GET /markets?ids=` for one chunk
 * (`holdingMarketChunks`), kept as the one page of a card list (`MarketPages`, nextCursor null)
 * under `holdingMarketsKey` — up to 50 held markets in one request, where #67 read one
 * `GET /markets/:idOrSlug` each (ADR-0142 결정 2-22's options, now on the chunk):
 *
 * - The rows are `MarketSummary`, never the detail's `Market`: a holding reads price, time, trade
 *   count, status, status key and the two display flags, all of which the summary carries, and
 *   the detail's entry (`['market', id]`, seeded by its server render) is no longer MY's.
 * - No poll. MY draws no payout-delay record; settlement reaches the holder as `user:position`.
 * - A focus re-read only where it can change what is shown (`holdingMarketsRefetchOnFocus`).
 * - `market:status`, the first-read race and a bought-back market re-read it through the
 *   provider (`holdingMarketsHolding`); a reconnect through `MARKETS_KEY`'s resnapshot.
 */
export function holdingMarketsQueryOptions(
  marketIds: readonly string[],
  seed?: () => MarketPages | undefined,
) {
  return {
    queryKey: holdingMarketsKey(marketIds),
    queryFn: async ({
      queryKey,
      signal,
    }: {
      queryKey: readonly unknown[];
      signal?: AbortSignal;
    }): Promise<MarketPages> => {
      const hash = hashKey(queryKey);
      try {
        const { data } = unwrap(
          await api.GET('/api/v1/markets', { params: { query: { ids: [...marketIds] } }, signal }),
        );
        // Only an answer the cache takes stands as the chunk's read: a cancelled one (a restart,
        // a resnapshot) would mark it fresh after a newer reason to read it (codex review).
        if (signal?.aborted !== true) noteHoldingRead(hash, Date.now());
        return { pages: [{ items: data, nextCursor: null }], pageParams: [undefined] };
      } catch (error) {
        // A failed read is a reason to read again, which a neighbour's tick must not clear; a
        // cancelled one is not this chunk's answer either way.
        if (signal?.aborted !== true) forgetHoldingReads(hash);
        throw error;
      }
    },
    // Fresh by the chunk's own last answer, never by `dataUpdatedAt`, which every card write of a
    // neighbour restamps (`holdingReads`, market-live.ts).
    staleTime: holdingChunkStaleTime,
    // A new set of held markets is a new key and a new observer: it starts from the rows the
    // cached chunks hold (`seedHoldingChunk`), so a holding whose market was already read keeps
    // its live price and flags until the answer. Not a read: the chunk's own read is still owed.
    ...(seed === undefined ? {} : { initialData: seed }),
    refetchInterval: false as const,
    refetchOnWindowFocus: holdingMarketsRefetchOnFocus,
  };
}

/**
 * Whether a chunk of held markets is read again when the window regains focus (ADR-0142 결정
 * 2-22, per chunk since #300): when it has no rows or its read failed, and when any of its markets
 * is 거래 마감 or 잠정 결과 — the two statuses whose label moves with time alone ('판정 지연'
 * `readsJudgementDelayed`, '이의 검토 중' `readsDisputeUnderReview`). Any other row's price, time,
 * trade count and status key come with the `GET /me/positions` that focus re-reads anyway, and
 * `markToLiveMarket` takes the later of the two. One request for the chunk however many of its
 * markets are closed. Still subject to `staleTime` — the chunk's own (`holdingChunkStaleTime`).
 */
export function holdingMarketsRefetchOnFocus(query: {
  state: { data: MarketPages | undefined; status: string; fetchFailureCount: number };
}): boolean {
  const { data, status, fetchFailureCount } = query.state;
  // A failure a neighbour's tick has since written over (`status` back to success) still counts:
  // a manual write keeps `fetchFailureCount`, which only a read's own start resets.
  if (data === undefined || status === 'error' || fetchFailureCount > 0) return true;
  return data.pages.some((page) =>
    page.items.some((market) => market.status === 'closed' || market.status === 'provisional'),
  );
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
