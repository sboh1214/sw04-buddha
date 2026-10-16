import { QueryClient, QueryObserver, partialMatchKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { type AdminMarket, type AdminRelatedMarket } from '@/lib/api';
import { DEFAULT_MARKET_FILTERS, marketsKey, relatedMarketsKey } from '@/lib/market-keys';
import { type MarketPages } from '@/lib/market-live';
import {
  ADMIN_MARKETS_KEY,
  ADMIN_RELATED_MARKETS_KEY,
  adminMarketKey,
  adminMarketQueryOptions,
  adminRelatedMarketsKey,
  adminRelatedSearchKey,
  applyMarket,
  applyRelatedMarkets,
  marketFillsKey,
} from './use-admin-markets';

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const draft: AdminMarket = {
  id: ID,
  slug: 'rate-cut-2026',
  title: '기준금리 인하?',
  description: null,
  rules: '한국은행 발표 기준.',
  resolutionSource: null,
  category: { slug: 'economy', nameKo: '경제' },
  imageUrl: null,
  status: 'draft',
  lastPrice: null,
  volumeCoin: '0',
  tradeCount: 0,
  traderCount: 0,
  closeAt: '2026-10-01T00:00:00.000Z',
  openAt: null,
  resolvedResult: null,
  resolvedAt: null,
  settledAt: null,
  voidedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  createdBy: 'admin',
  netCollectedCoin: '0',
  openInterest: { yes: 0, no: 0 },
  settlementSteps: [],
  statusEventId: '1',
  events: [],
};

const opened: AdminMarket = { ...draft, status: 'open', openAt: '2026-09-07T00:00:00.000Z' };

/**
 * The detail screen as it stands after one good load with the API gone: an observer is
 * mounted (so an invalidation actually refetches — with none, `refetchType: 'active'` matches
 * nothing and any assertion here would pass against the unfixed code too), the first fetch
 * answers the draft, every later one fails.
 */
async function loadedDetail(id = ID, queryKey: readonly unknown[] = adminMarketKey(id)) {
  let fetches = 0;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const observer = new QueryObserver<AdminMarket>(queryClient, {
    queryKey,
    queryFn: () => {
      fetches += 1;
      return fetches === 1 ? Promise.resolve(draft) : Promise.reject(new Error('API is down'));
    },
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  await observer.refetch();
  return { queryClient, observer, unsubscribe, fetches: () => fetches };
}

describe('applyMarket', () => {
  it('keeps the transitioned row on screen when the invalidation refetch fails', async () => {
    // The bug this pins: the POST succeeded, so the admin was told the market opened. With the
    // response discarded and the refetch failing, react-query keeps the row it had — `draft`,
    // with a live open button, under a success toast.
    const { queryClient, observer, unsubscribe, fetches } = await loadedDetail();
    try {
      expect(observer.getCurrentResult().data?.status).toBe('draft');

      await applyMarket(queryClient, ID, opened);

      const result = observer.getCurrentResult();
      expect(result.data?.status).toBe('open');
      expect(result.data?.openAt).toBe(opened.openAt);
      // The screen's own policy is untouched: the cached row stays and the notice still says
      // the latest could not be loaded (it is not a first-load failure that empties the page).
      expect(result.isRefetchError).toBe(true);
      expect(result.isLoadingError).toBe(false);
      // The seed costs no request, and the invalidation asks exactly once.
      expect(fetches()).toBe(2);
      // Still invalidated, so the next window focus tries again.
      expect(queryClient.getQueryState(adminMarketKey(ID))?.isInvalidated).toBe(true);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it('seeds the detail only, and invalidates the fills and every filtered list page', async () => {
    // A transition answers with the market, not with its fills or with any list page: those
    // are invalidated so they reload, never written from this response.
    const { queryClient, unsubscribe } = await loadedDetail();
    try {
      queryClient.setQueryData(marketFillsKey(ID), []);
      queryClient.setQueryData([...ADMIN_MARKETS_KEY, 'draft'], []);

      await applyMarket(queryClient, ID, opened);

      expect(queryClient.getQueryData(marketFillsKey(ID))).toEqual([]);
      expect(queryClient.getQueryState(marketFillsKey(ID))?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState([...ADMIN_MARKETS_KEY, 'draft'])?.isInvalidated).toBe(true);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it('puts the judgement on screen with its settlement steps, whatever the refetch does', async () => {
    // The 판정 answer is the market as the transaction committed it (ADR-0046): `resolved`, the
    // result, and one `pending` row per settlement step. The 정산 단계 panel reads that row, so
    // the admin sees the step the worker is about to run even when the refetch after it fails.
    const { queryClient, observer, unsubscribe } = await loadedDetail();
    const at = '2026-10-01T00:05:00.000Z';
    const judged: AdminMarket = {
      ...opened,
      status: 'resolved',
      resolvedResult: 'YES',
      resolvedAt: at,
      statusEventId: '4',
      settlementSteps: [
        {
          step: 'coin',
          status: 'pending',
          attempts: 0,
          completedAt: null,
          lastError: null,
          updatedAt: at,
        },
      ],
    };
    try {
      await applyMarket(queryClient, ID, judged);

      const result = observer.getCurrentResult();
      expect(result.data?.status).toBe('resolved');
      expect(result.data?.settlementSteps).toEqual(judged.settlementSteps);
      expect(result.isRefetchError).toBe(true);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it('lands a transition opened from an upper-case URL on the key that screen reads', async () => {
    // The two decisions the detail screen is made of, composed the way it composes them: the
    // query is keyed by `adminMarketQueryOptions(routeId)` and every child writes through
    // `market.id`. A uuid is accepted in either case and answered in lower, so keying on the
    // segment as typed left the write on a key the screen never read — the status badge and
    // the transition buttons kept the old row while the toast said otherwise.
    const routeId = ID.toUpperCase();
    const key = adminMarketQueryOptions(routeId).queryKey;
    expect(key).toEqual(adminMarketKey(ID));
    const { queryClient, observer, unsubscribe } = await loadedDetail(routeId, key);
    try {
      // What RecentFills reads, keyed on the same `market.id` its sibling writes through.
      queryClient.setQueryData(marketFillsKey(opened.id), []);

      await applyMarket(queryClient, opened.id, opened);

      expect(observer.getCurrentResult().data?.status).toBe('open');
      // And the fills of that market are asked for again — the half fix (route id for the
      // detail, response id for the fills) breaks exactly this.
      expect(queryClient.getQueryState(marketFillsKey(opened.id))?.isInvalidated).toBe(true);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it('sends no request for a segment that cannot name a market', () => {
    expect(adminMarketQueryOptions('abc').enabled).toBe(false);
    expect(adminMarketQueryOptions(ID).enabled).toBe(true);
    expect(adminMarketQueryOptions(ID).queryKey).toEqual(adminMarketKey(ID));
  });
});

const OTHER_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';

/** B as A's admin list holds it once linked: the list row plus who linked it and when. */
const linkedOther: AdminRelatedMarket = {
  id: OTHER_ID,
  slug: 'other',
  title: '다른 시장',
  category: { slug: 'economy', nameKo: '경제' },
  imageUrl: null,
  status: 'open',
  lastPrice: null,
  volumeCoin: '0',
  tradeCount: 0,
  traderCount: 0,
  closeAt: '2026-10-01T00:00:00.000Z',
  openAt: '2026-09-07T00:00:00.000Z',
  resolvedResult: null,
  statusEventId: '2',
  createdAt: '2026-09-01T00:00:00.000Z',
  linkedBy: { id: 'admin', nickname: '관리자' },
  linkedAt: '2026-09-08T00:00:00.000Z',
};

/** A public 관련 시장 list as the detail holds it: one page, no cursor. */
const relatedPages = (): MarketPages => ({
  pages: [{ items: [], nextCursor: null }],
  pageParams: [undefined],
});

/**
 * A's 관련 시장 panel after one good load with the API gone: mounted, so the invalidation really
 * refetches (see `loadedDetail`); the first fetch answers no links, every later one fails.
 */
async function loadedLinks() {
  let fetches = 0;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const observer = new QueryObserver<AdminRelatedMarket[]>(queryClient, {
    queryKey: adminRelatedMarketsKey(ID),
    queryFn: () => {
      fetches += 1;
      return fetches === 1 ? Promise.resolve([]) : Promise.reject(new Error('API is down'));
    },
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  await observer.refetch();
  return { queryClient, observer, unsubscribe, fetches: () => fetches };
}

/**
 * One market's 관련 시장 list mounted on `queryClient` (so an invalidation really refetches, see
 * `loadedDetail`), answering `rows` every time and counting its requests.
 */
function mountedLinks(queryClient: QueryClient, id: string, rows: AdminRelatedMarket[]) {
  let fetches = 0;
  const observer = new QueryObserver<AdminRelatedMarket[]>(queryClient, {
    queryKey: adminRelatedMarketsKey(id),
    queryFn: () => {
      fetches += 1;
      return Promise.resolve(rows);
    },
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  return { loaded: observer.refetch(), unsubscribe, fetches: () => fetches };
}

describe('applyRelatedMarkets (#65, ADR-0068)', () => {
  it('keeps the links the write answered on screen when the refetch after it fails', async () => {
    // The same hazard `applyMarket` pins: the POST linked B, the toast says so, and a refetch
    // that fails would otherwise leave '연결된 관련 시장이 없습니다.' under it.
    const { queryClient, observer, unsubscribe, fetches } = await loadedLinks();
    try {
      expect(observer.getCurrentResult().data).toEqual([]);

      await applyRelatedMarkets(queryClient, ID, OTHER_ID, [linkedOther]);

      const result = observer.getCurrentResult();
      expect(result.data).toEqual([linkedOther]);
      expect(result.isRefetchError).toBe(true);
      // The seed costs no request, and the invalidation asks exactly once.
      expect(fetches()).toBe(2);
      expect(queryClient.getQueryState(adminRelatedMarketsKey(ID))?.isInvalidated).toBe(true);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it("asks again for the other market's links and every public 관련 시장 list, and nothing else", async () => {
    // Both details change (two-way, ADR-0061 decision 1, item 19): B's admin panel, cached empty
    // a moment ago and still inside `staleTime`, must not mount on that list; nor may A's or B's
    // public section this tab holds. The answer is A's links, so B's are never written from it.
    const { queryClient, unsubscribe } = await loadedLinks();
    try {
      queryClient.setQueryData(adminRelatedMarketsKey(OTHER_ID), []);
      queryClient.setQueryData(relatedMarketsKey(ID), relatedPages());
      queryClient.setQueryData(relatedMarketsKey(OTHER_ID), relatedPages());
      queryClient.setQueryData(marketsKey(DEFAULT_MARKET_FILTERS), relatedPages());
      queryClient.setQueryData(adminMarketKey(ID), draft);

      await applyRelatedMarkets(queryClient, ID, OTHER_ID, [linkedOther]);

      const state = (key: readonly unknown[]) => queryClient.getQueryState(key);
      expect(queryClient.getQueryData(adminRelatedMarketsKey(OTHER_ID))).toEqual([]);
      expect(state(adminRelatedMarketsKey(OTHER_ID))?.isInvalidated).toBe(true);
      expect(state(relatedMarketsKey(ID))?.isInvalidated).toBe(true);
      expect(state(relatedMarketsKey(OTHER_ID))?.isInvalidated).toBe(true);
      // A link moves no market (#65's AC): the detail and the home's lists are left alone.
      expect(state(adminMarketKey(ID))?.isInvalidated).toBe(false);
      expect(queryClient.getQueryData(adminMarketKey(ID))).toBe(draft);
      expect(state(marketsKey(DEFAULT_MARKET_FILTERS))?.isInvalidated).toBe(false);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it("keeps the links out of the detail's seed, and the picker's search inside the lists'", () => {
    // The links sit under their own root, not under `adminMarketKey(id)`: a transition's seed of
    // the detail never lands on them. The picker's search sits under the admin list's prefix, so
    // a transition re-reads the statuses it shows — as an object element, so no status filter's
    // entry is it.
    expect(partialMatchKey(adminRelatedMarketsKey(ID), adminMarketKey(ID))).toBe(false);
    expect(partialMatchKey(adminRelatedMarketsKey(ID), ADMIN_RELATED_MARKETS_KEY)).toBe(true);
    expect(adminRelatedMarketsKey(ID.toUpperCase())).toEqual(adminRelatedMarketsKey(ID));
    expect(partialMatchKey(adminRelatedSearchKey('첫눈'), ADMIN_MARKETS_KEY)).toBe(true);
    for (const status of ['all', 'draft', 'open']) {
      expect(partialMatchKey(adminRelatedSearchKey('첫눈'), [...ADMIN_MARKETS_KEY, status])).toBe(
        false,
      );
    }
  });

  it("re-reads every other market's links on a transition, never seeds them, and leaves its own", async () => {
    // Review on #65: each row of a 관련 시장 list badges the market at its other end. B's list
    // holds A, so A's transition must reach it — or B's panel, mounted again inside `staleTime`,
    // goes on calling A '초안' under a hint that says a draft is not shown. A's own list holds only
    // other markets, which A's transition does not move, and it is mounted on A's screen: asking
    // it again would be one request per write for nothing. (This test pinned the opposite for
    // every list before: no transition asked any of them.)
    const { queryClient, unsubscribe } = await loadedDetail();
    const THIRD_ID = 'c3d4e5f6-0000-4000-8000-000000000003';
    const linkedSelf: AdminRelatedMarket = {
      ...linkedOther,
      id: ID,
      slug: draft.slug,
      title: draft.title,
      status: 'draft',
      openAt: null,
    };
    const own = mountedLinks(queryClient, ID, [linkedOther]);
    const other = mountedLinks(queryClient, OTHER_ID, [linkedSelf]);
    try {
      await Promise.all([own.loaded, other.loaded]);
      // A third market's list, cached but not on screen: marked, and its next mount asks.
      queryClient.setQueryData(adminRelatedMarketsKey(THIRD_ID), [linkedSelf]);
      queryClient.setQueryData(adminRelatedSearchKey('첫눈'), relatedPages());

      await applyMarket(queryClient, ID, opened);

      const state = (key: readonly unknown[]) => queryClient.getQueryState(key);
      expect(own.fetches()).toBe(1);
      expect(state(adminRelatedMarketsKey(ID))?.isInvalidated).toBe(false);
      expect(queryClient.getQueryData(adminRelatedMarketsKey(ID))).toEqual([linkedOther]);
      expect(other.fetches()).toBe(2);
      expect(state(adminRelatedMarketsKey(THIRD_ID))?.isInvalidated).toBe(true);
      // Nothing is written into a list: the seed is the detail's alone.
      expect(queryClient.getQueryData(adminRelatedMarketsKey(THIRD_ID))).toEqual([linkedSelf]);
      expect(state(adminRelatedSearchKey('첫눈'))?.isInvalidated).toBe(true);
    } finally {
      own.unsubscribe();
      other.unsubscribe();
      unsubscribe();
      queryClient.clear();
    }
  });
});
