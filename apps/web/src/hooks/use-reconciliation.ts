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
  type ReconciliationHoldDetail,
  type ReconciliationResult,
  type ReconciliationRun,
} from '@/lib/api';

export const ADMIN_RECONCILIATION_KEY = ['admin', 'reconciliation'] as const;
export const reconciliationHoldKey = (id: string) =>
  [...ADMIN_RECONCILIATION_KEY, 'hold', id] as const;

type Pages<T> = InfiniteData<{ items: T[]; nextCursor: string | null }, string | undefined>;

/** An ended hold/request never becomes pending because an older response arrives late. */
function mergeHold(old: ReconciliationHoldDetail | undefined, fresh: ReconciliationHoldDetail) {
  if (!old) return fresh;
  const requests = new Map(fresh.requests.map((request) => [request.id, request]));
  for (const request of old.requests) {
    const incoming = requests.get(request.id);
    if (!incoming || (request.status !== 'pending' && incoming.status === 'pending'))
      requests.set(request.id, request);
  }
  const oldIsNewer =
    old.latestResult !== null &&
    (fresh.latestResult === null || BigInt(old.latestResult.id) > BigInt(fresh.latestResult.id));
  return {
    ...fresh,
    hold: old.hold.recoveredAt !== null ? old.hold : oldIsNewer ? old.hold : fresh.hold,
    latestResult: oldIsNewer ? old.latestResult : fresh.latestResult,
    requests: [...requests.values()].sort(
      (a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.id.localeCompare(a.id),
    ),
  };
}

function storeHold(client: QueryClient, fresh: ReconciliationHoldDetail) {
  const key = reconciliationHoldKey(fresh.hold.id);
  const saved = mergeHold(client.getQueryData<ReconciliationHoldDetail>(key), fresh);
  client.setQueryData(key, saved);
  for (const query of client
    .getQueryCache()
    .findAll({ queryKey: [...ADMIN_RECONCILIATION_KEY, 'holds'] })) {
    const all = query.queryKey[3] === true;
    client.setQueryData<Pages<ReconciliationHoldDetail>>(query.queryKey, (old) => {
      if (!old) return old;
      const existing = old.pages
        .flatMap((page) => page.items)
        .find((item) => item.hold.id === saved.hold.id);
      const item = mergeHold(existing, saved);
      const keep = all || item.hold.recoveredAt === null;
      let seen = false;
      const pages = old.pages.map((page) => ({
        ...page,
        items: page.items.flatMap((row) => {
          if (row.hold.id !== item.hold.id) return [row];
          if (seen) return [];
          seen = true;
          return keep ? [item] : [];
        }),
      }));
      const first = pages[0]?.items[0];
      const newer =
        !first ||
        item.hold.startedAt > first.hold.startedAt ||
        (item.hold.startedAt === first.hold.startedAt && item.hold.id > first.hold.id);
      if (!seen && keep && newer && pages[0])
        pages[0] = { ...pages[0], items: [item, ...pages[0].items] };
      return { ...old, pages };
    });
  }
}

/** Apply committed facts before revalidation, so a failed follow-up GET keeps the successful write. */
export async function applyReconciliationWrite(
  client: QueryClient,
  value: ReconciliationRun | ReconciliationHoldDetail,
) {
  await client.cancelQueries({ queryKey: ADMIN_RECONCILIATION_KEY });
  const result = 'result' in value ? value.result : value.latestResult;
  if (result) {
    client.setQueriesData<Pages<ReconciliationResult>>(
      { queryKey: [...ADMIN_RECONCILIATION_KEY, 'results'] },
      (old) => {
        if (!old || !old.pages[0]) return old;
        let seen = false;
        const pages = old.pages.map((page) => ({
          ...page,
          items: page.items.map((row) => {
            if (row.id !== result.id) return row;
            seen = true;
            return result;
          }),
        }));
        // A recovery response may repeat an old audit. Do not move it across a cursor or insert
        // an unloaded historical row which a later page will return again.
        const first = pages[0]!.items[0];
        const newer =
          !first ||
          result.checkedAt > first.checkedAt ||
          (result.checkedAt === first.checkedAt && BigInt(result.id) > BigInt(first.id));
        if (!seen && newer) pages[0] = { ...pages[0]!, items: [result, ...pages[0]!.items] };
        return { ...old, pages };
      },
    );
  }
  if ('requests' in value) {
    storeHold(client, value);
    return;
  }
  if (value.hold) {
    const fromLists = client
      .getQueryCache()
      .findAll({ queryKey: [...ADMIN_RECONCILIATION_KEY, 'holds'] })
      .flatMap(
        (query) =>
          (query.state.data as Pages<ReconciliationHoldDetail> | undefined)?.pages.flatMap(
            (page) => page.items,
          ) ?? [],
      )
      .find((item) => item.hold.id === value.hold!.id);
    const cached =
      client.getQueryData<ReconciliationHoldDetail>(reconciliationHoldKey(value.hold.id)) ??
      fromLists;
    storeHold(client, {
      hold: value.hold,
      latestResult: value.result,
      requests: cached?.requests ?? [],
      market: cached?.market ?? null,
      user: cached?.user ?? null,
    });
  } else {
    // The run authoritatively found no active hold. Do not invent recovery timestamps.
    client.setQueriesData<Pages<ReconciliationHoldDetail>>(
      { queryKey: [...ADMIN_RECONCILIATION_KEY, 'holds'] },
      (old) =>
        old && {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            items: page.items.filter(
              (row) =>
                row.hold.targetKey !== value.result.targetKey ||
                row.hold.recoveredAt !== null ||
                (row.latestResult !== null &&
                  BigInt(row.latestResult.id) > BigInt(value.result.id)),
            ),
          })),
        },
    );
  }
}

export function useReconciliationHolds(all: boolean) {
  return useInfiniteQuery({
    queryKey: [...ADMIN_RECONCILIATION_KEY, 'holds', all],
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/reconciliation/holds', {
          params: {
            query: { state: all ? 'all' : 'active', ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
  });
}

export function useReconciliationResults() {
  return useInfiniteQuery({
    queryKey: [...ADMIN_RECONCILIATION_KEY, 'results'],
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/reconciliation/results', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
  });
}

export function useReconciliationHold(id: string) {
  return useQuery({
    queryKey: reconciliationHoldKey(id),
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/admin/reconciliation/holds/{holdId}', {
          params: { path: { holdId: id } },
        }),
      ).data,
  });
}
