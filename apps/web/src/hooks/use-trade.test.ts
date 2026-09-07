import { QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  type Market,
  type MarketListItem,
  type MarketStats,
  type Me,
  type Position,
  type QuoteBody,
  type QuoteResult,
  type TradeResult,
} from '@/lib/api';
import {
  DEFAULT_MARKET_FILTERS,
  ORDERS_KEY,
  POSITIONS_KEY,
  QUOTE_KEY,
  marketFillsKey,
  marketKey,
  marketsKey,
  quoteQueryKey,
} from '@/lib/market-keys';
import { type MarketPages } from '@/lib/market-live';
import { getQueryClient } from '@/lib/query-client';
import { ME_QUERY_KEY } from './use-me';
import { positionsKey } from './use-portfolio';
import {
  applyMarketStats,
  applyPositionRow,
  applyTradeMarket,
  applyTradeResult,
  heldQtyOf,
  mergePosition,
  quoteQueryOptions,
} from './use-trade';

/**
 * The trade panel's cache decisions, driven through the REAL QueryClient (`getQueryClient()`
 * answers a fresh one per call under node, so these run against the defaults the app ships —
 * the `joinMarket`/`joinMarketPages` structural sharing included). Nothing renders: apps/web
 * runs vitest under `environment: 'node'`, which is exactly why every decision below lives in
 * an exported function rather than in the panel.
 */

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';
const THIRD_ID = 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46';

const market: Market = {
  id: ID,
  slug: 'rate-cut-2026',
  title: '기준금리 인하?',
  description: null,
  rules: '한국은행 발표 기준.',
  resolutionSource: null,
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
  resolvedAt: null,
  disputeUntil: null,
  settledAt: null,
  voidedAt: null,
  createdAt: '2026-08-30T00:00:00.000Z',
};

const card: MarketListItem = {
  id: ID,
  slug: market.slug,
  title: market.title,
  category: market.category,
  imageUrl: null,
  status: 'open',
  lastPrice: 50,
  pYesBp: 5000,
  volumeP: '120000',
  tradeCount: 10,
  traderCount: 4,
  closeAt: market.closeAt,
  openAt: market.openAt,
  resolvedResult: null,
  createdAt: market.createdAt,
  sparkline: [4800, 4900, 5000],
};

/** A second card in the same page: the market this trade is not about. */
const otherCard: MarketListItem = {
  ...card,
  id: OTHER_ID,
  slug: 'won-1400',
  title: '원달러 1400?',
};

/** The infinite-list shape: the last page ends the list, and the first page has no cursor. */
const pagesOf = (...pages: MarketListItem[][]): MarketPages => ({
  pages: pages.map((items, index) => ({
    items,
    nextCursor: index === pages.length - 1 ? null : `cursor-${String(index)}`,
  })),
  pageParams: [undefined, ...pages.slice(1).map((_page, index) => `cursor-${String(index)}`)],
});

const me: Me = {
  id: 'user-1',
  email: 'a@example.com',
  emailVerified: true,
  profile: { nickname: '테스터', role: 'user', createdAt: '2026-08-01T00:00:00.000Z' },
  balance: { availableP: '100000', lockedP: '0' },
  linkedAccounts: [],
};

/** What `GET /me` answers after the trade — deliberately not what the seed wrote. */
const refetchedMe: Me = { ...me, balance: { availableP: '93999', lockedP: '0' } };

const position: Position = {
  marketId: ID,
  marketSlug: market.slug,
  marketTitle: market.title,
  marketStatus: 'open',
  marketLastPrice: 50,
  outcome: 'YES',
  qty: 12,
  costBasisP: '5400',
  realizedPnlP: '0',
  resolvedResult: null,
  settled: false,
  updatedAt: '2026-09-07T00:00:00.000Z',
  version: 7,
};

const otherPosition: Position = {
  ...position,
  marketId: OTHER_ID,
  marketSlug: otherCard.slug,
  marketTitle: otherCard.title,
  qty: 3,
  version: 2,
};

