import { type MarketTickEvent } from '@buddha/shared';
import { InfiniteQueryObserver, type QueryClient, hashKey, hydrate } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { type Market, type MarketListItem, type MarketSummary } from '@/lib/api';
import {
  DEFAULT_MARKET_FILTERS,
  MARKETS_KEY,
  type MarketFilters,
  dehydratePublic,
  marketKey,
  marketsKey,
} from '@/lib/market-keys';
import { type MarketPage, type MarketPages, applyTick, applyToPages } from '@/lib/market-live';
import { getQueryClient } from '@/lib/query-client';
import { marketQueryOptions, marketsInfiniteQueryOptions } from './use-markets';

/**
 * The market hooks' decisions, driven through a real QueryClient. Nothing renders — this app's
 * vitest runs under `environment: 'node'`, which is exactly why the option factories are exported
 * apart from the hooks: the key, the page param and the page shape ARE the decisions, and all
 * three are reachable without React.
 *
 * `getQueryClient()` answers a FRESH client on every call here (`isServer` is true with no
 * `window`), so each test gets its own cache AND the `structuralSharing` defaults the app really
 * ships (query-client.ts) rather than a copy of them.
 */

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';
const THIRD_ID = 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46';

const summary: MarketSummary = {
  id: ID,
  slug: 'rate-cut-2026',
  title: '기준금리 인하?',
  category: { slug: 'economy', nameKo: '경제' },
  imageUrl: null,
  status: 'open',
  lastPrice: 50,
  pYesBp: 5000,
  volumeP: '120000',
  tradeCount: 10,
  traderCount: 4,
  closeAt: '2026-10-01T00:00:00.000Z',
  openAt: '2026-09-01T00:00:00.000Z',
  resolvedResult: null,
  createdAt: '2026-08-30T00:00:00.000Z',
};

const card: MarketListItem = { ...summary, sparkline: [4800, 4900, 5000] };
const otherCard: MarketListItem = { ...card, id: OTHER_ID, slug: 'other', sparkline: [] };

const detail: Market = {
  ...summary,
  description: null,
  rules: '한국은행 발표 기준.',
  resolutionSource: null,
  resolvedAt: null,
  disputeUntil: null,
  settledAt: null,
  voidedAt: null,
};

const tick = (patch: Partial<MarketTickEvent> = {}): MarketTickEvent => ({
  type: 'market:tick',
  marketId: ID,
  pYesBp: 6300,
  lastPrice: 63,
  volumeP: '130000',
  tradeCount: 11,
  ts: '2026-09-07T00:00:00.000Z',
  ...patch,
});

/** The infinite shape the hook holds: the last page ends the list, the first has no cursor. */
const pagesOf = (...pages: MarketListItem[][]): MarketPages => ({
  pages: pages.map((items, index) => ({
    items,
    nextCursor: index === pages.length - 1 ? null : `cursor-${String(index)}`,
  })),
  pageParams: [undefined, ...pages.slice(1).map((_page, index) => `cursor-${String(index)}`)],
});

/**
 * The list as a mounted screen holds it: an observer over the hook's OWN options, so the entry
 * under test is the entry the hook would read. Its queryFn counts and answers an empty page, so
 * any refetch these tests do not expect both shows up in the count and erases what they assert on.
 */
function listObserver(queryClient: QueryClient, filters: MarketFilters, onFetch: () => void) {
  return new InfiniteQueryObserver<
    MarketPage,
    Error,
    MarketPages,
    readonly unknown[],
    string | undefined
  >(queryClient, {
    ...marketsInfiniteQueryOptions(filters),
    queryFn: () => {
      onFetch();
      return Promise.resolve({ items: [], nextCursor: null });
    },
    retry: false,
  });
}

describe('marketsInfiniteQueryOptions', () => {
  it('keys the list on the filter object, whatever order its fields were written in', () => {
    const filters: MarketFilters = { status: 'open', sort: 'volume', category: 'economy' };
    expect(marketsInfiniteQueryOptions(filters).queryKey).toEqual(marketsKey(filters));

    // `hashKey` sorts a plain object's keys and `JSON.stringify` drops undefined-valued
    // properties, so field order is irrelevant and `?category=` normalised away hashes like an
    // absent one. This is what lets the server's seed and the client's hook meet on one entry
    // without either side agreeing on how to spell the object.
    const reordered: MarketFilters = { sort: 'volume', category: 'economy', status: 'open' };
    expect(hashKey(marketsInfiniteQueryOptions(reordered).queryKey)).toBe(
      hashKey(marketsInfiniteQueryOptions(filters).queryKey),
    );
    const explicitUndefined: MarketFilters = {
      status: 'open',
      sort: 'volume',
      category: undefined,
    };
    expect(hashKey(marketsInfiniteQueryOptions(explicitUndefined).queryKey)).toBe(
      hashKey(marketsInfiniteQueryOptions(DEFAULT_MARKET_FILTERS).queryKey),
    );
  });

  it('asks for the first page with no cursor and ends the list on a null one', () => {
    const options = marketsInfiniteQueryOptions(DEFAULT_MARKET_FILTERS);

    // The page param the SSR payload was dehydrated with is `undefined`; any literal here would
    // name a different first page, and the hydrated pages would be refetched on mount.
    expect(options.initialPageParam).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: 'cursor-0' })).toBe('cursor-0');
    // The wire says `null` for the last page while the page param is `string | undefined`, so the
    // null is mapped rather than passed through — it would otherwise reach `queryFn` as a cursor.
    expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
  });
});

