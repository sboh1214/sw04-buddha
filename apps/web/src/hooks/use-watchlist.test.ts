import {
  MutationObserver,
  QueryObserver,
  type QueryClient,
  type QueryObserverResult,
  hashKey,
} from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApiError, type MarketSummary, type Me, type WatchState } from '@/lib/api';
import { WATCHLIST_PAGES_KEY, watchStateKey, watchlistPagesKey } from '@/lib/market-keys';
import { type MarketPage, type MarketPages } from '@/lib/market-live';
import { getQueryClient } from '@/lib/query-client';
import { type WatchButtonView, watchButtonView } from '@/lib/watchlist';
import { ME_QUERY_KEY } from './use-me';
import {
  type WatchVariables,
  updateWatchOptions,
  watchStateQueryOptions,
  watchlistInfiniteQueryOptions,
} from './use-watchlist';

/**
 * The 관심 등록 toggle's cache writes (#89, ADR-0064), driven through the REAL QueryClient
 * (`getQueryClient()` answers a fresh one per call under node). Nothing renders: apps/web runs
 * vitest under `environment: 'node'`, which is why the options are exported apart from their
 * hooks. A `QueryObserver` on the state stands in for the mounted button.
 */

const MARKET = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
const market = MARKET.toLowerCase();
/** A market no observer or earlier write ever made a state entry for. */
const UNSEEN_MARKET = '9b2e3c1d-4f5a-4b6c-8d7e-0f1a2b3c4d5e';

const me = (id: string): Me => ({
  id,
  email: `${id}@example.com`,
  emailVerified: true,
  profile: {
    publicId: 'k7m2p9qx4z',
    nickname: '테스터',
    role: 'user',
    createdAt: '2026-08-01T00:00:00.000Z',
    timeZone: null,
    nicknameChangeAvailableAt: null,
    interestCategoryIds: [],
    bio: null,
    imageUrl: null,
  },
  balance: { availableCoin: '0', lockedCoin: '0' },
  linkedAccounts: [],
  verification: {
    realName: '홍길동',
    phone: '01012345678',
    verifiedAt: '2026-10-18T00:00:00.000Z',
  },
  startGrant: null,
  onboarding: {
    consent: true,
    verification: true,
    nickname: true,
    completed: true,
    interests: true,
    nextStep: null,
    consents: [],
  },
});

const press = (watched: boolean, account = 'user-1'): WatchVariables => ({
  marketId: MARKET,
  watched,
  expectedAccountId: account,
});

const outage = () => new ApiError(503, { code: 'INTERNAL', message: 'x' } as never);
const forAnotherAccount = () =>
  new ApiError(403, {
    code: 'FORBIDDEN',
    message: 'x',
    details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
  });

/** A promise the test settles itself, so "what the screen shows while it is out" is explicit. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * The button's state observer, whose n-th read (1-based) answers `answer(n)`. Subscribing issues
 * the first read, as the button's mount does.
 */
