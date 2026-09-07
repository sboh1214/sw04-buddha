import {
  type MarketTickEvent,
  type UserBalanceEvent,
  type UserPositionEvent,
} from '@buddha/shared';
import { QueryObserver, hydrate } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { positionsKey } from '@/hooks/use-portfolio';
import {
  type Market,
  type MarketListItem,
  type MarketSummary,
  type Me,
  type Position,
} from './api';
import {
  DEFAULT_MARKET_FILTERS,
  MARKETS_KEY,
  dehydratePublic,
  marketKey,
  marketsKey,
} from './market-keys';
import {
  type MarketPages,
  applyBalanceEvent,
  applyPositionEvent,
  applyTick,
  applyToPages,
} from './market-live';
import { getQueryClient } from './query-client';

/**
 * The reducers of market-live.ts driven through a real QueryClient, because the contracts that
 * matter are the client's: an updater that answers `undefined` must not write, and the
 * `structuralSharing` defaults registered in query-client.ts must survive every path a value
 * can enter the cache by. Nothing here renders — TanStack Query itself runs fine under node.
 *
 * `getQueryClient()` answers a FRESH client on every call here (`isServer` is true with no
 * `window`), which is exactly what a per-test client needs and, more to the point, means these
 * tests exercise the defaults the app actually ships rather than a copy of them.
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

const snapshot: Market = {
  ...summary,
  description: null,
  rules: '한국은행 발표 기준.',
  resolutionSource: null,
  resolvedAt: null,
  disputeUntil: null,
  settledAt: null,
  voidedAt: null,
};

const card: MarketListItem = { ...summary, sparkline: [4800, 4900, 5000] };
const otherCard: MarketListItem = { ...card, id: OTHER_ID, slug: 'other', sparkline: [] };

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

const balance: UserBalanceEvent = {
  type: 'user:balance',
  availableP: '80000',
  lockedP: '1200',
  ledgerEntryId: '9',
  ts: '2026-09-07T00:00:00.000Z',
};

const me: Me = {
  id: 'user-1',
  email: 'a@example.com',
  emailVerified: true,
  profile: { nickname: '테스터', role: 'user', createdAt: '2026-08-01T00:00:00.000Z' },
  balance: { availableP: '100000', lockedP: '0' },
  linkedAccounts: [],
};

/** The row as a snapshot taken before the trade carries it. */
const beforeTrade: Position = {
  marketId: ID,
  marketSlug: summary.slug,
  marketTitle: summary.title,
  marketStatus: 'open',
  marketLastPrice: 50,
  resolvedResult: null,
  outcome: 'YES',
  qty: 10,
  costBasisP: '5000',
  realizedPnlP: '0',
  settled: false,
  version: 3,
  updatedAt: '2026-09-06T00:00:00.000Z',
};

/** The `user:position` that carries the trade the snapshot above is missing. */
const traded: UserPositionEvent = {
  type: 'user:position',
  marketId: ID,
  outcome: 'YES',
  qty: 14,
  costBasisP: '7000',
  realizedPnlP: '0',
  settled: false,
  version: 4,
  ts: '2026-09-07T00:00:00.000Z',
};

/** The infinite-list shape: the last page ends the list, and the first page has no cursor. */
const pagesOf = (...pages: MarketListItem[][]): MarketPages => ({
  pages: pages.map((items, index) => ({
    items,
    nextCursor: index === pages.length - 1 ? null : `cursor-${String(index)}`,
  })),
  pageParams: [undefined, ...pages.slice(1).map((_page, index) => `cursor-${String(index)}`)],
});

