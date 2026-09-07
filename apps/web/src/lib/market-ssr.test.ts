import { QueryClient, dehydrate, hashKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { type Market, type PriceSeries } from './api';
import { DEFAULT_MARKET_FILTERS, dehydratePublic, marketsKey } from './market-keys';
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
  pYesBp: 6300,
  volumeP: '1250000',
  tradeCount: 12,
  traderCount: 5,
  closeAt: '2026-12-01T00:00:00.000Z',
  openAt: '2026-09-01T00:00:00.000Z',
  resolvedResult: null,
  createdAt: '2026-08-31T00:00:00.000Z',
  description: null,
  rules: 'rules text',
  resolutionSource: null,
  resolvedAt: null,
  disputeUntil: null,
  settledAt: null,
  voidedAt: null,
};

const series: PriceSeries = {
  resolution: '1m',
  bucketSeconds: 300,
  from: '2026-09-06T00:00:00.000Z',
  to: '2026-09-07T00:00:00.000Z',
  truncated: false,
  points: [
    { ts: '2026-09-06T00:00:00.000Z', pYesBp: 5000, trigger: 'open' },
    { ts: '2026-09-06T12:00:00.000Z', pYesBp: 6300, trigger: 'trade' },
  ],
};

describe('seedMarketDetail', () => {
  it('seeds exactly the detail row and its default range, keyed on the uuid', () => {
    const queryClient = new QueryClient();
    seedMarketDetail(queryClient, market, series);

    // The slug is what the URL carried, but every live write (market:tick, TradeResult, the
    // ticks and fills routes) speaks uuids, so a slug-keyed entry would never be updated.
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

    // Every P is a decimal string and every instant an ISO string: no bigint, no Date, no
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
    // A failed `GET /markets/:id/ticks` must not take the question and the 정산 기준 down with
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
  it('falls back to the defaults for an absent, unknown or blank param', () => {
    expect(filtersFromSearchParams({})).toEqual(DEFAULT_MARKET_FILTERS);
    // `draft` is a real status the public list may not filter by; `price` is not a sort at
    // all. Both are hand-typed URLs, and neither may 500 a public page.
    expect(filtersFromSearchParams({ status: 'draft', sort: 'price' })).toEqual(
      DEFAULT_MARKET_FILTERS,
    );
    expect(filtersFromSearchParams({ status: '', sort: '' })).toEqual(DEFAULT_MARKET_FILTERS);
    expect(filtersFromSearchParams({ status: [], sort: [] })).toEqual(DEFAULT_MARKET_FILTERS);
  });

  it('keeps a known status and sort', () => {
    expect(filtersFromSearchParams({ status: 'settled', sort: 'closing' })).toEqual({
      status: 'settled',
      sort: 'closing',
    });
  });

  it('takes the first value of a repeated param', () => {
    expect(
      filtersFromSearchParams({
        status: ['closed', 'open'],
        sort: ['newest', 'volume'],
        category: ['sports', 'weather'],
        q: ['snow', 'rain'],
      }),
    ).toEqual({ status: 'closed', sort: 'newest', category: 'sports', q: 'snow' });
  });

  it('trims a category and a search term, and drops what the API would refuse', () => {
    expect(filtersFromSearchParams({ category: '  weather  ', q: '  snow  ' })).toEqual({
      ...DEFAULT_MARKET_FILTERS,
      category: 'weather',
      q: 'snow',
    });
    // Over the API's own bounds (category 50, q 100): dropped here rather than sent and
    // answered with a VALIDATION_ERROR the visitor cannot act on.
    expect(filtersFromSearchParams({ category: 'x'.repeat(51), q: 'y'.repeat(101) })).toEqual(
      DEFAULT_MARKET_FILTERS,
    );
  });

  it('omits a blank search term so it shares one cache key with an absent one', () => {
    const blank = filtersFromSearchParams({ q: '   ', category: ' ' });
    expect('q' in blank).toBe(false);
    expect('category' in blank).toBe(false);
    // The home page and the client list must derive the same key or the list refetches the
    // moment it hydrates.
    expect(hashKey(marketsKey(blank))).toBe(hashKey(marketsKey(filtersFromSearchParams({}))));
    expect(hashKey(marketsKey(blank))).toBe(hashKey(marketsKey(DEFAULT_MARKET_FILTERS)));
  });

  it('ignores the order the params arrive in', () => {
    const a = filtersFromSearchParams({ q: 'snow', status: 'open', sort: 'volume' });
    const b = filtersFromSearchParams({ sort: 'volume', q: 'snow', status: 'open' });
    expect(hashKey(marketsKey(a))).toBe(hashKey(marketsKey(b)));
  });
});
