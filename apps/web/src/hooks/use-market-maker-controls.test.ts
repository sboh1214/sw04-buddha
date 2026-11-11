import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AdminMarketMaker, MarketMakerControlWrite } from '@/lib/api';
import { marketMaker } from '@/test/market-maker';
import { makerControlApproved, makerControlRequest } from '@/test/market-maker-control';
import { adminMarketMakerKey } from './use-admin-market-maker';
import {
  CONTROL_KEY,
  applyControlWrite,
  controlDetailKey,
  currentMaker,
} from './use-market-maker-controls';
const fresh: MarketMakerControlWrite = {
  request: makerControlApproved,
  marketMaker: {
    ...marketMaker,
    runtime: {
      ...marketMaker.runtime!,
      desiredEnabled: false,
      controlGeneration: '2',
      generation: '4',
      updatedAt: '2026-11-11T00:01:00.000Z',
    },
  },
};
describe('committed maker control cache', () => {
  it('retains committed terminal status and the runtime snapshot through a late pending response and GET failure', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      client.setQueryData(['me'], { id: 'admin-b' });
      client.setQueryData(adminMarketMakerKey(marketMaker.marketId), marketMaker);
      const pending = [...CONTROL_KEY, 'admin-b', marketMaker.marketId, 'list', false];
      const all = [...CONTROL_KEY, 'admin-b', marketMaker.marketId, 'list', true];
      for (const key of [pending, all])
        client.setQueryData(key, {
          pages: [{ items: [makerControlRequest], nextCursor: null }],
          pageParams: [undefined],
        });
      await applyControlWrite(client, 'admin-b', fresh);
      await applyControlWrite(client, 'admin-b', { request: makerControlRequest, marketMaker });
      await expect(
        client.fetchQuery({
          queryKey: adminMarketMakerKey(marketMaker.marketId),
          queryFn: () => Promise.reject(new Error('offline')),
        }),
      ).rejects.toThrow('offline');
      expect(client.getQueryData(adminMarketMakerKey(marketMaker.marketId))).toEqual(
        fresh.marketMaker,
      );
      expect(
        client.getQueryData<MarketMakerControlWrite>(
          controlDetailKey('admin-b', marketMaker.marketId, makerControlRequest.id),
        )?.request.status,
      ).toBe('approved');
      expect(
        client.getQueryData<{ pages: { items: unknown[] }[] }>(pending)?.pages[0]?.items,
      ).toEqual([]);
      expect(
        client.getQueryData<{ pages: { items: { status: string }[] }[] }>(all)?.pages[0]?.items[0]
          ?.status,
      ).toBe('approved');
    } finally {
      client.clear();
    }
  });
  it('does not overwrite a newer worker observation in the same operational generation', () => {
    const newer = {
      ...fresh.marketMaker,
      runtime: {
        ...fresh.marketMaker.runtime!,
        generation: '5',
        updatedAt: '2026-11-11T00:02:00.000Z',
        state: 'ready' as const,
      },
    };
    expect(currentMaker(newer, fresh.marketMaker)).toBe(newer);
    expect(
      currentMaker(newer, {
        ...fresh.marketMaker,
        runtime: { ...fresh.marketMaker.runtime!, controlGeneration: '3' },
      })?.runtime?.controlGeneration,
    ).toBe('3');
  });
  it('checks the operator again after asynchronous query cancellation', async () => {
    const client = new QueryClient();
    try {
      client.setQueryData(['me'], { id: 'admin-b' });
      const cancel = client.cancelQueries.bind(client);
      vi.spyOn(client, 'cancelQueries').mockImplementation(async (...args) => {
        await cancel(...args);
        client.setQueryData(['me'], { id: 'admin-c' });
      });
      expect(await applyControlWrite(client, 'admin-b', fresh)).toBe(false);
      expect(
        client.getQueryData<AdminMarketMaker>(adminMarketMakerKey(marketMaker.marketId)),
      ).toBeUndefined();
    } finally {
      client.clear();
    }
  });
});
