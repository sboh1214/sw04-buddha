import { MARKET_SORTS, type MarketStatusEvent, type MarketTickEvent } from '@buddha/shared';
import {
  InfiniteQueryObserver,
  type QueryClient,
  QueryObserver,
  focusManager,
  hashKey,
  hydrate,
  partialMatchKey,
} from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Market, type MarketSummary, api } from '@/lib/api';
import {
  DEFAULT_MARKET_FILTERS,
  DEFAULT_SEARCH_FILTERS,
  MARKETS_KEY,
  MARKET_KEY,
  type MarketFilters,
  type MarketSearch,
  dehydratePublic,
  holdingMarketsKey,
  marketBookKey,
  marketKey,
  marketSearchKey,
  marketsKey,
  relatedMarketsKey,
} from '@/lib/market-keys';
import {
  type MarketPage,
  type MarketPages,
  Throttle,
  applyStatus,
  applyTick,
  applyToPages,
  HOLDING_READ_FRESH_MS,
  afterHoldingFirstRead,
  forgetHoldingReads,
  holdingChunkStaleTime,
  holdingChunksToRead,
  holdingMarketsFirstReads,
  holdingMarketsHolding,
  holdingReadFresh,
  noteHoldingRead,
  sameChunk,
  seedHoldingChunk,
  tickRestartsMarket,
} from '@/lib/market-live';
import { prefetchRelatedMarkets } from '@/lib/market-ssr';
import { getQueryClient, restartQueries } from '@/lib/query-client';
import { handleMarketStats } from '@/lib/market-stats-event';
import { LIVE_REFRESH_MS } from '@/lib/ticks';
import { priceIsStale } from './use-portfolio';
import {
  holdingMarketChunks,
  holdingMarketsQueryOptions,
  holdingMarketsRefetchOnFocus,
  marketQueryOptions,
  marketSearchInfiniteQueryOptions,
  marketsInfiniteQueryOptions,
  orderBookQueryOptions,
  relatedMarketsInfiniteQueryOptions,
  scheduleMarketBaselineRefresh,
} from './use-markets';

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
  judgementDelayed: false,
  disputeUnderReview: false,
  lastPrice: 50,
  lastFillAt: '2026-09-07T00:00:00.000Z',
  volumeCoin: '120000',
  tradeCount: 10,
  traderCount: 4,
  statsRevision: '10',
  closeAt: '2026-10-01T00:00:00.000Z',
  openAt: '2026-09-01T00:00:00.000Z',
  scheduledOpenAt: '2026-09-01T00:00:00.000Z',
  resolvedResult: null,
  judgementVersion: null,
  disputeDeadline: null,
  disputeOpen: false,
  // The `opened` event: the key `applyStatus` and `joinMarket` order the status by (M5).
  statusEventId: '2',
  createdAt: '2026-08-30T00:00:00.000Z',
};

const card: MarketSummary = { ...summary };
const otherCard: MarketSummary = { ...card, id: OTHER_ID, slug: 'other' };

const detail: Market = {
  ...summary,
  lastPrice24hAgo: null,
  description: null,
  yesCondition: '한국은행 발표 기준.',
  noCondition: '',
  eventDeadline: null,
  primarySource: null,
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: null,
  delayHandling: '',
  // #22's times: none, as on a market opened before them.
  scheduledOpenAt: null,
  scheduledAnnouncementAt: null,
  scheduledJudgementAt: null,
  judgementTimeZone: null,
  resolvedAt: null,
  settledAt: null,
  tags: [],
  // No rule version (#80): not opened yet, or opened before #80 (D4).
  ruleVersion: null,
  judgingRecord: {
    versions: [],
    pauses: [],
    delays: [],
    disputes: { total: 0, byVersion: [], decisions: [] },
    cancellation: null,
    payoutDelayed: false,
    correction: null,
  },
  ruleVersions: [],
  // No 판정 지연 기록 (#142): not reading 판정 지연.
  judgementDelay: null,
};

