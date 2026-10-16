import { MutationObserver, QueryObserver, type QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApiError, type Me, type RecentSearch } from '@/lib/api';
import { SEARCH_HISTORY_KEY } from '@/lib/market-keys';
import { getQueryClient } from '@/lib/query-client';
import { type SearchHistoryWrite } from '@/lib/search-history';
import { ME_QUERY_KEY } from './use-me';
import {
  recentSearchesQueryOptions,
  recordSearch,
  searchHistoryWriteOptions,
} from './use-search-history';

/**
 * 최근 검색 (#15, ADR-0066): the recent list's cache writes, driven through the REAL QueryClient
 * (`getQueryClient()` answers a fresh one per call under node), as use-watchlist.test.ts drives
 * the watch. Nothing renders: the options are exported apart from their hooks for this.
 */

const entry = (id: string, query: string): RecentSearch => ({
  id,
  query,
  searchedAt: '2026-10-16T00:00:00.000Z',
});
const LIST = [entry('a', '금리'), entry('b', '환율')];

const me = (id: string): Me => ({
  id,
  email: `${id}@example.com`,
  emailVerified: true,
  profile: {
    nickname: '테스터',
    role: 'user',
    createdAt: '2026-08-01T00:00:00.000Z',
    timeZone: null,
  },
  balance: { availableCoin: '0', lockedCoin: '0' },
  linkedAccounts: [],
  contact: { realName: '홍길동', phone: '01012345678' },
});

const outage = () => new ApiError(503, { code: 'INTERNAL', message: 'x' } as never);
const forAnotherAccount = () =>
  new ApiError(403, {
    code: 'FORBIDDEN',
    message: 'x',
    details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
  });

/** A promise the test settles itself. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets the mutation run its `onMutate` (it awaits a cancel) before the test looks. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A client holding account `account`'s profile and `list` as its recent searches. */
function seeded(account = 'user-a', list: RecentSearch[] = LIST): QueryClient {
  const queryClient = getQueryClient();
  queryClient.setQueryData(ME_QUERY_KEY, me(account));
  queryClient.setQueryData(SEARCH_HISTORY_KEY, list);
  return queryClient;
}