/** A row in 정산 이력: `GET /me/positions?status=settled` answers it, a trade never does. */
const settledPosition: Position = {
  ...position,
  marketId: THIRD_ID,
  marketSlug: 'cpi-2026',
  marketTitle: 'CPI 3% 이상?',
  marketStatus: 'settled',
  resolvedResult: 'YES',
  settled: true,
  realizedPnlP: '4200',
  version: 4,
};

const stats: MarketStats = {
  id: ID,
  lastPrice: 63,
  pYesBp: 6300,
  volumeP: '130000',
  tradeCount: 11,
};

const tradeResult: TradeResult = {
  balance: { availableP: '94000', lockedP: '0' },
  fill: {
    id: 'fill-1',
    amountP: '6000',
    createdAt: '2026-09-07T01:00:00.000Z',
    outcome: 'YES',
    priceAvgBp: 5100,
    qty: 20,
    side: 'buy',
  },
  market: stats,
  order: {
    id: 'order-1',
    marketId: ID,
    marketSlug: market.slug,
    marketTitle: market.title,
    outcome: 'YES',
    side: 'buy',
    type: 'market',
    status: 'filled',
    qty: 20,
    filledQty: 20,
    amountP: '6000',
    priceAvgBp: 5100,
    maxCostP: '6060',
    minProceedsP: null,
    createdAt: '2026-09-07T01:00:00.000Z',
  },
  position: { ...position, qty: 32, costBasisP: '11400', version: 8 },
};

const spend1000: QuoteBody = {
  marketId: ID,
  outcome: 'YES',
  side: 'buy',
  mode: 'spend',
  value: '1000',
};
const spend2000: QuoteBody = { ...spend1000, value: '2000' };

const quoteOf = (shares: number, amountP: string): QuoteResult => ({
  shares,
  amountP,
  maxPayoutP: String(shares * 100),
  priceAvgBp: 5100,
  priceBeforeBp: 5000,
  priceAfterBp: 5200,
});
const quoteA = quoteOf(19, '1000');
const quoteB = quoteOf(38, '2000');

