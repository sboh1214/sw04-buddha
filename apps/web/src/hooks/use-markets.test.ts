import { type MarketStatusEvent, type MarketTickEvent } from '@buddha/shared';
import {
  InfiniteQueryObserver,
  type QueryClient,
  QueryObserver,
  hashKey,
  hydrate,
} from '@tanstack/react-query';
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
import {
  type MarketPage,
  type MarketPages,
  Throttle,
  applyStatus,
  applyTick,
  applyToPages,
  tickRestartsMarket,
} from '@/lib/market-live';
import { getQueryClient, restartQueries } from '@/lib/query-client';
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
  volumeCoin: '120000',
  tradeCount: 10,
  traderCount: 4,
  closeAt: '2026-10-01T00:00:00.000Z',
  openAt: '2026-09-01T00:00:00.000Z',
  resolvedResult: null,
  // The `opened` event: the key `applyStatus` and `joinMarket` order the status by (M5).
  statusEventId: '2',
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
  settledAt: null,
  voidedAt: null,
};

const tick = (patch: Partial<MarketTickEvent> = {}): MarketTickEvent => ({
  type: 'market:tick',
  marketId: ID,
  lastPrice: 63,
  volumeCoin: '130000',
  tradeCount: 11,
  traderCount: 5,
  ts: '2026-09-07T00:00:00.000Z',
  ...patch,
});

/** A close, the transition that publishes no `user:position` and so has no second delivery. */
const statusEvent = (patch: Partial<MarketStatusEvent> = {}): MarketStatusEvent => ({
  type: 'market:status',
  marketId: ID,
  status: 'closed',
  resolvedResult: null,
  // One transition after the `opened` the fixture holds, so the event is newer by key.
  statusEventId: '3',
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

      expect(byVolume.getCurrentResult().data?.pages[0]?.items[0]?.lastPrice).toBe(63);
      // The same market sits on the SECOND page under the other sort, so one `setQueriesData`
      // over the shared root has to reach every page of every filter — not one query per card.
      expect(newest.getCurrentResult().data?.pages[1]?.items[0]?.lastPrice).toBe(63);
      expect(newest.getCurrentResult().data?.pages[0]?.items[0]?.lastPrice).toBe(summary.lastPrice);
      // PLAN 11.5: an event must never become a request.
      expect(fetches).toBe(0);
    } finally {
      for (const unsubscribe of stop) unsubscribe();
      queryClient.clear();
    }
  });

  it("moves a card's numbers and never its rank, which belongs to the fetch", () => {
    // A DELIBERATE refusal, pinned so it is not "fixed" back. `sort=volume` is keyset-paginated
    // on `(volume_coin DESC, id DESC)` (market.service.ts), so the order is the answer's: a tick
    // that overtakes the row above leaves the two cards in the order the server sent them, the
    // same way a market that closes stays in a `status=open` list until the next answer. The
    // alternatives were measured and are worse — invalidating costs one request per cached page
    // per tick and starves under a burst (each invalidation cancels the chain the last one
    // started), and a local re-sort can only order the keyset prefix this tab happens to hold,
    // which is neither the server's order nor a correct global one.
    const queryClient = getQueryClient();
    const leader = { ...card, id: THIRD_ID, slug: 'leader', volumeCoin: '900000', lastPrice: 40 };
    const key = marketsKey(DEFAULT_MARKET_FILTERS);
    queryClient.setQueryData<MarketPages>(key, pagesOf([leader, card]));

    let fetches = 0;
    const observer = listObserver(queryClient, DEFAULT_MARKET_FILTERS, () => {
      fetches += 1;
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      // The trailing card's volume overtakes the leader's.
      queryClient.setQueriesData<MarketPages>({ queryKey: MARKETS_KEY }, (held) =>
        applyToPages(held, (row) => applyTick(row, tick({ volumeCoin: '999999' }))),
      );

      const items = observer.getCurrentResult().data?.pages[0]?.items;
      // The number moved…
      expect(items?.[1]?.volumeCoin).toBe('999999');
      // …and the position did not.
      expect(items?.map((row) => row.id)).toEqual([THIRD_ID, ID]);
      // No request, and no invalidation waiting to become one.
      expect(fetches).toBe(0);
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    } finally {
      unsubscribe();
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
      expect(observer.getCurrentResult().data?.pages[0]?.items[0]?.lastPrice).toBe(
        summary.lastPrice,
      );
      expect(fetches).toBe(0);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });
});

