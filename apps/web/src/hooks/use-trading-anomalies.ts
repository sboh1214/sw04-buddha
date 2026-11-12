'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api';
import { useOperatorId } from './use-operator';

export const tradingAnomaliesKey = (operatorId: string | undefined, marketId: string) =>
  ['admin', 'trading-anomalies', operatorId, marketId] as const;

/** A report is one fixed snapshot. Paging it never reads another server snapshot. */
export const tradingAnomaliesOptions = (operatorId: string | undefined, marketId = '') =>
  queryOptions({
    queryKey: tradingAnomaliesKey(operatorId, marketId),
    enabled: operatorId !== undefined,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: false,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/admin/trading-anomalies', {
          params: { query: marketId ? { marketId } : {} },
          signal,
        }),
      ).data,
  });

export function useTradingAnomalies(marketId: string) {
  return useQuery(tradingAnomaliesOptions(useOperatorId(), marketId));
}
