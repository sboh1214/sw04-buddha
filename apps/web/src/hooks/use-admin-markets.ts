'use client';

import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Category, api, unwrap, type AdminMarket, type Fill } from '@/lib/api';
import { marketIdParam } from '@/lib/market-admin';
import { CATEGORIES_QUERY_KEY, MARKET_FILLS_KEY, marketFillsKey } from '@/lib/market-keys';

/**
 * Query keys the admin market screens share (PLAN 11.5 rules, admin-prefixed like
 * `['admin', 'coupons']`). The list key is a prefix: `['admin', 'markets', status]` per
 * filter, so one invalidation of `ADMIN_MARKETS_KEY` refreshes every filtered page.
 */
export const ADMIN_MARKETS_KEY = ['admin', 'markets'] as const;
export const ADMIN_MARKET_KEY = ['admin', 'market'] as const;

export const adminMarketKey = (id: string) => [...ADMIN_MARKET_KEY, id] as const;

/**
 * The two keys the admin screens share with the public market screens now live in the
 * directive-free `lib/market-keys.ts`, because a server component may not import them from
 * here: every export of a `'use client'` module is a client reference, which throws when it
 * is called during the server render. Re-exported so no admin import site had to move.
 */
export { CATEGORIES_QUERY_KEY, MARKET_FILLS_KEY, marketFillsKey };

/** Active categories in display order (`GET /categories`, public). */
export function useCategories() {
  return useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: async (): Promise<Category[]> => unwrap(await api.GET('/api/v1/categories')).data,
  });
}

/**
 * One market with its LMSR state, exposure and event log (`GET /admin/markets/:id`), keyed
 * on the CANONICAL id rather than the route segment as typed.
 *
 * A uuid is accepted in either case and the API answers with the row's own lower-case id, so
 * a screen keyed on an upper-case URL would hold a row whose `market.id` names a different
 * key — and every child that writes through `market.id` (a transition, a save) would then
 * seed and invalidate a key nothing on that screen reads (A-M3-29). Exported apart from the
 * hook because the decision is what matters and a component cannot be executed in this
 * app's test runner.
 *
 * No request goes out for a segment that cannot name a market: the API would answer 400,
 * which reads as "try again" for what is a wrong address.
 */
export function adminMarketQueryOptions(routeId: string) {
  const id = marketIdParam(routeId);
  return {
    queryKey: adminMarketKey(id ?? ''),
    queryFn: async (): Promise<AdminMarket> =>
      unwrap(await api.GET('/api/v1/admin/markets/{id}', { params: { path: { id: id ?? '' } } }))
        .data,
    enabled: id !== undefined,
  };
}

export function useAdminMarket(routeId: string) {
  return useQuery(adminMarketQueryOptions(routeId));
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

/**
 * After any admin write: the detail, the fills and every filtered list page.
 *
 * Not 남발 (PLAN 11.5): `refetchType` stays at its default `'active'`, so a list page that is
 * not mounted is only marked, and its next mount is the request.
 */
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
 * `id` is the key the caller's own query uses — this function cannot know which string that
 * is. The detail screen keys on the canonical id (`adminMarketQueryOptions`), so there
 * `market.id` is that string by construction, not by a convention a call site must remember
 * (A-M3-29).
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
