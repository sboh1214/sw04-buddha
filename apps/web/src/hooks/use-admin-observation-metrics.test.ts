import { QueryObserver, focusManager, partialMatchKey } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { getQueryClient } from '@/lib/query-client';
import {
  ADMIN_OBSERVATION_METRICS_KEY,
  adminObservationMetricsQueryOptions,
} from './use-admin-observation-metrics';
import { ADMIN_OPERATIONS_KEY } from './use-admin-operations';

const MINUTE = 60_000;

afterEach(() => {
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function answering() {
  return vi.spyOn(api, 'GET').mockResolvedValue({
    data: { data: { asOf: '2026-11-24T06:00:00.000Z' } },
    response: new Response(null, { status: 200 }),
  } as never);
}

/**
 * 관측 지표's one read (#96, ADR-0169) and its request budget (ADR-0138: at most 50 a minute per
 * signed-in tab): one GET on entry, one more per window focus once 30 s stale, none by a timer.
 */
describe('관측 지표’s query', () => {
  it('asks the one route with no query, under the private admin root', async () => {
    const get = answering();
    const options = adminObservationMetricsQueryOptions();
    expect(options.queryKey).toEqual(['admin', 'observation-metrics']);
    expect(await options.queryFn()).toEqual({ asOf: '2026-11-24T06:00:00.000Z' });
    expect(get).toHaveBeenCalledWith('/api/v1/admin/observation-metrics');
    // Apart from the other admin lists, with no timer and no option over the client's defaults.
    expect(partialMatchKey(ADMIN_OBSERVATION_METRICS_KEY, ADMIN_OPERATIONS_KEY)).toBe(false);
    expect(Object.keys(options).sort()).toEqual(['queryFn', 'queryKey']);
  });

  it('reads once on entry, again on a focus after 30 s, and never by a timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
    const get = answering();
    const queryClient = getQueryClient();
    // What QueryClientProvider does: the client listens to the window's focus.
    queryClient.mount();
    const observer = new QueryObserver(queryClient, adminObservationMetricsQueryOptions());
    const off = observer.subscribe(() => undefined);
    const focus = async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
    };
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledTimes(1);
      // A focus inside the 30 s: the numbers held, no request.
      await vi.advanceTimersByTimeAsync(10_000);
      await focus();
      expect(get).toHaveBeenCalledTimes(1);
      // Ten minutes on screen: no poll, no realtime.
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(get).toHaveBeenCalledTimes(1);
      // A focus once stale: one more.
      await focus();
      expect(get).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      off();
      queryClient.unmount();
      queryClient.clear();
    }
  });
});
