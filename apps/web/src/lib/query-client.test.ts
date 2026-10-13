import { QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { positionsKey } from '@/hooks/use-portfolio';
import { type Position } from './api';
import { POSITIONS_KEY } from './market-keys';
import {
  cancelFirstFetch,
  getQueryClient,
  listSection,
  listView,
  profileView,
  sessionListSection,
} from './query-client';

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
  costBasisCoin: '5000',
  realizedPnlCoin: '0',
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

describe('listSection', () => {
  it('shows the rows AND says the refresh failed, because the notice is not a rung', () => {
    // 주문 이력 rendered `isLoadingError` alone, so a refetch that failed after the rows existed
    // — the ONLY path a new order arrives by, since nothing patches `['orders']` in place —
    // landed on the ordinary rows arm with no notice and no way back.
    expect(
      listSection({ isPending: false, isLoadingError: false, isRefetchError: true }, 1),
    ).toEqual({ stale: true, body: 'rows' });
  });

  it('keeps saying 끝난 주문이 없습니다 UNDER the notice, never instead of it', () => {
    // The empty variant is the one that states something FALSE rather than merely stale: an
    // account with no prior orders trades in another tab, the orders refetch fails, and the
    // section asserts there is no order history about an order the balance and the holding on
    // the same screen already show. The empty body is still the last thing the server said, so
    // it stays — but it does not stay unlabelled. A ladder that spent `stale` as a fourth arm
    // would replace it and say nothing at all.
    expect(
      listSection({ isPending: false, isLoadingError: false, isRefetchError: true }, 0),
    ).toEqual({ stale: true, body: 'empty' });
  });

  it('never marks a first-load failure stale — there is nothing to keep', () => {
    expect(
      listSection({ isPending: false, isLoadingError: true, isRefetchError: false }, 0),
    ).toEqual({ stale: false, body: 'failed' });
    expect(
      listSection({ isPending: true, isLoadingError: false, isRefetchError: true }, 0),
    ).toEqual({ stale: false, body: 'pending' });
  });
});

describe('profileView', () => {
  it('calls a lost session what it is, not a profile that failed to load', () => {
    // THE HAZARD: a session ending under a MOUNTED screen disables every private query in the
    // same render and `SessionCacheGuard` then resets the cache, so the observer settles at
    // "no data, not pending" — which every one of these screens read as a load failure, offering
    // a 다시 시도 that can only 401. The page gate is server-side and runs on navigation only,
    // so nothing moves the reader off the screen. Measured: status 'pending', fetchStatus
    // 'idle', data undefined, and the hook's own override collapses isPending to false.
    expect(
      profileView({ isLoggedIn: false, isPending: false, isFetching: false, hasProfile: false }),
    ).toBe('signedOut');
  });

  it('tests pending FIRST, so a sign-in prompt never flashes on an ordinary load', () => {
    // `useSession` pins `isPending` through hydration and `isLoggedIn` is false there too, so a
    // bare `!isLoggedIn` would show the prompt on EVERY load — an always-on regression worse
    // than the bug. `isFetching` covers the other half: the tab that signs out clears `['me']`
    // while better-auth's atom still holds the old session (DECISIONS.md, M1 PR #2 round 3,
    // where its absence flashed a false error on every ordinary logout, reproduced 3/3).
    expect(
      profileView({ isLoggedIn: false, isPending: true, isFetching: false, hasProfile: false }),
    ).toBe('pending');
    expect(
      profileView({ isLoggedIn: false, isPending: false, isFetching: true, hasProfile: false }),
    ).toBe('pending');
  });

  it('keeps `failed` honest: signed in, settled, and the profile really did not arrive', () => {
    expect(
      profileView({ isLoggedIn: true, isPending: false, isFetching: false, hasProfile: false }),
    ).toBe('failed');
    expect(
      profileView({ isLoggedIn: true, isPending: false, isFetching: false, hasProfile: true }),
    ).toBe('ready');
  });

  it('never blanks a profile it already holds, which `isFetching` first would do', () => {
    // `isFetching` is true for EVERY background refetch — a focus refetch, an expired staleTime
    // — so asking it before the data would drop a skeleton over a good balance several times an
    // hour. Measured on a real observer mid-refetch: `isPending false, isFetching true, hasData
    // true`. The flags only decide what to say when there is nothing to show.
    expect(
      profileView({ isLoggedIn: true, isPending: false, isFetching: true, hasProfile: true }),
    ).toBe('ready');
    // Even a session already gone keeps the last figure on screen for the tick before
    // `SessionCacheGuard` empties the cache; a stale number beats a flash of nothing.
    expect(
      profileView({ isLoggedIn: false, isPending: false, isFetching: false, hasProfile: true }),
    ).toBe('ready');
  });
});

describe('sessionListSection', () => {
  it('says the refresh failed instead of asserting 아직 이 시장에 참여하지 않았습니다', () => {
    // THE FALSE SENTENCE: `user:position` can neither BUILD a row (it carries no marketSlug,
    // marketTitle, marketStatus or marketLastPrice) nor MOVE one between the open and settled
    // lists, so `applyPositionEvent` answers `refetch` for both — another tab opening this
    // market's first holding, and a settlement. That refetch is the ONLY path, and when it
    // failed the detail card told an account that DOES hold — on a settled market, one already
    // paid out — that it never participated. The empty rung is the one that most needs a label.
    expect(
      sessionListSection(
        { isLoggedIn: true, isPending: false, isLoadingError: false, isRefetchError: true },
        0,
      ),
    ).toEqual({ stale: true, body: 'empty' });
  });

  it('keeps the rows and still says they stopped being refreshed', () => {
    expect(
      sessionListSection(
        { isLoggedIn: true, isPending: false, isLoadingError: false, isRefetchError: true },
        1,
      ),
    ).toEqual({ stale: true, body: 'rows' });
  });

  it('never puts a stale notice above a sign-in prompt', () => {
    // A query `SessionCacheGuard` reset holds no rows to be stale ABOUT, and the 다시 시도 such
    // a notice offers could only 401. The session rung has to be answered first.
    expect(
      sessionListSection(
        { isLoggedIn: false, isPending: false, isLoadingError: false, isRefetchError: true },
        0,
      ),
    ).toEqual({ stale: false, body: 'signedOut' });
  });

  it('lets pending win over signedOut, so no prompt flashes through hydration', () => {
    expect(
      sessionListSection(
        { isLoggedIn: false, isPending: true, isLoadingError: false, isRefetchError: true },
        0,
      ),
    ).toEqual({ stale: false, body: 'pending' });
  });

  it('leaves a FIRST-load failure replacing the body, which is still right', () => {
    // Only `stale` keeps its content. A load that never answered has nothing to keep, so the
    // error and its 다시 시도 take the whole card as they always did.
    expect(
      sessionListSection(
        { isLoggedIn: true, isPending: false, isLoadingError: true, isRefetchError: false },
        0,
      ),
    ).toEqual({ stale: false, body: 'failed' });
  });
});
