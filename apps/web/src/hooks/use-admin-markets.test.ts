import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { adminDisputesKey } from '@/lib/admin-disputes';
import { type AdminMarket } from '@/lib/api';
import {
  ADMIN_MARKETS_KEY,
  adminMarketKey,
  adminMarketQueryOptions,
  applyMarket,
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
  lastPrice: 30,
  pYesBp: 3000,
  volumeP: '0',
  tradeCount: 0,
  traderCount: 0,
  closeAt: '2026-10-01T00:00:00.000Z',
  openAt: null,
  resolvedResult: null,
  resolvedAt: null,
  disputeUntil: null,
  settledAt: null,
  voidedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  liquidityB: '1000.000000',
  qYes: '-847.2978603872',
  qNo: '0.0000000000',
  initialProbBp: 3000,
  reserveP: '120398',
  createdBy: 'admin',
  netCollectedP: '0',
  openInterest: { yes: 0, no: 0 },
  disputeCounts: { open: 0, accepted: 0, rejected: 0 },
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

  it('re-asks the 이의 목록, whose rows carry a copy of the market', async () => {
    // The mirror of `applyReviewedDispute`, which already invalidates the market detail because
    // its 이의 counts moved. An `AdminDispute` embeds `marketStatus`, `resolvedResult` and
    // `statusEventId` (A-M5-20), and the list joins no market room — so after a 결과 변경 or a
    // 무효 the cached group heading kept the result the admin had just replaced, for whatever
    // its 30초 staleTime had left. The admin's own path runs through it: the 수용 dialog sends
    // them to the market detail to change a result, and the detail links back to this list.
    //
    // Marked, not refetched: `refetchType` stays `'active'` and no 이의 목록 is mounted on
    // `/admin/markets/[id]`, so this costs no request (PLAN 11.5).
    const { queryClient, unsubscribe } = await loadedDetail();
    try {
      const filtered = adminDisputesKey({ marketId: ID });
      queryClient.setQueryData(filtered, { pages: [], pageParams: [] });

      await applyMarket(queryClient, ID, opened);

      expect(queryClient.getQueryState(filtered)?.isInvalidated).toBe(true);
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
