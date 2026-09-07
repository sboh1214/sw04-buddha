import { marketListQuerySchema, marketSortSchema, publicMarketStatusSchema } from '@buddha/shared';
import { type QueryClient } from '@tanstack/react-query';
import { type Market, type PriceSeries } from './api';
import { DEFAULT_MARKET_FILTERS, type MarketFilters, marketKey, ticksKey } from './market-keys';
import { DEFAULT_TICK_RANGE } from './ticks';

/**
 * The seeding and normalising half of the SSR path, kept out of the pages so it can be tested:
 * a server component cannot be executed in this app's test runner (vitest runs with
 * `environment: 'node'`), so every decision the pages make lives here as a pure function.
 */

/**
 * Puts the detail row and its price series into the per-request cache under the keys the client
 * screens read, ready for `dehydratePublic` to carry them into the HTML.
 *
 * Seeded rather than prefetched: the page already holds the row (it had to branch on 404 before
 * rendering anything) and the series was fetched to be drawn, so a `prefetchQuery` would repeat
 * both requests. A query built by `setQueryData` has status 'success', which is exactly what
 * `defaultShouldDehydrateQuery` keeps.
 *
 * The market key is always the row's canonical uuid, never the slug the URL carried (A-M3-29):
 * `market:tick`, `TradeResult.market.id` and the ticks/fills routes all speak uuids, so a cache
 * keyed on the slug would never be written to by the live path.
 */
export function seedMarketDetail(
  queryClient: QueryClient,
  market: Market,
  series: PriceSeries,
): void {
  queryClient.setQueryData(marketKey(market.id), market);
  queryClient.setQueryData(ticksKey(market.id, DEFAULT_TICK_RANGE), series);
}

/**
 * The home page's raw `searchParams`. Every value is `string | string[]` because a repeated
 * param arrives as an array (the idiom at settings/page.tsx:20-24).
 */
export interface MarketSearchParams {
  status?: string | string[];
  sort?: string | string[];
  category?: string | string[];
  q?: string | string[];
}

/** A repeated param arrives as an array; the first value is the one the filter UI wrote. */
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `category` and `q` are normalised by the API's own query schema, never by a local copy. */
const { category: categoryParam, q: qParam } = marketListQuerySchema.shape;

/**
 * Normalises the URL into the filter object that IS the list's cache key, once, on the server;
 * the client receives it as a prop and never re-derives it. Two independent derivations would
 * be one default away from a second cache entry, which reads as a list that fetches itself
 * again the moment it hydrates.
 *
 * Nothing here throws: a hand-typed `?status=draft` or `?sort=price` falls back to the default
 * rather than 500-ing a public page. A blank or over-long `category`/`q` is dropped instead of
 * being sent — the API's schema refuses both, and an omitted field hashes identically to one
 * set to `undefined` (`hashKey` stringifies, and `JSON.stringify` drops undefined values), so
 * `?q=` and no `q` at all share one cache entry.
 */
export function filtersFromSearchParams(searchParams: MarketSearchParams): MarketFilters {
  const status = publicMarketStatusSchema.safeParse(firstValue(searchParams.status));
  const sort = marketSortSchema.safeParse(firstValue(searchParams.sort));
  const category = categoryParam.safeParse(firstValue(searchParams.category));
  const q = qParam.safeParse(firstValue(searchParams.q));
  return {
    status: status.success ? status.data : DEFAULT_MARKET_FILTERS.status,
    sort: sort.success ? sort.data : DEFAULT_MARKET_FILTERS.sort,
    ...(category.success && category.data !== undefined ? { category: category.data } : {}),
    ...(q.success && q.data !== undefined ? { q: q.data } : {}),
  };
}