function stateObserver(queryClient: QueryClient, answer: (read: number) => Promise<WatchState>) {
  let reads = 0;
  const observer = new QueryObserver<WatchState>(queryClient, {
    queryKey: watchStateKey(MARKET),
    queryFn: () => {
      reads += 1;
      return answer(reads);
    },
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  return { observer, reads: () => reads, unsubscribe };
}

function toggle(
  queryClient: QueryClient,
  put: (variables: WatchVariables) => Promise<WatchState>,
  onSessionChanged: () => void = () => undefined,
) {
  return new MutationObserver(queryClient, updateWatchOptions(queryClient, onSessionChanged, put));
}

const watchedState = (queryClient: QueryClient) =>
  queryClient.getQueryData<WatchState>(watchStateKey(MARKET))?.watched;

describe('the watchlist queries', () => {
  it('key the state on the canonical id and wait for a session', () => {
    expect(watchStateQueryOptions(MARKET).queryKey).toEqual(['watchlist', 'market', market]);
    expect(watchStateQueryOptions(MARKET, null).enabled).toBe(false);
    expect(watchStateQueryOptions(MARKET, { user: {} }).enabled).toBe(true);
    expect(watchlistInfiniteQueryOptions({}, undefined).enabled).toBe(false);
    expect(watchlistInfiniteQueryOptions({}, { user: {} }).queryKey).toEqual(watchlistPagesKey({}));
    // The home's 관심 시장 view (ADR-0065) is its own entry per order and category, apart from MY's.
    const view = { status: 'open', sort: 'recommended', category: 'economy' } as const;
    expect(watchlistInfiniteQueryOptions(view, { user: {} }).queryKey).toEqual(
      watchlistPagesKey(view),
    );
    expect(hashKey(watchlistPagesKey(view))).not.toBe(
      hashKey(watchlistPagesKey({ ...view, sort: 'watched' })),
    );
    expect(hashKey(watchlistPagesKey(view))).not.toBe(hashKey(watchlistPagesKey({})));
  });

  it('page the list on its cursor until a null one, so every watch is reachable (no cap)', async () => {
    const options = watchlistInfiniteQueryOptions({}, { user: {} });
    expect(options.initialPageParam).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: 'cursor-2' })).toBe('cursor-2');

    const row = (id: string) => ({ id }) as MarketSummary;
    const first: MarketPage = { items: [row('m2')], nextCursor: 'cursor-2' };
    const last: MarketPage = { items: [row('m1')], nextCursor: null };
    const queryClient = getQueryClient();
    try {
      // The real queryFn needs a cookie and a server; what is pinned is that the page shape and
      // the two page-param rules compose into a list that ends by itself (use-portfolio.test.ts).
      const data = await queryClient.fetchInfiniteQuery({
        queryKey: options.queryKey,
        initialPageParam: options.initialPageParam,
        getNextPageParam: options.getNextPageParam,
        queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
          Promise.resolve(pageParam === undefined ? first : last),
        pages: 3,
      });
      expect(data.pageParams).toEqual([undefined, 'cursor-2']);
      expect(data.pages.flatMap((page) => page.items).map((item) => item.id)).toEqual(['m2', 'm1']);
    } finally {
      queryClient.clear();
    }
  });

  it('join a late list answer like the home grid, so a card is never rolled back', () => {
    // The `structuralSharing` registration on ['watchlist', 'pages'] (query-client.ts).
    const queryClient = getQueryClient();
    const card: MarketSummary = {
      id: market,
      slug: 'rate-cut-2026',
      title: '기준금리 인하?',
      category: { slug: 'economy', nameKo: '경제' },
      imageUrl: null,
      status: 'closed',
      lastPrice: 63,
      volumeCoin: '130000',
      tradeCount: 11,
      traderCount: 5,
      closeAt: '2026-10-01T00:00:00.000Z',
      openAt: '2026-09-01T00:00:00.000Z',
      resolvedResult: null,
      statusEventId: '3',
      createdAt: '2026-08-30T00:00:00.000Z',
    };
    const pages = (row: MarketSummary): MarketPages => ({
      pages: [{ items: [row], nextCursor: null }],
      pageParams: [undefined],
    });
    const key = watchlistPagesKey({});
    queryClient.setQueryData(key, pages(card));
    // An answer that left before the trade and the close it carries.
    queryClient.setQueryData(
      key,
      pages({ ...card, status: 'open', statusEventId: '2', lastPrice: 50, tradeCount: 10 }),
    );
    const held = queryClient.getQueryData<MarketPages>(key)?.pages[0]?.items[0];
    expect(held).toMatchObject({ status: 'closed', lastPrice: 63, tradeCount: 11 });
    // The state under the same root is no page and is never joined as one.
    queryClient.setQueryData(watchStateKey(MARKET), { watched: true });
    queryClient.setQueryData(watchStateKey(MARKET), { watched: false });
    expect(watchedState(queryClient)).toBe(false);
  });
});

