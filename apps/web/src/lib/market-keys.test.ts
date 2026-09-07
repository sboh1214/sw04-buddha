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
import { type QuoteBody } from './api';
import {
  CATEGORIES_QUERY_KEY,
  DEFAULT_MARKET_FILTERS,
  MARKETS_KEY,
  MARKET_FILLS_KEY,
  MARKET_KEY,
  ORDERS_KEY,
  POSITIONS_KEY,
  QUOTE_KEY,
  TICKS_KEY,
  type MarketFilters,
  dehydratePublic,
  isPrivateQueryKey,
  marketFillsKey,
  marketKey,
  marketsKey,
  quoteMarketKey,
  quoteQueryKey,
  ticksKey,
} from './market-keys';

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER_ID = '5c1f8a02-1d3e-4b7a-9c88-0b2f6d4e1a99';

const quoteBody: QuoteBody = {
  marketId: ID,
  outcome: 'YES',
  side: 'buy',
  mode: 'spend',
  value: '1000',
};

describe('the market key builders', () => {
  it('keys the detail on the canonical lower-cased uuid, never the segment as typed', () => {
    // A-M3-29: the API answers with the row's own lower-case id, so a screen keyed on an
    // upper-case URL segment would hold a row whose `market.id` names a different key — and
    // every live write (a `market:tick`, a `TradeResult`, an invalidation) goes through that id.
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

  it('hangs the fills and the quotes off their own roots', () => {
    expect(marketFillsKey(ID)).toEqual([...MARKET_FILLS_KEY, ID]);
    expect(quoteMarketKey(ID)).toEqual([...QUOTE_KEY, ID]);
  });
});

describe('marketsKey', () => {
  it('opens on the open markets by volume', () => {
    expect(DEFAULT_MARKET_FILTERS).toEqual({ status: 'open', sort: 'volume' });
  });

  it('hashes the same whatever the field order and however an absent filter is spelled', () => {
    // `hashKey` sorts object keys and `JSON.stringify` drops undefined values, so the server's
    // normalised filters and a client object built in another order share one cache entry —
    // which is what stops the list from refetching the moment it hydrates.
    const fromServer: MarketFilters = { status: 'open', sort: 'volume' };
    const rebuilt: MarketFilters = { sort: 'volume', status: 'open', category: undefined };
    expect(hashKey(marketsKey(fromServer))).toBe(hashKey(marketsKey(rebuilt)));
  });

  it('separates a blank q from an absent one', () => {
    // Why `filtersFromSearchParams` drops an empty `q` instead of passing it through: `?q=`
    // would otherwise be a second cache entry for the very same list.
    const blank = hashKey(marketsKey({ ...DEFAULT_MARKET_FILTERS, q: '' }));
    const absent = hashKey(marketsKey(DEFAULT_MARKET_FILTERS));
    expect(blank).not.toBe(absent);
  });

  it('changes with every filter that changes the request', () => {
    const distinct: MarketFilters[] = [
      DEFAULT_MARKET_FILTERS,
      { ...DEFAULT_MARKET_FILTERS, sort: 'newest' },
      { ...DEFAULT_MARKET_FILTERS, status: 'settled' },
      { ...DEFAULT_MARKET_FILTERS, category: 'economy' },
      { ...DEFAULT_MARKET_FILTERS, q: '금리' },
    ];
    const hashes = new Set(distinct.map((filters) => hashKey(marketsKey(filters))));
    expect(hashes.size).toBe(distinct.length);
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

  it('gives the positions join both lists and nothing else', () => {
    // The third `setQueryDefaults` registration joins `Position[]` by row version. It has to
    // reach `['positions', 'open']` and `['positions', 'settled']` — the socket, the trade
    // answer and every REST fetch all write those two — and it must reach neither `['orders']`
    // (a paged `{ items, nextCursor }`) nor any market key, whose values are a different shape
    // entirely.
    expect(partialMatchKey(positionsKey('open'), POSITIONS_KEY)).toBe(true);
    expect(partialMatchKey(positionsKey('settled'), POSITIONS_KEY)).toBe(true);
    expect(partialMatchKey(ORDERS_KEY, POSITIONS_KEY)).toBe(false);
    expect(partialMatchKey(marketKey(ID), POSITIONS_KEY)).toBe(false);
    expect(partialMatchKey(positionsKey('open'), MARKETS_KEY)).toBe(false);
  });
});

describe('quoteQueryKey', () => {
  it('parks on one idle key while there is no valid body', () => {
    expect(quoteQueryKey(undefined)).toEqual([...QUOTE_KEY, 'idle']);
  });

  it('carries every input of the quote, so a superseded answer lands on its own entry', () => {
    expect(quoteQueryKey(quoteBody)).toEqual([...QUOTE_KEY, ID, 'buy', 'YES', 'spend', '1000']);
    // The race fix: one more keystroke is a different key, so the older response is written
    // where the panel no longer reads.
    const asked = hashKey(quoteQueryKey(quoteBody));
    expect(asked).not.toBe(hashKey(quoteQueryKey({ ...quoteBody, value: '10000' })));
    expect(asked).not.toBe(hashKey(quoteQueryKey({ ...quoteBody, outcome: 'NO' })));
  });

  it('sits under the market prefix a committed trade invalidates', () => {
    expect(partialMatchKey(quoteQueryKey(quoteBody), quoteMarketKey(ID))).toBe(true);
    expect(partialMatchKey(quoteQueryKey(quoteBody), quoteMarketKey(OTHER_ID))).toBe(false);
    // The idle key must not be swept away with another market's quotes.
    expect(partialMatchKey(quoteQueryKey(undefined), quoteMarketKey(ID))).toBe(false);
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
    ];
    for (const [name, key] of sessionKeys) expect(isPrivateQueryKey(key), name).toBe(true);
  });

  it('leaves every public market key dehydratable', () => {
    const publicKeys: ReadonlyArray<readonly unknown[]> = [
      MARKETS_KEY,
      MARKET_KEY,
      TICKS_KEY,
      QUOTE_KEY,
      MARKET_FILLS_KEY,
      CATEGORIES_QUERY_KEY,
      marketsKey(DEFAULT_MARKET_FILTERS),
      marketKey(ID),
      ticksKey(ID, '1D'),
      marketFillsKey(ID),
      quoteMarketKey(ID),
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
