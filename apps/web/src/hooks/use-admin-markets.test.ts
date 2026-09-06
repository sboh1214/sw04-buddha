import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { type AdminMarket } from '@/lib/api';
import {
  ADMIN_MARKETS_KEY,
  adminMarketKey,
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
  events: [],
};

const opened: AdminMarket = { ...draft, status: 'open', openAt: '2026-09-07T00:00:00.000Z' };

/**
 * The detail screen as it stands after one good load with the API gone: an observer is
 * mounted (so an invalidation actually refetches — with none, `refetchType: 'active'` matches
 * nothing and any assertion here would pass against the unfixed code too), the first fetch
 * answers the draft, every later one fails.
 */
async function loadedDetail(key = ID) {
  let fetches = 0;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const observer = new QueryObserver<AdminMarket>(queryClient, {
    queryKey: adminMarketKey(key),
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

  it('seeds the key the screen reads, not the id the API answered with', async () => {
    // The screen keys its query on the id in the URL. A request uuid is accepted in upper case
    // and answered in lower (uuidSchema lower-cases at the boundary), so seeding under
    // `fresh.id` would write a key nothing is reading and leave the screen stale.
    const upper = ID.toUpperCase();
    const { queryClient, observer, unsubscribe } = await loadedDetail(upper);
    try {
      await applyMarket(queryClient, upper, opened);
      expect(observer.getCurrentResult().data?.status).toBe('open');
      expect(queryClient.getQueryData(adminMarketKey(ID))).toBeUndefined();
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });
});
