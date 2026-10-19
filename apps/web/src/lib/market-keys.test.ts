import { MARKET_SORTS } from '@buddha/shared';
import { QueryClient, hashKey, partialMatchKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ADMIN_MARKETS_KEY } from '@/hooks/use-admin-markets';
import { ACCOUNTS_QUERY_KEY, ME_QUERY_KEY } from '@/hooks/use-me';
import { positionsKey } from '@/hooks/use-portfolio';
import {
  CHARGE_PACKAGES_QUERY_KEY,
  LEDGER_QUERY_KEY,
  PAYMENTS_QUERY_KEY,
} from '@/hooks/use-wallet';
import { AUTHORED_KEY, MY_AUTHORED_KEY, myAuthoredKey, profileAuthoredKey } from './authored';
import { LIKES_KEY, myPostLikesKey } from './likes';
import {
  CATEGORIES_QUERY_KEY,
  DEFAULT_MARKET_FILTERS,
  DEFAULT_SEARCH_FILTERS,
  HOME_MARKET_STATUS,
  MARKETS_KEY,
  MARKET_RELATED_KEY,
  MARKET_SEARCH_KEY,
  MARKET_FILLS_KEY,
  MARKET_KEY,
  ORDERS_KEY,
  POSITIONS_KEY,
  PRIVATE_QUERY_ROOTS,
  SEARCH_HISTORY_KEY,
  TICKS_KEY,
  WATCHLIST_KEY,
  WATCHLIST_PAGES_KEY,
  type MarketFilters,
  type MarketSearch,
  dehydratePublic,
  isPrivateQueryKey,
  marketFillsKey,
  marketKey,
  marketSearchKey,
  marketsKey,
  publicListQuery,
  relatedMarketsKey,
  relatedMarketsQuery,
  searchListQuery,
  ticksKey,
  watchStateKey,
  watchlistPagesKey,
} from './market-keys';

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('the market key builders', () => {
  it('keys the detail on the canonical lower-cased uuid, never the segment as typed', () => {
    // A-M3-29: the API answers with the row's own lower-case id, so a screen keyed on an
    // upper-case URL segment would hold a row whose `market.id` names a different key — and
    // every live write (a `market:tick`, an invalidation) goes through that id.
    expect(marketKey(ID.toUpperCase())).toEqual([...MARKET_KEY, ID]);
    expect(hashKey(marketKey(ID.toUpperCase()))).toBe(hashKey(marketKey(ID)));
  });

  it('puts the range token, not a timestamp, in the ticks key', () => {
    // A `Date.now()`-derived `from` in the key would mint a new entry on every render and
    // refetch forever; the token keeps one entry per range whose refetch reads a fresh window.
    expect(ticksKey(ID, '1D')).toEqual([...TICKS_KEY, ID, '1D']);
    expect(hashKey(ticksKey(ID, '1D'))).not.toBe(hashKey(ticksKey(ID, '1W')));
    expect(partialMatchKey(ticksKey(ID, '1D'), TICKS_KEY)).toBe(true);
  });

  it('hangs the fills off their own root', () => {
    expect(marketFillsKey(ID)).toEqual([...MARKET_FILLS_KEY, ID]);
  });
});

