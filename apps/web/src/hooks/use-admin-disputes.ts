'use client';

import {
  type InfiniteData,
  type QueryClient,
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type AdminDisputeFilters,
  type DisputePage,
  normalizeAdminDisputeFilters,
  replaceDisputeRow,
} from '@/lib/admin-disputes';
import { type AdminDispute, type ReviewDisputeBody, api, unwrap } from '@/lib/api';
import { adminMarketKey } from './use-admin-markets';

/**
 * The admin 이의 목록's queries (design 5.2, 5.6), admin-prefixed like `['admin', 'markets']`
 * so the root is private (`PRIVATE_QUERY_ROOTS`) and one invalidation of `ADMIN_DISPUTES_KEY`
 * refreshes every filtered page. The filter set travels as one normalised object rather than
 * positional segments (`marketsKey`'s reasoning): a new filter cannot silently reorder the
 * key, and `{}` / `{ status: undefined }` / an upper-case `marketId` all hash to one entry.
 */
export const ADMIN_DISPUTES_KEY = ['admin', 'disputes'] as const;

export const adminDisputesKey = (filters: AdminDisputeFilters) =>
  [...ADMIN_DISPUTES_KEY, normalizeAdminDisputeFilters(filters)] as const;

/**
 * Cursor-paginated, 20 per page (PLAN 7), newest first. `keepPreviousData` keeps the previous
 * filter's rows up while the next loads, as the market and user lists do, so changing the
 * status filter does not flash the skeleton. Exported apart from the hook because the
 * decisions are what a test can execute; a component cannot be, in this app's runner.
 */
export function adminDisputesInfiniteQueryOptions(filters: AdminDisputeFilters) {
  const { status, marketId } = normalizeAdminDisputeFilters(filters);
  return {
    queryKey: adminDisputesKey(filters),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<DisputePage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/disputes', {
          params: {
            query: {
              ...(status === undefined ? {} : { status }),
              ...(marketId === undefined ? {} : { marketId }),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: DisputePage) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  };
}

export function useAdminDisputes(filters: AdminDisputeFilters) {
  return useInfiniteQuery(adminDisputesInfiniteQueryOptions(filters));
}

/**
 * After a review answered with the row: show what the server just committed in every cached
 * page, then confirm it against the server — and refresh the market's detail, whose 이의
 * counts moved with it. The seed is what keeps the list honest when that refetch fails
 * (`applyMarket`'s reasoning: a list that keeps rendering cached rows on a refetch error must
 * not keep the old status under a toast that says otherwise). The write and the invalidation
 * stay in one synchronous block so a GET already in flight cannot land on top of the seed.
 */
export function applyReviewedDispute(queryClient: QueryClient, fresh: AdminDispute) {
  queryClient.setQueriesData<InfiniteData<DisputePage>>({ queryKey: ADMIN_DISPUTES_KEY }, (old) =>
    replaceDisputeRow(old, fresh),
  );
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ADMIN_DISPUTES_KEY }),
    queryClient.invalidateQueries({ queryKey: adminMarketKey(fresh.marketId) }),
  ]);
}

export interface ReviewDisputeVariables {
  id: string;
  body: ReviewDisputeBody;
}

/**
 * `PATCH /admin/disputes/:id` (PLAN 7.3). Cache writes happen here, once; the toast and the
 * dialog are the caller's, passed per `mutate` call — the dialog stays mounted and pinned
 * while the request runs, so those callbacks always find their screen.
 */
export function useReviewDispute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: ReviewDisputeVariables) =>
      unwrap(await api.PATCH('/api/v1/admin/disputes/{id}', { params: { path: { id } }, body }))
        .data,
    onSuccess: (reviewed) => applyReviewedDispute(queryClient, reviewed),
  });
}