describe('the SSR-seeded list', () => {
  it('hands the hook the dehydrated pages without a single request', async () => {
    // The home server component's half: one page fetched with the server client, prefetched as an
    // INFINITE query (so `pageParams` and the query type ride along), then dehydrated into the
    // HTML. AC 2 is this test plus the page: first paint carries the current 확률.
    const serverClient = getQueryClient();
    await serverClient.prefetchInfiniteQuery({
      queryKey: marketsKey(DEFAULT_MARKET_FILTERS),
      queryFn: (): Promise<MarketPage> =>
        Promise.resolve({ items: [card, otherCard], nextCursor: 'cursor-0' }),
      initialPageParam: undefined as string | undefined,
    });
    const queryClient = getQueryClient();
    hydrate(queryClient, dehydratePublic(serverClient));

    let fetches = 0;
    const observer = listObserver(queryClient, DEFAULT_MARKET_FILTERS, () => {
      fetches += 1;
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      const result = observer.getCurrentResult();
      expect(result.data?.pages).toHaveLength(1);
      expect(result.data?.pages[0]?.items[0]?.id).toBe(ID);
      expect(result.data?.pages[0]?.items[0]?.sparkline).toEqual(card.sparkline);
      // The seeded page carries a cursor, so 더 보기 is offered from the first paint.
      expect(result.hasNextPage).toBe(true);
      // The whole point of hydrating rather than passing `initialData`: no request on mount.
      expect(fetches).toBe(0);
    } finally {
      unsubscribe();
      queryClient.clear();
      serverClient.clear();
    }
  });
});

describe('the live list', () => {
  it('patches every filter that holds the market, and no observer refetches', () => {
    const byNewest: MarketFilters = { ...DEFAULT_MARKET_FILTERS, sort: 'newest' };
    const queryClient = getQueryClient();
    queryClient.setQueryData<MarketPages>(
      marketsKey(DEFAULT_MARKET_FILTERS),
      pagesOf([card], [otherCard]),
    );
    queryClient.setQueryData<MarketPages>(marketsKey(byNewest), pagesOf([otherCard], [card]));

    let fetches = 0;
    const count = () => {
      fetches += 1;
    };
    const byVolume = listObserver(queryClient, DEFAULT_MARKET_FILTERS, count);
    const newest = listObserver(queryClient, byNewest, count);
    const stop = [byVolume.subscribe(() => undefined), newest.subscribe(() => undefined)];
    try {
      queryClient.setQueriesData<MarketPages>({ queryKey: MARKETS_KEY }, (held) =>
        applyToPages(held, (row) => applyTick(row, tick())),
      );

      expect(byVolume.getCurrentResult().data?.pages[0]?.items[0]?.pYesBp).toBe(6300);
      // The same market sits on the SECOND page under the other sort, so one `setQueriesData`
      // over the shared root has to reach every page of every filter — not one query per card.
      expect(newest.getCurrentResult().data?.pages[1]?.items[0]?.pYesBp).toBe(6300);
      expect(newest.getCurrentResult().data?.pages[0]?.items[0]?.pYesBp).toBe(summary.pYesBp);
      // PLAN 11.5: an event must never become a request.
      expect(fetches).toBe(0);
    } finally {
      for (const unsubscribe of stop) unsubscribe();
      queryClient.clear();
    }
  });

  it('writes nothing at all when no cached page holds the market', () => {
    // `applyToPages` answers `undefined`, `setQueryData` returns early on it, and the observer is
    // never notified: a tick for a market the visitor is not looking at costs nothing, and — the
    // part that matters — does not restart `staleTime` on a list it did not change.
    const queryClient = getQueryClient();
    const key = marketsKey(DEFAULT_MARKET_FILTERS);
    queryClient.setQueryData<MarketPages>(key, pagesOf([card], [otherCard]));
    const held = queryClient.getQueryData<MarketPages>(key);
    const updatedAt = queryClient.getQueryState(key)?.dataUpdatedAt;

    let fetches = 0;
    const observer = listObserver(queryClient, DEFAULT_MARKET_FILTERS, () => {
      fetches += 1;
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      queryClient.setQueriesData<MarketPages>({ queryKey: MARKETS_KEY }, (pages) =>
        applyToPages(pages, (row) => applyTick(row, tick({ marketId: THIRD_ID }))),
      );

      expect(queryClient.getQueryData<MarketPages>(key)).toBe(held);
      expect(queryClient.getQueryState(key)?.dataUpdatedAt).toBe(updatedAt);
      expect(observer.getCurrentResult().data?.pages[0]?.items[0]?.pYesBp).toBe(summary.pYesBp);
      expect(fetches).toBe(0);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });
});

describe('marketQueryOptions', () => {
  it('lands a market opened from an upper-case uuid on the entry the live path writes', () => {
    // A uuid is accepted in either case and answered in lower, and `market:tick` names its market
    // by the row's own id. A screen keyed on the segment as typed would therefore hold a row that
    // no event, trade answer or invalidation ever reaches (A-M3-29).
    const routeId = ID.toUpperCase();
    expect(marketQueryOptions(routeId).queryKey).toEqual(marketKey(ID));

    const queryClient = getQueryClient();
    queryClient.setQueryData<Market>(marketQueryOptions(routeId).queryKey, detail);

    queryClient.setQueryData<Market>(marketKey(detail.id), (row) => applyTick(row, tick()));

    const shown = queryClient.getQueryData<Market>(marketQueryOptions(routeId).queryKey);
    expect(shown?.pYesBp).toBe(6300);
    expect(shown?.lastPrice).toBe(63);
    queryClient.clear();
  });
});
