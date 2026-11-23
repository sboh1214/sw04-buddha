import {
  InfiniteQueryObserver,
  QueryObserver,
  environmentManager,
  partialMatchKey,
} from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AdminMarket, api } from '@/lib/api';
import { getQueryClient } from '@/lib/query-client';
import { ADMIN_OPERATIONS_KEY } from './use-admin-operations';
import {
  ADMIN_MARKET_KEY,
  adminMarketHeaderQueryOptions,
  adminMarketKey,
  adminMarketQueryOptions,
  applyMarket,
} from './use-admin-markets';
import {
  ADMIN_MARKET_WORK_KEY,
  adminMarketWorkKey,
  adminMarketWorkQueryOptions,
} from './use-admin-market-work';

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER = '3f2504e0-4f89-11d3-9a0c-0305e82c3302';
const MINUTE = 60_000;
const HISTORY = `/api/v1/admin/markets/{id}/work-history`;
const DETAIL = '/api/v1/admin/markets/{id}';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * `api.GET` answering every history read with an empty page (`nextCursor` as given) and every
 * detail read with a SETTLING market — the status the detail polls every few seconds.
 */
function answering(nextCursor: string | null = null) {
  return vi.spyOn(api, 'GET').mockImplementation(((path: string) =>
    Promise.resolve({
      data:
        path === HISTORY
          ? { data: [], meta: { nextCursor } }
          : { data: { id: ID, title: '첫눈이 올까?', status: 'settling' } },
      response: new Response(null, { status: 200 }),
    })) as never);
}

const callsTo = (get: ReturnType<typeof answering>, path: string) =>
  (get.mock.calls as unknown as [string, ...unknown[]][]).filter(([called]) => called === path)
    .length;

/**
 * 시장별 작업 이력 (#145 part 2, ADR-0164): what the history asks, under one prefix of the private
 * admin root, which every admin write to a market marks; and the screen's request budget (ADR-0138:
 * at most 50 a minute per signed-in tab) — the history and the market's header once, a kind once in
 * 30 s, 더 보기 one each, and nothing by a timer, even for a market the detail polls.
 */