const tick = (patch: Partial<MarketTickEvent> = {}): MarketTickEvent => ({
  type: 'market:tick',
  marketId: ID,
  lastPrice: 63,
  volumeCoin: '130000',
  tradeCount: 11,
  traderCount: 5,
  statsRevision: String(patch.tradeCount ?? 11),
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
const pagesOf = (...pages: MarketSummary[][]): MarketPages => ({
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
    const filters: MarketFilters = { sort: 'closing', category: 'economy' };
    expect(marketsInfiniteQueryOptions(filters).queryKey).toEqual(marketsKey(filters));

    // `hashKey` sorts a plain object's keys and `JSON.stringify` drops undefined-valued
    // properties, so field order is irrelevant and `?category=` normalised away hashes like an
    // absent one. This is what lets the server's seed and the client's hook meet on one entry
    // without either side agreeing on how to spell the object.
    const reordered: MarketFilters = { category: 'economy', sort: 'closing' };
    expect(hashKey(marketsInfiniteQueryOptions(reordered).queryKey)).toBe(
      hashKey(marketsInfiniteQueryOptions(filters).queryKey),
    );
    const explicitUndefined: MarketFilters = {
      sort: 'recommended',
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

/**
 * What a list's own queryFn sends to `GET /markets`. The API answers a request that lost its
 * order with 추천, its default, and one that lost its category with every category — a page
 * either way, the right select value and URL over the wrong cards — so the request itself is
 * what has to be pinned, per order. `api.GET` is spied on, so nothing leaves the process.
 */
describe('the request each list sends', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Spies on `api.GET` with an empty last page, and answers the query of every call. */
  function sentQueries() {
    // `as never`: the spy's type is the generated client's answer for every GET path at once
    // (since #46 an image route among them), which no one answer satisfies; the call is checked
    // by what it sent, below.
    const spy = vi.spyOn(api, 'GET').mockResolvedValue({
      data: { data: [], meta: { nextCursor: null } },
      response: new Response(null, { status: 200 }),
    } as never);
    // The generated client's overloads type the calls too narrowly to destructure; each call is
    // `(path, { params: { query } })`.
    const calls = spy.mock.calls as unknown as [string, { params: { query: unknown } }][];
    return () => calls.map(([path, init]) => ({ path, query: init.params.query }));
  }

  it('sends the home’s status, the order picked, and the category and cursor when there are', async () => {
    const sent = sentQueries();
    for (const sort of MARKET_SORTS) {
      await marketsInfiniteQueryOptions({ sort }).queryFn({ pageParam: undefined });
      await marketsInfiniteQueryOptions({ sort, category: 'economy' }).queryFn({
        pageParam: 'cursor-1',
      });
    }
    expect(sent()).toEqual(
      MARKET_SORTS.flatMap((sort) => [
        { path: '/api/v1/markets', query: { status: 'open', sort } },
        {
          path: '/api/v1/markets',
          query: { status: 'open', sort, category: 'economy', cursor: 'cursor-1' },
        },
      ]),
    );
  });

  it('sends a search’s term, status and order always, and the category and cursor when there are', async () => {
    const sent = sentQueries();
    for (const sort of MARKET_SORTS) {
      await marketSearchInfiniteQueryOptions({
        ...DEFAULT_SEARCH_FILTERS,
        sort,
        q: '금리',
      }).queryFn({ pageParam: undefined });
      await marketSearchInfiniteQueryOptions({
        q: '금리',
        status: 'closed',
        sort,
        category: 'economy',
      }).queryFn({ pageParam: 'cursor-1' });
    }
    expect(sent()).toEqual(
      MARKET_SORTS.flatMap((sort) => [
        { path: '/api/v1/markets', query: { status: 'all', sort, q: '금리' } },
        {
          path: '/api/v1/markets',
          query: { status: 'closed', sort, q: '금리', category: 'economy', cursor: 'cursor-1' },
        },
      ]),
    );
  });
});

describe('the SSR-seeded list', () => {
  it('hands the hook the dehydrated pages without a single request', async () => {
    // The home server component's half: one page fetched with the server client, prefetched as an
    // INFINITE query (so `pageParams` and the query type ride along), then dehydrated into the
    // HTML. AC 2 is this test plus the page: first paint carries the current 시장가격.
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
      expect(result.data?.pages[0]?.items[0]).toEqual(card);
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
    const recommended = listObserver(queryClient, DEFAULT_MARKET_FILTERS, count);
    const newest = listObserver(queryClient, byNewest, count);
    const stop = [recommended.subscribe(() => undefined), newest.subscribe(() => undefined)];
    try {
      queryClient.setQueriesData<MarketPages>({ queryKey: MARKETS_KEY }, (held) =>
        applyToPages(held, (row) => applyTick(row, tick())),
      );

      expect(recommended.getCurrentResult().data?.pages[0]?.items[0]?.lastPrice).toBe(63);
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
    // A DELIBERATE refusal, pinned so it is not "fixed" back. `sort=recommended` is keyset-
    // paginated on `(24-hour volume DESC, open time DESC, id DESC)` (market-order.ts, ADR-0065;
    // the volume order before it was the same on `volume_coin`), so the order is the answer's: a
    // tick that overtakes the row above leaves the two cards in the order the server sent them, the
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
    // THE HAZARD: MY opens one `['market', id]` per held market (`useQueries`) and joins
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
    queryClient.setQueryData<Market>(marketKey(ID), {
      ...detail,
      tradeCount: 99,
      statsRevision: '99',
    });
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
    // already running — the one that read the market BEFORE the close. MY's
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

describe('the search screen’s results (#15, ADR-0066)', () => {
  const search: MarketSearch = { ...DEFAULT_SEARCH_FILTERS, q: '금리', status: 'closed' };

  it('keys a search on its own entry, asks with no cursor first and holds no previous search', () => {
    const options = marketSearchInfiniteQueryOptions(search);
    expect(options.queryKey).toEqual(marketSearchKey(search));
    expect(options.initialPageParam).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: 'c' })).toBe('c');
    // A new term is a new search with its own loading state, not the last one's cards.
    expect(options).not.toHaveProperty('placeholderData');
  });

  it('takes the socket’s writes and the card join of the home’s root, by prefix', () => {
    const queryClient = getQueryClient();
    try {
      queryClient.setQueryData<MarketPages>(marketSearchKey(search), pagesOf([card]));
      queryClient.setQueriesData<MarketPages>({ queryKey: MARKETS_KEY }, (held) =>
        applyToPages(held, (row) => applyStatus(row, statusEvent())),
      );
      const held = () => queryClient.getQueryData<MarketPages>(marketSearchKey(search));
      expect(held()?.pages[0]?.items[0]?.status).toBe('closed');
      // A late answer read before the close does not roll the card back (joinMarketPages).
      queryClient.setQueryData<MarketPages>(marketSearchKey(search), pagesOf([card]));
      expect(held()?.pages[0]?.items[0]?.status).toBe('closed');
    } finally {
      queryClient.clear();
    }
  });
});

describe('a detail’s 관련 시장 (#65, ADR-0068)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keys the list on the lower-cased market, asks with no cursor first and follows every cursor', () => {
    // No cap on what is shown (ADR-0061 decision 1, item 19): 더 보기 has to reach the last link,
    // so a cursor goes on and only the wire's null ends the list.
    const options = relatedMarketsInfiniteQueryOptions(ID.toUpperCase());
    expect(options.queryKey).toEqual(relatedMarketsKey(ID));
    expect(options.initialPageParam).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: 'c' })).toBe('c');
    expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
  });

  it('sends the market’s related route, by its lower-cased id, with the page’s cursor', async () => {
    // `as never`: see 'the request each list sends' above.
    const spy = vi.spyOn(api, 'GET').mockResolvedValue({
      data: { data: [card], meta: { nextCursor: 'cursor-2' } },
      response: new Response(null, { status: 200 }),
    } as never);
    const options = relatedMarketsInfiniteQueryOptions(ID.toUpperCase());
    await expect(options.queryFn({ pageParam: undefined })).resolves.toEqual({
      items: [card],
      nextCursor: 'cursor-2',
    });
    // 더 보기: the NEXT page, not the first one again.
    await options.queryFn({ pageParam: 'cursor-1' });
    const calls = spy.mock.calls as unknown as [
      string,
      { params: { path: unknown; query: unknown } },
    ][];
    expect(calls.map(([route, init]) => ({ route, ...init.params }))).toEqual([
      { route: '/api/v1/markets/{id}/related', path: { id: ID }, query: {} },
      { route: '/api/v1/markets/{id}/related', path: { id: ID }, query: { cursor: 'cursor-1' } },
    ]);
  });

  it('hands the section the page the detail read on the server, without a request', async () => {
    const serverClient = getQueryClient();
    await prefetchRelatedMarkets(serverClient, ID, () =>
      Promise.resolve<MarketPage>({ items: [otherCard], nextCursor: 'cursor-0' }),
    );
    const queryClient = getQueryClient();
    hydrate(queryClient, dehydratePublic(serverClient));

    let fetches = 0;
    const observer = new InfiniteQueryObserver<
      MarketPage,
      Error,
      MarketPages,
      readonly unknown[],
      string | undefined
    >(queryClient, {
      ...relatedMarketsInfiniteQueryOptions(ID),
      queryFn: () => {
        fetches += 1;
        return Promise.resolve({ items: [], nextCursor: null });
      },
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      const result = observer.getCurrentResult();
      expect(result.data?.pages[0]?.items).toEqual([otherCard]);
      expect(result.hasNextPage).toBe(true);
      expect(fetches).toBe(0);
    } finally {
      unsubscribe();
      queryClient.clear();
      serverClient.clear();
    }
  });
});

describe('a detail’s 호가창 (#122, ADR-0138)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keys and asks for the book by the lower-cased market, the key the signal restarts', async () => {
    // `as never`: see 'the request each list sends' above.
    const book = { marketId: ID, marketRejectReason: null, contracts: [] };
    const spy = vi.spyOn(api, 'GET').mockResolvedValue({
      data: { data: book },
      response: new Response(null, { status: 200 }),
    } as never);
    const options = orderBookQueryOptions(ID.toUpperCase());
    expect(options.queryKey).toEqual(marketBookKey(ID));
    expect(options.queryKey).toEqual(['market-book', ID]);
    await expect(options.queryFn()).resolves.toEqual(book);
    const calls = spy.mock.calls as unknown as [string, { params: { path: unknown } }][];
    expect(calls.map(([route, init]) => ({ route, path: init.params.path }))).toEqual([
      { route: '/api/v1/markets/{id}/book', path: { id: ID } },
    ]);
  });

  it('reads the book again on every mount, so a return to the detail misses no signal', () => {
    // The room is left with the detail, and nothing restarts the key on a re-join (ADR-0138 2-1).
    expect(orderBookQueryOptions(ID).refetchOnMount).toBe('always');
  });
});