/** The recent list's observer, answering `reads` in turn: it stands in for the mounted list. */
function listObserver(queryClient: QueryClient, reads: () => Promise<RecentSearch[]>) {
  const observer = new QueryObserver<RecentSearch[]>(queryClient, {
    queryKey: SEARCH_HISTORY_KEY,
    queryFn: reads,
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  return { observer, unsubscribe };
}

const held = (queryClient: QueryClient) =>
  queryClient.getQueryData<RecentSearch[]>(SEARCH_HISTORY_KEY);

const deleteOf = (id: string, account = 'user-a'): SearchHistoryWrite => ({
  kind: 'delete',
  id,
  expectedAccountId: account,
});

describe('the recent searches query', () => {
  it('is one private entry that waits for a session', () => {
    expect(recentSearchesQueryOptions(null).queryKey).toEqual(['search-history']);
    expect(recentSearchesQueryOptions(null).enabled).toBe(false);
    expect(recentSearchesQueryOptions(undefined).enabled).toBe(false);
    expect(recentSearchesQueryOptions({ user: {} }).enabled).toBe(true);
  });
});

describe('recordSearch', () => {
  it('posts the term and marks the recent list stale, without waiting on it to search', async () => {
    const queryClient = seeded();
    const sent: unknown[] = [];
    await recordSearch(
      queryClient,
      { query: '금리', expectedAccountId: 'user-a' },
      () => undefined,
      (body) => {
        sent.push(body);
        return Promise.resolve([]);
      },
    );
    expect(sent).toEqual([{ query: '금리', expectedAccountId: 'user-a' }]);
    expect(queryClient.getQueryState(SEARCH_HISTORY_KEY)?.isInvalidated).toBe(true);
  });

  it('never throws: a record that failed is a missing line, not a failed search', async () => {
    const queryClient = seeded();
    let sessionAsked = 0;
    await expect(
      recordSearch(
        queryClient,
        { query: '금리', expectedAccountId: 'user-a' },
        () => (sessionAsked += 1),
        () => Promise.reject(outage()),
      ),
    ).resolves.toBeUndefined();
    expect(sessionAsked).toBe(0);
    // Another account's cookie now: the session is asked for again, so the guard can reset.
    await recordSearch(
      queryClient,
      { query: '금리', expectedAccountId: 'user-a' },
      () => (sessionAsked += 1),
      () => Promise.reject(forAnotherAccount()),
    );
    expect(sessionAsked).toBe(1);
    expect(held(queryClient)).toEqual(LIST);
  });
});

describe('searchHistoryWriteOptions', () => {
  it('drops the entry at the press and reads the list again once the write is done', async () => {
    const queryClient = seeded();
    const answer = deferred<RecentSearch[]>();
    const { observer, unsubscribe } = listObserver(queryClient, () => Promise.resolve([LIST[1]!]));
    const mutation = new MutationObserver(
      queryClient,
      searchHistoryWriteOptions(
        queryClient,
        () => undefined,
        () => answer.promise,
      ),
    );
    const done = mutation.mutate(deleteOf('a'));
    await flush();
    expect(held(queryClient)).toEqual([LIST[1]]);
    answer.resolve([LIST[1]!]);
    await done;
    expect(observer.getCurrentResult().data).toEqual([LIST[1]]);
    unsubscribe();
  });

  it('clears the whole list at the press', async () => {
    const queryClient = seeded();
    const answer = deferred<RecentSearch[]>();
    const mutation = new MutationObserver(
      queryClient,
      searchHistoryWriteOptions(
        queryClient,
        () => undefined,
        () => answer.promise,
      ),
    );
    const done = mutation.mutate({ kind: 'clear', expectedAccountId: 'user-a' });
    await flush();
    expect(held(queryClient)).toEqual([]);
    answer.resolve([]);
    await done;
  });

  it('puts the list back when the write fails, and asks for the session on another account', async () => {
    const queryClient = seeded();
    let sessionAsked = 0;
    const mutation = new MutationObserver(
      queryClient,
      searchHistoryWriteOptions(
        queryClient,
        () => (sessionAsked += 1),
        () => Promise.reject(outage()),
      ),
    );
    await expect(mutation.mutate(deleteOf('a'))).rejects.toThrow();
    expect(held(queryClient)).toEqual(LIST);
    expect(sessionAsked).toBe(0);

    const refused = new MutationObserver(
      queryClient,
      searchHistoryWriteOptions(
        queryClient,
        () => (sessionAsked += 1),
        () => Promise.reject(forAnotherAccount()),
      ),
    );
    await expect(refused.mutate({ kind: 'clear', expectedAccountId: 'user-a' })).rejects.toThrow();
    expect(held(queryClient)).toEqual(LIST);
    expect(sessionAsked).toBe(1);
  });

  it('never puts one account’s terms back into another account’s list', async () => {
    // The press was for user-a; before its failure landed, the tab became user-b's
    // (SessionCacheGuard reset the cache, and user-b's list was read). The rollback must not
    // write user-a's terms over it.
    const queryClient = seeded('user-a');
    const answer = deferred<RecentSearch[]>();
    const mutation = new MutationObserver(
      queryClient,
      searchHistoryWriteOptions(
        queryClient,
        () => undefined,
        () => answer.promise,
      ),
    );
    const done = mutation.mutate(deleteOf('a', 'user-a'));
    await flush();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-b'));
    const theirs = [entry('z', '남의 검색')];
    queryClient.setQueryData(SEARCH_HISTORY_KEY, theirs);
    answer.reject(outage());
    await expect(done).rejects.toThrow();
    expect(held(queryClient)).toEqual(theirs);
  });

  it('reads the list again only when the last of several writes is done', async () => {
    const queryClient = seeded();
    const first = deferred<RecentSearch[]>();
    const second = deferred<RecentSearch[]>();
    let reads = 0;
    const { unsubscribe } = listObserver(queryClient, () => {
      reads += 1;
      return Promise.resolve([]);
    });
    const answers = [first, second];
    const options = searchHistoryWriteOptions(
      queryClient,
      () => undefined,
      () => answers.shift()!.promise,
    );
    const one = new MutationObserver(queryClient, options).mutate(deleteOf('a'));
    const two = new MutationObserver(queryClient, options).mutate(deleteOf('b'));
    await flush();
    expect(held(queryClient)).toEqual([]);
    first.resolve([LIST[1]!]);
    await one;
    // The second delete is still out: no read that could bring its entry back for a moment.
    expect(reads).toBe(0);
    expect(held(queryClient)).toEqual([]);
    second.resolve([]);
    await two;
    expect(reads).toBe(1);
    unsubscribe();
  });
});