describe('updateWatchOptions', () => {
  it('moves the state on the press, keeps the server’s answer, and refreshes the list and the state', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-1'));
    const state = stateObserver(queryClient, (read) => Promise.resolve({ watched: read > 1 }));
    // A list MY fetched earlier: the press must mark it for a refetch.
    queryClient.setQueryData(watchlistPagesKey({}), {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    });
    try {
      await state.observer.refetch();
      expect(watchedState(queryClient)).toBe(false);

      const answer = deferred<WatchState>();
      const sent: WatchVariables[] = [];
      const observer = toggle(queryClient, (variables) => {
        sent.push(variables);
        return answer.promise;
      });
      const done = observer.mutate(press(true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Optimistic: pressed before the server answered.
      expect(watchedState(queryClient)).toBe(true);
      expect(sent).toEqual([press(true)]);

      answer.resolve({ watched: true });
      await done;
      expect(watchedState(queryClient)).toBe(true);
      // The state was read again so the screen ends on the server's word; the list is stale.
      expect(state.reads()).toBe(2);
      expect(
        queryClient.getQueryCache().find({ queryKey: watchlistPagesKey({}) })?.state.isInvalidated,
      ).toBe(true);
      expect(queryClient.getQueryCache().findAll({ queryKey: WATCHLIST_PAGES_KEY })).toHaveLength(
        1,
      );
    } finally {
      state.unsubscribe();
    }
  });

  it('puts the state back when the press fails', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-1'));
    // The read after the failed press fails too (the API is down): a failed refetch keeps what
    // the cache holds, so only the rollback can have put `true` back — not the server's word.
    const state = stateObserver(queryClient, (read) =>
      read === 1 ? Promise.resolve({ watched: true }) : Promise.reject(outage()),
    );
    try {
      await state.observer.refetch();
      const observer = toggle(queryClient, () => Promise.reject(outage()));
      await expect(observer.mutate(press(false))).rejects.toThrow();
      expect(state.reads()).toBe(2);
      expect(watchedState(queryClient)).toBe(true);
    } finally {
      state.unsubscribe();
    }
  });

  it('drops a state read that left before the press, so its old answer cannot undo the press', async () => {
    // The button accepts a press while a background read is out (a refocus, a reconnect): the
    // read left before the write and would land after the optimistic state with the old one.
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-1'));
    const background = deferred<WatchState>();
    const state = stateObserver(queryClient, (read) =>
      read === 1
        ? Promise.resolve({ watched: false })
        : read === 2
          ? background.promise
          : Promise.resolve({ watched: true }),
    );
    try {
      await state.observer.refetch();
      void state.observer.refetch();
      expect(state.reads()).toBe(2);

      const answer = deferred<WatchState>();
      const done = toggle(queryClient, () => answer.promise).mutate(press(true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(watchedState(queryClient)).toBe(true);

      // The old answer lands while the PUT is still out: the press keeps the screen.
      background.resolve({ watched: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(watchedState(queryClient)).toBe(true);

      answer.resolve({ watched: true });
      await done;
      expect(watchedState(queryClient)).toBe(true);
    } finally {
      state.unsubscribe();
    }
  });

  it('holds no state again when it held none before a failed press, rather than keep the guess', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-1'));
    let reads = 0;
    const observer = toggle(queryClient, () => Promise.reject(outage()));
    // No state observer has answered: the cache holds nothing for this market.
    const state = new QueryObserver<WatchState>(queryClient, {
      queryKey: watchStateKey(MARKET),
      queryFn: () => {
        reads += 1;
        return Promise.resolve({ watched: false });
      },
      enabled: false,
      retry: false,
    });
    const unsubscribe = state.subscribe(() => undefined);
    try {
      await expect(observer.mutate(press(true))).rejects.toThrow();
      // The optimistic `true` is gone: the entry is back to holding nothing.
      expect(watchedState(queryClient)).toBeUndefined();
      expect(reads).toBe(0);
    } finally {
      unsubscribe();
    }
    // With no entry at all before the press, the optimistic one goes too.
    await expect(observer.mutate({ ...press(true), marketId: UNSEEN_MARKET })).rejects.toThrow();
    expect(queryClient.getQueryState(watchStateKey(UNSEEN_MARKET))).toBeUndefined();
  });

  it('draws no button after a failed first read, and the toggle once a later read succeeds', async () => {
    // The API is down: the first read fails, so the button is not drawn at all (owner decision
    // 2026-10-16, ADR-0064) — an unpressed toggle would tell a member who came to unwatch that
    // the market is not watched. The next read (a refocus, a reconnect) answers and brings the
    // toggle with the real state, never the placeholder in between.
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-1'));
    const state = stateObserver(queryClient, (read) =>
      read === 1 ? Promise.reject(outage()) : Promise.resolve({ watched: true }),
    );
    const views: WatchButtonView[] = [];
    const view = (result: QueryObserverResult<WatchState>) =>
      watchButtonView({ sessionPending: false, signedIn: true, state: result, saving: false });
    const stopViews = state.observer.subscribe((result) => views.push(view(result)));
    try {
      await state.observer.refetch();
      expect(state.observer.getCurrentResult()).toMatchObject({
        status: 'error',
        isFetched: true,
        data: undefined,
      });
      expect(view(state.observer.getCurrentResult())).toEqual({ kind: 'hidden' });
      views.length = 0;

      await state.observer.refetch();
      expect(state.reads()).toBe(2);
      expect(views.filter((drawn) => drawn.kind === 'placeholder')).toEqual([]);
      expect(view(state.observer.getCurrentResult())).toEqual({
        kind: 'toggle',
        pressed: true,
        press: 'unwatch',
      });
    } finally {
      stopViews();
      state.unsubscribe();
    }
  });

  it('keeps a drawn toggle through a refetch that fails after a success', async () => {
    // TanStack keeps the data it had when a later read fails, so the toggle (which may hold the
    // keyboard focus) is neither hidden nor swapped for the placeholder.
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-1'));
    const state = stateObserver(queryClient, (read) =>
      read === 1 ? Promise.resolve({ watched: false }) : Promise.reject(outage()),
    );
    const views: WatchButtonView[] = [];
    const view = (result: QueryObserverResult<WatchState>) =>
      watchButtonView({ sessionPending: false, signedIn: true, state: result, saving: false });
    const stopViews = state.observer.subscribe((result) => views.push(view(result)));
    try {
      await state.observer.refetch();
      views.length = 0;
      await state.observer.refetch();
      expect(state.reads()).toBe(2);
      expect(views.filter((drawn) => drawn.kind !== 'toggle')).toEqual([]);
      expect(view(state.observer.getCurrentResult())).toEqual({
        kind: 'toggle',
        pressed: false,
        press: 'watch',
      });
    } finally {
      stopViews();
      state.unsubscribe();
    }
  });

  it('asks for the session again on a refusal as another account, and puts the state back', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-1'));
    queryClient.setQueryData(watchStateKey(MARKET), { watched: false });
    let sessions = 0;
    const observer = toggle(
      queryClient,
      () => Promise.reject(forAnotherAccount()),
      () => {
        sessions += 1;
      },
    );
    await expect(observer.mutate(press(true))).rejects.toThrow();
    expect(sessions).toBe(1);
    expect(watchedState(queryClient)).toBe(false);

    // Any other failure does not, and puts the state back too. No observer holds the state, so
    // no read after the failure can stand in for the rollback.
    await expect(
      toggle(
        queryClient,
        () => Promise.reject(outage()),
        () => {
          sessions += 1;
        },
      ).mutate(press(true)),
    ).rejects.toThrow();
    expect(sessions).toBe(1);
    expect(watchedState(queryClient)).toBe(false);
  });

  it('writes nothing into another account’s cache when the tab switched while the press was out', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-1'));
    queryClient.setQueryData(watchStateKey(MARKET), { watched: false });
    const answer = deferred<WatchState>();
    const observer = toggle(queryClient, () => answer.promise);
    const done = observer.mutate(press(true, 'user-1'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // SessionCacheGuard reset the cache and user-2's profile and state landed.
    queryClient.setQueryData(ME_QUERY_KEY, me('user-2'));
    queryClient.setQueryData(watchStateKey(MARKET), { watched: false });
    answer.resolve({ watched: true });
    await done;
    expect(watchedState(queryClient)).toBe(false);

    // A failure landing then does not "restore" user-1's state over user-2's either.
    queryClient.setQueryData(ME_QUERY_KEY, me('user-1'));
    queryClient.setQueryData(watchStateKey(MARKET), { watched: true });
    const failing = deferred<WatchState>();
    const second = toggle(queryClient, () => failing.promise).mutate(press(false, 'user-1'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    queryClient.setQueryData(ME_QUERY_KEY, me('user-2'));
    queryClient.setQueryData(watchStateKey(MARKET), { watched: false });
    failing.reject(outage());
    await expect(second).rejects.toThrow();
    expect(watchedState(queryClient)).toBe(false);
  });
});
