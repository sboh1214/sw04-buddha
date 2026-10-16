'use client';

import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { type Market, api, unwrap } from '@/lib/api';
import { type MarketFilters, marketKey, marketsKey } from '@/lib/market-keys';
import { type MarketPage } from '@/lib/market-live';
import { DEFAULT_TICK_RANGE, type TickRange, ticksQueryOptions } from '@/lib/ticks';
import { useMarketFills as useMarketFillsQuery } from './use-admin-markets';

/**
 * The public market screens' reads (PLAN 11.4-11.5): the home list, the detail row, its price
 * series and its fills.
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
 * keeps the cards that are on screen while the next filter or search term loads — the list is
 * both filtered and searched, so without it every keystroke would drop back to the skeleton
 * (admin-markets.tsx:59-77).
 */
export function marketsInfiniteQueryOptions(filters: MarketFilters) {
  return {
    queryKey: marketsKey(filters),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<MarketPage> => {
      // An absent `category`/`q` is omitted rather than sent empty: the API's query schema
      // refuses a blank one. Written the same way as the server twin, field for field.
      const { data, meta } = unwrap(
        await api.GET('/api/v1/markets', {
          params: {
            query: {
              status: filters.status,
              sort: filters.sort,
              ...(filters.category === undefined ? {} : { category: filters.category }),
              ...(filters.q === undefined ? {} : { q: filters.q }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
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
  };
}

export function useMarket(marketId: string) {
  return useQuery(marketQueryOptions(marketId));
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
 * use-me.ts). `enabled` defaults to true because a market that reached a public route has been
 * opened — a draft is NOT_FOUND there — while the admin caller still gates its own draft.
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
 * Active categories in display order (`GET /categories`) for the header's category row, the
 * home headline and the sub-category sidebar. Public, and
 * re-exported for the same reason the fills are delegated: `CATEGORIES_QUERY_KEY` is one key, so
 * it deserves one query function.
 */
export { useCategories } from './use-admin-markets';