describe('marketsKey', () => {
  it('opens on 추천, with no status: the home lists open markets only (ADR-0065)', () => {
    // Was `{ status: 'open', sort: 'volume' }` before this PR: the volume order is gone until #132
    // and the status is no filter but the constant every home list asks for.
    expect(DEFAULT_MARKET_FILTERS).toEqual({ sort: 'recommended' });
    expect(HOME_MARKET_STATUS).toBe('open');
  });

  it('hashes the same whatever the field order and however an absent filter is spelled', () => {
    // `hashKey` sorts object keys and `JSON.stringify` drops undefined values, so the server's
    // normalised filters and a client object built in another order share one cache entry —
    // which is what stops the list from refetching the moment it hydrates.
    const fromServer: MarketFilters = { sort: 'newest', category: 'economy' };
    const rebuilt: MarketFilters = { category: 'economy', sort: 'newest', watchlist: undefined };
    expect(hashKey(marketsKey(fromServer))).toBe(hashKey(marketsKey(rebuilt)));
  });

  it('separates a blank category from an absent one', () => {
    // Why `filtersFromSearchParams` drops an empty `category` instead of passing it through:
    // `?category=` would otherwise be a second cache entry for the very same list. (This pinned
    // a blank `q` until the home stopped reading `q`, ADR-0066; the search screen's own key
    // pins it below.)
    const blank = hashKey(marketsKey({ ...DEFAULT_MARKET_FILTERS, category: '' }));
    const absent = hashKey(marketsKey(DEFAULT_MARKET_FILTERS));
    expect(blank).not.toBe(absent);
  });

  it('changes with every filter that changes the request', () => {
    const distinct: MarketFilters[] = [
      DEFAULT_MARKET_FILTERS,
      { ...DEFAULT_MARKET_FILTERS, sort: 'newest' },
      { ...DEFAULT_MARKET_FILTERS, sort: 'closing' },
      { ...DEFAULT_MARKET_FILTERS, category: 'economy' },
    ];
    const hashes = new Set(distinct.map((filters) => hashKey(marketsKey(filters))));
    expect(hashes.size).toBe(distinct.length);
  });
});

describe('publicListQuery', () => {
  it('sends the order picked, every one of them, with the home status', () => {
    // The API defaults to 추천 as well, so a request that dropped or pinned its order would still
    // answer, in the wrong order, and type-check (the query's `sort` is optional): the SSR
    // prefetch and the client's queryFn both build their query here, and this is what pins it.
    for (const sort of MARKET_SORTS) {
      expect(publicListQuery({ ...DEFAULT_MARKET_FILTERS, sort })).toEqual({
        status: HOME_MARKET_STATUS,
        sort,
      });
    }
  });

  it('adds a category and a cursor only when there is one, and never a search term', () => {
    // The API's query schema refuses a blank one, so an absent filter is no field at all. The
    // home does not search (ADR-0066): this PR took `q` out of its query.
    expect(publicListQuery({ sort: 'closing', category: 'economy' }, '1788408306789_abc')).toEqual({
      status: 'open',
      sort: 'closing',
      category: 'economy',
      cursor: '1788408306789_abc',
    });
    expect(Object.keys(publicListQuery({ sort: 'newest', category: undefined }))).toEqual([
      'status',
      'sort',
    ]);
  });
});

describe('the search screen’s key and query (#15, ADR-0066)', () => {
  const search: MarketSearch = { ...DEFAULT_SEARCH_FILTERS, q: '금리' };

  it('starts on every public status and 추천', () => {
    // ADR-0061 decision 1, items 13 and 14.
    expect(DEFAULT_SEARCH_FILTERS).toEqual({ status: 'all', sort: 'recommended' });
  });

  it('sends the term, the status and the order always, every one of them', () => {
    // The API's default status is the home's `open`: a search that lost its status would hide
    // every ended market and still answer. Its default order is 추천: a lost order would answer
    // in the wrong one. So both are always written out.
    for (const status of ['all', 'open', 'closed', 'resolved', 'settled', 'voided'] as const) {
      for (const sort of MARKET_SORTS) {
        expect(searchListQuery({ ...search, status, sort })).toEqual({ status, sort, q: '금리' });
      }
    }
  });

  it('adds a category and a cursor only when there is one', () => {
    expect(searchListQuery({ ...search, category: 'economy' }, '1788408306789_abc')).toEqual({
      status: 'all',
      sort: 'recommended',
      q: '금리',
      category: 'economy',
      cursor: '1788408306789_abc',
    });
    expect(Object.keys(searchListQuery({ ...search, category: undefined }))).toEqual([
      'status',
      'sort',
      'q',
    ]);
  });

  it('keys each search apart, under the home list’s root but never as one of its lists', () => {
    const distinct: MarketSearch[] = [
      search,
      { ...search, q: '환율' },
      { ...search, status: 'closed' },
      { ...search, sort: 'newest' },
      { ...search, category: 'economy' },
    ];
    const hashes = new Set(distinct.map((entry) => hashKey(marketSearchKey(entry))));
    expect(hashes.size).toBe(distinct.length);
    // Under ['markets'], so its card join and the socket's writes reach it; never the home's.
    expect(partialMatchKey(marketSearchKey(search), MARKETS_KEY)).toBe(true);
    expect(partialMatchKey(marketSearchKey(search), MARKET_SEARCH_KEY)).toBe(true);
    expect(partialMatchKey(marketsKey(DEFAULT_MARKET_FILTERS), MARKET_SEARCH_KEY)).toBe(false);
    expect(partialMatchKey(marketSearchKey(search), MARKET_KEY)).toBe(false);
    expect(isPrivateQueryKey(marketSearchKey(search))).toBe(false);
  });
});