describe('marketQueryOptions', () => {
  it('re-reads a pending payout even with no status event and stops after completion (#24)', () => {
    const options = marketQueryOptions(ID);
    const queryClient = getQueryClient();
    const interval = () =>
      options.refetchInterval({
        state: {
          data: queryClient.getQueryData<Market>(options.queryKey),
        },
      });
    expect(interval()).toBe(false);
    for (const status of ['resolved', 'settling'] as const) {
      queryClient.setQueryData<Market>(options.queryKey, { ...detail, status, statusEventId: '8' });
      expect(interval()).toBe(5_000);
    }
    // A successful read discovers a failed payout under the SAME status key.
    queryClient.setQueryData<Market>(options.queryKey, {
      ...detail,
      status: 'settling',
      statusEventId: '8',
      judgingRecord: { ...detail.judgingRecord, payoutDelayed: true },
    });
    expect(queryClient.getQueryData<Market>(options.queryKey)?.judgingRecord.payoutDelayed).toBe(
      true,
    );
    expect(interval()).toBe(5_000);
    queryClient.setQueryData<Market>(options.queryKey, {
      ...detail,
      status: 'settled',
      statusEventId: '9',
    });
    expect(interval()).toBe(false);
    for (const status of [
      'scheduled',
      'open',
      'paused',
      'closed',
      'provisional',
      'cancelled',
    ] as const) {
      // A new query is used because status keys must never move backward.
      const isolated = { state: { data: { ...detail, status } } };
      expect(options.refetchInterval(isolated)).toBe(false);
    }
    queryClient.clear();
  });
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
  it('re-reads an open detail every five minutes however often ticks land (ADR-0139)', async () => {
    // THE HAZARD (#64 review): a `refetchInterval` is re-armed by every write to its query, so
    // a tick every four minutes pushed the read back forever and `lastPrice24hAgo` never moved.
    vi.useFakeTimers();
    const queryClient = getQueryClient();
    queryClient.setQueryData<Market>(marketKey(ID), detail);
    let fetches = 0;
    const observer = new QueryObserver<Market>(queryClient, {
      ...marketQueryOptions(ID),
      queryFn: () => {
        fetches += 1;
        return Promise.resolve(queryClient.getQueryData<Market>(marketKey(ID)) ?? detail);
      },
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const mounted = fetches;
      const stop = scheduleMarketBaselineRefresh(queryClient, ID);
      for (let minute = 1; minute <= 20; minute += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        if (minute % 4 === 0) {
          const tradeCount = 10 + minute / 4;
          queryClient.setQueryData<Market>(marketKey(ID), (row) =>
            applyTick(row, tick({ tradeCount, statsRevision: String(tradeCount) })),
          );
        }
        // Minute 5, 10, 15 and 20: one read each, the tick a minute earlier notwithstanding.
        expect(fetches - mounted, `minute ${String(minute)}`).toBe(Math.floor(minute / 5));
      }
      expect(LIVE_REFRESH_MS).toBe(5 * 60_000);
      // Stopped (the market left 거래 중, or the detail unmounted): no read.
      stop();
      await vi.advanceTimersByTimeAsync(2 * LIVE_REFRESH_MS);
      expect(fetches - mounted).toBe(4);
      // A hidden tab reads nothing, as `refetchIntervalInBackground: false` did.
      const hidden = scheduleMarketBaselineRefresh(queryClient, ID);
      focusManager.setFocused(false);
      await vi.advanceTimersByTimeAsync(2 * LIVE_REFRESH_MS);
      expect(fetches - mounted).toBe(4);
      hidden();
    } finally {
      unsubscribe();
      focusManager.setFocused(undefined);
      vi.useRealTimers();
      queryClient.clear();
    }
  });
});

/**
 * MY's holdings read the detail's entry with two observer options of their own (#67, ADR-0142
 * 결정 2-22): no settlement poll, and a focus re-read only where a label moves with time.
 */
describe('MY’s holdings read their markets 50 to a request (#300, ADR-0147)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  /** One chunk's answer as the entry holds it: one page, no cursor. */
  const chunk = (...rows: MarketSummary[]): MarketPages => ({
    pages: [{ items: rows, nextCursor: null }],
    pageParams: [undefined],
  });

  it('chunks the held ids lower-cased, distinct and sorted, 50 to a chunk', () => {
    expect(holdingMarketChunks([THIRD_ID, ID.toUpperCase(), OTHER_ID, ID])).toEqual([
      [ID, OTHER_ID, THIRD_ID].sort(),
    ]);
    // The order the groups are drawn in makes no new entry.
    expect(holdingMarketChunks([OTHER_ID, ID])).toEqual(holdingMarketChunks([ID, OTHER_ID]));
    const many = Array.from({ length: 120 }, (_, n) => idOf(119 - n));
    const chunks = holdingMarketChunks(many);
    expect(chunks.map((ids) => ids.length)).toEqual([50, 50, 20]);
    expect(chunks.flat()).toEqual([...many].sort());
    expect(holdingMarketChunks([])).toEqual([]);
  });

  it('asks GET /markets?ids= once for the chunk and keeps the answer as one card page', async () => {
    const ids = [ID, OTHER_ID];
    const options = holdingMarketsQueryOptions(ids);
    expect(options.queryKey).toEqual(holdingMarketsKey(ids));
    const spy = vi.spyOn(api, 'GET').mockResolvedValue({
      data: { data: [card, otherCard], meta: { nextCursor: null } },
      response: new Response(null, { status: 200 }),
    } as never);
    expect(await options.queryFn({ queryKey: options.queryKey })).toEqual(chunk(card, otherCard));
    expect(spy.mock.calls).toEqual([['/api/v1/markets', { params: { query: { ids } } }]]);
    // Never the detail's entry: a summary written into `['market', id]` would draw a detail with
    // its rules and record missing.
    expect(partialMatchKey(options.queryKey, MARKET_KEY)).toBe(false);
    expect(partialMatchKey(options.queryKey, MARKETS_KEY)).toBe(true);
  });

  it('never polls, and re-reads on focus only a chunk with no rows, a failure or a 마감·잠정 결과', () => {
    expect(holdingMarketsQueryOptions([ID]).refetchInterval).toBe(false);
    expect(holdingMarketsQueryOptions([ID]).refetchOnWindowFocus).toBe(
      holdingMarketsRefetchOnFocus,
    );
    const focus = (
      data: MarketPages | undefined,
      status = data === undefined ? 'pending' : 'success',
      fetchFailureCount = 0,
    ) => holdingMarketsRefetchOnFocus({ state: { data, status, fetchFailureCount } });
    expect(focus(undefined)).toBe(true);
    expect(focus(undefined, 'error')).toBe(true);
    expect(focus(chunk({ ...card, status: 'open' }), 'error')).toBe(true);
    for (const status of ['closed', 'provisional'] as const) {
      // One such market among open ones: the chunk, once.
      expect(focus(chunk(card, { ...otherCard, status })), status).toBe(true);
    }
    for (const status of [
      'scheduled',
      'open',
      'paused',
      'resolved',
      'settling',
      'settled',
      'cancelled',
    ] as const) {
      expect(focus(chunk({ ...card, status }, otherCard)), status).toBe(false);
    }
    expect(focus(chunk())).toBe(false);
    // A failure a neighbour's tick wrote over: status back to success, the count kept.
    expect(focus(chunk(card), 'success', 3)).toBe(true);
  });

  it('takes the card reducers and the list join, so an older answer never rolls a tick back', () => {
    const client = getQueryClient();
    const key = holdingMarketsKey([ID, OTHER_ID]);
    client.setQueryData<MarketPages>(key, chunk(card, otherCard));
    // What the provider's card loop does for a tick of ID (`CARD_PAGES_KEYS` → `MARKETS_KEY`).
    const tick = {
      marketId: ID,
      lastPrice: 61,
      volumeCoin: '130000',
      tradeCount: 11,
      statsRevision: '11',
      traderCount: 4,
      ts: '2026-09-07T00:01:00.000Z',
    };
    client.setQueriesData<MarketPages>({ queryKey: MARKETS_KEY }, (held) =>
      applyToPages(held, (row) => applyTick(row, tick as never)),
    );
    expect(client.getQueryData<MarketPages>(key)?.pages[0]?.items[0]).toMatchObject({
      lastPrice: 61,
      tradeCount: 11,
    });
    // An answer read before that trade lands after it: `joinMarketPages` keeps the tick's pair.
    client.setQueryData<MarketPages>(key, chunk(card, otherCard));
    expect(client.getQueryData<MarketPages>(key)?.pages[0]?.items[0]).toMatchObject({
      lastPrice: 61,
      tradeCount: 11,
    });
    client.clear();
  });

  it('finds the chunks naming a market, and owes a first read one follow-up, once', async () => {
    const client = getQueryClient();
    const both = holdingMarketsKey([ID, OTHER_ID]);
    const third = holdingMarketsKey([THIRD_ID]);
    client.setQueryData<MarketPages>(third, chunk({ ...card, id: THIRD_ID }));
    // A first read on the wire: no rows, fetching — answered by the test.
    let answer: (pages: MarketPages) => void = () => undefined;
    void client.prefetchQuery({
      queryKey: both,
      queryFn: () => new Promise<MarketPages>((resolve) => (answer = resolve)),
    });
    // A home list holding the same market is not MY's.
    client.setQueryData<MarketPages>(marketsKey(DEFAULT_MARKET_FILTERS), chunk(card));
    expect(holdingMarketsHolding(client, ID.toUpperCase()).map((q) => q.queryKey)).toEqual([both]);
    expect(holdingMarketsHolding(client, THIRD_ID).map((q) => q.queryKey)).toEqual([third]);
    const owed = holdingMarketsFirstReads(client, ID);
    expect(owed.map((q) => q.queryKey)).toEqual([both]);
    // The same chunk's other market, later ticks: no second follow-up for this first read.
    expect(holdingMarketsFirstReads(client, OTHER_ID)).toEqual([]);
    expect(holdingMarketsFirstReads(client, ID)).toEqual([]);
    // A chunk with rows takes the tick by the card loop: nothing owed.
    expect(holdingMarketsFirstReads(client, THIRD_ID)).toEqual([]);
    // The follow-up runs after the first answer, never cancelling it.
    let followed = 0;
    afterHoldingFirstRead(owed[0]!, () => (followed += 1));
    expect(followed).toBe(0);
    expect(client.getQueryState(both)?.fetchStatus).toBe('fetching');
    answer(chunk(card, otherCard));
    await vi.waitFor(() => expect(followed).toBe(1));
    // Once done, a later first read may owe one again.
    await client.resetQueries({ queryKey: both });
    void client.prefetchQuery({
      queryKey: both,
      queryFn: () => new Promise<MarketPages>(() => undefined),
    });
    expect(holdingMarketsFirstReads(client, ID).map((q) => q.queryKey)).toEqual([both]);
    client.clear();
  });

  it('is fresh by its own last answer, which no neighbour’s tick restamps (review)', async () => {
    const client = getQueryClient();
    const ids = [ID, OTHER_ID];
    const options = holdingMarketsQueryOptions(ids);
    const hash = hashKey(options.queryKey);
    forgetHoldingReads();
    let reads = 0;
    vi.spyOn(api, 'GET').mockImplementation((() => {
      reads += 1;
      return Promise.resolve({
        data: { data: [card, otherCard], meta: { nextCursor: null } },
        response: new Response(null, { status: 200 }),
      });
    }) as never);
    const observe = () => {
      const observer = new QueryObserver<MarketPages>(client, options);
      return observer.subscribe(() => undefined);
    };
    /** Until the read in flight has answered (leaving mid-read would cancel it). */
    const landed = () =>
      vi.waitFor(() => expect(client.getQueryState(options.queryKey)?.fetchStatus).toBe('idle'));
    let leave = observe();
    await vi.waitFor(() => expect(reads).toBe(1));
    await landed();
    leave();
    expect(holdingReadFresh(hash, Date.now())).toBe(true);
    // Back within the read's freshness: nothing asked.
    leave = observe();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(1);
    leave();
    // A status of one of its markets forgets the read; a neighbour's tick then writes the chunk
    // (a manual success: `dataUpdatedAt` now, `isInvalidated` cleared) — and the chunk is
    // still read when observed again.
    expect(holdingChunksToRead(client, OTHER_ID).map((q) => q.queryHash)).toEqual([hash]);
    await restartQueries(client, options.queryKey, sameChunk({ queryHash: hash }));
    const tick = {
      marketId: ID,
      lastPrice: 61,
      volumeCoin: '130000',
      tradeCount: 11,
      statsRevision: '11',
      traderCount: 4,
      ts: '2026-09-07T00:01:00.000Z',
    };
    client.setQueriesData<MarketPages>({ queryKey: MARKETS_KEY }, (held) =>
      applyToPages(held, (row) => applyTick(row, tick as never)),
    );
    expect(client.getQueryState(options.queryKey)?.isInvalidated).toBe(false);
    leave = observe();
    await vi.waitFor(() => expect(reads).toBe(2));
    await landed();
    leave();
    // Past the client's staleTime with no reason: read again, as any entry.
    expect(holdingReadFresh(hash, Date.now() + HOLDING_READ_FRESH_MS)).toBe(false);
    client.clear();
  });

  it('restarts a chunk by its own hash, never a longer chunk its ids begin (review)', async () => {
    const client = getQueryClient();
    const short = holdingMarketsKey([ID, OTHER_ID]);
    const long = holdingMarketsKey([ID, OTHER_ID, THIRD_ID]);
    client.setQueryData<MarketPages>(short, chunk(card, otherCard));
    client.setQueryData<MarketPages>(long, chunk(card, otherCard, { ...card, id: THIRD_ID }));
    // A key restart matches by prefix: the id list [ID, OTHER_ID] is a prefix of the longer one.
    expect(partialMatchKey(long, short)).toBe(true);
    const target = client.getQueryCache().find({ queryKey: short, exact: true })!;
    await restartQueries(client, short, sameChunk(target));
    expect(client.getQueryState(short)?.isInvalidated).toBe(true);
    expect(client.getQueryState(long)?.isInvalidated).toBe(false);
    client.clear();
  });

  it('keeps a failure on screen after a neighbour’s tick writes the chunk (review)', async () => {
    const client = getQueryClient();
    const key = holdingMarketsKey([ID, OTHER_ID]);
    client.setQueryData<MarketPages>(key, chunk(card, otherCard));
    await client
      .fetchQuery({
        queryKey: key,
        queryFn: () => Promise.reject(new Error('503')),
        staleTime: 0,
        retry: false,
      })
      .catch(() => undefined);
    const observer = new QueryObserver<MarketPages>(client, { queryKey: key, enabled: false });
    const leave = observer.subscribe(() => undefined);
    expect(priceIsStale(observer.getCurrentResult())).toBe(true);
    const tick = {
      marketId: ID,
      lastPrice: 61,
      volumeCoin: '130000',
      tradeCount: 11,
      statsRevision: '11',
      traderCount: 4,
      ts: '2026-09-07T00:01:00.000Z',
    };
    client.setQueriesData<MarketPages>({ queryKey: MARKETS_KEY }, (held) =>
      applyToPages(held, (row) => applyTick(row, tick as never)),
    );
    const after = observer.getCurrentResult();
    // The write put the status back to success …
    expect(after.isError).toBe(false);
    // … and the failure still stands until a read answers.
    expect(after.failureCount).toBe(1);
    expect(priceIsStale(after)).toBe(true);
    leave();
    client.clear();
  });

  it('starts a new set of held markets from the cached chunks’ rows, and still reads it (codex)', async () => {
    const client = getQueryClient();
    forgetHoldingReads();
    // [A, B] was read, and A has since ticked; B is sold out, so the set is [A] — a new key.
    const ticked: MarketSummary = { ...card, lastPrice: 61, tradeCount: 11, statsRevision: '11' };
    client.setQueryData<MarketPages>(holdingMarketsKey([ID, OTHER_ID]), chunk(ticked, otherCard));
    // An older chunk naming A too: the join keeps the newer row.
    client.setQueryData<MarketPages>(holdingMarketsKey([ID, THIRD_ID]), chunk(card));
    expect(seedHoldingChunk(client, [ID])).toEqual(chunk(ticked));
    expect(seedHoldingChunk(client, [THIRD_ID])).toBeUndefined();
    let reads = 0;
    vi.spyOn(api, 'GET').mockImplementation((() => {
      reads += 1;
      return Promise.resolve({
        data: { data: [{ ...ticked, lastPrice: 62, tradeCount: 12 }], meta: { nextCursor: null } },
        response: new Response(null, { status: 200 }),
      });
    }) as never);
    const options = holdingMarketsQueryOptions([ID], () => seedHoldingChunk(client, [ID]));
    const observer = new QueryObserver<MarketPages>(client, options);
    // The first render already has A's live row — not the positions snapshot.
    expect(observer.getCurrentResult().data?.pages[0]?.items[0]?.lastPrice).toBe(61);
    const leave = observer.subscribe(() => undefined);
    // And the chunk's own read is still owed: a seed is not an answer.
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data?.pages[0]?.items[0]?.lastPrice).toBe(62),
    );
    expect(reads).toBe(1);
    leave();
    client.clear();
  });

  it('owes nothing after a first read that fails: no read past the retry policy (codex)', async () => {
    const client = getQueryClient();
    const key = holdingMarketsKey([OTHER_ID, THIRD_ID]);
    let fail: (error: Error) => void = () => undefined;
    void client
      .prefetchQuery({
        queryKey: key,
        queryFn: () => new Promise<MarketPages>((_, reject) => (fail = reject)),
        retry: false,
      })
      .catch(() => undefined);
    const owed = holdingMarketsFirstReads(client, OTHER_ID);
    expect(owed.map((q) => q.queryKey)).toEqual([key]);
    let followed = 0;
    afterHoldingFirstRead(owed[0]!, () => (followed += 1));
    fail(new Error('429'));
    await vi.waitFor(() => expect(client.getQueryState(key)?.status).toBe('error'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(followed).toBe(0);
    // And the bookkeeping is cleared: the next first read may owe one again.
    void client.prefetchQuery({
      queryKey: key,
      queryFn: () => new Promise<MarketPages>(() => undefined),
    });
    expect(holdingMarketsFirstReads(client, THIRD_ID).map((q) => q.queryKey)).toEqual([key]);
    client.clear();
  });

  it('seeds a tie from the chunk answered last, whatever order the cache holds them in (codex)', () => {
    const client = getQueryClient();
    forgetHoldingReads();
    // [A, B] was read after a dispute's decision (the same status key, new flags); [A, C], an
    // older chunk off screen, still holds the flags from before — and sits later in the cache.
    const ab = holdingMarketsKey([ID, OTHER_ID]);
    const ac = holdingMarketsKey([ID, THIRD_ID]);
    const before: MarketSummary = { ...card, status: 'provisional', disputeUnderReview: false };
    const decided: MarketSummary = { ...before, disputeUnderReview: true };
    client.setQueryData<MarketPages>(ab, chunk(decided, otherCard));
    client.setQueryData<MarketPages>(ac, chunk(before));
    noteHoldingRead(hashKey(ac), 1_000);
    noteHoldingRead(hashKey(ab), 2_000);
    // A read forgotten since (a status restart) still orders by its answer.
    forgetHoldingReads(hashKey(ab));
    expect(seedHoldingChunk(client, [ID])?.pages[0]?.items[0]?.disputeUnderReview).toBe(true);
    client.clear();
  });

  it('owes a follow-up to a seeded chunk on its read only for a market it has no row of', () => {
    const client = getQueryClient();
    const key = holdingMarketsKey([ID, THIRD_ID]);
    void client.prefetchQuery({
      queryKey: key,
      queryFn: () => new Promise<MarketPages>(() => undefined),
      initialData: chunk(card),
      staleTime: 0,
    });
    expect(client.getQueryState(key)?.fetchStatus).toBe('fetching');
    // ID's row is there: the card loop takes its tick.
    expect(holdingMarketsFirstReads(client, ID)).toEqual([]);
    // THIRD_ID has none yet: its tick would be dropped, and the answer on the wire predates it.
    expect(holdingMarketsFirstReads(client, THIRD_ID).map((q) => q.queryKey)).toEqual([key]);
    client.clear();
  });

  it('never counts a cancelled read as the chunk’s answer (codex)', async () => {
    forgetHoldingReads();
    vi.spyOn(api, 'GET').mockResolvedValue({
      data: { data: [card], meta: { nextCursor: null } },
      response: new Response(null, { status: 200 }),
    } as never);
    const options = holdingMarketsQueryOptions([ID]);
    const hash = hashKey(options.queryKey);
    const cancelled = new AbortController();
    cancelled.abort();
    await options.queryFn({ queryKey: options.queryKey, signal: cancelled.signal });
    expect(holdingReadFresh(hash, Date.now())).toBe(false);
    await options.queryFn({ queryKey: options.queryKey, signal: new AbortController().signal });
    expect(holdingReadFresh(hash, Date.now())).toBe(true);
    // A cancelled failure does not forget the answer that stands.
    vi.spyOn(api, 'GET').mockRejectedValue(new Error('aborted'));
    await expect(
      options.queryFn({ queryKey: options.queryKey, signal: cancelled.signal }),
    ).rejects.toThrow('aborted');
    expect(holdingReadFresh(hash, Date.now())).toBe(true);
    // The request carries the signal, so a cancel stops it on the wire too.
    expect(vi.mocked(api.GET).mock.calls.at(-1)?.[1]).toMatchObject({ signal: cancelled.signal });
    expect(options.staleTime).toBe(holdingChunkStaleTime);
  });
});

describe('participant-only event during an unseeded first GET (#132)', () => {
  it('restarts the stale request and obtains the committed participant revision without inventing a market', async () => {
    const client = getQueryClient();
    let fetches = 0;
    const latest = { ...detail, traderCount: 0, statsRevision: '12' };
    const observer = new QueryObserver<Market>(client, {
      queryKey: marketKey(ID),
      queryFn: () => Promise.resolve(++fetches === 1 ? detail : latest),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      const event = {
        type: 'market:stats' as const,
        marketId: ID,
        traderCount: 0,
        statsRevision: '12',
      };
      handleMarketStats(client, new Throttle(1000), event);
      expect(client.getQueryData(marketKey(ID))).toBeUndefined();
      await vi.waitFor(() => expect(observer.getCurrentResult().data?.statsRevision).toBe('12'));
      expect(fetches).toBe(2);
      expect(observer.getCurrentResult().data).toEqual(latest);
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
