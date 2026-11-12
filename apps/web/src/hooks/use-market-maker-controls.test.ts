import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AdminMarketMaker, MarketMakerControlWrite } from '@/lib/api';
import { marketMaker } from '@/test/market-maker';
import { makerControlApproved, makerControlRequest } from '@/test/market-maker-control';
import { adminMarketMakerKey } from './use-admin-market-maker';
import { adminMarketKey } from './use-admin-markets';
import { makerMetricsKey, makerMetricsListKey, makerOverviewKey } from './use-market-maker-metrics';
import { treasuryBalanceKey } from './use-treasury';
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
type Action = NonNullable<MarketMakerControlWrite['request']['execution']>['action'];
const derivedKeys = (operator = 'admin-b'): readonly QueryKey[] => [
  makerMetricsKey(operator, marketMaker.marketId),
  makerOverviewKey(operator),
  makerMetricsListKey(operator),
  adminMarketKey(marketMaker.marketId),
  treasuryBalanceKey,
];
const executed = (action: Action): MarketMakerControlWrite => ({
  ...fresh,
  request: {
    ...fresh.request,
    execution: { ...fresh.request.execution!, action },
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('committed maker control cache', () => {
  it.each(['stop', 'resume', 'settings', 'increase'] as const)(
    'marks only the derived reads changed by an executed %s stale',
    async (action) => {
      const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
      try {
        client.setQueryData(['me'], { id: 'admin-b' });
        const keys = derivedKeys();
        const unrelated = [
          ...derivedKeys('admin-c').slice(0, 3),
          makerMetricsKey('admin-b', 'other-market'),
          adminMarketKey('other-market'),
          ['admin', 'treasury', 'history'],
        ];
        for (const key of [...keys, ...unrelated]) client.setQueryData(key, { cached: true });
        expect(await applyControlWrite(client, 'admin-b', executed(action))).toBe(true);
        const changed = action === 'increase' ? 5 : action === 'settings' ? 4 : 3;
        for (const [index, key] of keys.entries())
          expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(
            index < changed,
          );
        for (const key of unrelated)
          expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(false);
      } finally {
        client.clear();
      }
    },
  );
  it('cancels pre-approval reads and refreshes mounted snapshots without a late GET overwriting them', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const reads = derivedKeys().map((queryKey, index) => ({
      queryKey,
      old: deferred<{ version: number; availableCoin: string }>(),
      after: { version: 2, availableCoin: String(900 - index) },
      signal: undefined as AbortSignal | undefined,
      calls: 0,
    }));
    const observers = reads.map((read) => {
      client.setQueryData(read.queryKey, { version: 1, availableCoin: '1000' });
      return new QueryObserver(client, {
        queryKey: read.queryKey,
        queryFn: ({ signal }) => {
          read.calls += 1;
          if (read.calls === 1) {
            read.signal = signal;
            return read.old.promise;
          }
          return Promise.resolve(read.after);
        },
      });
    });
    const unsubscribes = observers.map((observer) => observer.subscribe(() => undefined));
    const pending = observers.map((observer) => observer.refetch());
    try {
      client.setQueryData(['me'], { id: 'admin-b' });
      await applyControlWrite(client, 'admin-b', executed('increase'));
      await vi.waitFor(() => {
        for (const read of reads) {
          expect(read.signal?.aborted).toBe(true);
          expect(read.calls).toBe(2);
          expect(client.getQueryData(read.queryKey)).toEqual(read.after);
        }
      });
      for (const read of reads) read.old.resolve({ version: 1, availableCoin: '1000' });
      await Promise.all(pending);
      for (const read of reads) expect(client.getQueryData(read.queryKey)).toEqual(read.after);
      expect(client.getQueryData(adminMarketMakerKey(marketMaker.marketId))).toEqual(
        fresh.marketMaker,
      );
    } finally {
      for (const read of reads) read.old.resolve({ version: 1, availableCoin: '1000' });
      for (const unsubscribe of unsubscribes) unsubscribe();
      client.clear();
    }
  });
  it.each(['pending', 'rejected', 'retracted', 'approved'] as const)(
    'does not refetch economic snapshots for a %s response without execution',
    async (status) => {
      const client = new QueryClient();
      try {
        client.setQueryData(['me'], { id: 'admin-b' });
        // A late pending answer may retain an approved cached row; it is still not a new execution.
        client.setQueryData(
          controlDetailKey('admin-b', marketMaker.marketId, fresh.request.id),
          fresh,
        );
        for (const key of derivedKeys()) client.setQueryData(key, { cached: true });
        await applyControlWrite(client, 'admin-b', {
          ...fresh,
          request: { ...fresh.request, status, execution: null },
        });
        for (const key of derivedKeys())
          expect(client.getQueryState(key)?.isInvalidated).toBe(false);
      } finally {
        client.clear();
      }
    },
  );
  it('does not invalidate either operator or shared economic caches after an account switch', async () => {
    const client = new QueryClient();
    try {
      client.setQueryData(['me'], { id: 'admin-c' });
      for (const key of [...derivedKeys(), ...derivedKeys('admin-c')])
        client.setQueryData(key, { cached: true });
      expect(await applyControlWrite(client, 'admin-b', executed('increase'))).toBe(false);
      for (const key of [...derivedKeys(), ...derivedKeys('admin-c')])
        expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    } finally {
      client.clear();
    }
  });
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
      for (const key of derivedKeys()) client.setQueryData(key, { cached: true });
      const cancel = client.cancelQueries.bind(client);
      vi.spyOn(client, 'cancelQueries').mockImplementation(async (...args) => {
        await cancel(...args);
        client.setQueryData(['me'], { id: 'admin-c' });
      });
      expect(await applyControlWrite(client, 'admin-b', executed('increase'))).toBe(false);
      for (const key of derivedKeys()) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
      expect(
        client.getQueryData<AdminMarketMaker>(adminMarketMakerKey(marketMaker.marketId)),
      ).toBeUndefined();
    } finally {
      client.clear();
    }
  });
});