describe('the related markets’ key and query (#65, ADR-0068)', () => {
  it('keys a detail’s related markets on the canonical uuid, under the home list’s root', () => {
    expect(relatedMarketsKey(ID.toUpperCase())).toEqual(['markets', 'related', ID]);
    // Under ['markets'], so the card join, the socket's card writes and a reconnect's re-read
    // reach it; never one of the home's lists, the search's results or the detail row.
    expect(partialMatchKey(relatedMarketsKey(ID), MARKETS_KEY)).toBe(true);
    expect(partialMatchKey(relatedMarketsKey(ID), MARKET_RELATED_KEY)).toBe(true);
    expect(partialMatchKey(relatedMarketsKey(ID), MARKET_SEARCH_KEY)).toBe(false);
    expect(partialMatchKey(marketsKey(DEFAULT_MARKET_FILTERS), MARKET_RELATED_KEY)).toBe(false);
    expect(partialMatchKey(relatedMarketsKey(ID), MARKET_KEY)).toBe(false);
    expect(hashKey(relatedMarketsKey(ID))).not.toBe(
      hashKey(relatedMarketsKey(ID.replace('3', '4'))),
    );
    // Public (ADR-0061 decision 1, item 18): the detail dehydrates it.
    expect(isPrivateQueryKey(relatedMarketsKey(ID))).toBe(false);
  });

  it('sends a cursor only when there is one, and no order: 추천 is the owner’s (item 19)', () => {
    expect(relatedMarketsQuery()).toEqual({});
    expect(relatedMarketsQuery('1788408306789_0_null_abc')).toEqual({
      cursor: '1788408306789_0_null_abc',
    });
  });
});

describe('key prefix isolation', () => {
  it('never matches the list prefix against the detail prefix', () => {
    // The two `setQueryDefaults` registrations (`structuralSharing` on ['market'] and on
    // ['markets']) match by key PREFIX, element-wise. If either prefix matched the other's
    // keys, one join would run over the wrong value shape.
    const listKey = marketsKey(DEFAULT_MARKET_FILTERS);
    expect(partialMatchKey(listKey, MARKET_KEY)).toBe(false);
    expect(partialMatchKey(marketKey(ID), MARKETS_KEY)).toBe(false);
    expect(partialMatchKey(listKey, MARKETS_KEY)).toBe(true);
    expect(partialMatchKey(marketKey(ID), MARKET_KEY)).toBe(true);
  });

  it('gives the watchlist join its pages and never a watch state or the home lists (#89)', () => {
    // The `structuralSharing` on ['watchlist', 'pages'] joins `MarketSummary` pages; under the
    // same root a `WatchState` lives, which that join would mangle, and the home's
    // ['markets', …] has its own registration.
    const pages = watchlistPagesKey({});
    expect(partialMatchKey(pages, WATCHLIST_PAGES_KEY)).toBe(true);
    expect(partialMatchKey(watchlistPagesKey({ category: 'economy' }), WATCHLIST_PAGES_KEY)).toBe(
      true,
    );
    expect(partialMatchKey(watchStateKey(ID), WATCHLIST_PAGES_KEY)).toBe(false);
    expect(partialMatchKey(pages, MARKETS_KEY)).toBe(false);
    expect(partialMatchKey(marketsKey(DEFAULT_MARKET_FILTERS), WATCHLIST_PAGES_KEY)).toBe(false);
    // One root covers both, so a SessionCacheGuard reset and `isPrivateQueryKey` reach both.
    expect(partialMatchKey(watchStateKey(ID), WATCHLIST_KEY)).toBe(true);
    expect(watchStateKey(ID.toUpperCase())).toEqual(watchStateKey(ID));
  });

  it('gives the positions join both lists and nothing else', () => {
    // The third `setQueryDefaults` registration joins `Position[]` by row version. It has to
    // reach `['positions', 'open']` and `['positions', 'settled']` — the socket and every REST
    // fetch write those two — and it must reach neither `['orders']`
    // (a paged `{ items, nextCursor }`) nor any market key, whose values are a different shape
    // entirely.
    expect(partialMatchKey(positionsKey('open'), POSITIONS_KEY)).toBe(true);
    expect(partialMatchKey(positionsKey('settled'), POSITIONS_KEY)).toBe(true);
    expect(partialMatchKey(ORDERS_KEY, POSITIONS_KEY)).toBe(false);
    expect(partialMatchKey(marketKey(ID), POSITIONS_KEY)).toBe(false);
    expect(partialMatchKey(positionsKey('open'), MARKETS_KEY)).toBe(false);
  });
});

