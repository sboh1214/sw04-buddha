'use client';

import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api';

export const ADMIN_MARKET_MAKER_KEY = ['admin', 'market-maker'] as const;
export const adminMarketMakerKey = (id: string) => [...ADMIN_MARKET_MAKER_KEY, id] as const;

/** Private observations only, with visible-page polling for worker progress. */
export function useAdminMarketMaker(id: string) {
  return useQuery({
    queryKey: adminMarketMakerKey(id),
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/admin/markets/{id}/market-maker', {
          params: { path: { id } },
          signal,
        }),
      ).data,
    refetchInterval: 10_000,
  });
}
