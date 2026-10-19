'use client';

import { type ProposalStatus } from '@buddha/shared';
import {
  type QueryClient,
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query';
import { ADMIN_MARKETS_KEY } from '@/hooks/use-admin-markets';
import { type AdminProposal, api, unwrap } from '@/lib/api';
import {
  ADMIN_PROPOSALS_KEY,
  PROPOSALS_KEY,
  adminProposalKey,
  adminProposalsKey,
  proposalIdParam,
} from '@/lib/proposals';

/**
 * The operators' review of 시장 제안 (#77, ADR-0089). Under the private `['admin']` root
 * (`PRIVATE_QUERY_ROOTS`); the list per status filter under one prefix, the detail on the
 * canonical id. The options are exported apart from the hooks for the node test runner
 * (use-admin-proposals.test.ts).
 */

export interface AdminProposalPage {
  items: AdminProposal[];
  nextCursor: string | null;
}

/**
 * `GET /admin/proposals`, newest first, every status unless one is picked, 20 per page with 더 보기
 * (the API's default page). The previous filter's rows stay while the next loads, as the admin
 * market list's do: a filter switch does not flash the skeleton.
 */
export function adminProposalsInfiniteQueryOptions(status: ProposalStatus | '') {
  return {
    queryKey: adminProposalsKey(status),
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<AdminProposalPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/proposals', {
          params: {
            query: {
              ...(status === '' ? {} : { status }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AdminProposalPage) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  };
}

export function useAdminProposals(status: ProposalStatus | '') {
  return useInfiniteQuery(adminProposalsInfiniteQueryOptions(status));
}

/**
 * One proposal (`GET /admin/proposals/:id`) on the canonical id. A segment that cannot name a
 * proposal sends nothing (the API would answer 400, which reads as "try again" for a wrong
 * address); the screen says 찾을 수 없습니다 for it as for a 404.
 */
export function adminProposalQueryOptions(routeId: string) {
  const id = proposalIdParam(routeId);
  return {
    queryKey: adminProposalKey(id ?? ''),
    queryFn: async (): Promise<AdminProposal> =>
      unwrap(await api.GET('/api/v1/admin/proposals/{id}', { params: { path: { id: id ?? '' } } }))
        .data,
    enabled: id !== undefined,
  };
}

export function useAdminProposal(routeId: string) {
  return useQuery(adminProposalQueryOptions(routeId));
}

/**
 * After an operator's write, which answered with the proposal as it committed: the detail shows it
 * now — a refetch that fails cannot leave the old status and its buttons under a toast that says
 * otherwise (`applyMarket`'s reason) — then every filtered list is asked again, and the member's
 * own 내 제안 in this tab too (an operator may have proposed it: the owner set no same-person rule).
 * A 채택 that made a draft also asks the admin market lists again: the draft is a new row there.
 * Seed and invalidations stay in one synchronous block, as in `applyMarket`.
 */
export function applyProposal(
  queryClient: QueryClient,
  fresh: AdminProposal,
  { marketCreated = false }: { marketCreated?: boolean } = {},
) {
  queryClient.setQueryData(adminProposalKey(fresh.id), fresh);
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: adminProposalKey(fresh.id) }),
    queryClient.invalidateQueries({ queryKey: ADMIN_PROPOSALS_KEY }),
    queryClient.invalidateQueries({ queryKey: PROPOSALS_KEY }),
    ...(marketCreated ? [queryClient.invalidateQueries({ queryKey: ADMIN_MARKETS_KEY })] : []),
  ]);
}
