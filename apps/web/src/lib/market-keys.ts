import { type QueryClient, defaultShouldDehydrateQuery, dehydrate } from '@tanstack/react-query';
// `import type`, not the inline `{ type X }` this app usually writes: under verbatimModuleSyntax
// an inline type import still emits `import {}` from the module, and `./ticks` imports `ticksKey`
// back from here — an erased import keeps that a type-level cycle instead of a runtime one, and
// keeps a server component that only wanted a cache key from loading the browser API client.
import type { MarketSort, PublicMarketStatus } from '@buddha/shared';
import type { TickRange } from './ticks';

/**
 * Every market-related query key, in a module with NO `'use client'` directive.
 *
 * The server components seed the cache and the client hooks read it back under the same
 * strings, so both sides have to share one definition — and a server component cannot take it
 * from a hook module: every export of a `'use client'` module is a client reference, which
 * throws when it is called during the server render. Hence a directive-free lib module.
 * `hooks/use-admin-markets.ts` re-exports the two keys the admin screens already import from
 * it, so no admin import site moves. Key shapes follow PLAN 11.5.
 */

/**
 * The key roots. `['markets']` and `['market']` never match each other: react-query compares
 * keys element-wise (`partialMatchKey`), so the list and the detail can carry different
 * `structuralSharing` defaults without one registration swallowing the other.
 */
export const MARKETS_KEY = ['markets'] as const;
export const MARKET_KEY = ['market'] as const;
export const TICKS_KEY = ['ticks'] as const;
export const MARKET_FILLS_KEY = ['market-fills'] as const;
/** `_QUERY_KEY` rather than `_KEY` because the admin screens already import it under that name. */
export const CATEGORIES_QUERY_KEY = ['categories'] as const;
/**
 * Session-scoped, so never SSR'd (`PRIVATE_QUERY_ROOTS` below). They are declared here anyway
 * because the realtime provider refreshes them beside the market keys (`user:position`).
 */
export const POSITIONS_KEY = ['positions'] as const;
export const ORDERS_KEY = ['orders'] as const;

/**
 * The public list's filter set, which IS its cache key. Normalised once, on the server
 * (`filtersFromSearchParams`), and handed to the client as a prop: two independent derivations
 * of the same `searchParams` would be one default away from a second cache entry, and the
 * second entry would refetch what the SSR payload already carries.
 */
export interface MarketFilters {
  status: PublicMarketStatus;
  sort: MarketSort;
  category?: string;
  q?: string;
}

export const DEFAULT_MARKET_FILTERS: MarketFilters = { status: 'open', sort: 'volume' };

/**
 * `hashKey` sorts a plain object's keys and `JSON.stringify` drops undefined-valued properties
 * (query-core `utils.ts`), so field order here is irrelevant and an absent `category` hashes
 * identically to `category: undefined`. The filters travel as one object rather than as
 * positional segments so a new filter cannot silently reorder every existing key.
 */
export const marketsKey = (filters: MarketFilters) => [...MARKETS_KEY, filters] as const;

/**
 * The detail key, always on the row's canonical lower-cased uuid and never on the slug
 * (A-M3-29).
 *
 * `uuidSchema` lower-cases every request-supplied uuid, so the API answers with the row's own
 * lower-case id. A screen keyed on the URL segment as typed would hold a row whose `market.id`
 * names a different key, and every write that goes through that id — a `market:tick`, an
 * invalidation — would land on a key nothing on the screen reads. The slug is worse still: the
 * ticks and fills routes both speak uuids, so a slug-keyed entry would never be written to by
 * the live path at all.
 */
export const marketKey = (marketId: string) => [...MARKET_KEY, marketId.toLowerCase()] as const;

/**
 * `range` is a token ('1D'), never a timestamp: a refetch under the same key reads a fresh
 * window from the server, which is what keeps the chart's right edge live.
 */
export const ticksKey = (marketId: string, range: TickRange) =>
  [...TICKS_KEY, marketId, range] as const;

export const marketFillsKey = (marketId: string) => [...MARKET_FILLS_KEY, marketId] as const;

/**
 * Key roots that need the session cookie. They are never fetched on the server (`api.server.ts`
 * forwards no cookie), and this is the second lock: `dehydrate` serialises the WHOLE
 * per-request client (`getQueryCache().getAll()`), so a `['me']` that got in would ride the RSC
 * payload into the HTML and refill exactly the cache the session guard exists to empty — with
 * no ordering key on `Balance` to tell that stale payload from a fresh client answer.
 */
export const PRIVATE_QUERY_ROOTS: ReadonlySet<string> = new Set([
  'me',
  'positions',
  'orders',
  'ledger',
  'payments',
  'charge-packages',
  'admin',
]);

export function isPrivateQueryKey(queryKey: readonly unknown[]): boolean {
  const [root] = queryKey;
  return typeof root === 'string' && PRIVATE_QUERY_ROOTS.has(root);
}

/** `dehydrate` for an SSR page: successful PUBLIC queries only. */
export function dehydratePublic(queryClient: QueryClient) {
  return dehydrate(queryClient, {
    shouldDehydrateQuery: (query) =>
      defaultShouldDehydrateQuery(query) && !isPrivateQueryKey(query.queryKey),
  });
}
