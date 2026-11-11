'use client';
import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import {
  api,
  unwrap,
  type AdminMarketMaker,
  type MarketMakerControlRequest,
  type MarketMakerControlWrite,
} from '@/lib/api';
import { adminMarketMakerKey } from './use-admin-market-maker';
import { adminMarketKey } from './use-admin-markets';
import { makerMetricsKey, makerMetricsListKey, makerOverviewKey } from './use-market-maker-metrics';
import { treasuryBalanceKey } from './use-treasury';
export const CONTROL_KEY = ['admin', 'market-maker-controls'] as const;
export const controlDetailKey = (operator: string | undefined, marketId: string, id: string) =>
  [...CONTROL_KEY, operator, marketId, 'detail', id] as const;
type Pages = InfiniteData<
  { items: MarketMakerControlRequest[]; nextCursor: string | null },
  string | undefined
>;
export function currentMaker(old: AdminMarketMaker | undefined, fresh: AdminMarketMaker) {
  if (!old?.runtime || !fresh.runtime) return old?.runtime && !fresh.runtime ? old : fresh;
  const a = old.runtime;
  const b = fresh.runtime;
  if (BigInt(a.controlGeneration) > BigInt(b.controlGeneration)) return old;
  if (
    a.controlGeneration === b.controlGeneration &&
    (BigInt(a.generation) > BigInt(b.generation) || a.updatedAt > b.updatedAt)
  )
    return old;
  return fresh;
}
export async function applyControlWrite(
  client: QueryClient,
  operator: string,
  fresh: MarketMakerControlWrite,
) {
  if (client.getQueryData<{ id: string }>(['me'])?.id !== operator) return false;
  // Only the committed execution changes assets/configuration. Pending/cleanup responses
  // must not refresh economic reads, even when a cached request is already approved.
  const action = fresh.request.status === 'approved' ? fresh.request.execution?.action : undefined;
  const changedReads: QueryKey[] = action
    ? [
        makerMetricsKey(operator, fresh.request.marketId),
        makerOverviewKey(operator),
        makerMetricsListKey(operator),
      ]
    : [];
  if (action === 'settings' || action === 'increase')
    changedReads.push(adminMarketKey(fresh.request.marketId));
  if (action === 'increase') changedReads.push(treasuryBalanceKey);
  await Promise.all([
    client.cancelQueries({ queryKey: [...CONTROL_KEY, operator] }),
    client.cancelQueries({ queryKey: adminMarketMakerKey(fresh.marketMaker.marketId) }),
    ...changedReads.map((queryKey) => client.cancelQueries({ queryKey, exact: true })),
  ]);
  if (client.getQueryData<{ id: string }>(['me'])?.id !== operator) return false;
  const key = controlDetailKey(operator, fresh.request.marketId, fresh.request.id);
  const old = client.getQueryData<MarketMakerControlWrite>(key);
  let request =
    old && old.request.status !== 'pending' && fresh.request.status === 'pending'
      ? old.request
      : fresh.request;
  for (const query of client.getQueryCache().findAll({ queryKey: [...CONTROL_KEY, operator] })) {
    if (query.queryKey[4] !== 'list') continue;
    const prior = (query.state.data as Pages | undefined)?.pages
      .flatMap((page) => page.items)
      .find((row) => row.id === request.id);
    if (prior && prior.status !== 'pending' && request.status === 'pending') request = prior;
  }
  const maker = currentMaker(
    client.getQueryData<AdminMarketMaker>(adminMarketMakerKey(fresh.marketMaker.marketId)),
    fresh.marketMaker,
  );
  client.setQueryData(adminMarketMakerKey(maker.marketId), maker);
  client.setQueryData(key, { request, marketMaker: maker });
  for (const query of client.getQueryCache().findAll({ queryKey: [...CONTROL_KEY, operator] })) {
    if (query.queryKey[4] !== 'list') continue;
    const marketId = query.queryKey[3];
    if (marketId && marketId !== request.marketId) continue;
    const all = query.queryKey[5] === true;
    client.setQueryData<Pages>(query.queryKey, (oldPages) => {
      if (!oldPages?.pages[0]) return oldPages;
      let found = false;
      const pages = oldPages.pages.map((page) => ({
        ...page,
        items: page.items.flatMap((row) => {
          if (row.id !== request.id) return [row];
          if (found) return [];
          found = true;
          const r = row.status !== 'pending' && request.status === 'pending' ? row : request;
          return all || r.status === 'pending' ? [r] : [];
        }),
      }));
      if (!found && (all || request.status === 'pending'))
        pages[0] = { ...pages[0]!, items: [request, ...pages[0]!.items] };
      return { ...oldPages, pages };
    });
  }
  // Cancel the old GETs first; active views refresh, while unmounted views become stale.
  // Keep the authoritative control/maker response if any dependent refresh fails.
  for (const queryKey of changedReads) void client.invalidateQueries({ queryKey, exact: true });
  return true;
}
export function useMarketMakerControlRequests(
  operator: string | undefined,
  marketId: string | undefined,
  all: boolean,
) {
  return useInfiniteQuery({
    queryKey: [...CONTROL_KEY, operator, marketId, 'list', all],
    enabled: !!operator,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const query = {
        status: all ? ('all' as const) : ('pending' as const),
        ...(pageParam ? { cursor: pageParam } : {}),
      };
      const response = marketId
        ? await api.GET('/api/v1/admin/markets/{marketId}/market-maker/control-requests', {
            params: { path: { marketId }, query },
            signal,
          })
        : await api.GET('/api/v1/admin/market-maker/control-requests', {
            params: { query },
            signal,
          });
      const { data, meta } = unwrap(response);
      return { items: data, nextCursor: meta.nextCursor };
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
export function useMarketMakerControl(
  operator: string | undefined,
  marketId: string,
  requestId: string,
) {
  return useQuery({
    queryKey: controlDetailKey(operator, marketId, requestId),
    enabled: !!operator,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET(
          '/api/v1/admin/markets/{marketId}/market-maker/control-requests/{requestId}',
          { params: { path: { marketId, requestId } }, signal },
        ),
      ).data,
  });
}
export function useMarketMakerControlHistory(operator: string | undefined, marketId: string) {
  return useInfiniteQuery({
    queryKey: [...CONTROL_KEY, operator, marketId, 'history'],
    enabled: !!operator,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/markets/{marketId}/market-maker/control-history', {
          params: { path: { marketId }, query: pageParam ? { cursor: pageParam } : {} },
          signal,
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