describe('작업 이력’s queries', () => {
  it('asks one market’s history a page per cursor, with its kind or none for 전체', async () => {
    const get = answering('c2');
    const all = adminMarketWorkQueryOptions(ID, undefined);
    expect(all.queryKey).toEqual(['admin', 'market-work', ID, 'all']);
    expect(all.enabled).toBe(true);
    expect(await all.queryFn({ pageParam: undefined })).toEqual({ items: [], nextCursor: 'c2' });
    expect(get).toHaveBeenLastCalledWith(HISTORY, { params: { path: { id: ID }, query: {} } });
    await all.queryFn({ pageParam: 'c2' });
    expect(get).toHaveBeenLastCalledWith(HISTORY, {
      params: { path: { id: ID }, query: { cursor: 'c2' } },
    });
    const settlement = adminMarketWorkQueryOptions(ID, 'settlement');
    expect(settlement.queryKey).toEqual(['admin', 'market-work', ID, 'settlement']);
    await settlement.queryFn({ pageParam: 'c3' });
    expect(get).toHaveBeenLastCalledWith(HISTORY, {
      params: { path: { id: ID }, query: { kind: 'settlement', cursor: 'c3' } },
    });
    expect(settlement.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
    expect(settlement.getNextPageParam({ items: [], nextCursor: 'c4' })).toBe('c4');
  });

  it('is keyed on the canonical id, and asks nothing for a segment that names no market', () => {
    expect(adminMarketWorkQueryOptions(ID.toUpperCase(), 'edit').queryKey).toEqual(
      adminMarketWorkKey(ID, 'edit'),
    );
    expect(adminMarketWorkQueryOptions('abc', undefined).enabled).toBe(false);
    for (const key of [adminMarketWorkKey(ID, undefined), adminMarketWorkKey(OTHER, 'pause')]) {
      expect(partialMatchKey(key, ADMIN_MARKET_WORK_KEY)).toBe(true);
    }
    for (const other of [ADMIN_MARKET_KEY, ADMIN_OPERATIONS_KEY]) {
      expect(partialMatchKey(ADMIN_MARKET_WORK_KEY, other)).toBe(false);
    }
  });

  it('keeps another kind’s rows of the same market while the next loads, never another market’s', () => {
    const options = adminMarketWorkQueryOptions(ID, 'pause');
    const held = { pages: [], pageParams: [] };
    expect(options).not.toHaveProperty('refetchInterval');
    expect(options.placeholderData(held, { queryKey: adminMarketWorkKey(ID, undefined) })).toBe(
      held,
    );
    expect(
      options.placeholderData(held, { queryKey: adminMarketWorkKey(OTHER, 'pause') }),
    ).toBeUndefined();
    expect(options.placeholderData(held, undefined)).toBeUndefined();
  });

  it('reads the header under the detail’s key with no timer of its own', () => {
    const header = adminMarketHeaderQueryOptions(ID);
    expect(header.queryKey).toEqual(adminMarketQueryOptions(ID).queryKey);
    expect(header.queryKey).toEqual(adminMarketKey(ID));
    expect(header.refetchInterval).toBe(false);
  });

  it('is marked by every admin write to a market — this one’s and any other’s', async () => {
    const queryClient = getQueryClient();
    try {
      const keys = [adminMarketWorkKey(ID, undefined), adminMarketWorkKey(OTHER, 'other')];
      for (const key of keys) queryClient.setQueryData(key, { pages: [], pageParams: [] });
      // A link written from this market adds its row to the other end's history too (145-13).
      await applyMarket(queryClient, ID, { id: ID, status: 'open' } as AdminMarket);
      for (const key of keys) {
        expect(queryClient.getQueryState(key)?.isInvalidated, key.join('/')).toBe(true);
      }
    } finally {
      queryClient.clear();
    }
  });
});

describe('작업 이력’s request budget (ADR-0138, ADR-0164 결과)', () => {
  it('reads the history and the header once, a kind once in 30 s, 더 보기 once, and nothing by a timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
    // A browser, not the server: query-core runs no `refetchInterval` under node, where a poll
    // would otherwise go unseen.
    environmentManager.setIsServer(() => false);
    const get = answering('c2');
    const queryClient = getQueryClient();
    const mountList = (kind: Parameters<typeof adminMarketWorkQueryOptions>[1]) => {
      const observer = new InfiniteQueryObserver(
        queryClient,
        adminMarketWorkQueryOptions(ID, kind) as never,
      );
      return { observer, off: observer.subscribe(() => undefined) };
    };
    try {
      // Entry: the header (a SETTLING market, which the detail would re-read every few seconds)
      // and 전체 — two GETs.
      const header = new QueryObserver(queryClient, adminMarketHeaderQueryOptions(ID));
      const offHeader = header.subscribe(() => undefined);
      let list = mountList(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(callsTo(get, DETAIL)).toBe(1);
      expect(callsTo(get, HISTORY)).toBe(1);
      // 더 보기: one more.
      await list.observer.fetchNextPage();
      expect(callsTo(get, HISTORY)).toBe(2);
      // 지급 a few seconds later: one more; back to 전체 inside its 30 s: none.
      await vi.advanceTimersByTimeAsync(5_000);
      list.off();
      list = mountList('settlement');
      await vi.advanceTimersByTimeAsync(0);
      expect(callsTo(get, HISTORY)).toBe(3);
      await vi.advanceTimersByTimeAsync(5_000);
      list.off();
      list = mountList(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(callsTo(get, HISTORY)).toBe(3);
      // Ten minutes on screen: no poll of either, though the market is 지급 중.
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(callsTo(get, HISTORY)).toBe(3);
      expect(callsTo(get, DETAIL)).toBe(1);
      list.off();
      offHeader();
    } finally {
      queryClient.clear();
      environmentManager.setIsServer(() => typeof window === 'undefined' || 'Deno' in globalThis);
    }
  });
});
