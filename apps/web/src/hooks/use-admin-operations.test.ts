import { readFileSync } from 'node:fs';
import { InfiniteQueryObserver, partialMatchKey } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AdminMarket, api } from '@/lib/api';
import { getQueryClient } from '@/lib/query-client';
import { ADMIN_MARKETS_KEY, ADMIN_MARKET_JUDGEMENTS_KEY, applyMarket } from './use-admin-markets';
import {
  ADMIN_OPERATIONS_FAILURES_KEY,
  ADMIN_OPERATIONS_KEY,
  adminOperationsClosingKey,
  adminOperationsClosingQueryOptions,
  adminOperationsFailuresQueryOptions,
  adminOperationsJudgementsKey,
  adminOperationsJudgementsQueryOptions,
} from './use-admin-operations';

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const MINUTE = 60_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** `api.GET` answering an empty page, `nextCursor` as given: what each list asks is recorded. */
function answering(nextCursor: string | null = null) {
  return vi.spyOn(api, 'GET').mockResolvedValue({
    data: { data: [], meta: { nextCursor } },
    response: new Response(null, { status: 200 }),
  } as never);
}

/**
 * 운영 대기열's three lists (#145, ADR-0163): what each asks, under one prefix of the private admin
 * root, and the request budget of the screen (ADR-0138: at most 50 a minute per signed-in tab) —
 * one GET for the list on screen, one more per sub-choice not read in the last 30 s, none by a
 * timer, and every admin write to a market marks the lists.
 */
describe('운영 대기열’s queries', () => {
  it('asks each list a page per cursor with its own sub-choice', async () => {
    const get = answering('c2');
    for (const within of ['24h', '3d', '7d'] as const) {
      const options = adminOperationsClosingQueryOptions(within);
      expect(options.queryKey).toEqual(['admin', 'operations', 'closing', within]);
      expect(await options.queryFn({ pageParam: undefined })).toEqual({
        items: [],
        nextCursor: 'c2',
      });
      expect(get).toHaveBeenLastCalledWith('/api/v1/admin/operations/closing', {
        params: { query: { within } },
      });
      await options.queryFn({ pageParam: 'c2' });
      expect(get).toHaveBeenLastCalledWith('/api/v1/admin/operations/closing', {
        params: { query: { within, cursor: 'c2' } },
      });
      expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
      expect(options.getNextPageParam({ items: [], nextCursor: 'c3' })).toBe('c3');
    }
    for (const filter of ['all', 'delayed'] as const) {
      const options = adminOperationsJudgementsQueryOptions(filter);
      expect(options.queryKey).toEqual(['admin', 'operations', 'judgements', filter]);
      await options.queryFn({ pageParam: undefined });
      expect(get).toHaveBeenLastCalledWith('/api/v1/admin/operations/judgements', {
        params: { query: { filter } },
      });
      await options.queryFn({ pageParam: 'c2' });
      expect(get).toHaveBeenLastCalledWith('/api/v1/admin/operations/judgements', {
        params: { query: { filter, cursor: 'c2' } },
      });
    }
    const failures = adminOperationsFailuresQueryOptions();
    expect(failures.queryKey).toEqual(['admin', 'operations', 'failures']);
    await failures.queryFn({ pageParam: undefined });
    expect(get).toHaveBeenLastCalledWith('/api/v1/admin/operations/failures', {
      params: { query: {} },
    });
    await failures.queryFn({ pageParam: 'c2' });
    expect(get).toHaveBeenLastCalledWith('/api/v1/admin/operations/failures', {
      params: { query: { cursor: 'c2' } },
    });
  });

  it('keeps every list under its own prefix, apart from the other admin lists', () => {
    for (const key of [
      adminOperationsClosingKey('24h'),
      adminOperationsJudgementsKey('delayed'),
      ADMIN_OPERATIONS_FAILURES_KEY,
    ]) {
      expect(partialMatchKey(key, ADMIN_OPERATIONS_KEY)).toBe(true);
    }
    for (const other of [ADMIN_MARKETS_KEY, ADMIN_MARKET_JUDGEMENTS_KEY]) {
      expect(partialMatchKey(ADMIN_OPERATIONS_KEY, other)).toBe(false);
    }
    // No timer of their own, and the previous sub-choice's rows stay while the next loads.
    for (const options of [
      adminOperationsClosingQueryOptions('24h'),
      adminOperationsJudgementsQueryOptions('all'),
      adminOperationsFailuresQueryOptions(),
    ]) {
      expect(options).not.toHaveProperty('refetchInterval');
      expect(options.placeholderData).toBeTypeOf('function');
    }
  });

  it('is asked again by every admin write to a market, and the retry', async () => {
    const queryClient = getQueryClient();
    try {
      const keys = [
        adminOperationsClosingKey('3d'),
        adminOperationsJudgementsKey('all'),
        ADMIN_OPERATIONS_FAILURES_KEY,
      ];
      for (const key of keys) queryClient.setQueryData(key, { pages: [], pageParams: [] });
      await applyMarket(queryClient, ID, { id: ID, status: 'settled' } as AdminMarket);
      for (const key of keys) {
        expect(queryClient.getQueryState(key)?.isInvalidated, key.join('/')).toBe(true);
      }
    } finally {
      queryClient.clear();
    }
    // The retry dialog reads them again through the same call (settlement-retry-write.test.ts).
    expect(
      readFileSync(
        new URL('../app/admin/operations/settlement-retry-dialog.tsx', import.meta.url),
        {
          encoding: 'utf8',
        },
      ),
    ).toContain('const refresh = () => invalidateMarket(queryClient, marketId);');
  });
});

describe('운영 대기열’s request budget (ADR-0138, ADR-0163 결과)', () => {
  it('reads the list on screen once, a sub-choice once in 30 s, and nothing by a timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
    const get = answering();
    const queryClient = getQueryClient();
    const mount = <T extends { queryKey: readonly unknown[] }>(options: T) => {
      const observer = new InfiniteQueryObserver(queryClient, options as never);
      return observer.subscribe(() => undefined);
    };
    try {
      // Entry: 마감 예정 in 24시간, one GET.
      let off = mount(adminOperationsClosingQueryOptions('24h'));
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledTimes(1);
      // 3일 a few seconds later: one more.
      await vi.advanceTimersByTimeAsync(5_000);
      off();
      off = mount(adminOperationsClosingQueryOptions('3d'));
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledTimes(2);
      // Back to 24시간 inside its 30 s: the rows held, no request.
      await vi.advanceTimersByTimeAsync(5_000);
      off();
      off = mount(adminOperationsClosingQueryOptions('24h'));
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledTimes(2);
      // Ten minutes on screen: no poll, no realtime.
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(get).toHaveBeenCalledTimes(2);
      off();
      // The other two tabs: one GET each, then nothing by a timer.
      off = mount(adminOperationsJudgementsQueryOptions('all'));
      await vi.advanceTimersByTimeAsync(0);
      off();
      off = mount(adminOperationsFailuresQueryOptions());
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(get).toHaveBeenCalledTimes(4);
      off();
    } finally {
      queryClient.clear();
    }
  });
});
