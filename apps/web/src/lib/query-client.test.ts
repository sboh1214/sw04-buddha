import {
  InfiniteQueryObserver,
  QueryObserver,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
  onlineManager,
} from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { positionsKey } from '@/hooks/use-portfolio';
import { postImageUploader } from '@/hooks/use-posts';
import { positionFixture } from '@/test/positions';
import { ApiError, type Position, api } from './api';
import {
  CATEGORIES_QUERY_KEY,
  MARKETS_KEY,
  MARKET_KEY,
  POSITIONS_KEY,
  holdingMarketsKey,
  marketKey,
} from './market-keys';
import { MY_ACTIONS_KEY, MY_REPORTS_KEY, MY_RESTRICTION_KEY, myRestrictionKey } from './moderation';
import {
  ME_KEY,
  cancelFirstFetch,
  getQueryClient,
  listSection,
  listView,
  moreFailed,
  profileView,
  readFailed,
  restartQueries,
  sessionListSection,
  setResnapshotOwed,
} from './query-client';

/** The account a positions list is keyed by (#67, ADR-0142). */
const TEST_ACCOUNT = 'a1e1c0de-0000-4000-8000-000000000001';

/**
 * `cancelFirstFetch`'s predicate, driven through the REAL client this app ships.
 *
 * The predicate is the whole safety of the cancel, and what it protects is not obvious: a
 * MOUNTED list loses nothing either way, because the invalidation's own `cancelRefetch` was
 * going to cancel that refetch anyway. It is the UNMOUNTED one that pays.
 */
const position: Position = positionFixture({
  marketLastPrice: 50,
  qty: 10,
  version: 3,
  updatedAt: '2026-09-06T00:00:00.000Z',
});

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
      queryKey: positionsKey('settled', TEST_ACCOUNT),
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
      expect(
        queryClient.getQueryData<Position[]>(positionsKey('settled', TEST_ACCOUNT))?.[0]?.qty,
      ).toBe(99);
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
      queryKey: positionsKey('open', TEST_ACCOUNT),
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
      expect(queryClient.getQueryState(positionsKey('open', TEST_ACCOUNT))?.fetchStatus).toBe(
        'fetching',
      );

      cancelFirstFetch(queryClient, POSITIONS_KEY);

      expect(queryClient.getQueryState(positionsKey('open', TEST_ACCOUNT))?.fetchStatus).toBe(
        'fetching',
      );
      land([{ ...position, qty: 99 }]);
      await second;
      expect(
        queryClient.getQueryData<Position[]>(positionsKey('open', TEST_ACCOUNT))?.[0]?.qty,
      ).toBe(99);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });
});

