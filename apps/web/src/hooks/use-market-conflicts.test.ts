import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { type AdminMarket, type AdminMarketConflictWrite } from '@/lib/api';
import { adminMarketKey } from './use-admin-markets';
import { applyMarketConflictWrite, marketConflictsKey } from './use-market-conflicts';

describe('committed conflict declaration', () => {
  it('keeps the committed retraction and reopened disputes when the following GET fails', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const id = '00000000-0000-4000-8000-000000000001';
    const before = {
      id,
      status: 'provisional',
      judgement: { pending: { requestId: 'pending' } },
      disputes: { holding: 1, items: [{ status: 'accepted' }] },
    } as unknown as AdminMarket;
    const after = {
      ...before,
      judgement: { ...before.judgement, pending: null },
      disputes: { ...before.disputes, items: [{ status: 'pending' }] },
    } as unknown as AdminMarket;
    client.setQueryData(adminMarketKey(id), before);
    const observer = new QueryObserver(client, {
      queryKey: adminMarketKey(id),
      queryFn: () => Promise.reject(new Error('offline')),
      retry: false,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    const conflicts: AdminMarketConflictWrite['conflicts'] = {
      marketId: id,
      operator: {
        userId: 'a',
        hasFill: false,
        conflicted: true,
        declaration: {
          id,
          reason: '직접 이해관계',
          declaredAt: '2026-11-09T01:00:00.000Z',
          declaredBy: { id: 'a', nickname: '운영자' },
        },
      },
      declarations: [],
    };
    try {
      await applyMarketConflictWrite(client, { conflicts, market: after });
      expect(client.getQueryData(adminMarketKey(id))).toEqual(after);
      expect(observer.getCurrentResult().isRefetchError).toBe(true);
      expect(client.getQueryData(marketConflictsKey(id, 'a'))).toEqual(conflicts);
      expect(client.getQueryData(marketConflictsKey(id, 'b'))).toBeUndefined();
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