/** A promise whose settlement this test owns, so two quotes can be answered out of order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('quoteQueryOptions', () => {
  it('leaves a late answer on its own key, so the newer intent never reads it', async () => {
    // THE RACE, without React: the trader typed 1,000 then 2,000, and the first request comes
    // back last. Nothing cancels it and no sequence number is kept — every input is in the key,
    // so the stale answer lands in the entry only the intent that asked for it reads.
    const queryClient = getQueryClient();
    const first = deferred<QuoteResult>();
    const second = deferred<QuoteResult>();
    const observerA = new QueryObserver<QuoteResult>(queryClient, {
      ...quoteQueryOptions(spend1000),
      queryFn: () => first.promise,
    });
    const observerB = new QueryObserver<QuoteResult>(queryClient, {
      ...quoteQueryOptions(spend2000),
      queryFn: () => second.promise,
    });
    const unsubscribeA = observerA.subscribe(() => undefined);
    const unsubscribeB = observerB.subscribe(() => undefined);
    try {
      expect(quoteQueryKey(spend1000)).not.toEqual(quoteQueryKey(spend2000));

      second.resolve(quoteB);
      await vi.waitFor(() => {
        expect(observerB.getCurrentResult().data).toEqual(quoteB);
      });

      first.resolve(quoteA);
      await vi.waitFor(() => {
        expect(queryClient.getQueryData(quoteQueryKey(spend1000))).toEqual(quoteA);
      });

      // The summary the trader is reading is still priced on what they typed last.
      expect(observerB.getCurrentResult().data).toEqual(quoteB);
      expect(queryClient.getQueryData(quoteQueryKey(spend2000))).toEqual(quoteB);
    } finally {
      unsubscribeA();
      unsubscribeB();
      queryClient.clear();
    }
  });

  it('marks the previous intent as placeholder data until the new one answers', async () => {
    // The hazard `keepPreviousData` introduces, which the panel closes by reading
    // `isPlaceholderData ? undefined : data`: between the two keys the observer publishes the
    // OLD numbers, and a wire body built from them would buy the wrong amount.
    const queryClient = getQueryClient();
    const first = deferred<QuoteResult>();
    const second = deferred<QuoteResult>();
    const observer = new QueryObserver<QuoteResult>(queryClient, {
      ...quoteQueryOptions(spend1000),
      queryFn: () => first.promise,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      first.resolve(quoteA);
      await vi.waitFor(() => {
        expect(observer.getCurrentResult().data).toEqual(quoteA);
      });
      expect(observer.getCurrentResult().isPlaceholderData).toBe(false);

      observer.setOptions({ ...quoteQueryOptions(spend2000), queryFn: () => second.promise });

      const switched = observer.getCurrentResult();
      expect(switched.isPlaceholderData).toBe(true);
      expect(switched.data).toEqual(quoteA);

      second.resolve(quoteB);
      await vi.waitFor(() => {
        expect(observer.getCurrentResult().isPlaceholderData).toBe(false);
      });
      expect(observer.getCurrentResult().data).toEqual(quoteB);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it('parks on one idle key and asks nothing while there is nothing to price', async () => {
    const idle = quoteQueryOptions(undefined);
    expect(idle.enabled).toBe(false);
    expect(idle.queryKey).toEqual([...QUOTE_KEY, 'idle']);
    // Belt and braces for the day `enabled` is dropped: the queryFn refuses instead of posting
    // a body the schema would reject, which would read as a failed quote to the panel.
    await expect(idle.queryFn()).rejects.toThrow();
  });
});

describe('applyTradeResult', () => {
  it('seeds the balance, the position and the price before any refetch lands', async () => {
    // AC 3's primary path. An Idempotency-Key replay publishes NO realtime event, so a screen
    // that waited for `user:balance` would keep showing the balance from before the trade; and
    // the seed must be synchronous, or the invalidation's refetch is what the user waits for.
    const queryClient = getQueryClient();
    let meFetches = 0;
    let positionFetches = 0;
    const meObserver = new QueryObserver<Me>(queryClient, {
      queryKey: ME_QUERY_KEY,
      queryFn: () => {
        meFetches += 1;
        return Promise.resolve(meFetches === 1 ? me : refetchedMe);
      },
    });
    const positionObserver = new QueryObserver<Position[]>(queryClient, {
      // The key 내 포지션 reads; the invalidation below prefix-matches it from POSITIONS_KEY.
      queryKey: positionsKey('open'),
      queryFn: () => {
        positionFetches += 1;
        return Promise.resolve([position]);
      },
    });
    const unsubscribeMe = meObserver.subscribe(() => undefined);
    const unsubscribePositions = positionObserver.subscribe(() => undefined);
    try {
      // The mount fetch is already in flight, so this awaits it rather than adding one.
      await Promise.all([meObserver.refetch(), positionObserver.refetch()]);
      const loaded = { me: meFetches, positions: positionFetches };
      queryClient.setQueryData(ORDERS_KEY, { pages: [], pageParams: [] });
      queryClient.setQueryData(marketFillsKey(ID), []);
      queryClient.setQueryData(marketKey(ID), market);

      const done = applyTradeResult(queryClient, tradeResult);

      // One synchronous block, before a single request goes out.
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.balance).toEqual(tradeResult.balance);
      expect(queryClient.getQueryData<Position[]>(positionsKey('open'))?.[0]?.qty).toBe(32);
      expect(queryClient.getQueryData<Market>(marketKey(ID))?.pYesBp).toBe(6300);

      await done;

      // Exactly one refetch per mounted observer — the seed itself costs no request — and the
      // answer wins, which is the only ordering a Balance with no ledgerEntryId can have.
      expect(meFetches).toBe(loaded.me + 1);
      expect(positionFetches).toBe(loaded.positions + 1);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.balance).toEqual(refetchedMe.balance);
      // What the answer cannot seed is asked for again instead of being guessed.
      expect(queryClient.getQueryState(ORDERS_KEY)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(marketFillsKey(ID))?.isInvalidated).toBe(true);
    } finally {
      unsubscribeMe();
      unsubscribePositions();
      queryClient.clear();
    }
  });

  it('invents no session state for a tab that holds none', async () => {
    // `setQueryData` returns early on an updater that answers undefined, so a logged-out tab
    // (or one whose ['me'] was cleared by SessionCacheGuard mid-flight) gains no balance entry
    // — and no ['me'] query for the invalidation to refetch either.
    const queryClient = getQueryClient();
    try {
      await applyTradeResult(queryClient, tradeResult);

      expect(queryClient.getQueryData(ME_QUERY_KEY)).toBeUndefined();
      expect(queryClient.getQueryCache().find({ queryKey: ME_QUERY_KEY })).toBeUndefined();
      expect(queryClient.getQueryCache().find({ queryKey: POSITIONS_KEY })).toBeUndefined();
    } finally {
      queryClient.clear();
    }
  });
});

describe('applyTradeMarket', () => {
  it('writes the market and nothing private, which is all a foreign answer may write', async () => {
    // What `useTrade` applies when the answer belongs to an account this tab has left: nothing
    // cancels an in-flight POST, so A's balance and A's position row would otherwise land on
    // top of the caches SessionCacheGuard has just reset for B. The market moved because
    // SOMEBODY traded, so that half is written whoever is now signed in.
    const queryClient = getQueryClient();
    try {
      queryClient.setQueryData(marketKey(ID), market);
      queryClient.setQueryData<Me>(ME_QUERY_KEY, me);
      queryClient.setQueryData<Position[]>(positionsKey('open'), [position]);
      queryClient.setQueryData(marketFillsKey(ID), []);

      const done = applyTradeMarket(queryClient, tradeResult);

      expect(queryClient.getQueryData<Market>(marketKey(ID))?.pYesBp).toBe(6300);
      expect(queryClient.getQueryData<Market>(marketKey(ID))?.tradeCount).toBe(11);
      // The other account's balance and holdings are untouched, by reference.
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toBe(me);
      expect(queryClient.getQueryData<Position[]>(positionsKey('open'))?.[0]).toBe(position);

      await done;

      // 체결 내역 is public too: a fill happened, and the list has to go and read it.
      expect(queryClient.getQueryState(marketFillsKey(ID))?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.isInvalidated).toBe(false);
      expect(queryClient.getQueryState(positionsKey('open'))?.isInvalidated).toBe(false);
    } finally {
      queryClient.clear();
    }
  });
});

describe('applyMarketStats', () => {
  it('patches the detail and every cached list page, and drops a patch that is not newer', () => {
    // The seam with the socket handler: one reducer, one `supersedes(tradeCount)` rule, so
    // whichever of the trade answer and the market:tick arrives second is a no-op rather than a
    // rollback of the other.
    const queryClient = getQueryClient();
    try {
      queryClient.setQueryData(marketKey(ID), market);
      queryClient.setQueryData(marketsKey(DEFAULT_MARKET_FILTERS), pagesOf([card, otherCard]));
      queryClient.setQueryData(
        marketsKey({ ...DEFAULT_MARKET_FILTERS, sort: 'closing' }),
        pagesOf([otherCard], [card]),
      );

      applyMarketStats(queryClient, stats);

      expect(queryClient.getQueryData<Market>(marketKey(ID))).toEqual({
        ...market,
        lastPrice: 63,
        pYesBp: 6300,
        volumeP: '130000',
        tradeCount: 11,
      });
      const first = queryClient.getQueryData<MarketPages>(marketsKey(DEFAULT_MARKET_FILTERS));
      expect(first?.pages[0]?.items[0]).toEqual({
        ...card,
        lastPrice: 63,
        pYesBp: 6300,
        volumeP: '130000',
        tradeCount: 11,
        // The card's line has to end where its badge says it does.
        sparkline: [4800, 4900, 6300],
      });
      // The market this trade was not about is untouched, in the same page.
      expect(first?.pages[0]?.items[1]).toEqual(otherCard);
      // And so is the second filter's second page, keyed independently.
      const second = queryClient.getQueryData<MarketPages>(
        marketsKey({ ...DEFAULT_MARKET_FILTERS, sort: 'closing' }),
      );
      expect(second?.pages[1]?.items[0]?.pYesBp).toBe(6300);

      const updatedAt = queryClient.getQueryState(marketKey(ID))?.dataUpdatedAt;
      applyMarketStats(queryClient, { ...stats, lastPrice: 20, pYesBp: 2000, volumeP: '0' });

      // Equal tradeCount is a duplicate, not an update: no write, so no re-render and no
      // restarted staleTime either.
      expect(queryClient.getQueryData<Market>(marketKey(ID))?.pYesBp).toBe(6300);
      expect(queryClient.getQueryState(marketKey(ID))?.dataUpdatedAt).toBe(updatedAt);
      const dropped = queryClient.getQueryData<MarketPages>(marketsKey(DEFAULT_MARKET_FILTERS));
      expect(dropped?.pages[0]?.items[0]?.pYesBp).toBe(6300);
    } finally {
      queryClient.clear();
    }
  });

  it('creates no cache entry for a market nothing on screen holds', () => {
    // `setQueryData` and `setQueriesData` both answer undefined here, and neither builds an
    // entry — a market the trader reached from nowhere must not appear in a list it is not in.
    const queryClient = getQueryClient();
    try {
      queryClient.setQueryData(marketsKey(DEFAULT_MARKET_FILTERS), pagesOf([card]));

      applyMarketStats(queryClient, { ...stats, id: THIRD_ID });

      expect(queryClient.getQueryData(marketKey(THIRD_ID))).toBeUndefined();
      const held = queryClient.getQueryData<MarketPages>(marketsKey(DEFAULT_MARKET_FILTERS));
      expect(held?.pages[0]?.items[0]).toEqual(card);
    } finally {
      queryClient.clear();
    }
  });
});

describe('mergePosition', () => {
  it('replaces the (marketId, outcome) row, appends when absent and drops a stale version', () => {
    const traded = tradeResult.position;

    expect(mergePosition([otherPosition, position], traded)).toEqual([otherPosition, traded]);
    // The first trade in a market: newest first, the order GET /me/positions answers in.
    expect(mergePosition([otherPosition], traded)).toEqual([traded, otherPosition]);
    // The same (market, outcome) on the other side is a different row.
    expect(mergePosition([{ ...position, outcome: 'NO' }], traded)).toEqual([
      traded,
      { ...position, outcome: 'NO' },
    ]);
    // A replay of the answer this cache already has, and an older one: both dropped, so a
    // trade answer and a user:position event for the same write cannot undo each other.
    expect(mergePosition([traded], traded)).toBeUndefined();
    expect(mergePosition([traded], { ...traded, qty: 1, version: 7 })).toBeUndefined();
    // Nothing cached is nothing to correct; the invalidation that follows fetches the row.
    expect(mergePosition(undefined, traded)).toBeUndefined();
  });

  it('seeds the open list and leaves 정산 이력 alone', () => {
    // A trade can only move an open position (`assertTradable` refuses every other status), so
    // prepending its answer into a cached settled list would show an unsettled row under
    // 정산 이력 until the next fetch. Both lists are still invalidated by applyTradeResult.
    const queryClient = getQueryClient();
    try {
      queryClient.setQueryData(positionsKey('open'), [otherPosition, position]);
      queryClient.setQueryData(positionsKey('settled'), [settledPosition]);

      applyPositionRow(queryClient, tradeResult.position);

      expect(queryClient.getQueryData<Position[]>(positionsKey('open'))).toEqual([
        otherPosition,
        tradeResult.position,
      ]);
      expect(queryClient.getQueryData<Position[]>(positionsKey('settled'))).toEqual([
        settledPosition,
      ]);
    } finally {
      queryClient.clear();
    }
  });
});

describe('heldQtyOf', () => {
  it('tells 보유 없음 from 아직 모름', () => {
    // 0 refuses a sell before it costs a round trip; undefined never blocks one, because a
    // panel that refused on a list it has not loaded would be inventing a refusal.
    expect(heldQtyOf([otherPosition, position], ID, 'YES')).toBe(12);
    expect(heldQtyOf([position], ID, 'NO')).toBe(0);
    expect(heldQtyOf([], ID, 'YES')).toBe(0);
    expect(heldQtyOf(undefined, ID, 'YES')).toBeUndefined();
    // A row traded down to zero is still a row (status=open keeps it), and still not unknown.
    expect(heldQtyOf([{ ...position, qty: 0 }], ID, 'YES')).toBe(0);
  });
});
