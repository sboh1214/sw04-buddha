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
  type ReconciliationCorrectionDetail,
  type ReconciliationCorrectionRequest,
} from '@/lib/api';
import { ADMIN_RECONCILIATION_KEY } from './use-reconciliation';

export const ADMIN_CORRECTIONS_KEY = [...ADMIN_RECONCILIATION_KEY, 'corrections'] as const;
export const correctionDetailKey = (resultId: string) =>
  [...ADMIN_CORRECTIONS_KEY, 'result', resultId] as const;
export const MEMBER_CORRECTIONS_KEY = ['reconciliation-corrections'] as const;

type Pages<T> = InfiniteData<{ items: T[]; nextCursor: string | null }, string | undefined>;

/** An old pending answer cannot undo a committed approval, rejection or retraction. */
export function mergeCorrectionRequests(
  old: readonly ReconciliationCorrectionRequest[],
  fresh: readonly ReconciliationCorrectionRequest[],
): ReconciliationCorrectionRequest[] {
  const rows = new Map(fresh.map((row) => [row.id, row]));
  for (const row of old) {
    const incoming = rows.get(row.id);
    if (!incoming || (row.status !== 'pending' && incoming.status === 'pending'))
      rows.set(row.id, row);
  }
  return [...rows.values()].sort(
    (a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.id.localeCompare(a.id),
  );
}

/** Keep the committed result visible even when the following list/detail GET fails. */
export async function applyCorrectionWrite(
  client: QueryClient,
  detail: ReconciliationCorrectionDetail,
) {
  await client.cancelQueries({ queryKey: ADMIN_CORRECTIONS_KEY });
  const key = correctionDetailKey(detail.result.id);
  const saved = client.getQueryData<ReconciliationCorrectionDetail>(key);
  const listed = client
    .getQueryCache()
    .findAll({ queryKey: [...ADMIN_CORRECTIONS_KEY, 'requests'] })
    .flatMap(
      (query) =>
        (query.state.data as Pages<ReconciliationCorrectionRequest> | undefined)?.pages.flatMap(
          (page) => page.items,
        ) ?? [],
    )
    .filter((request) => request.resultId === detail.result.id);
  const requests = mergeCorrectionRequests(
    [...listed, ...(saved?.requests ?? [])],
    detail.requests,
  );
  client.setQueryData(key, { ...detail, requests });
  for (const query of client
    .getQueryCache()
    .findAll({ queryKey: [...ADMIN_CORRECTIONS_KEY, 'requests'] })) {
    const all = query.queryKey[4] === true;
    client.setQueryData<Pages<ReconciliationCorrectionRequest>>(query.queryKey, (old) => {
      if (!old || !old.pages[0]) return old;
      const replacements = new Map(requests.map((row) => [row.id, row]));
      const seen = new Set<string>();
      const pages = old.pages.map((page) => ({
        ...page,
        items: page.items.flatMap((row) => {
          const incoming = replacements.get(row.id);
          if (!incoming) return [row];
          if (seen.has(row.id)) return [];
          seen.add(row.id);
          const fresh = row.status !== 'pending' && incoming.status === 'pending' ? row : incoming;
          return all || fresh.status === 'pending' ? [fresh] : [];
        }),
      }));
      const first = pages[0]!.items[0];
      const additions = requests.filter(
        (row) =>
          !seen.has(row.id) &&
          (all || row.status === 'pending') &&
          (!first ||
            row.requestedAt > first.requestedAt ||
            (row.requestedAt === first.requestedAt && row.id > first.id)),
      );
      pages[0] = { ...pages[0]!, items: [...additions, ...pages[0]!.items] };
      return { ...old, pages };
    });
  }
}

export function useCorrectionDetail(resultId: string) {
  return useQuery({
    queryKey: correctionDetailKey(resultId),
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/admin/reconciliation/results/{resultId}/corrections', {
          params: { path: { resultId } },
        }),
      ).data,
  });
}

export function useCorrectionRequests(all: boolean) {
  return useInfiniteQuery({
    queryKey: [...ADMIN_CORRECTIONS_KEY, 'requests', all],
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/reconciliation/correction-requests', {
          params: {
            query: { status: all ? 'all' : 'pending', ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
  });
}

/** Approved own-account records only; this root is private and cleared on account change. */
export function useMemberCorrections() {
  return useInfiniteQuery({
    queryKey: MEMBER_CORRECTIONS_KEY,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/me/reconciliation-corrections', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
  });
}
