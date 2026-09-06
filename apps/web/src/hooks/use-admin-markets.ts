'use client';

import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Category, api, unwrap, type AdminMarket, type Fill } from '@/lib/api';

/**
 * Query keys the admin market screens share (PLAN 11.5 rules, admin-prefixed like
 * `['admin', 'coupons']`). The list key is a prefix: `['admin', 'markets', status]` per
 * filter, so one invalidation of `ADMIN_MARKETS_KEY` refreshes every filtered page.
 */
export const ADMIN_MARKETS_KEY = ['admin', 'markets'] as const;
export const ADMIN_MARKET_KEY = ['admin', 'market'] as const;
export const CATEGORIES_QUERY_KEY = ['categories'] as const;
export const MARKET_FILLS_KEY = ['market-fills'] as const;

export const adminMarketKey = (id: string) => [...ADMIN_MARKET_KEY, id] as const;
export const marketFillsKey = (id: string) => [...MARKET_FILLS_KEY, id] as const;

/** Active categories in display order (`GET /categories`, public). */
export function useCategories() {
  return useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: async (): Promise<Category[]> => unwrap(await api.GET('/api/v1/categories')).data,
  });
}

/**
 * One market with its LMSR state, exposure and event log (`GET /admin/markets/:id`). Not
 * sent while `enabled` is false — the detail screen passes `isMarketId(id)`, since the API
 * would only answer a malformed id with a 400.
 */
export function useAdminMarket(id: string, enabled = true) {
  return useQuery({
    queryKey: adminMarketKey(id),
    queryFn: async (): Promise<AdminMarket> =>
      unwrap(await api.GET('/api/v1/admin/markets/{id}', { params: { path: { id } } })).data,
    enabled,
  });
}

/**
 * Newest fills, anonymous (`GET /markets/:id/fills`). A draft is invisible on the public
 * routes (404, design 3.2), so the query waits until the market has been opened.
 */
export function useMarketFills(id: string, enabled: boolean) {
  return useQuery({
    queryKey: marketFillsKey(id),
    queryFn: async (): Promise<Fill[]> =>
      unwrap(await api.GET('/api/v1/markets/{id}/fills', { params: { path: { id } } })).data,
    enabled,
  });
}

/** After any admin write: the detail, the fills and every filtered list page. */
function invalidateMarket(queryClient: QueryClient, id: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: adminMarketKey(id) }),
    queryClient.invalidateQueries({ queryKey: marketFillsKey(id) }),
    queryClient.invalidateQueries({ queryKey: ADMIN_MARKETS_KEY }),
  ]);
}

/**
 * After an admin write that answered with the row (every transition and the edit): show what
 * the server just committed, then confirm it against the server.
 *
 * The seed is what makes the detail screen honest when the refetch that follows fails. That
 * screen keeps rendering cached data on a refetch error and says so in a notice, so without
 * the seed a market that just opened stays `draft` on screen — under a toast saying it
 * opened, with the open button still live — until something refetches it. Invalidating still
 * happens: the response is the row as of its own transaction, and a refetch that lands after
 * it wins.
 *
 * `id` is the caller's, never `fresh.id`: the screen keys its query on the id in the URL,
 * which the API accepts in upper case and answers in lower (uuidSchema lower-cases requests),
 * so seeding under the response's id would leave the screen reading an untouched key.
 *
 * The two statements stay in one synchronous block — an `await` between them would let a GET
 * that is already in flight (started before the write) land on top of the seed instead of
 * being cancelled by the invalidation.
 */
export function applyMarket(queryClient: QueryClient, id: string, fresh: AdminMarket) {
  queryClient.setQueryData(adminMarketKey(id), fresh);
  return invalidateMarket(queryClient, id);
}

export function useApplyMarket(id: string) {
  const queryClient = useQueryClient();
  return (fresh: AdminMarket) => applyMarket(queryClient, id, fresh);
}