describe('isPrivateQueryKey', () => {
  it('covers the root of every session-dependent key in the app', () => {
    // Asserted against the real constants rather than a copy of the strings: a new personal
    // key whose root is not registered here fails this test instead of leaking into an SSR
    // payload, where it would be visible in view-source and shared by every visitor of a
    // cached page.
    const sessionKeys: ReadonlyArray<readonly [string, readonly unknown[]]> = [
      ['ME_QUERY_KEY', ME_QUERY_KEY],
      ['ACCOUNTS_QUERY_KEY', ACCOUNTS_QUERY_KEY],
      ['LEDGER_QUERY_KEY', LEDGER_QUERY_KEY],
      ['PAYMENTS_QUERY_KEY', PAYMENTS_QUERY_KEY],
      ['CHARGE_PACKAGES_QUERY_KEY', CHARGE_PACKAGES_QUERY_KEY],
      ['ADMIN_MARKETS_KEY', ADMIN_MARKETS_KEY],
      ['POSITIONS_KEY', POSITIONS_KEY],
      ['ORDERS_KEY', ORDERS_KEY],
      ['watchlistPagesKey', watchlistPagesKey({})],
      ['watchStateKey', watchStateKey(ID)],
      ['SEARCH_HISTORY_KEY', SEARCH_HISTORY_KEY],
      ['LIKES_KEY', LIKES_KEY],
      ['myPostLikesKey', myPostLikesKey(ID)],
      ['MY_AUTHORED_KEY', MY_AUTHORED_KEY],
      ['myAuthoredKey', myAuthoredKey('posts')],
      ['myAuthoredKey', myAuthoredKey('comments')],
    ];
    for (const [name, key] of sessionKeys) expect(isPrivateQueryKey(key), name).toBe(true);
  });

  it('registers exactly the roots the app still keys personal data under', () => {
    // The account's own disputes went with the dispute stage (ADR-0046); a root nothing keys
    // under any more is a stale entry, not a lock. 'watchlist' came with #89: nobody but the
    // member sees a watchlist (#37, ADR-0064). 'search-history' came with #15 (ADR-0066): the
    // recent searches are the session's own, read with the member's cookie, so they are never
    // fetched on the server or dehydrated (who else may see them is #37 item 11) — this PR
    // changed the list, so the expectation changed with it. 'likes' came with #49 (ADR-0076):
    // whether the reader liked a post or a comment is theirs alone (PRIVATE_DATA `likers`), read
    // with their cookie; the counts are public and live under the posts' root. 'my-authored' came
    // with #51 (ADR-0080): MY '내 글' is the member's own writing with the hidden items and their
    // reasons (#45-5: the member's alone), read with their cookie; a profile's lists are public.
    // 'my-moderation' came with #50 (ADR-0081): the member's own reports and the actions taken on
    // them (PRIVATE_DATA `reports`, `moderation`); the operators' reads live under 'admin'.
    // 'proposals' came with #77 (ADR-0089): a proposal is the proposer's and the operators' alone
    // (ADR-0069 decision 4) — that PR changed the list too.
    expect([...PRIVATE_QUERY_ROOTS].sort()).toEqual(
      [
        'admin',
        'charge-packages',
        'ledger',
        'me',
        'orders',
        'payments',
        'positions',
        'watchlist',
        'search-history',
        'likes',
        'my-authored',
        'my-moderation',
        'proposals',
      ].sort(),
    );
    expect(PRIVATE_QUERY_ROOTS.has('disputes')).toBe(false);
  });

  it('leaves every public market key dehydratable', () => {
    const publicKeys: ReadonlyArray<readonly unknown[]> = [
      MARKETS_KEY,
      MARKET_KEY,
      TICKS_KEY,
      MARKET_FILLS_KEY,
      CATEGORIES_QUERY_KEY,
      marketsKey(DEFAULT_MARKET_FILTERS),
      marketKey(ID),
      ticksKey(ID, '1D'),
      marketFillsKey(ID),
      relatedMarketsKey(ID),
      // A profile's lists (#51): public, the same for every reader (read in the browser only).
      AUTHORED_KEY,
      profileAuthoredKey('k7m2p9qx4z', 'posts'),
    ];
    for (const key of publicKeys) expect(isPrivateQueryKey(key), hashKey(key)).toBe(false);
  });

  it('says nothing about a key with no string root', () => {
    expect(isPrivateQueryKey([])).toBe(false);
    expect(isPrivateQueryKey([{ status: 'open' }])).toBe(false);
  });
});

