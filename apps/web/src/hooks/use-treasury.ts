'use client';

import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query';
import {
  api,
  unwrap,
  type AdminTreasury,
  type TreasuryIssueRequest,
  type TreasuryIssueWrite,
} from '@/lib/api';

export const ADMIN_TREASURY_KEY = ['admin', 'treasury'] as const;
export const treasuryBalanceKey = [...ADMIN_TREASURY_KEY, 'balance'] as const;
export const treasuryRequestKey = (id: string) => [...ADMIN_TREASURY_KEY, 'request', id] as const;
type Pages = InfiniteData<
  { items: TreasuryIssueRequest[]; nextCursor: string | null },
  string | undefined
>;

/** Approval, rejection and retraction cannot be replaced by an older pending response. */
function latestRequest(old: TreasuryIssueRequest | undefined, fresh: TreasuryIssueRequest) {
  return old && old.status !== 'pending' && fresh.status === 'pending' ? old : fresh;
}

export async function applyTreasuryWrite(client: QueryClient, fresh: TreasuryIssueWrite) {
  await client.cancelQueries({ queryKey: ADMIN_TREASURY_KEY });
  const oldBalance = client.getQueryData<AdminTreasury>(treasuryBalanceKey);
  // Only a larger cumulative issuance proves that this snapshot is newer. Allocation,
  // recall and actual-balance restoration can change balances without changing issuance;
  // an equal-issuance POST must preserve the cached balance until the follow-up GET.
  if (!oldBalance || BigInt(fresh.treasury.issuedCoin) > BigInt(oldBalance.issuedCoin))
    client.setQueryData(treasuryBalanceKey, fresh.treasury);
  const key = treasuryRequestKey(fresh.request.id);
  let request = latestRequest(client.getQueryData<TreasuryIssueRequest>(key), fresh.request);
  const lists = client.getQueryCache().findAll({ queryKey: [...ADMIN_TREASURY_KEY, 'requests'] });
  for (const query of lists) {
    const old = (query.state.data as Pages | undefined)?.pages
      .flatMap((page) => page.items)
      .find((row) => row.id === request.id);
    request = latestRequest(old, request);
  }
  client.setQueryData(key, request);
  for (const query of lists) {
    const all = query.queryKey[3] === true;
    client.setQueryData<Pages>(query.queryKey, (old) => {
      if (!old?.pages[0]) return old;
      let seen = false;
      const pages = old.pages.map((page) => ({
        ...page,
        items: page.items.flatMap((row) => {
          if (row.id !== request.id) return [row];
          if (seen) return [];
          seen = true;
          return all || request.status === 'pending' ? [request] : [];
        }),
      }));
      const first = pages[0]!.items[0];
      if (
        !seen &&
        (all || request.status === 'pending') &&
        (!first ||
          request.requestedAt > first.requestedAt ||
          (request.requestedAt === first.requestedAt && request.id > first.id))
      ) {
        pages[0] = { ...pages[0]!, items: [request, ...pages[0]!.items] };
      }
      return { ...old, pages };
    });
  }
}

export function useTreasury() {
  return useQuery({
    queryKey: treasuryBalanceKey,
    queryFn: async ({ signal }) => unwrap(await api.GET('/api/v1/admin/treasury', { signal })).data,
  });
}

export function useTreasuryRequest(id: string) {
  return useQuery({
    queryKey: treasuryRequestKey(id),
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/admin/treasury/issue-requests/{id}', {
          params: { path: { id } },
          signal,
        }),
      ).data,
  });
}

export function useTreasuryRequests(all: boolean) {
  return useInfiniteQuery({
    queryKey: [...ADMIN_TREASURY_KEY, 'requests', all],
    queryFn: async ({
      pageParam,
      signal,
    }: {
      pageParam: string | undefined;
      signal: AbortSignal;
    }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/treasury/issue-requests', {
          params: {
            query: { status: all ? 'all' : 'pending', ...(pageParam ? { cursor: pageParam } : {}) },
          },
          signal,
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
  });
}

export function useTreasuryHistory() {
  return useInfiniteQuery({
    queryKey: [...ADMIN_TREASURY_KEY, 'history'],
    queryFn: async ({
      pageParam,
      signal,
    }: {
      pageParam: string | undefined;
      signal: AbortSignal;
    }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/treasury/history', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
          signal,
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
  });
}
