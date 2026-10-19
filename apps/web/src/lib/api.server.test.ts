import { MARKET_LIST_STATUSES, MARKET_SORTS } from '@buddha/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  fetchMarketSearchPageServer as FetchMarketSearchPage,
  fetchMarketsPageServer as FetchMarketsPage,
  fetchPostsPageServer as FetchPostsPage,
  fetchRelatedMarketsPageServer as FetchRelatedMarketsPage,
} from './api.server';
import { type MarketFilters, type MarketSearch } from './market-keys';

/**
 * The SSR reads of `GET /markets`: the home's (`fetchMarketsPageServer`), per order, and the
 * search screen's first page (`fetchMarketSearchPageServer`, owner decision 2026-10-16,
 * ADR-0066), per status and order — and the detail's 관련 시장 (`fetchRelatedMarketsPageServer`,
 * #65), whose path names the market. Each list's first paint is its read's dehydrated pages, so a
 * prefetch that dropped the order, the status or the category would paint the wrong cards under
 * the right select value and URL — and the API answers such a request with its defaults (추천,
 * `open`, every category), so nothing else would fail.
 *
 * The server client is built when the module loads, with the `fetch` it finds then, so `fetch` is
 * stubbed first and the module imported after it; nothing leaves the process.
 */

const requests: URL[] = [];
const fakeFetch = vi.fn((input: Request) => {
  requests.push(new URL(input.url));
  return Promise.resolve(
    new Response(JSON.stringify({ data: [], meta: { nextCursor: null } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
});

// A type-only import above (erased): the module itself is imported after the stub, below.
let fetchMarketsPageServer: typeof FetchMarketsPage;
let fetchMarketSearchPageServer: typeof FetchMarketSearchPage;
let fetchRelatedMarketsPageServer: typeof FetchRelatedMarketsPage;
let fetchPostsPageServer: typeof FetchPostsPage;

beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  ({
    fetchMarketsPageServer,
    fetchMarketSearchPageServer,
    fetchRelatedMarketsPageServer,
    fetchPostsPageServer,
  } = await import('./api.server'));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

/** The query a request carried, as a plain object. */
const queryOf = (url: URL) => Object.fromEntries(url.searchParams);

describe('fetchMarketsPageServer', () => {
  it('sends the home’s status and the order picked, and the category and cursor when there are', async () => {
    requests.length = 0;
    for (const sort of MARKET_SORTS) {
      const plain: MarketFilters = { sort };
      const narrowed: MarketFilters = { sort, category: 'economy' };
      await expect(fetchMarketsPageServer(plain)).resolves.toEqual({
        items: [],
        nextCursor: null,
      });
      await fetchMarketsPageServer(narrowed, 'cursor-1');
    }
    expect(requests.map((url) => url.pathname)).toEqual(
      MARKET_SORTS.flatMap(() => ['/api/v1/markets', '/api/v1/markets']),
    );
    expect(requests.map(queryOf)).toEqual(
      MARKET_SORTS.flatMap((sort) => [
        { status: 'open', sort },
        { status: 'open', sort, category: 'economy', cursor: 'cursor-1' },
      ]),
    );
  });
});

describe('fetchMarketSearchPageServer', () => {
  it('sends the term, the status and the order always, and the category and cursor when there are', async () => {
    requests.length = 0;
    const cases = MARKET_LIST_STATUSES.flatMap((status) =>
      MARKET_SORTS.map((sort) => ({ status, sort })),
    );
    for (const { status, sort } of cases) {
      const plain: MarketSearch = { q: '금리', status, sort };
      await expect(fetchMarketSearchPageServer(plain)).resolves.toEqual({
        items: [],
        nextCursor: null,
      });
      await fetchMarketSearchPageServer({ ...plain, category: 'economy' }, 'cursor-1');
    }
    expect(new Set(requests.map((url) => url.pathname))).toEqual(new Set(['/api/v1/markets']));
    expect(requests.map(queryOf)).toEqual(
      cases.flatMap(({ status, sort }) => [
        { status, sort, q: '금리' },
        { status, sort, q: '금리', category: 'economy', cursor: 'cursor-1' },
      ]),
    );
  });
});

describe('fetchRelatedMarketsPageServer', () => {
  it('asks the market’s related route, by its id, with the cursor only when there is one', async () => {
    requests.length = 0;
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    await expect(fetchRelatedMarketsPageServer(id)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await fetchRelatedMarketsPageServer(id, 'cursor-1');
    expect(requests.map((url) => url.pathname)).toEqual([
      `/api/v1/markets/${id}/related`,
      `/api/v1/markets/${id}/related`,
    ]);
    // No order and no status: the owner fixed both (ADR-0061 decision 1, item 19).
    expect(requests.map(queryOf)).toEqual([{}, { cursor: 'cursor-1' }]);
  });
});

describe('fetchPostsPageServer', () => {
  it('sends the filters that are on as the list asks for them (#46), the market as marketId', async () => {
    requests.length = 0;
    const market = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    await expect(fetchPostsPageServer({})).resolves.toEqual({ items: [], nextCursor: null });
    await fetchPostsPageServer({ market, category: 'economy', q: '금리' }, 'cursor-1');
    expect(requests.map((url) => url.pathname)).toEqual(['/api/v1/posts', '/api/v1/posts']);
    expect(requests.map(queryOf)).toEqual([
      {},
      { marketId: market, category: 'economy', q: '금리', cursor: 'cursor-1' },
    ]);
  });
});
