import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Order, api } from '@/lib/api';
import { myFillHistoryKey, myOrderHistoryKey, mySettlementsKey } from '@/lib/market-keys';
import type { CursorPage } from '@/lib/order-join';
import {
  fillHistoryQueryOptions,
  historyQuery,
  orderHistoryQueryOptions,
  settlementHistoryQueryOptions,
} from './use-my-history';

/**
 * 거래·정산 이력's three reads (#124, ADR-0143): what each asks the server for, under which key,
 * and when it may ask at all.
 */

const SESSION = { user: { id: 'a1e1c0de-0000-4000-8000-000000000001' } };
const ACCOUNT = 'a1e1c0de-0000-4000-8000-000000000001';
const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

afterEach(() => {
  vi.restoreAllMocks();
});

/** `api.GET` answering one empty page, with the calls it took. */
function emptyPages() {
  return vi.spyOn(api, 'GET').mockResolvedValue({
    data: { data: [], meta: { nextCursor: null } },
    response: new Response(),
  } as never);
}

describe('historyQuery', () => {
  it('sends the page size always, and a filter or a cursor only when there is one', () => {
    expect(historyQuery({}, undefined)).toEqual({ limit: 20 });
    expect(historyQuery({ period: '7d' }, undefined)).toEqual({ limit: 20, period: '7d' });
    expect(historyQuery({ market: MARKET.toUpperCase(), period: '90d' }, 'cursor-2')).toEqual({
      limit: 20,
      marketId: MARKET,
      period: '90d',
      cursor: 'cursor-2',
    });
  });

  it('sends the period as its token: no instant is computed in the browser', () => {
    const query = historyQuery({ period: '30d' }, undefined);
    expect(Object.keys(query).sort()).toEqual(['limit', 'period']);
    expect(JSON.stringify(query)).not.toMatch(/\d{4}-\d{2}-\d{2}|from|to|since/);
  });
});

describe('the three lists’ options', () => {
  it('key each list by its filters and the account, and wait for both the session and it', () => {
    const filters = { period: '7d' } as const;
    const orders = orderHistoryQueryOptions(filters, ACCOUNT, SESSION);
    const fills = fillHistoryQueryOptions(filters, ACCOUNT, SESSION);
    const settlements = settlementHistoryQueryOptions(filters, ACCOUNT, SESSION);
    expect(orders.queryKey).toEqual(myOrderHistoryKey(filters, ACCOUNT));
    expect(fills.queryKey).toEqual(myFillHistoryKey(filters, ACCOUNT));
    expect(settlements.queryKey).toEqual(mySettlementsKey(filters, ACCOUNT));
    for (const options of [orders, fills, settlements]) {
      expect(options.enabled).toBe(true);
      expect(options.initialPageParam).toBeUndefined();
      expect(options.getNextPageParam({ nextCursor: null })).toBeUndefined();
      expect(options.getNextPageParam({ nextCursor: 'cursor-2' })).toBe('cursor-2');
    }
    for (const make of [
      orderHistoryQueryOptions,
      fillHistoryQueryOptions,
      settlementHistoryQueryOptions,
    ]) {
      // No session, a session still looked up, or an account `GET /me` has not named: no read.
      expect(make(filters, ACCOUNT).enabled).toBe(false);
      expect(make(filters, ACCOUNT, null).enabled).toBe(false);
      expect(make(filters, undefined, SESSION).enabled).toBe(false);
    }
  });

  it('ask the ended orders, the fills and the settlement records, each with the filters', async () => {
    const get = emptyPages();
    const filters = { market: MARKET, period: '30d' } as const;
    await orderHistoryQueryOptions(filters, ACCOUNT, SESSION).queryFn({ pageParam: undefined });
    await fillHistoryQueryOptions(filters, ACCOUNT, SESSION).queryFn({ pageParam: 'c2' });
    await settlementHistoryQueryOptions({}, ACCOUNT, SESSION).queryFn({ pageParam: undefined });
    expect(get.mock.calls).toEqual([
      [
        '/api/v1/me/orders',
        { params: { query: { state: 'ended', limit: 20, marketId: MARKET, period: '30d' } } },
      ],
      [
        '/api/v1/me/fills',
        { params: { query: { limit: 20, marketId: MARKET, period: '30d', cursor: 'c2' } } },
      ],
      ['/api/v1/me/settlements', { params: { query: { limit: 20 } } }],
    ]);
  });

  it('accumulate `{ items, nextCursor }` pages until the cursor runs out', async () => {
    const options = orderHistoryQueryOptions({}, ACCOUNT, SESSION);
    const row = (id: string) => ({ id }) as Order;
    const first: CursorPage<Order> = { items: [row('o1')], nextCursor: 'cursor-2' };
    const last: CursorPage<Order> = { items: [row('o2')], nextCursor: null };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      // The real queryFn needs a cookie and a server; what is worth pinning is that the page
      // shape and the two page-param rules compose into a list that ends by itself.
      const data = await queryClient.fetchInfiniteQuery({
        queryKey: options.queryKey,
        initialPageParam: options.initialPageParam,
        getNextPageParam: options.getNextPageParam,
        queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
          Promise.resolve(pageParam === undefined ? first : last),
        pages: 3,
      });
      expect(data.pageParams).toEqual([undefined, 'cursor-2']);
      expect(data.pages.flatMap((page) => page.items).map((item) => item.id)).toEqual(['o1', 'o2']);
    } finally {
      queryClient.clear();
    }
  });
});
