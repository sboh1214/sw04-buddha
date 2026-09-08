import { QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { positionsKey } from '@/hooks/use-portfolio';
import { type Position } from './api';
import { POSITIONS_KEY } from './market-keys';
import { cancelFirstFetch, getQueryClient, listView } from './query-client';

/**
 * `cancelFirstFetch`'s predicate, driven through the REAL client this app ships.
 *
 * The predicate is the whole safety of the cancel, and what it protects is not obvious: a
 * MOUNTED list loses nothing either way, because the invalidation's own `cancelRefetch` was
 * going to cancel that refetch anyway. It is the UNMOUNTED one that pays.
 */
const position: Position = {
  marketId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  marketSlug: 'rate-cut-2026',
  marketTitle: '기준금리 인하?',
  marketStatus: 'open',
  marketLastPrice: 50,
  resolvedResult: null,
  outcome: 'YES',
  qty: 10,
  costBasisP: '5000',
  realizedPnlP: '0',
  settled: false,
  version: 3,
  updatedAt: '2026-09-06T00:00:00.000Z',
};

describe('cancelFirstFetch', () => {
  it('keeps an answer already on the wire for a list nobody is watching', async () => {
    // THE CASE THE PREDICATE EXISTS FOR. An unpredicated `cancelQueries` REVERTS this list to
    // the rows it held before the refetch (revert defaults true), and the invalidation behind
    // it refetches only what is ACTIVE — so a list whose screen has just unmounted gets its
    // in-flight answer thrown away and nothing scheduled to ask again, and the stale row
    // stands until something mounts the list once more.
    const queryClient = getQueryClient();
    let land: (rows: Position[]) => void = () => undefined;
    const observer = new QueryObserver<Position[]>(queryClient, {
      queryKey: positionsKey('settled'),
      queryFn: () =>
        new Promise<Position[]>((resolve) => {
          land = resolve;
        }),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      const first = observer.refetch();
      land([position]);
      await first;

      // A refetch is in flight when the screen holding it goes away. The queryFn consumes no
      // `signal` (nor does the app's `api.GET`), so query-core lets the request run on.
      const second = observer.refetch().catch(() => undefined);
      unsubscribe();

      cancelFirstFetch(queryClient, POSITIONS_KEY);

      land([{ ...position, qty: 99, version: 4 }]);
      await second;
      expect(queryClient.getQueryData<Position[]>(positionsKey('settled'))?.[0]?.qty).toBe(99);
    } finally {
      queryClient.clear();
    }
  });
  it('leaves a refetch that already has an answer to `cancelRefetch`', async () => {
    // The mounted half of the same rule, and here the predicate costs nothing either way:
    // `refetchQueries` passes `cancelRefetch` and query-core honours it on a list that holds
    // rows, so this refetch was going to be cancelled and restarted regardless. What the
    // predicate saves is the spinner blip — without it the state below reads 'idle' for a
    // moment while a request is genuinely in flight. The answer is only LOST when nobody is
    // watching (the case above).
    const queryClient = getQueryClient();
    let land: (rows: Position[]) => void = () => undefined;
    const observer = new QueryObserver<Position[]>(queryClient, {
      queryKey: positionsKey('open'),
      queryFn: () =>
        new Promise<Position[]>((resolve) => {
          land = resolve;
        }),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      const first = observer.refetch();
      land([position]);
      await first;

      // A refetch over rows that are already there — the case the predicate must skip.
      const second = observer.refetch();
      expect(queryClient.getQueryState(positionsKey('open'))?.fetchStatus).toBe('fetching');

      cancelFirstFetch(queryClient, POSITIONS_KEY);

      expect(queryClient.getQueryState(positionsKey('open'))?.fetchStatus).toBe('fetching');
      land([{ ...position, qty: 99 }]);
      await second;
      expect(queryClient.getQueryData<Position[]>(positionsKey('open'))?.[0]?.qty).toBe(99);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });
});

describe('listView', () => {
  it('calls a list STALE when its refetch failed but the rows are still there', () => {
    // THE HAZARD: query-core reports a failure two ways, and a ladder written on
    // `isLoadingError` alone folds one of them into `ready`. Measured with a real observer: a
    // refetch that fails after data exists answers `isLoadingError: false, isRefetchError: true`
    // and KEEPS the rows — so 보유 포지션 and 체결 내역 went on rendering a list that had stopped
    // being refreshed, with nothing on screen to say so and no way back.
    expect(listView({ isPending: false, isLoadingError: false, isRefetchError: true })).toBe(
      'stale',
    );
  });

  it('keeps the two failures apart, because only one of them has rows to show', () => {
    // A FIRST fetch that exhausts its retries has nothing to render, so the section is replaced
    // by `LoadFailed`. A failed refetch keeps its answer, and dropping a screenful because one
    // refresh failed loses more than the staleness costs — the reading `market-list.tsx` takes.
    expect(listView({ isPending: false, isLoadingError: true, isRefetchError: false })).toBe(
      'failed',
    );
  });

  it('reports pending first, because a query retrying after a failure reports both', () => {
    expect(listView({ isPending: true, isLoadingError: false, isRefetchError: true })).toBe(
      'pending',
    );
  });

  it('is ready only when nothing failed', () => {
    expect(listView({ isPending: false, isLoadingError: false, isRefetchError: false })).toBe(
      'ready',
    );
  });
});
