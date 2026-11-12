'use client';
import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import {
  api,
  unwrap,
  type AdminClassifiableFill,
  type FillClassificationRequest,
  type FillClassificationWrite,
} from '@/lib/api';

export const CLASSIFICATIONS_KEY = ['admin', 'fill-classifications'] as const;
export const classifiableFillKey = (operator: string | undefined, fillId: string) =>
  [...CLASSIFICATIONS_KEY, operator, fillId, 'fill'] as const;
export const classificationRequestKey = (
  operator: string | undefined,
  fillId: string,
  id: string,
) => [...CLASSIFICATIONS_KEY, operator, fillId, 'request', id] as const;
type Pages = InfiniteData<
  { items: FillClassificationRequest[]; nextCursor: string | null },
  string | undefined
>;
export function latestClassifiableFill(
  old: AdminClassifiableFill | undefined,
  fresh: AdminClassifiableFill,
) {
  return old && BigInt(old.classificationRevision) > BigInt(fresh.classificationRevision)
    ? old
    : fresh;
}
const latestRequest = (
  old: FillClassificationRequest | undefined,
  fresh: FillClassificationRequest,
) => (old && old.status !== 'pending' && fresh.status === 'pending' ? old : fresh);

export function joinClassificationRequests(
  old: Pages | undefined,
  fresh: Pages,
  all: boolean,
): Pages {
  if (!old) return fresh;
  const known = new Map(old.pages.flatMap((p) => p.items).map((r) => [r.id, r]));
  return {
    ...fresh,
    pages: fresh.pages.map((p) => ({
      ...p,
      items: p.items.flatMap((r) => {
        const latest = latestRequest(known.get(r.id), r);
        return all || latest.status === 'pending' ? [latest] : [];
      }),
    })),
  };
}

export async function applyClassificationWrite(
  client: QueryClient,
  operator: string,
  fresh: FillClassificationWrite,
) {
  await client.cancelQueries({ queryKey: [...CLASSIFICATIONS_KEY, operator] });
  if (client.getQueryData<{ id: string }>(['me'])?.id !== operator) return false;
  const fillId = fresh.fill.id;
  const fill = latestClassifiableFill(
    client.getQueryData(classifiableFillKey(operator, fillId)),
    fresh.fill,
  );
  const key = classificationRequestKey(operator, fillId, fresh.request.id);
  let request = latestRequest(
    client.getQueryData<FillClassificationWrite>(key)?.request,
    fresh.request,
  );
  const lists = client
    .getQueryCache()
    .findAll({ queryKey: [...CLASSIFICATIONS_KEY, operator] })
    .filter((q) => q.queryKey[4] === 'list');
  for (const q of lists) {
    const old = (q.state.data as Pages | undefined)?.pages
      .flatMap((p) => p.items)
      .find((r) => r.id === request.id);
    request = latestRequest(old, request);
  }
  client.setQueryData(classifiableFillKey(operator, fillId), fill);
  client.setQueryData(key, { request, fill });
  for (const q of lists) {
    if (q.queryKey[3] && q.queryKey[3] !== fillId) continue;
    const all = q.queryKey[5] === true;
    client.setQueryData<Pages>(q.queryKey, (old) => {
      if (!old?.pages[0]) return old;
      let found = false;
      const pages = old.pages.map((p) => ({
        ...p,
        items: p.items.flatMap((r) => {
          if (r.id !== request.id) return [r];
          if (found) return [];
          found = true;
          return all || request.status === 'pending' ? [latestRequest(r, request)] : [];
        }),
      }));
      const first = pages[0]!.items[0];
      // A write to an older, unloaded request is not permission to move it ahead of the cursor.
      const newest =
        !first ||
        request.requestedAt > first.requestedAt ||
        (request.requestedAt === first.requestedAt && request.id > first.id);
      if (!found && newest && (all || request.status === 'pending'))
        pages[0]!.items.unshift(request);
      return { ...old, pages };
    });
  }
  return true;
}
export function useClassifiableFill(operator: string | undefined, fillId: string, enabled = true) {
  return useQuery({
    queryKey: classifiableFillKey(operator, fillId),
    enabled: !!operator && !!fillId && enabled,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/admin/fills/{fillId}', { params: { path: { fillId } }, signal }),
      ).data,
    structuralSharing: (old, fresh) =>
      latestClassifiableFill(
        old as AdminClassifiableFill | undefined,
        fresh as AdminClassifiableFill,
      ),
  });
}
export function useClassificationRequest(operator: string | undefined, fillId: string, id: string) {
  return useQuery({
    queryKey: classificationRequestKey(operator, fillId, id),
    enabled: !!operator && !!id,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/admin/fills/{fillId}/classification-requests/{requestId}', {
          params: { path: { fillId, requestId: id } },
          signal,
        }),
      ).data,
    structuralSharing: (old, fresh) => {
      const a = old as FillClassificationWrite | undefined,
        b = fresh as FillClassificationWrite;
      return {
        ...b,
        request: latestRequest(a?.request, b.request),
        fill: latestClassifiableFill(a?.fill, b.fill),
      };
    },
  });
}
export function useClassificationRequests(
  operator: string | undefined,
  fillId: string | undefined,
  all: boolean,
) {
  return useInfiniteQuery({
    queryKey: [...CLASSIFICATIONS_KEY, operator, fillId, 'list', all],
    enabled: !!operator,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const query = {
        status: all ? ('all' as const) : ('pending' as const),
        ...(pageParam ? { cursor: pageParam } : {}),
      };
      const response = fillId
        ? await api.GET('/api/v1/admin/fills/{fillId}/classification-requests', {
            params: { path: { fillId }, query },
            signal,
          })
        : await api.GET('/api/v1/admin/fill-classifications/requests', {
            params: { query },
            signal,
          });
      const { data, meta } = unwrap(response);
      return { items: data, nextCursor: meta.nextCursor };
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    structuralSharing: (old, fresh) =>
      joinClassificationRequests(old as Pages | undefined, fresh as Pages, all),
  });
}
export function useClassificationHistory(operator: string | undefined, fillId: string) {
  return useInfiniteQuery({
    queryKey: [...CLASSIFICATIONS_KEY, operator, fillId, 'history'],
    enabled: !!operator && !!fillId,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/fills/{fillId}/classification-history', {
          params: { path: { fillId }, query: pageParam ? { cursor: pageParam } : {} },
          signal,
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
