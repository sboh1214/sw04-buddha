import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { anomalyReport } from '@/test/trading-anomalies';
import { tradingAnomaliesKey, tradingAnomaliesOptions } from './use-trading-anomalies';

const answer = (data: unknown) => ({ data: { data, meta: {} }, response: new Response() }) as never;
function deferred() {
  let resolve!: (value: never) => void;
  const promise = new Promise<never>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => vi.restoreAllMocks());

describe('fixed private anomaly snapshots', () => {
  it('requires a known operator and never automatically replaces a viewed snapshot', () => {
    const options = tradingAnomaliesOptions(undefined);
    expect(options.enabled).toBe(false);
    expect(options.staleTime).toBe(Infinity);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnReconnect).toBe(false);
    expect(options.refetchOnMount).toBe(false);
    expect(tradingAnomaliesKey('a', '')).not.toEqual(tradingAnomaliesKey('b', ''));
  });
  it('cancels the old operator request without leaking a late answer into the next account', async () => {
    const older = deferred();
    const newer = deferred();
    const get = vi
      .spyOn(api, 'GET')
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const cache = client();
    const observer = new QueryObserver(cache, tradingAnomaliesOptions('a'));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      const signal = (get.mock.calls[0]?.[1] as { signal: AbortSignal } | undefined)?.signal;
      observer.setOptions(tradingAnomaliesOptions('b'));
      expect(signal?.aborted).toBe(true);
      expect(observer.getCurrentResult().data).toBeUndefined();
      newer.resolve(answer({ ...anomalyReport, asOf: '2026-11-11T03:00:00.000Z' }));
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data?.asOf).toBe('2026-11-11T03:00:00.000Z'),
      );
      older.resolve(answer(anomalyReport));
      await older.promise;
      expect(cache.getQueryData(tradingAnomaliesKey('a', ''))).toBeUndefined();
      expect(observer.getCurrentResult().data?.asOf).toBe('2026-11-11T03:00:00.000Z');
    } finally {
      unsubscribe();
      cache.clear();
    }
  });
  it('refreshes the same filter atomically and discards an aborted late calculation', async () => {
    const older = deferred();
    const next = { ...anomalyReport, asOf: '2026-11-11T04:00:00.000Z' };
    const get = vi
      .spyOn(api, 'GET')
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(answer(next));
    const cache = client();
    const marketId = anomalyReport.candidates[0]!.market.id;
    cache.setQueryData(tradingAnomaliesKey('a', marketId), anomalyReport);
    const observer = new QueryObserver(cache, tradingAnomaliesOptions('a', marketId));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      const first = observer.refetch();
      const signal = (get.mock.calls[0]?.[1] as { signal: AbortSignal } | undefined)?.signal;
      await observer.refetch({ cancelRefetch: true });
      expect(signal?.aborted).toBe(true);
      older.resolve(answer(anomalyReport));
      await first;
      expect(observer.getCurrentResult().data).toEqual(next);
      expect(get).toHaveBeenLastCalledWith('/api/v1/admin/trading-anomalies', {
        params: { query: { marketId } },
        signal: expect.any(AbortSignal) as unknown,
      });
    } finally {
      unsubscribe();
      cache.clear();
    }
  });
  it('retains the earlier snapshot and error state on a failed refresh', async () => {
    vi.spyOn(api, 'GET').mockRejectedValue(new Error('503'));
    const cache = client();
    cache.setQueryData(tradingAnomaliesKey('a', ''), anomalyReport);
    const observer = new QueryObserver(cache, tradingAnomaliesOptions('a'));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      expect(observer.getCurrentResult().isError).toBe(true);
      expect(observer.getCurrentResult().data).toEqual(anomalyReport);
    } finally {
      unsubscribe();
      cache.clear();
    }
  });
});