describe('a write refused with RESTRICTED (#185)', () => {
  it('reads the member’s restriction and actions again, so the banner says the restriction that refused it', async () => {
    const client = getQueryClient();
    client.setQueryData(MY_RESTRICTION_KEY, { restriction: null });
    // An account's own entry (ADR-0140 결정 2-26) is under the same prefix.
    client.setQueryData(myRestrictionKey('account-a'), { restriction: null });
    client.setQueryData(MY_ACTIONS_KEY, { pages: [], pageParams: [] });
    client.setQueryData(MY_REPORTS_KEY, { pages: [], pageParams: [] });
    const refuse = (error: Error) =>
      client
        .getMutationCache()
        .build(client, { mutationFn: () => Promise.reject(error), retry: false })
        .execute(undefined)
        .catch(() => undefined);

    await refuse(new ApiError(403, { code: 'FORBIDDEN', message: 'not yours' }));
    expect(client.getQueryState(MY_RESTRICTION_KEY)?.isInvalidated).toBe(false);
    expect(client.getQueryState(MY_ACTIONS_KEY)?.isInvalidated).toBe(false);

    await refuse(
      new ApiError(403, {
        code: 'RESTRICTED',
        message: 'restricted',
        details: { kind: 'writing', endsAt: null },
      }),
    );
    expect(client.getQueryState(MY_RESTRICTION_KEY)?.isInvalidated).toBe(true);
    expect(client.getQueryState(myRestrictionKey('account-a'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(MY_ACTIONS_KEY)?.isInvalidated).toBe(true);
    // Nothing else of the member's is touched.
    expect(client.getQueryState(MY_REPORTS_KEY)?.isInvalidated).toBe(false);
    client.clear();
  });

  it('does so for a post’s image too, a plain call through its uploader', async () => {
    const client = getQueryClient();
    client.setQueryData(MY_RESTRICTION_KEY, { restriction: null });
    client.setQueryData(MY_ACTIONS_KEY, { pages: [], pageParams: [] });
    const send = vi.spyOn(api, 'POST').mockResolvedValue({
      error: {
        error: {
          code: 'RESTRICTED',
          message: 'restricted',
          details: { kind: 'writing', endsAt: null },
        },
      },
      response: new Response(null, { status: 403 }),
    });
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    // The refusal goes on to the editor's toast.
    await expect(postImageUploader(client, () => undefined)(file, 'user-1')).rejects.toMatchObject({
      code: 'RESTRICTED',
    });
    expect(send).toHaveBeenCalledOnce();
    expect(client.getQueryState(MY_RESTRICTION_KEY)?.isInvalidated).toBe(true);
    expect(client.getQueryState(MY_ACTIONS_KEY)?.isInvalidated).toBe(true);
    // Another refusal of the upload leaves them be.
    client.setQueryData(MY_RESTRICTION_KEY, { restriction: null });
    send.mockResolvedValue({
      error: { error: { code: 'IMAGE_NOT_ALLOWED', message: 'x', details: { reason: 'type' } } },
      response: new Response(null, { status: 422 }),
    });
    await expect(postImageUploader(client, () => undefined)(file, 'user-1')).rejects.toMatchObject({
      code: 'IMAGE_NOT_ALLOWED',
    });
    expect(client.getQueryState(MY_RESTRICTION_KEY)?.isInvalidated).toBe(false);
    send.mockRestore();
    client.clear();
  });
});

describe('listView', () => {
  it('calls a list STALE when its refetch failed but the rows are still there', () => {
    // THE HAZARD: query-core reports a failure two ways, and a ladder written on
    // `isLoadingError` alone folds one of them into `ready`. Measured with a real observer: a
    // refetch that fails after data exists answers `isLoadingError: false, isRefetchError: true`
    // and KEEPS the rows — so 보유 포지션 and 체결 내역 went on rendering a list that had stopped
    // being refreshed, with nothing on screen to say so and no way back.
    expect(
      listView({ isPending: false, isLoadingError: false, isRefetchError: true, error: null }),
    ).toBe('stale');
  });

  it('keeps the two failures apart, because only one of them has rows to show', () => {
    // A FIRST fetch that exhausts its retries has nothing to render, so the section is replaced
    // by `LoadFailed`. A failed refetch keeps its answer, and dropping a screenful because one
    // refresh failed loses more than the staleness costs — the reading `market-list.tsx` takes.
    expect(
      listView({ isPending: false, isLoadingError: true, isRefetchError: false, error: null }),
    ).toBe('failed');
  });

  it('reports pending first, because a query retrying after a failure reports both', () => {
    expect(
      listView({ isPending: true, isLoadingError: false, isRefetchError: true, error: null }),
    ).toBe('pending');
  });

  it('is ready only when nothing failed', () => {
    expect(
      listView({ isPending: false, isLoadingError: false, isRefetchError: false, error: null }),
    ).toBe('ready');
  });
});

describe('listSection', () => {
  it('shows the rows AND says the refresh failed, because the notice is not a rung', () => {
    // 주문 이력 rendered `isLoadingError` alone, so a refetch that failed after the rows existed
    // — the ONLY path a new order arrives by, since nothing patches `['orders']` in place —
    // landed on the ordinary rows arm with no notice and no way back.
    expect(
      listSection(
        { isPending: false, isLoadingError: false, isRefetchError: true, error: null },
        1,
      ),
    ).toEqual({ stale: true, body: 'rows' });
  });

  it('keeps saying 아직 주문 내역이 없습니다 UNDER the notice, never instead of it', () => {
    // The empty variant is the one that states something FALSE rather than merely stale: an
    // account with no prior orders trades in another tab, the orders refetch fails, and the
    // section asserts there is no order history about an order the balance and the holding on
    // the same screen already show. The empty body is still the last thing the server said, so
    // it stays — but it does not stay unlabelled. A ladder that spent `stale` as a fourth arm
    // would replace it and say nothing at all.
    expect(
      listSection(
        { isPending: false, isLoadingError: false, isRefetchError: true, error: null },
        0,
      ),
    ).toEqual({ stale: true, body: 'empty' });
  });

  it('never marks a first-load failure stale — there is nothing to keep', () => {
    expect(
      listSection(
        { isPending: false, isLoadingError: true, isRefetchError: false, error: null },
        0,
      ),
    ).toEqual({ stale: false, body: 'failed' });
    expect(
      listSection({ isPending: true, isLoadingError: false, isRefetchError: true, error: null }, 0),
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
        {
          isLoggedIn: true,
          isPending: false,
          isLoadingError: false,
          isRefetchError: true,
          error: null,
        },
        0,
      ),
    ).toEqual({ stale: true, body: 'empty' });
  });

  it('keeps the rows and still says they stopped being refreshed', () => {
    expect(
      sessionListSection(
        {
          isLoggedIn: true,
          isPending: false,
          isLoadingError: false,
          isRefetchError: true,
          error: null,
        },
        1,
      ),
    ).toEqual({ stale: true, body: 'rows' });
  });

  it('never puts a stale notice above a sign-in prompt', () => {
    // A query `SessionCacheGuard` reset holds no rows to be stale ABOUT, and the 다시 시도 such
    // a notice offers could only 401. The session rung has to be answered first.
    expect(
      sessionListSection(
        {
          isLoggedIn: false,
          isPending: false,
          isLoadingError: false,
          isRefetchError: true,
          error: null,
        },
        0,
      ),
    ).toEqual({ stale: false, body: 'signedOut' });
  });

  it('lets pending win over signedOut, so no prompt flashes through hydration', () => {
    expect(
      sessionListSection(
        {
          isLoggedIn: false,
          isPending: true,
          isLoadingError: false,
          isRefetchError: true,
          error: null,
        },
        0,
      ),
    ).toEqual({ stale: false, body: 'pending' });
  });

  it('leaves a FIRST-load failure replacing the body, which is still right', () => {
    // Only `stale` keeps its content. A load that never answered has nothing to keep, so the
    // error and its 다시 시도 take the whole card as they always did.
    expect(
      sessionListSection(
        {
          isLoggedIn: true,
          isPending: false,
          isLoadingError: true,
          isRefetchError: false,
          error: null,
        },
        0,
      ),
    ).toEqual({ stale: false, body: 'failed' });
  });
});

describe('a 더 보기 that failed (owner decision 2026-10-20 7, ADR-0075)', () => {
  /** A page of a list: its rows and the next cursor. */
  interface Page {
    items: number[];
    nextCursor: string | null;
  }

  /**
   * A list driven through the REAL client and an infinite observer, as every 더 보기 list's
   * `useInfiniteQuery` holds it — with no retry, so a refusal lands at once. `answer` says how a
   * read goes: the first page (no cursor) and the next ('c2').
   */
  function observeList(answer: (cursor: string | undefined) => Promise<Page>) {
    const queryClient = getQueryClient();
    const observer = new InfiniteQueryObserver<
      Page,
      Error,
      InfiniteData<Page>,
      readonly unknown[],
      string | undefined
    >(queryClient, {
      queryKey: ['a-list'],
      queryFn: ({ pageParam }) => answer(pageParam),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    const now = () => observer.getCurrentResult();
    return {
      queryClient,
      observer,
      now,
      /** What a list section reads: its rung, the 더 보기 notice and an `isError` list's rung. */
      reads: () => ({
        section: listSection(now(), now().data?.pages.flatMap((page) => page.items).length ?? 0),
        moreFailed: moreFailed(now()),
        readFailed: readFailed(now()),
      }),
      settled: async (ready: () => boolean) => {
        for (let i = 0; i < 100 && !ready(); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(ready()).toBe(true);
      },
      done: () => {
        unsubscribe();
        queryClient.clear();
      },
    };
  }

  const first: Page = { items: [3, 2], nextCursor: 'c2' };
  const rest: Page = { items: [1], nextCursor: null };
  const refused = () => Promise.reject(new Error('503'));

  /** An answer held open until the test lets it land — a refetch caught on its way. */
  function held(): { promise: Promise<Page>; land: (page: Page) => void; fail: () => void } {
    let land: (page: Page) => void = () => undefined;
    let fail: () => void = () => undefined;
    const promise = new Promise<Page>((resolve, reject) => {
      land = resolve;
      fail = () => {
        reject(new Error('503'));
      };
    });
    return { promise, land, fail };
  }

  it('is said above 더 보기 with the rows kept, withdrawn while asked again, gone once the page came', async () => {
    // THE HOLE: query-core reports it as `isFetchNextPageError` with `isRefetchError` false, so
    // `listSection` sees an ordinary list; and `isError` is true, so a rung on it alone dropped
    // every row read so far.
    let down = true;
    const list = observeList((cursor) =>
      cursor === undefined ? Promise.resolve(first) : down ? refused() : Promise.resolve(rest),
    );
    try {
      await list.settled(() => list.now().isSuccess);
      await list.observer.fetchNextPage();
      expect(list.now()).toMatchObject({
        isError: true,
        isFetchNextPageError: true,
        isRefetchError: false,
        hasNextPage: true,
      });
      expect(list.reads()).toEqual({
        section: { stale: false, body: 'rows' },
        moreFailed: true,
        readFailed: false,
      });
      expect(list.now().data?.pages).toEqual([first]);

      down = false;
      const again = list.observer.fetchNextPage();
      expect(list.now().isFetchingNextPage).toBe(true);
      expect(list.reads()).toMatchObject({ moreFailed: false, readFailed: false });
      await again;
      expect(list.reads()).toEqual({
        section: { stale: false, body: 'rows' },
        moreFailed: false,
        readFailed: false,
      });
      expect(list.now().data?.pages).toEqual([first, rest]);
    } finally {
      list.done();
    }
  });

  it('is not a first read that failed, nor a refresh that failed — those are the rungs', async () => {
    const failing = observeList(refused);
    try {
      await failing.settled(() => failing.now().isLoadingError);
      expect(failing.reads()).toEqual({
        section: { stale: false, body: 'failed' },
        moreFailed: false,
        readFailed: true,
      });
    } finally {
      failing.done();
    }

    let down = false;
    const refreshing = observeList(() => (down ? refused() : Promise.resolve(rest)));
    try {
      await refreshing.settled(() => refreshing.now().isSuccess);
      down = true;
      await refreshing.observer.refetch();
      expect(refreshing.reads()).toEqual({
        section: { stale: true, body: 'rows' },
        moreFailed: false,
        readFailed: true,
      });
    } finally {
      refreshing.done();
    }
  });

  it('stays through a cache write, which sets the status back to success with no page come', async () => {
    // THE SOCKET'S WRITE: `market:tick` and `market:status` patch every held card page with
    // `setQueriesData` (realtime-provider.tsx — the home's, the search's and 관련 시장's grids and
    // MY 관심 시장), and the reader's own comment goes into the comments the same way. Each write
    // dispatches `success`: TanStack's own flags then say nothing failed, while 더 보기 is still
    // there and the next page never came — so the notice vanished on the next trade.
    let down = true;
    const list = observeList((cursor) =>
      cursor === undefined ? Promise.resolve(first) : down ? refused() : Promise.resolve(rest),
    );
    try {
      await list.settled(() => list.now().isSuccess);
      await list.observer.fetchNextPage();
      expect(list.reads()).toMatchObject({ moreFailed: true });

      list.queryClient.setQueriesData<InfiniteData<Page>>({ queryKey: ['a-list'] }, (data) =>
        data === undefined
          ? data
          : { ...data, pages: data.pages.map((page) => ({ ...page, items: [30, 2] })) },
      );
      // What the flags say after the write: nothing failed, a next page to read.
      expect(list.now()).toMatchObject({
        isError: false,
        isFetchNextPageError: false,
        hasNextPage: true,
      });
      expect(list.reads()).toEqual({
        section: { stale: false, body: 'rows' },
        moreFailed: true,
        readFailed: false,
      });
      expect(list.now().data?.pages).toEqual([{ items: [30, 2], nextCursor: 'c2' }]);

      // Asked again: withdrawn while it runs, gone with the page.
      down = false;
      const again = list.observer.fetchNextPage();
      expect(list.reads()).toMatchObject({ moreFailed: false });
      await again;
      expect(list.reads()).toEqual({
        section: { stale: false, body: 'rows' },
        moreFailed: false,
        readFailed: false,
      });
    } finally {
      list.done();
    }
  });

  it('says no failure while a refetch runs after it — no refresh failed, and the rows stay', async () => {
    // THE FALSE FAILURE: a refetch — a refocus (a failed query is invalidated, so at once), an
    // invalidation, a poll — resets the direction TanStack reads `isFetchNextPageError` from and
    // leaves the status at `error` while it runs. Its flags then say a refresh failed: a list on
    // `listSection` said '최신 정보를 불러오지 못했습니다' and a list on `isError` swapped every row
    // for its error, until the refetch landed.
    let answer: () => Promise<Page> = refused;
    const list = observeList((cursor) =>
      cursor === undefined ? (answer === refused ? Promise.resolve(first) : answer()) : refused(),
    );
    try {
      await list.settled(() => list.now().isSuccess);
      await list.observer.fetchNextPage();
      expect(list.reads()).toMatchObject({ moreFailed: true, readFailed: false });

      const succeeding = held();
      answer = () => succeeding.promise;
      const refetch = list.observer.refetch();
      // What the flags say while it runs: a refresh that failed, over the rows held.
      expect(list.now()).toMatchObject({
        isError: true,
        isFetchNextPageError: false,
        isRefetchError: true,
        isRefetching: true,
      });
      expect(list.reads()).toEqual({
        section: { stale: false, body: 'rows' },
        moreFailed: false,
        readFailed: false,
      });
      expect(list.now().data?.pages).toEqual([first]);
      succeeding.land(first);
      await refetch;
      expect(list.reads()).toEqual({
        section: { stale: false, body: 'rows' },
        moreFailed: false,
        readFailed: false,
      });

      // A refetch that then REALLY fails is a refresh that failed — its rungs, not the 더 보기's.
      await list.observer.fetchNextPage();
      expect(list.reads()).toMatchObject({ moreFailed: true });
      const failing = held();
      answer = () => failing.promise;
      const refetchAgain = list.observer.refetch();
      expect(list.reads()).toMatchObject({ section: { stale: false }, readFailed: false });
      failing.fail();
      await refetchAgain;
      expect(list.reads()).toEqual({
        section: { stale: true, body: 'rows' },
        moreFailed: false,
        readFailed: true,
      });
    } finally {
      list.done();
    }
  });

  it('leaves a refresh that really failed saying so while it is asked again', async () => {
    // The mark is what tells the two apart, not whether something is running: a failed refresh
    // keeps its notice and its rung through its own retry, as it always did.
    let answer: () => Promise<Page> = () => Promise.resolve(rest);
    const list = observeList(() => answer());
    try {
      await list.settled(() => list.now().isSuccess);
      answer = refused;
      await list.observer.refetch();
      const failed = {
        section: { stale: true, body: 'rows' },
        moreFailed: false,
        readFailed: true,
      };
      expect(list.reads()).toEqual(failed);

      const retry = held();
      answer = () => retry.promise;
      const again = list.observer.refetch();
      expect(list.now().isRefetching).toBe(true);
      expect(list.reads()).toEqual(failed);
      retry.land(rest);
      await again;
      expect(list.reads()).toEqual({
        section: { stale: false, body: 'rows' },
        moreFailed: false,
        readFailed: false,
      });
    } finally {
      list.done();
    }
  });
});

describe('ME_KEY', () => {
  it("is `['me']` as hooks/use-me.ts keys it, named again here for the server side of this file (ADR-0079 7-23)", () => {
    expect(ME_KEY).toEqual(ME_QUERY_KEY);
  });
});

/**
 * A reconnect used to read each snapshot key TWICE (#67, ADR-0142 결정 2-21, measured: 98 market
 * rows for 50 held on `/my/positions`): the browser's `online` refetched every observer past its
 * `staleTime`, and the socket's `connect` then restarted all of them (`resnapshot()`), the first
 * answer already landed and so joined by nothing. While the provider says a resnapshot is owed
 * (`setResnapshotOwed`), `online` leaves those keys to it. Driven through the real client: the
 * `refetchOnReconnect` default is the client's, and the restart is the provider's `restartQueries`.
 */
describe('a reconnect reads a snapshot key once (ADR-0142 결정 2-21)', () => {
  const OWED = [MARKET_KEY, POSITIONS_KEY, ME_QUERY_KEY] as const;
  const MARKET = 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46';

  beforeEach(() => {
    // Only the clock: the reads below resolve on real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    onlineManager.setOnline(true);
  });

  /** Lets every read started so far land. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Past the client's 30-second `staleTime`, so every entry held is stale. */
  const age = () => vi.setSystemTime(Date.now() + 31_000);

  /**
   * A mounted observer of `queryKey`, counting its reads. Held fresh before it subscribes (so the
   * mount reads nothing) unless `seed` is false. Each answer is a new row (a new `id`, so the market
   * join takes it), an empty list for a positions key.
   */
  function watch(
    client: QueryClient,
    queryKey: QueryKey,
    options: { seed?: boolean; refetchOnReconnect?: boolean } = {},
  ) {
    const isList = queryKey[0] === POSITIONS_KEY[0];
    const reads = { count: 0 };
    if (options.seed !== false) client.setQueryData(queryKey, isList ? [] : { id: 'seed' });
    const observer = new QueryObserver<unknown>(client, {
      queryKey,
      queryFn: () => {
        reads.count += 1;
        return Promise.resolve(isList ? [] : { id: `read-${String(reads.count)}` });
      },
      retry: false,
      ...(options.refetchOnReconnect === undefined
        ? {}
        : { refetchOnReconnect: options.refetchOnReconnect }),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    return { reads, unsubscribe };
  }

  it('leaves an owed key to the resnapshot: none on online, one on the restart', async () => {
    const client = getQueryClient();
    const market = watch(client, marketKey(MARKET));
    try {
      setResnapshotOwed(client, OWED);
      age();
      client.getQueryCache().onOnline();
      await settle();
      expect(market.reads.count).toBe(0);
      await restartQueries(client, MARKET_KEY);
      await settle();
      // Two before this change: the `online` read had landed, so the restart read once more.
      expect(market.reads.count).toBe(1);
    } finally {
      market.unsubscribe();
      setResnapshotOwed(client, null);
      client.clear();
    }
  });

  it('reads on online as before when nothing is owed, or the key is not owed, or the debt is paid', async () => {
    const client = getQueryClient();
    const market = watch(client, marketKey(MARKET));
    const restriction = watch(client, myRestrictionKey(TEST_ACCOUNT));
    const categories = watch(client, CATEGORIES_QUERY_KEY);
    try {
      // Nothing owed: a tab that never connected, or `online` with the socket still up.
      age();
      client.getQueryCache().onOnline();
      await settle();
      expect([market.reads.count, restriction.reads.count, categories.reads.count]).toEqual([
        1, 1, 1,
      ]);
      // Owed, but not these two keys: they are read; the market is left to the resnapshot.
      setResnapshotOwed(client, OWED);
      age();
      client.getQueryCache().onOnline();
      await settle();
      expect([market.reads.count, restriction.reads.count, categories.reads.count]).toEqual([
        1, 2, 2,
      ]);
      // Paid (the provider's `connect`, after its `resnapshot()`): back to the first case.
      setResnapshotOwed(client, null);
      age();
      client.getQueryCache().onOnline();
      await settle();
      expect([market.reads.count, restriction.reads.count, categories.reads.count]).toEqual([
        2, 3, 3,
      ]);
    } finally {
      market.unsubscribe();
      restriction.unsubscribe();
      categories.unsubscribe();
      client.clear();
    }
  });

  it('still resumes, once, a first read paused while offline', async () => {
    // That is the retryer's `continue()` on `online`, not the reconnect refetch the debt turns off.
    const client = getQueryClient();
    client.mount();
    onlineManager.setOnline(false);
    setResnapshotOwed(client, OWED);
    const market = watch(client, marketKey(MARKET), { seed: false });
    try {
      await settle();
      expect(client.getQueryState(marketKey(MARKET))?.fetchStatus).toBe('paused');
      expect(market.reads.count).toBe(0);
      onlineManager.setOnline(true);
      await settle();
      await settle();
      expect(market.reads.count).toBe(1);
      expect(client.getQueryState(marketKey(MARKET))?.status).toBe('success');
    } finally {
      market.unsubscribe();
      setResnapshotOwed(client, null);
      client.unmount();
      client.clear();
    }
  });

  it('reads MY’s 50 held markets as one chunk, once, on a reconnect (#300, ADR-0147)', async () => {
    // #300 reads the rows 50 to a request under `['markets']`, which the provider owes as a
    // snapshot key beside `['market']`: the 50 reads above become one.
    const client = getQueryClient();
    const owed = [MARKETS_KEY, POSITIONS_KEY, ME_QUERY_KEY] as const;
    const ids = Array.from(
      { length: 50 },
      (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    );
    const page = () => ({ pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });
    const reads = { count: 0 };
    client.setQueryData(holdingMarketsKey(ids), page());
    const observer = new QueryObserver<unknown>(client, {
      queryKey: holdingMarketsKey(ids),
      queryFn: () => {
        reads.count += 1;
        return Promise.resolve(page());
      },
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      setResnapshotOwed(client, owed);
      age();
      client.getQueryCache().onOnline();
      await settle();
      for (const root of owed) await restartQueries(client, root);
      await settle();
      expect(reads.count).toBe(1);
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it('reads 50 held markets, both positions lists and me once each on a reconnect, not twice', async () => {
    const client = getQueryClient();
    const markets = Array.from({ length: 50 }, (_, index) =>
      watch(client, marketKey(`market-${String(index)}`)),
    );
    const lists = [
      watch(client, positionsKey('open', TEST_ACCOUNT)),
      watch(client, positionsKey('settled', TEST_ACCOUNT)),
    ];
    const me = watch(client, ME_QUERY_KEY);
    const all = [...markets, ...lists, me];
    const total = () => all.reduce((sum, observer) => sum + observer.reads.count, 0);
    /** `online`, then the socket's `connect` restarting each owed root. */
    const reconnect = async () => {
      age();
      client.getQueryCache().onOnline();
      await settle();
      for (const root of OWED) await restartQueries(client, root);
      await settle();
    };
    try {
      setResnapshotOwed(client, OWED);
      await reconnect();
      expect(total()).toBe(50 + 2 + 1);
      expect(markets.every((observer) => observer.reads.count === 1)).toBe(true);
      // Without the debt, each was read twice (the measured 98 + 4 + 2 had two markets fresh).
      setResnapshotOwed(client, null);
      await reconnect();
      expect(total()).toBe(50 + 2 + 1 + 2 * (50 + 2 + 1));
    } finally {
      for (const observer of all) observer.unsubscribe();
      client.clear();
    }
  });

  it("leaves a hook's own `refetchOnReconnect: false` alone, owed or not", async () => {
    const client = getQueryClient();
    const own = watch(client, ['admin', 'trading-anomalies'], { refetchOnReconnect: false });
    const market = watch(client, marketKey(MARKET), { refetchOnReconnect: false });
    try {
      age();
      client.getQueryCache().onOnline();
      await settle();
      setResnapshotOwed(client, OWED);
      age();
      client.getQueryCache().onOnline();
      await settle();
      expect([own.reads.count, market.reads.count]).toEqual([0, 0]);
    } finally {
      own.unsubscribe();
      market.unsubscribe();
      setResnapshotOwed(client, null);
      client.clear();
    }
  });
});