/**
 * The `market:tick` handler's market-row half, wired exactly as realtime-provider.tsx wires it:
 * the query's state read BEFORE the write, the REAL `tickRestartsMarket` gate, and the socket's
 * own throttle. Only the composition is restated here; every rule it applies is the export's.
 */
function onTick(queryClient: QueryClient, event: MarketTickEvent, restart = new Throttle(1_000)) {
  const row = queryClient
    .getQueryCache()
    .find<Market>({ queryKey: marketKey(event.marketId), exact: true });
  queryClient.setQueryData<Market>(marketKey(event.marketId), (held) => applyTick(held, event));
  if (tickRestartsMarket(row?.state, restart, event.marketId, Date.now())) {
    void restartQueries(queryClient, marketKey(event.marketId));
  }
}

describe('a tick that arrives during an unseeded first fetch', () => {
  it('re-asks for the market, because the answer on the wire left before the trade', async () => {
    // THE HAZARD: /portfolio opens one `['market', id]` per held market (`useQueries`) and joins
    // every room, and NOTHING seeds those entries — only the detail page is seeded. `applyTick`
    // answers `undefined` for a cache with no row, so the event was dropped; the first request,
    // whose snapshot predates the trade, then landed with the old price and stood. `staleTime`
    // is 30s and the next tick on a quiet market may be an hour away, so 현재가, 평가 금액 and
    // 총 평가 금액 were all marked to a price the market had already left.
    const queryClient = getQueryClient();
    let fetches = 0;
    const observer = new QueryObserver<Market>(queryClient, {
      queryKey: marketKey(ID),
      // The first request left before the trade and knows nothing about it.
      queryFn: () =>
        Promise.resolve(
          (fetches += 1) === 1 ? detail : { ...detail, lastPrice: 63, tradeCount: 11 },
        ),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      onTick(queryClient, tick());
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(fetches).toBe(2);
      expect(queryClient.getQueryData<Market>(marketKey(ID))?.lastPrice).toBe(63);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it('restarts at most once a window, so a busy market cannot starve its own rescue', async () => {
    // Each restart CANCELS the request in flight. Without the throttle, a market trading faster
    // than one round trip would cancel every attempt before it landed and the row would never
    // arrive — the rescue eating itself, which is the same `cancelRefetch` starvation that made
    // invalidating the volume list on every tick worthless.
    const queryClient = getQueryClient();
    const restart = new Throttle(1_000);
    let fetches = 0;
    const observer = new QueryObserver<Market>(queryClient, {
      queryKey: marketKey(ID),
      queryFn: () =>
        new Promise((resolve) => {
          fetches += 1;
          // Slower than the burst, which is the whole point.
          setTimeout(() => resolve(detail), 50);
        }),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      for (let i = 0; i < 10; i += 1) onTick(queryClient, tick(), restart);
      await new Promise((resolve) => setTimeout(resolve, 120));

      // The mount's own fetch, plus exactly one restart for the whole burst.
      expect(fetches).toBe(2);
      expect(queryClient.getQueryData<Market>(marketKey(ID))).toBeDefined();
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it('leaves a market query that FAILED to its own retry rule', async () => {
    // An errored query holds no data either, and restarting it per tick would fight both the
    // retry rule (query-client.ts refuses to retry a 4xx) and the error UI the screen renders.
    // The hazard is an answer ON THE WIRE, so `fetchStatus` is the test, not `data` alone.
    const queryClient = getQueryClient();
    let fetches = 0;
    const observer = new QueryObserver<Market>(queryClient, {
      queryKey: marketKey(ID),
      queryFn: () => {
        fetches += 1;
        return Promise.reject(new Error('down'));
      },
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const failed = fetches;
      for (let i = 0; i < 5; i += 1) onTick(queryClient, tick());
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(fetches).toBe(failed);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it('does nothing for a market the tab keeps no entry for, which is every card on the home grid', () => {
    // The list joins every rendered card's room but keeps no `['market', id]` entry — the grid
    // reads `['markets', filters]`. Without the "exists" test, every tick on the home page would
    // run an invalidation against a key nothing holds.
    const queryClient = getQueryClient();
    try {
      onTick(queryClient, tick());

      expect(queryClient.getQueryCache().find({ queryKey: marketKey(ID) })).toBeUndefined();
    } finally {
      queryClient.clear();
    }
  });

  it('costs nothing once the row is cached, which is what keeps it from being 남발', () => {
    // `applyTick` answers `undefined` for TWO reasons — no row at all, and a row this event does
    // not supersede — and only the first may become a request. Restarting on the second would
    // buy one per duplicate or late tick, which is the 남발 PLAN 11.5 refuses.
    const queryClient = getQueryClient();
    queryClient.setQueryData<Market>(marketKey(ID), { ...detail, tradeCount: 99 });
    const updatedAt = queryClient.getQueryState(marketKey(ID))?.dataUpdatedAt;
    try {
      for (let i = 0; i < 10; i += 1) onTick(queryClient, tick());

      // Not invalidated, not rewritten: ten late ticks cost exactly nothing.
      expect(queryClient.getQueryState(marketKey(ID))?.isInvalidated).toBe(false);
      expect(queryClient.getQueryState(marketKey(ID))?.dataUpdatedAt).toBe(updatedAt);
      expect(queryClient.getQueryData<Market>(marketKey(ID))?.tradeCount).toBe(99);
    } finally {
      queryClient.clear();
    }
  });
});

/**
 * The `market:status` handler's market-row half, wired as realtime-provider.tsx wires it. No
 * gate: this refetch is sanctioned on every status event, so `restartQueries` only adds the
 * cancel a first fetch needs and is the plain invalidation on any other cache.
 */
function onStatus(queryClient: QueryClient, event: MarketStatusEvent) {
  queryClient.setQueryData<Market>(marketKey(event.marketId), (held) => applyStatus(held, event));
  void restartQueries(queryClient, marketKey(event.marketId));
}

describe('a status event that arrives during an unseeded first fetch', () => {
  it('re-asks, because the answer on the wire read the market before the transition', async () => {
    // THE HAZARD, and the more serious half of the pair the tick handler fixed. `applyStatus`
    // writes nothing into a cache with no row, and a bare invalidation hands back the request
    // already running — the one that read the market BEFORE the close. /portfolio's
    // `['market', id]` entries are unseeded (`useQueries`), so that pre-close snapshot landed as
    // fresh and the row went on saying `open` — which on screen is the MISSING 마감 badge, since
    // `OpenPositionRow` draws one only when `marketStatus !== 'open'`. A close publishes NO
    // `user:position`, so the positions row cannot correct it, the closed market publishes no
    // further tick, and the success dispatch cleared the invalidation flag: nothing was
    // scheduled to ask again.
    const queryClient = getQueryClient();
    let fetches = 0;
    const observer = new QueryObserver<Market>(queryClient, {
      queryKey: marketKey(ID),
      queryFn: () =>
        Promise.resolve((fetches += 1) === 1 ? detail : { ...detail, status: 'closed' as const }),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      onStatus(queryClient, statusEvent());
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(fetches).toBe(2);
      expect(queryClient.getQueryData<Market>(marketKey(ID))?.status).toBe('closed');
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it('still invalidates a market row it DID patch, which is the ordinary path', async () => {
    // The seeded detail screen: the reducer moved the badge, and the invalidation is what fills
    // in the price a transition does not carry. Restarting here would buy nothing.
    const queryClient = getQueryClient();
    let fetches = 0;
    const observer = new QueryObserver<Market>(queryClient, {
      queryKey: marketKey(ID),
      queryFn: () => {
        fetches += 1;
        return Promise.resolve({ ...detail, status: 'closed' as const });
      },
      retry: false,
    });
    queryClient.setQueryData<Market>(marketKey(ID), detail);
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const seeded = fetches;
      onStatus(queryClient, statusEvent());
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The reducer moved the badge synchronously, and exactly one refetch followed.
      expect(queryClient.getQueryData<Market>(marketKey(ID))?.status).toBe('closed');
      expect(fetches).toBe(seeded + 1);
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
    // no event or invalidation ever reaches (A-M3-29).
    const routeId = ID.toUpperCase();
    expect(marketQueryOptions(routeId).queryKey).toEqual(marketKey(ID));

    const queryClient = getQueryClient();
    queryClient.setQueryData<Market>(marketQueryOptions(routeId).queryKey, detail);

    queryClient.setQueryData<Market>(marketKey(detail.id), (row) => applyTick(row, tick()));

    const shown = queryClient.getQueryData<Market>(marketQueryOptions(routeId).queryKey);
    expect(shown?.lastPrice).toBe(63);
    queryClient.clear();
  });
});
