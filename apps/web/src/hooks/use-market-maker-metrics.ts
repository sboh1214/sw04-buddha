'use client';

import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api';
import { useOperatorId } from './use-operator';

export const MARKET_MAKER_METRICS_KEY = ['admin', 'market-maker-metrics'] as const;
export const makerMetricsKey = (operatorId: string | undefined, marketId: string) =>
  [...MARKET_MAKER_METRICS_KEY, operatorId, 'market', marketId] as const;
export const makerOverviewKey = (operatorId: string | undefined) =>
  [...MARKET_MAKER_METRICS_KEY, operatorId, 'overview'] as const;
export const makerMetricsListKey = (operatorId: string | undefined) =>
  [...MARKET_MAKER_METRICS_KEY, operatorId, 'list'] as const;

/** Private snapshots stay with the operator who requested them; no previous-account placeholder. */
export const makerMetricsOptions = (operatorId: string | undefined, marketId: string) =>
  queryOptions({
    queryKey: makerMetricsKey(operatorId, marketId),
    enabled: operatorId !== undefined,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/admin/markets/{id}/market-maker/metrics', {
          params: { path: { id: marketId } },
          signal,
        }),
      ).data,
    refetchInterval: 10_000,
  });
export const makerOverviewOptions = (operatorId: string | undefined) =>
  queryOptions({
    queryKey: makerOverviewKey(operatorId),
    enabled: operatorId !== undefined,
    queryFn: async ({ signal }) =>
      unwrap(await api.GET('/api/v1/admin/market-makers/overview', { signal })).data,
    refetchInterval: 10_000,
  });
export const makerMetricsListOptions = (operatorId: string | undefined) =>
  infiniteQueryOptions({
    queryKey: makerMetricsListKey(operatorId),
    enabled: operatorId !== undefined,
    queryFn: async ({
      pageParam,
      signal,
    }: {
      pageParam: string | undefined;
      signal: AbortSignal;
    }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/market-makers', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
          signal,
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
export function useMarketMakerMetrics(marketId: string) {
  return useQuery(makerMetricsOptions(useOperatorId(), marketId));
}
export function useMarketMakerOverview() {
  return useQuery(makerOverviewOptions(useOperatorId()));
}
export function useMarketMakerMetricsList() {
  return useInfiniteQuery(makerMetricsListOptions(useOperatorId()));
}
