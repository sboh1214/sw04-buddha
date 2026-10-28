import { MARKET_LIST_STATUSES, MARKET_SORTS } from '@buddha/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  fetchMarketSearchPageServer as FetchMarketSearchPage,
  fetchMarketsPageServer as FetchMarketsPage,
  fetchNoticeServer as FetchNotice,
  fetchPinnedNoticesServer as FetchPinnedNotices,
  fetchPostsPageServer as FetchPostsPage,
  fetchProfileServer as FetchProfile,
  fetchRelatedMarketsPageServer as FetchRelatedMarketsPage,
  lookUpWriteMarketServer as LookUpWriteMarket,
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

/** A notice id the fake API answers NOT_FOUND for, as it does for a notice that never was. */
const MISSING_NOTICE = '0b3e6f1a-2c4d-4e5f-8a9b-1c2d3e4f5a6b';

const fakeFetch = vi.fn((input: Request) => {
  requests.push(new URL(input.url));
  if (new URL(input.url).pathname === `/api/v1/notices/${MISSING_NOTICE}`) {
    return Promise.resolve(
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Notice not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
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
let lookUpWriteMarketServer: typeof LookUpWriteMarket;
let fetchPinnedNoticesServer: typeof FetchPinnedNotices;
let fetchNoticeServer: typeof FetchNotice;
let fetchProfileServer: typeof FetchProfile;

beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  ({
    fetchMarketsPageServer,
    fetchMarketSearchPageServer,
    fetchRelatedMarketsPageServer,
    fetchPostsPageServer,
    lookUpWriteMarketServer,
    fetchPinnedNoticesServer,
    fetchNoticeServer,
    fetchProfileServer,
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

describe('the write page’s read of its market (lookUpWriteMarketServer)', () => {
  const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const answer = (status: number, body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const refusal = (status: number, code: string) =>
    answer(status, { error: { code, message: 'x' } });

  it('is none only when the API says there is no such market, and failed for any other failure (Codex review of #219, round 2)', async () => {
    fakeFetch.mockImplementationOnce(() =>
      answer(200, { data: { id, title: '기준금리 인하?', status: 'closed', rules: '…' } }),
    );
    await expect(lookUpWriteMarketServer(id)).resolves.toEqual({
      kind: 'found',
      market: { id, title: '기준금리 인하?', status: 'closed' },
    });
    // A draft or an unknown id (404), an id the route does not take (400): no such market.
    fakeFetch.mockImplementationOnce(() => refusal(404, 'NOT_FOUND'));
    await expect(lookUpWriteMarketServer(id)).resolves.toEqual({ kind: 'none' });
    fakeFetch.mockImplementationOnce(() => refusal(400, 'VALIDATION_ERROR'));
    await expect(lookUpWriteMarketServer(id)).resolves.toEqual({ kind: 'none' });
    // The API failing, busy or out of reach says nothing about the market.
    fakeFetch.mockImplementationOnce(() => refusal(500, 'INTERNAL'));
    await expect(lookUpWriteMarketServer(id)).resolves.toEqual({
      kind: 'failed',
      marketId: id,
    });
    fakeFetch.mockImplementationOnce(() => refusal(429, 'RATE_LIMITED'));
    await expect(lookUpWriteMarketServer(id)).resolves.toEqual({
      kind: 'failed',
      marketId: id,
    });
    fakeFetch.mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed')));
    await expect(lookUpWriteMarketServer(id)).resolves.toEqual({
      kind: 'failed',
      marketId: id,
    });
    // No market in the address: nothing is read.
    fakeFetch.mockClear();
    await expect(lookUpWriteMarketServer(undefined)).resolves.toEqual({
      kind: 'none',
    });
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

describe('the notice reads (#138)', () => {
  it('asks for the pinned notices without a query: the API decides the order and the limit', async () => {
    requests.length = 0;
    await expect(fetchPinnedNoticesServer()).resolves.toEqual([]);
    expect(requests.map((url) => url.pathname)).toEqual(['/api/v1/notices']);
    expect(requests.map(queryOf)).toEqual([{}]);
  });

  it('asks for a notice by its id, and reads a notice that is not there as null (a 404 page)', async () => {
    requests.length = 0;
    await expect(fetchNoticeServer(MISSING_NOTICE)).resolves.toBeNull();
    expect(requests.map((url) => url.pathname)).toEqual([`/api/v1/notices/${MISSING_NOTICE}`]);
  });
});

describe('fetchProfileServer', () => {
  it('asks for a profile by its public id, and answers null for NOT_FOUND only (#41)', async () => {
    requests.length = 0;
    const answer = (status: number, body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    fakeFetch.mockImplementationOnce((input: Request) => {
      requests.push(new URL(input.url));
      return answer(200, { data: { member: { publicId: 'k7m2p9qx4z' } } });
    });
    await expect(fetchProfileServer('k7m2p9qx4z')).resolves.toMatchObject({
      member: { publicId: 'k7m2p9qx4z' },
    });
    // An unknown public id (and, with #140, a withdrawn account) is a 404 to the visitor.
    fakeFetch.mockImplementationOnce((input: Request) => {
      requests.push(new URL(input.url));
      return answer(404, { error: { code: 'NOT_FOUND', message: 'Profile not found' } });
    });
    await expect(fetchProfileServer('zzzzzzzzzz')).resolves.toBeNull();
    // Anything else is the error boundary's, not a 404.
    fakeFetch.mockImplementationOnce(() =>
      answer(500, { error: { code: 'INTERNAL', message: 'boom' } }),
    );
    await expect(fetchProfileServer('k7m2p9qx4y')).rejects.toThrow('boom');
    expect(requests.map((url) => url.pathname)).toEqual([
      '/api/v1/profiles/k7m2p9qx4z',
      '/api/v1/profiles/zzzzzzzzzz',
    ]);
  });
});
