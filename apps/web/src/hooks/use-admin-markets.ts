'use client';

import {
  type QueryClient,
  hashKey,
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type AdminMarket,
  type AdminRelatedMarket,
  type Category,
  type Fill,
  type MarketSummary,
  api,
  unwrap,
} from '@/lib/api';
import { marketIdParam, settlementPollInterval } from '@/lib/market-admin';
import {
  CATEGORIES_QUERY_KEY,
  MARKET_FILLS_KEY,
  MARKET_RELATED_KEY,
  marketFillsKey,
} from '@/lib/market-keys';
import { relatedSearchQuery } from '@/lib/related-markets';

/**
 * Query keys the admin market screens share (PLAN 11.5 rules, admin-prefixed like
 * `['admin', 'coupons']`). The list key is a prefix: `['admin', 'markets', status]` per
 * filter, so one invalidation of `ADMIN_MARKETS_KEY` refreshes every filtered page.
 */
export const ADMIN_MARKETS_KEY = ['admin', 'markets'] as const;
export const ADMIN_MARKET_KEY = ['admin', 'market'] as const;

export const adminMarketKey = (id: string) => [...ADMIN_MARKET_KEY, id] as const;

/**
 * 관련 시장 (#65, ADR-0068) on the admin detail: one market's links, every status, under the
 * private `['admin']` root (never SSR'd). Its own root segment rather than under
 * `adminMarketKey(id)`, so `applyMarket`'s seed of the detail never lands on the links, and a
 * write to a market leaves that market's own list alone: no row of it is that market. Every OTHER
 * market's list is asked again by the write (`invalidateMarket`), since each row badges the market
 * at its other end with its status and title — the one written may be among them.
 */
export const ADMIN_RELATED_MARKETS_KEY = ['admin', 'related-markets'] as const;
export const adminRelatedMarketsKey = (id: string) =>
  [...ADMIN_RELATED_MARKETS_KEY, id.toLowerCase()] as const;

/**
 * The 관련 시장 picker's search: `GET /admin/markets?q=`, under the admin list's prefix so an admin
 * write that invalidates the lists (`invalidateMarket`) refreshes the statuses it shows too. An
 * object as the third element, never a status string, so no status filter's entry is it.
 */
export const adminRelatedSearchKey = (q: string) =>
  [...ADMIN_MARKETS_KEY, { relatedSearch: q }] as const;

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
 * One market with its trade stats, exposure and event log (`GET /admin/markets/:id`), keyed
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

/**
 * The admin detail, re-read every few seconds while the market is `resolved` so the 정산 단계
 * panel and the 정산 대기 badge follow the worker (`settlementPollInterval`, ADR-0046).
 */
export function useAdminMarket(routeId: string) {
  return useQuery({
    ...adminMarketQueryOptions(routeId),
    refetchInterval: (query) => settlementPollInterval(query.state.data),
  });
}

/** One market's links (`GET /admin/markets/:id/related`): any status, the latest link first. */
export function useAdminRelatedMarkets(id: string) {
  return useQuery({
    queryKey: adminRelatedMarketsKey(id),
    queryFn: async (): Promise<AdminRelatedMarket[]> =>
      unwrap(await api.GET('/api/v1/admin/markets/{id}/related', { params: { path: { id } } }))
        .data,
  });
}

/**
 * The picker's results for a term (`GET /admin/markets?q=`, every status, newest first), 20 per
 * page with 더 보기 like the admin list. Nothing is asked until there is a term.
 */
export function useAdminRelatedSearch(q: string | undefined) {
  return useInfiniteQuery({
    queryKey: adminRelatedSearchKey(q ?? ''),
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<{ items: MarketSummary[]; nextCursor: string | null }> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/markets', {
          params: { query: relatedSearchQuery(q ?? '', pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    enabled: q !== undefined,
    placeholderData: keepPreviousData,
  });
}

/**
 * After a link or an unlink: the answer is the market's links as the write committed them, so it
 * goes on screen now — a refetch that fails cannot leave the old list under a toast that says
 * otherwise — then the other market's admin list and every public 관련 시장 list held in this tab
 * (both details change, ADR-0061 decision 1, item 19) are asked again. Not 남발: only mounted
 * observers refetch (PLAN 11.5). Seed and invalidations stay in one synchronous block, as in
 * `applyMarket`.
 */
export function applyRelatedMarkets(
  queryClient: QueryClient,
  id: string,
  otherId: string,
  fresh: AdminRelatedMarket[],
) {
  queryClient.setQueryData(adminRelatedMarketsKey(id), fresh);
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: adminRelatedMarketsKey(id) }),
    queryClient.invalidateQueries({ queryKey: adminRelatedMarketsKey(otherId) }),
    queryClient.invalidateQueries({ queryKey: MARKET_RELATED_KEY }),
  ]);
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
 * After any admin write: the detail, the fills, every filtered list page, and every other market's
 * 관련 시장 list. Each row of such a list badges the market at its other end with its status and
 * title, so a market linked to this one would otherwise go on showing it as it was — a draft just
 * opened still '초안' under the hint that says a draft is not shown, for as long as `staleTime`
 * keeps that list fresh (review on #65). Which lists hold this market is the server's to say, so
 * every one but this market's own is asked; its own holds only other markets, and on this
 * market's screen it is mounted, so including it would be one request per write for nothing.
 *
 * Not 남발 (PLAN 11.5): `refetchType` stays at its default `'active'`, so a list page that is
 * not mounted is only marked, and its next mount is the request.
 */
function invalidateMarket(queryClient: QueryClient, id: string) {
  const ownLinks = hashKey(adminRelatedMarketsKey(id));
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: adminMarketKey(id) }),
    queryClient.invalidateQueries({ queryKey: marketFillsKey(id) }),
    queryClient.invalidateQueries({ queryKey: ADMIN_MARKETS_KEY }),
    queryClient.invalidateQueries({
      queryKey: ADMIN_RELATED_MARKETS_KEY,
      predicate: (query) => query.queryHash !== ownLinks,
    }),
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