describe('the market detail cache', () => {
  it('does not let a refetch that started before a trade roll the probability back', async () => {
    // THE RACE, and it has nothing to do with sockets: refetchOnWindowFocus and
    // refetchOnReconnect are on, so a request that left before the trade committed lands after
    // the tick was applied and carries the older stats. The join is what makes it harmless.
    const queryClient = getQueryClient();
    let answer: Market = snapshot;
    let fetches = 0;
    const observer = new QueryObserver<Market>(queryClient, {
      queryKey: marketKey(ID),
      queryFn: () => {
        fetches += 1;
        return Promise.resolve(answer);
      },
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      queryClient.setQueryData<Market>(marketKey(ID), (held) => applyTick(held, tick()));
      // The in-flight answer: one trade behind on every stat, and news only about the title.
      answer = { ...snapshot, title: '10월 기준금리 인하?' };
      await observer.refetch();

      const data = observer.getCurrentResult().data;
      expect(data?.pYesBp).toBe(6300);
      expect(data?.lastPrice).toBe(63);
      expect(data?.volumeP).toBe('130000');
      expect(data?.tradeCount).toBe(11);
      expect(data?.title).toBe('10월 기준금리 인하?');
      expect(fetches).toBe(2);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it('serves the hydrated snapshot and takes a tick without asking the API', () => {
    // What the detail page does on first paint: the server seeded the market, so the socket's
    // first event has to land on the hydrated entry rather than trigger a load (PLAN 11.5).
    const serverClient = getQueryClient();
    serverClient.setQueryData<Market>(marketKey(ID), snapshot);
    const queryClient = getQueryClient();
    hydrate(queryClient, dehydratePublic(serverClient));

    let fetches = 0;
    const observer = new QueryObserver<Market>(queryClient, {
      queryKey: marketKey(ID),
      queryFn: () => {
        fetches += 1;
        return Promise.resolve(snapshot);
      },
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      expect(observer.getCurrentResult().data?.pYesBp).toBe(snapshot.pYesBp);

      queryClient.setQueryData<Market>(marketKey(ID), (held) => applyTick(held, tick()));

      expect(observer.getCurrentResult().data?.pYesBp).toBe(6300);
      expect(fetches).toBe(0);
    } finally {
      unsubscribe();
      queryClient.clear();
      serverClient.clear();
    }
  });

  it('leaves dataUpdatedAt alone when the tick is not newer than what is held', () => {
    // The undefined-updater contract: a duplicate delivery must not restart staleTime, or a
    // busy market would keep its entry permanently fresh and never reconcile with the API.
    const queryClient = getQueryClient();
    queryClient.setQueryData<Market>(marketKey(ID), snapshot);
    const before = queryClient.getQueryState(marketKey(ID))?.dataUpdatedAt;
    const held = queryClient.getQueryData<Market>(marketKey(ID));
    expect(before).toBeGreaterThan(0);

    queryClient.setQueryData<Market>(marketKey(ID), (row) =>
      applyTick(row, tick({ tradeCount: snapshot.tradeCount })),
    );

    expect(queryClient.getQueryState(marketKey(ID))?.dataUpdatedAt).toBe(before);
    expect(queryClient.getQueryData<Market>(marketKey(ID))).toBe(held);
    queryClient.clear();
  });
});

describe('the market list caches', () => {
  it('patches every filter holding the market and leaves the other pages untouched', () => {
    const queryClient = getQueryClient();
    const byVolume = marketsKey(DEFAULT_MARKET_FILTERS);
    const byNewest = marketsKey({ ...DEFAULT_MARKET_FILTERS, sort: 'newest' });
    queryClient.setQueryData<MarketPages>(byVolume, pagesOf([card], [otherCard]));
    queryClient.setQueryData<MarketPages>(byNewest, pagesOf([otherCard, card]));
    const untouched = queryClient.getQueryData<MarketPages>(byVolume)?.pages[1];
    expect(untouched?.items[0]?.id).toBe(OTHER_ID);

    queryClient.setQueriesData<MarketPages>({ queryKey: MARKETS_KEY }, (held) =>
      applyToPages(held, (row) => applyTick(row, tick())),
    );

    const volumePages = queryClient.getQueryData<MarketPages>(byVolume);
    const newestPages = queryClient.getQueryData<MarketPages>(byNewest);
    expect(volumePages?.pages[0]?.items[0]?.pYesBp).toBe(6300);
    expect(newestPages?.pages[0]?.items[1]?.pYesBp).toBe(6300);
    // Sorted by volume it is still the first card, so only its own page was rebuilt.
    expect(volumePages?.pages[1]).toBe(untouched);
    queryClient.clear();
  });

  it('writes nothing at all for a market no cached page holds', () => {
    const queryClient = getQueryClient();
    const byVolume = marketsKey(DEFAULT_MARKET_FILTERS);
    queryClient.setQueryData<MarketPages>(byVolume, pagesOf([card], [otherCard]));
    const before = queryClient.getQueryState(byVolume)?.dataUpdatedAt;
    const held = queryClient.getQueryData<MarketPages>(byVolume);

    queryClient.setQueriesData<MarketPages>({ queryKey: MARKETS_KEY }, (pages) =>
      applyToPages(pages, (row) => applyTick(row, tick({ marketId: THIRD_ID }))),
    );

    expect(queryClient.getQueryState(byVolume)?.dataUpdatedAt).toBe(before);
    expect(queryClient.getQueryData<MarketPages>(byVolume)).toBe(held);
    queryClient.clear();
  });
});

describe('the me cache', () => {
  it('is not created by a balance event for a visitor who is not signed in', () => {
    // `user:balance` is only delivered to a signed-in socket, but a sign-out that races the
    // last event must not leave a synthesised profile behind for the next screen to read.
    // `refetch` is the answer the reducer gives, and an invalidation of a key nothing has
    // asked for builds no entry — which is what makes that answer safe here.
    const queryClient = getQueryClient();

    const patch = applyBalanceEvent(queryClient.getQueryData<Me>(ME_QUERY_KEY), balance);
    expect(patch.kind).toBe('refetch');
    void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });

    expect(queryClient.getQueryData(ME_QUERY_KEY)).toBeUndefined();
    expect(queryClient.getQueryState(ME_QUERY_KEY)).toBeUndefined();
    queryClient.clear();
  });

  it('re-asks for a profile the event interrupted, instead of spinning for good', async () => {
    // THE HAZARD: a balance event lands while the FIRST `GET /me` is still in flight. The
    // handler cancels that request so a snapshot taken before the event cannot land on top of
    // it — and a cancel REVERTS the query to the state it had before it started, which for a
    // first load is `pending` with no data and no observer fetching. Writing nothing there
    // left the balance chip and 잔고 요약 on a skeleton until the next window focus.
    const queryClient = getQueryClient();
    let answer: Me = { ...me, balance: { availableP: '100000', lockedP: '0' } };
    let fetches = 0;
    const observer = new QueryObserver<Me>(queryClient, {
      queryKey: ME_QUERY_KEY,
      queryFn: () => {
        fetches += 1;
        return Promise.resolve(answer);
      },
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      // The first request is in flight and has answered nothing yet.
      const first = observer.refetch();
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toBeUndefined();

      const patch = applyBalanceEvent(queryClient.getQueryData<Me>(ME_QUERY_KEY), balance);
      expect(patch.kind).toBe('refetch');
      void queryClient.cancelQueries({ queryKey: ME_QUERY_KEY, exact: true });
      // The cancel is synchronous down to the state change, so the query is idle again and the
      // refetch below is a REAL second request rather than a subscription to the cancelled one.
      // This is also the stuck state itself: nothing is fetching, nothing has answered, and no
      // observer is going to try again on its own.
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.fetchStatus).toBe('idle');
      expect(observer.getCurrentResult().isPending).toBe(true);
      expect(observer.getCurrentResult().data).toBeUndefined();
      // What the server answers now reflects the event the socket delivered.
      answer = { ...me, balance: { availableP: balance.availableP, lockedP: balance.lockedP } };
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });
      await first;

      expect(observer.getCurrentResult().data?.balance).toEqual({
        availableP: '80000',
        lockedP: '1200',
      });
      expect(observer.getCurrentResult().isPending).toBe(false);
      expect(fetches).toBe(2);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });
});

describe('the positions caches', () => {
  it('does not let a fetch that started before a trade roll the row back', async () => {
    // The same race the market detail closes above, on the list the 매도 ceiling and 평가손익
    // are read from: a mount or a focus refetch left before another tab's trade, the
    // `user:position` event applied it, and then the older answer landed. Nothing refetches
    // again afterwards, so the rollback stood until the next unrelated trigger.
    const queryClient = getQueryClient();
    let answer: Position[] = [beforeTrade];
    const observer = new QueryObserver<Position[]>(queryClient, {
      queryKey: positionsKey('open'),
      queryFn: () => Promise.resolve(answer),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      const patch = applyPositionEvent(queryClient.getQueryData(positionsKey('open')), traded);
      expect(patch.kind).toBe('replace');
      if (patch.kind === 'replace') {
        queryClient.setQueryData<Position[]>(positionsKey('open'), patch.positions);
      }
      // The in-flight answer: one trade behind, and news only about the market it names.
      answer = [{ ...beforeTrade, marketTitle: '10월 기준금리 인하?', marketLastPrice: 63 }];
      await observer.refetch();

      const row = observer.getCurrentResult().data?.[0];
      expect(row?.qty).toBe(14);
      expect(row?.costBasisP).toBe('7000');
      expect(row?.version).toBe(4);
      // …while everything only a REST answer knows still comes from it.
      expect(row?.marketTitle).toBe('10월 기준금리 인하?');
      expect(row?.marketLastPrice).toBe(63);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it('keeps the two lists apart, so one join cannot reach the other', () => {
    // `['positions']` covers both variants by prefix; a settled row at an older version must
    // not be merged into the open list's row of the same (market, outcome).
    const queryClient = getQueryClient();
    queryClient.setQueryData<Position[]>(positionsKey('open'), [
      { ...beforeTrade, qty: 14, version: 4 },
    ]);
    queryClient.setQueryData<Position[]>(positionsKey('settled'), [
      { ...beforeTrade, qty: 0, settled: true, version: 2 },
    ]);

    expect(queryClient.getQueryData<Position[]>(positionsKey('open'))?.[0]?.qty).toBe(14);
    expect(queryClient.getQueryData<Position[]>(positionsKey('settled'))?.[0]?.qty).toBe(0);
    queryClient.clear();
  });
});