describe('dehydratePublic', () => {
  it('leaves every personal entry out of the SSR payload', () => {
    // `dehydrate` serialises the WHOLE per-request client, so anything a page put in the cache
    // rides the RSC payload into the HTML. This is the second lock behind api.server.ts
    // forwarding no cookie.
    const queryClient = new QueryClient();
    try {
      queryClient.setQueryData(ME_QUERY_KEY, { id: 'u1' });
      queryClient.setQueryData(ACCOUNTS_QUERY_KEY, []);
      queryClient.setQueryData(POSITIONS_KEY, []);
      queryClient.setQueryData(ORDERS_KEY, []);
      queryClient.setQueryData(LEDGER_QUERY_KEY, []);
      queryClient.setQueryData(PAYMENTS_QUERY_KEY, []);
      queryClient.setQueryData(CHARGE_PACKAGES_QUERY_KEY, []);
      queryClient.setQueryData(ADMIN_MARKETS_KEY, []);
      queryClient.setQueryData(watchlistPagesKey({}), { pages: [], pageParams: [] });
      queryClient.setQueryData(watchStateKey(ID), { watched: true });
      queryClient.setQueryData(SEARCH_HISTORY_KEY, [{ id: ID, query: '금리', searchedAt: '' }]);
      queryClient.setQueryData(myAuthoredKey('posts'), { pages: [], pageParams: [] });
      queryClient.setQueryData(marketKey(ID), { id: ID });

      const roots = dehydratePublic(queryClient).queries.map((query) => query.queryKey[0]);
      expect(roots).toEqual(['market']);
    } finally {
      queryClient.clear();
    }
  });

  it('keeps the successful-only rule the seeded pages rely on', async () => {
    // A query built by `setQueryData` has status 'success'; a failed prefetch has not, and
    // hydrating one would hand the client a rejected query it never asked for.
    const queryClient = new QueryClient();
    try {
      const failed = queryClient.fetchQuery({
        queryKey: marketsKey(DEFAULT_MARKET_FILTERS),
        queryFn: (): Promise<unknown> => Promise.reject(new Error('API is down')),
        retry: false,
      });
      await expect(failed).rejects.toThrow('API is down');

      expect(dehydratePublic(queryClient).queries).toEqual([]);
    } finally {
      queryClient.clear();
    }
  });
});
