'use client';

import { type QueryClient, useQuery } from '@tanstack/react-query';
import { type AdminMarketConflictWrite, api, unwrap } from '@/lib/api';
import { applyMarket } from './use-admin-markets';
import { useOperatorId } from './use-operator';

export const MARKET_CONFLICTS_KEY = ['admin', 'market-conflicts'] as const;
export const marketConflictsKey = (marketId: string, operatorId: string | undefined) =>
  [...MARKET_CONFLICTS_KEY, marketId, operatorId] as const;

/** A declaration can retract a pending correction and reopen disputes in the same commit. */
export async function applyMarketConflictWrite(
  client: QueryClient,
  fresh: AdminMarketConflictWrite,
) {
  const key = marketConflictsKey(fresh.conflicts.marketId, fresh.conflicts.operator.userId);
  await client.cancelQueries({ queryKey: key });
  client.setQueryData(key, fresh.conflicts);
  await applyMarket(client, fresh.market.id, fresh.market);
}

/** The result includes the current operator, so a different account never inherits it. */
export function useMarketConflicts(marketId: string) {
  const operatorId = useOperatorId();
  return useQuery({
    queryKey: marketConflictsKey(marketId, operatorId),
    enabled: operatorId !== undefined,
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/admin/markets/{id}/conflicts', {
          params: { path: { id: marketId } },
        }),
      ).data,
  });
}
