import { InfiniteQueryObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { makerMetrics, makerMetricsRow, makerOverview } from '@/test/market-maker-metrics';
import {
  makerMetricsKey,
  makerMetricsListKey,
  makerMetricsListOptions,
  makerMetricsOptions,
  makerOverviewKey,
  makerOverviewOptions,
} from './use-market-maker-metrics';

const answer = (data: unknown, meta = {}) =>
  ({ data: { data, meta }, response: new Response() }) as never;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
afterEach(() => vi.restoreAllMocks());

describe('private current metrics reads', () => {
  it('disables every read until an operator is known and uses separate account scopes', () => {
    expect(makerMetricsOptions(undefined, makerMetrics.marketId).enabled).toBe(false);
    expect(makerOverviewOptions(undefined).enabled).toBe(false);
    expect(makerMetricsListOptions(undefined).enabled).toBe(false);
    expect(makerMetricsKey('a', makerMetrics.marketId)).not.toEqual(
      makerMetricsKey('b', makerMetrics.marketId),
    );
    expect(makerOverviewKey('a')).not.toEqual(makerOverviewKey('b'));
    expect(makerMetricsListKey('a')).not.toEqual(makerMetricsListKey('b'));
  });
  it('forwards cancellation and cannot put the prior operator response on the new operator screen', async () => {
    const a = deferred<never>();
    const b = deferred<never>();
    const get = vi.spyOn(api, 'GET').mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const cache = client();
    const observer = new QueryObserver(cache, makerMetricsOptions('a', makerMetrics.marketId));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      const signal = (get.mock.calls[0]?.[1] as { signal: AbortSignal } | undefined)?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      observer.setOptions(makerMetricsOptions('b', makerMetrics.marketId));
      expect(signal?.aborted).toBe(true);
      expect(observer.getCurrentResult().data).toBeUndefined();
      b.resolve(answer({ ...makerMetrics, title: 'B 응답' }));
      await vi.waitFor(() => expect(observer.getCurrentResult().data?.title).toBe('B 응답'));
      a.resolve(answer({ ...makerMetrics, title: 'A 응답' }));
      await a.promise;
      expect(observer.getCurrentResult().data?.title).toBe('B 응답');
      expect(cache.getQueryData(makerMetricsKey('a', makerMetrics.marketId))).toBeUndefined();
    } finally {
      unsubscribe();
      cache.clear();
    }
  });
  it('ignores an aborted late snapshot after a manual refresh has already returned', async () => {
    const older = deferred<never>();
    const newer = {
      ...makerOverview,
      asOf: '2026-11-11T02:00:00.000Z',
      totals: { ...makerOverview.totals, fundsCoin: '700' },
    };
    const get = vi
      .spyOn(api, 'GET')
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(answer(newer));
    const cache = client();
    cache.setQueryData(makerOverviewKey('a'), makerOverview);
    const observer = new QueryObserver(cache, makerOverviewOptions('a'));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      const first = observer.refetch();
      const signal = (get.mock.calls[0]?.[1] as { signal: AbortSignal } | undefined)?.signal;
      await observer.refetch({ cancelRefetch: true });
      expect(signal?.aborted).toBe(true);
      older.resolve(answer(makerOverview));
      await first;
      expect(cache.getQueryData(makerOverviewKey('a'))).toEqual(newer);
    } finally {
      unsubscribe();
      cache.clear();
    }
  });
  it('keeps the loaded rows on a failed next page and sends the server cursor unchanged', async () => {
    const get = vi
      .spyOn(api, 'GET')
      .mockResolvedValueOnce(answer([makerMetricsRow], { nextCursor: 'opaque-cursor' }))
      .mockRejectedValueOnce(new Error('503'));
    const cache = client();
    const observer = new InfiniteQueryObserver(cache, makerMetricsListOptions('a'));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().data?.pages).toHaveLength(1));
      await observer.fetchNextPage();
      expect(get).toHaveBeenLastCalledWith('/api/v1/admin/market-makers', {
        params: { query: { cursor: 'opaque-cursor' } },
        signal: expect.any(AbortSignal) as unknown,
      });
      expect(observer.getCurrentResult().isFetchNextPageError).toBe(true);
      expect(observer.getCurrentResult().data?.pages[0]?.items).toEqual([makerMetricsRow]);
    } finally {
      unsubscribe();
      cache.clear();
    }
  });
  it('preserves the last overview snapshot on 503 and marks the read as an error', async () => {
    const get = vi.spyOn(api, 'GET').mockRejectedValue(new Error('503'));
    const cache = client();
    cache.setQueryData(makerOverviewKey('a'), makerOverview);
    try {
      await expect(
        cache.fetchQuery({ ...makerOverviewOptions('a'), staleTime: 0 }),
      ).rejects.toThrow('503');
      expect(get).toHaveBeenCalledOnce();
      expect(cache.getQueryData(makerOverviewKey('a'))).toEqual(makerOverview);
      expect(cache.getQueryState(makerOverviewKey('a'))?.status).toBe('error');
    } finally {
      cache.clear();
    }
  });
});
