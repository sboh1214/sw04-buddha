'use client';

import { type MarketWorkKind } from '@buddha/shared';
import { type InfiniteData, useInfiniteQuery } from '@tanstack/react-query';
import { type AdminMarketWorkEntry, api, unwrap } from '@/lib/api';
import { marketIdParam } from '@/lib/market-admin';

/**
 * 시장별 작업 이력 (#145 part 2, ADR-0164): `GET /admin/markets/:id/work-history` under the private
 * `['admin']` root (`PRIVATE_QUERY_ROOTS`), `[…, id, kind]` with `'all'` for 전체 — keyed on the
 * canonical id, as the detail is (A-M3-29). Every admin write to a market asks the whole prefix
 * again (`invalidateMarket`): a write can add an entry to this market's history and, through a
 * link's other end (145-13), to another's. 20 a page with 더 보기 (the API's default page), oldest
 * first; the previous kind's rows kept while the next loads; nothing polls (ADR-0138 — the request
 * budget is use-admin-market-work.test.ts'). The options are exported apart from the hook for the
 * node test runner.
 */
export const ADMIN_MARKET_WORK_KEY = ['admin', 'market-work'] as const;
export const adminMarketWorkKey = (id: string, kind: MarketWorkKind | undefined) =>
  [...ADMIN_MARKET_WORK_KEY, id.toLowerCase(), kind ?? 'all'] as const;

/** One page of a market's history. */
export interface AdminMarketWorkPage {
  items: AdminMarketWorkEntry[];
  nextCursor: string | null;
}

/**
 * One market's history, one kind or every one. No request goes out for a segment that cannot name
 * a market (`marketIdParam`): the screen says 찾을 수 없습니다 without one.
 */
export function adminMarketWorkQueryOptions(routeId: string, kind: MarketWorkKind | undefined) {
  const id = marketIdParam(routeId);
  const queryKey = adminMarketWorkKey(id ?? '', kind);
  return {
    queryKey,
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<AdminMarketWorkPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/markets/{id}/work-history', {
          params: {
            path: { id: id ?? '' },
            query: {
              ...(kind === undefined ? {} : { kind }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AdminMarketWorkPage) => last.nextCursor ?? undefined,
    // Another kind's rows of the same market only: a link to another market's history (the
    // same screen, a new id) never shows this market's entries under that market's title.
    placeholderData: (
      previous: InfiniteData<AdminMarketWorkPage, string | undefined> | undefined,
      previousQuery: { queryKey: readonly unknown[] } | undefined,
    ) => (previousQuery?.queryKey[2] === queryKey[2] ? previous : undefined),
    enabled: id !== undefined,
  };
}

export function useAdminMarketWork(routeId: string, kind: MarketWorkKind | undefined) {
  return useInfiniteQuery(adminMarketWorkQueryOptions(routeId, kind));
}
