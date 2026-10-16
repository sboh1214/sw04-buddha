import { QueryClient, dehydrate, hashKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { type Market, type PriceSeries } from './api';
import { MARKET_SORTS } from '@buddha/shared';
import {
  DEFAULT_MARKET_FILTERS,
  type MarketFilters,
  dehydratePublic,
  marketsKey,
} from './market-keys';
import { detailWindowEnd, filtersFromSearchParams, seedMarketDetail } from './market-ssr';

const MARKET_ID = '1f2e3d4c-0000-4000-8000-000000000000';

const market: Market = {
  id: MARKET_ID,
  slug: 'first-snow',
  title: 'first snow',
  category: { slug: 'weather', nameKo: '날씨' },
  imageUrl: null,
  status: 'open',
  lastPrice: 63,
  volumeCoin: '1250000',
  tradeCount: 12,
  traderCount: 5,
  closeAt: '2026-12-01T00:00:00.000Z',
  openAt: '2026-09-01T00:00:00.000Z',
  resolvedResult: null,
  statusEventId: '2',
  createdAt: '2026-08-31T00:00:00.000Z',
  description: null,
  rules: 'rules text',
  resolutionSource: null,
  resolvedAt: null,
  settledAt: null,
  voidedAt: null,
};

const series: PriceSeries = {
  resolution: '1m',
  bucketSeconds: 300,
  from: '2026-09-06T00:00:00.000Z',
  to: '2026-09-07T00:00:00.000Z',
  truncated: false,
  tradeCount: 41,
  points: [
    { ts: '2026-09-06T00:00:00.000Z', pYesBp: 5000, trigger: 'trade' },
    { ts: '2026-09-06T12:00:00.000Z', pYesBp: 6300, trigger: 'trade' },
  ],
};

describe('seedMarketDetail', () => {
  it('seeds exactly the detail row and its default range, keyed on the uuid', () => {
    const queryClient = new QueryClient();
    seedMarketDetail(queryClient, market, series);

    // The slug is what the URL carried, but every live write (market:tick, the ticks and fills
    // routes) speaks uuids, so a slug-keyed entry would never be updated.
    const keys = dehydrate(queryClient).queries.map((query) => query.queryKey);
    expect(keys).toHaveLength(2);
    expect(keys).toContainEqual(['market', MARKET_ID]);
    expect(keys).toContainEqual(['ticks', MARKET_ID, '1D']);
  });

  it('seeds the values the screens read back, not a copy of them', () => {
    const queryClient = new QueryClient();
    seedMarketDetail(queryClient, market, series);

    expect(queryClient.getQueryData(['market', MARKET_ID])).toBe(market);
    expect(queryClient.getQueryData(['ticks', MARKET_ID, '1D'])).toBe(series);
  });

  it('dehydrates to plain JSON, so no serialize/deserialize transformer is needed', () => {
    const queryClient = new QueryClient();
    seedMarketDetail(queryClient, market, series);

    // Every Coin amount is a decimal string and every instant an ISO string: no bigint, no Date, no
    // undefined. toStrictEqual rather than toEqual because a dropped `undefined` property is
    // exactly what a missing transformer would look like.
    const state = dehydratePublic(queryClient);
    expect(JSON.parse(JSON.stringify(state))).toStrictEqual(state);
  });

  it('cannot leak a private query into the SSR payload', () => {
    const queryClient = new QueryClient();
    seedMarketDetail(queryClient, market, series);
    // The RSC payload Next inlines into the HTML would otherwise carry one account's data,
    // and refill the cache SessionCacheGuard exists to empty.
    queryClient.setQueryData(['me'], { profile: { nickname: 'someone' } });

    expect(dehydratePublic(queryClient).queries.map((query) => query.queryKey[0])).toEqual([
      'market',
      'ticks',
    ]);
  });

  it('seeds the row alone when the ticks read failed, leaving the key for the client', () => {
    const queryClient = new QueryClient();
    // A failed `GET /markets/:id/ticks` must not take the question and the 규칙 down with
    // it, so the page renders with `null` here. The ticks key must then stay UNBUILT: seeding
    // the `null` would build a SUCCESSFUL query holding it, and the chart reads `held.points`
    // straight off a settled ticks query instead of fetching and reporting the failure itself.
    seedMarketDetail(queryClient, market, null);

    const keys = dehydrate(queryClient).queries.map((query) => query.queryKey);
    expect(keys).toEqual([['market', MARKET_ID]]);
    expect(queryClient.getQueryState(['ticks', MARKET_ID, '1D'])).toBeUndefined();
  });
});

describe('detailWindowEnd', () => {
  it('is the window end the server closed on its own clock', () => {
    expect(detailWindowEnd(series)).toBe(Date.parse('2026-09-07T00:00:00.000Z'));
  });

  it('is absent when there is no series, so the countdown falls back to the close time', () => {
    expect(detailWindowEnd(null)).toBeUndefined();
  });

  it('is absent rather than NaN for an unparseable `to`', () => {
    // `z.iso.datetime()` makes this unrealistic, but a NaN would reach `CountdownBadge` as a
    // number, and `formatRemaining` divides by it — the badge would render a literal `NaN초`.
    expect(detailWindowEnd({ ...series, to: 'not a date' })).toBeUndefined();
  });
});

describe('filtersFromSearchParams', () => {
  /** The public view of one URL: what `marketsKey` is built from. */
  const publicView = (params: Parameters<typeof filtersFromSearchParams>[0]): MarketFilters => {
    const filters = filtersFromSearchParams(params);
    if (filters.watchlist === true) throw new Error('expected the public view');
    return filters;
  };

  it('falls back to the defaults for an absent, unknown or blank param', () => {
    expect(filtersFromSearchParams({})).toEqual(DEFAULT_MARKET_FILTERS);
    expect(DEFAULT_MARKET_FILTERS).toEqual({ sort: 'recommended' });
    // `price` is not a sort at all: a hand-typed URL, which may not 500 a public page.
    expect(filtersFromSearchParams({ sort: 'price' })).toEqual(DEFAULT_MARKET_FILTERS);
    expect(filtersFromSearchParams({ sort: '' })).toEqual(DEFAULT_MARKET_FILTERS);
    expect(filtersFromSearchParams({ sort: [] })).toEqual(DEFAULT_MARKET_FILTERS);
  });

  it('keeps each public order', () => {
    for (const sort of MARKET_SORTS) {
      expect(filtersFromSearchParams({ sort })).toEqual({ ...DEFAULT_MARKET_FILTERS, sort });
    }
  });

  it('ignores a bookmarked ?status= and ?sort=volume rather than redirecting (as D23 does)', () => {
    // The home has no status filter and lists open markets only (ADR-0061 decision 1, item 13),
    // and the volume order is gone until #132 (item 11). Links saved before still open the home,
    // on its default list — this PR changed both, the old expectations kept a status.
    expect(filtersFromSearchParams({ status: 'settled', sort: 'volume' })).toEqual(
      DEFAULT_MARKET_FILTERS,
    );
    expect(filtersFromSearchParams({ status: 'resolving', sort: 'newest' })).toEqual({
      ...DEFAULT_MARKET_FILTERS,
      sort: 'newest',
    });
    expect('status' in filtersFromSearchParams({ status: 'closed' })).toBe(false);
    // 최근 관심 등록 순 is the 관심 시장 view's alone (ADR-0061 decision 3, the #63 row).
    expect(filtersFromSearchParams({ sort: 'watched' })).toEqual(DEFAULT_MARKET_FILTERS);
  });

  it('ignores ?q= rather than redirecting: the search is its own screen (ADR-0066)', () => {
    // ADR-0061 decision 1, item 14: an old `/?q=rain` link opens the home on its default list,
    // not a search and not a redirect (D23's direction). This PR took `q` off the home, so the
    // expectations that kept it here are gone; lib/market-search.test.ts holds the screen's own.
    expect(filtersFromSearchParams({ q: 'rain' })).toEqual(DEFAULT_MARKET_FILTERS);
    expect(filtersFromSearchParams({ q: 'rain', sort: 'closing', category: 'weather' })).toEqual({
      sort: 'closing',
      category: 'weather',
    });
    expect('q' in filtersFromSearchParams({ q: 'rain' })).toBe(false);
  });

  it('takes the first value of a repeated param', () => {
    expect(
      filtersFromSearchParams({
        status: ['closed', 'open'],
        sort: ['newest', 'volume'],
        category: ['sports', 'weather'],
        q: ['snow', 'rain'],
      }),
    ).toEqual({ sort: 'newest', category: 'sports' });
  });

  it('trims a category, and drops what the API would refuse', () => {
    expect(filtersFromSearchParams({ category: '  weather  ' })).toEqual({
      ...DEFAULT_MARKET_FILTERS,
      category: 'weather',
    });
    // Over the API's own bound (category 50): dropped here rather than sent and answered with a
    // VALIDATION_ERROR the visitor cannot act on.
    expect(filtersFromSearchParams({ category: 'x'.repeat(51) })).toEqual(DEFAULT_MARKET_FILTERS);
  });

  it('omits a blank category so it shares one cache key with an absent one', () => {
    const blank = publicView({ q: '   ', category: ' ' });
    expect('q' in blank).toBe(false);
    expect('category' in blank).toBe(false);
    // The home page and the client list must derive the same key or the list refetches the
    // moment it hydrates.
    expect(hashKey(marketsKey(blank))).toBe(hashKey(marketsKey(publicView({}))));
    expect(hashKey(marketsKey(blank))).toBe(hashKey(marketsKey(DEFAULT_MARKET_FILTERS)));
  });

  it('ignores the order the params arrive in', () => {
    const a = publicView({ q: 'snow', status: 'open', sort: 'newest' });
    const b = publicView({ sort: 'newest', q: 'snow', status: 'open' });
    expect(hashKey(marketsKey(a))).toBe(hashKey(marketsKey(b)));
  });

  describe('the 관심 시장 view (?watchlist=1, ADR-0065)', () => {
    it('starts on 최근 관심 등록 순 and keeps the category', () => {
      expect(filtersFromSearchParams({ watchlist: '1' })).toEqual({
        watchlist: true,
        sort: 'watched',
      });
      expect(filtersFromSearchParams({ watchlist: '1', category: ' economy ' })).toEqual({
        watchlist: true,
        sort: 'watched',
        category: 'economy',
      });
    });

    it('takes the public orders too, and nothing else', () => {
      for (const sort of [...MARKET_SORTS, 'watched']) {
        expect(filtersFromSearchParams({ watchlist: '1', sort })).toEqual({
          watchlist: true,
          sort,
        });
      }
      for (const sort of ['volume', 'price', '']) {
        expect(filtersFromSearchParams({ watchlist: '1', sort })).toEqual({
          watchlist: true,
          sort: 'watched',
        });
      }
    });

    it('drops a search term and a status: the watchlist has neither', () => {
      expect(filtersFromSearchParams({ watchlist: '1', q: 'snow', status: 'closed' })).toEqual({
        watchlist: true,
        sort: 'watched',
      });
    });

    it('is on for exactly ?watchlist=1, the first value of a repeated one', () => {
      for (const value of ['0', 'true', 'on', '', ' 1']) {
        expect(filtersFromSearchParams({ watchlist: value })).toEqual(DEFAULT_MARKET_FILTERS);
      }
      expect(filtersFromSearchParams({ watchlist: ['1', '0'] })).toMatchObject({
        watchlist: true,
      });
      expect(filtersFromSearchParams({ watchlist: ['0', '1'] })).toEqual(DEFAULT_MARKET_FILTERS);
    });
  });
});
