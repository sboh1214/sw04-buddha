import { readFileSync } from 'node:fs';
import { MutationObserver, QueryObserver, type QueryClient, hashKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApiError, type Me, type RecentSearch } from '@/lib/api';
import { searchHistoryKey } from '@/lib/market-keys';
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
  queryClient.setQueryData(searchHistoryKey(account), list);
  return queryClient;
}

/** The recent list's observer, answering `reads` in turn: it stands in for the mounted list. */
function listObserver(queryClient: QueryClient, reads: () => Promise<RecentSearch[]>) {
  const observer = new QueryObserver<RecentSearch[]>(queryClient, {
    queryKey: searchHistoryKey('user-a'),
    queryFn: reads,
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  return { observer, unsubscribe };
}

/** The recent list the client holds for `account` (user-a's unless named). */
const held = (queryClient: QueryClient, account = 'user-a') =>
  queryClient.getQueryData<RecentSearch[]>(searchHistoryKey(account));

const deleteOf = (id: string, account = 'user-a'): SearchHistoryWrite => ({
  kind: 'delete',
  id,
  expectedAccountId: account,
});

describe('the recent searches query', () => {
  it('is one private entry per account on screen, read once that account is known (ADR-0091)', () => {
    expect(recentSearchesQueryOptions('user-a').queryKey).toEqual(['search-history', 'user-a']);
    expect(recentSearchesQueryOptions('user-a').enabled).toBe(true);
    // Signed out, or `GET /me` not answered yet: never asked.
    expect(recentSearchesQueryOptions(undefined).enabled).toBe(false);
    // Each account's list is an entry of its own: the one read for A is never B's.
    expect(hashKey(searchHistoryKey('user-b'))).not.toBe(hashKey(searchHistoryKey('user-a')));
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
    expect(queryClient.getQueryState(searchHistoryKey('user-a'))?.isInvalidated).toBe(true);
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

  it('undoes each failed delete on its own when two are in flight (Codex on #212)', async () => {
    // Deleting a, then b; both fail, the first failure first. Restoring each write's snapshot
    // would leave [b] — a hidden though neither delete happened — and the read after them fails
    // in the same outage, so nothing would correct it.
    // The server's order: the newest search first.
    const newer = { ...entry('a', '금리'), searchedAt: '2026-10-16T02:00:00.000Z' };
    const older = { ...entry('b', '환율'), searchedAt: '2026-10-16T01:00:00.000Z' };
    const queryClient = seeded('user-a', [newer, older]);
    const first = deferred<RecentSearch[]>();
    const second = deferred<RecentSearch[]>();
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
    first.reject(outage());
    await expect(one).rejects.toThrow();
    // b's delete is still out: a comes back, b stays hidden.
    expect(held(queryClient)).toEqual([newer]);
    second.reject(outage());
    await expect(two).rejects.toThrow();
    expect(held(queryClient)).toEqual([newer, older]);

    // The other order of failures ends the same.
    const again = seeded('user-a', [newer, older]);
    const third = deferred<RecentSearch[]>();
    const fourth = deferred<RecentSearch[]>();
    const more = [third, fourth];
    const options2 = searchHistoryWriteOptions(
      again,
      () => undefined,
      () => more.shift()!.promise,
    );
    const three = new MutationObserver(again, options2).mutate(deleteOf('a'));
    const four = new MutationObserver(again, options2).mutate(deleteOf('b'));
    await flush();
    fourth.reject(outage());
    await expect(four).rejects.toThrow();
    expect(held(again)).toEqual([older]);
    third.reject(outage());
    await expect(three).rejects.toThrow();
    expect(held(again)).toEqual([newer, older]);
  });

  it('writes only the list of the account it named, never another account’s (ADR-0091)', async () => {
    // The press names the account whose list the screen drew, and every write of it — the entry
    // dropped at the press, the rollback — goes into that account's list: user-b's, read after
    // `['me']` turned to user-b (in place, or after SessionCacheGuard's reset), is left alone. One
    // entry for both — the key before ADR-0091 — would hide user-a's entry in user-b's list, and
    // put user-a's terms back over it.
    const queryClient = seeded('user-a');
    const theirs = [entry('z', '남의 검색')];
    queryClient.setQueryData(searchHistoryKey('user-b'), theirs);
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
    expect(held(queryClient, 'user-b')).toEqual(theirs);
    // The tab became user-b's before the failure landed.
    queryClient.setQueryData(ME_QUERY_KEY, me('user-b'));
    answer.reject(outage());
    await expect(done).rejects.toThrow();
    expect(held(queryClient)).toEqual(LIST);
    expect(held(queryClient, 'user-b')).toEqual(theirs);
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

  it('reads again only the list of the account it named, after that account’s last write (ADR-0091)', async () => {
    // Each account's list is an entry of its own: a delete named for user-a makes user-a's list
    // stale and no other — and user-b's write still on its way does not hold user-a's read back.
    const queryClient = seeded('user-a');
    queryClient.setQueryData(searchHistoryKey('user-b'), [entry('z', '남의 검색')]);
    const forA = deferred<RecentSearch[]>();
    const forB = deferred<RecentSearch[]>();
    const answers = [forB, forA];
    const options = searchHistoryWriteOptions(
      queryClient,
      () => undefined,
      () => answers.shift()!.promise,
    );
    const b = new MutationObserver(queryClient, options).mutate(deleteOf('z', 'user-b'));
    const a = new MutationObserver(queryClient, options).mutate(deleteOf('a', 'user-a'));
    await flush();
    forA.resolve([LIST[1]!]);
    await a;
    expect(queryClient.getQueryState(searchHistoryKey('user-a'))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(searchHistoryKey('user-b'))?.isInvalidated).toBe(false);
    forB.resolve([]);
    await b;
    expect(queryClient.getQueryState(searchHistoryKey('user-b'))?.isInvalidated).toBe(true);
  });
});

describe('the account the recent searches are written for (ADR-0091)', () => {
  it('is the one of the `Me` the screen was drawn from, never the session’s', () => {
    // In the render between the session naming B and SessionCacheGuard's reset the screen is still
    // A's, and a write naming the session's account would be taken with B's cookie: a term searched
    // on A's screen recorded for B, B's history cleared from A's list. No component renders under
    // node, so the wiring is pinned in the sources: the hooks offer no account (no session id), the
    // header's box, the search screen's box and its list hand them the `Me`'s id — which keys the
    // list (above) — and the deletes send it. e2e search.spec.ts ('탭의 계정이 …', '탭의 세션이 …')
    // drives both orders.
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source('./use-search-history.ts')).not.toMatch(/user\.id|\bmeBelongsTo\b/);
    const nav = source('../components/layout/nav.tsx');
    expect(nav).toContain('const accountId = useMe().data?.id;');
    expect(nav).toContain('const record = useRecordSearch(accountId);');
    const screen = source('../app/search/market-search.tsx');
    expect(screen).toContain('const accountId = useMe().data?.id;');
    expect(screen).toContain('const record = useRecordSearch(accountId);');
    expect(screen).toContain('const accountId = me.data?.id;');
    expect(screen).toContain('const recent = useRecentSearches(accountId);');
    expect(screen.match(/expectedAccountId: accountId\b/g)).toHaveLength(2);
    expect(screen).not.toMatch(/useSearchHistoryWrite\(\)\.accountId|\{ write, accountId \}/);
  });

  it('draws both boxes again for each account, so a term typed for A is never recorded for B', () => {
    // `['me']` can turn from A to B under a box that stays mounted — the header's never remounts —
    // in place before the session does (ADR-0090 결정 4-2) or through SessionCacheGuard's reset;
    // the term typed on A's screen would then be submitted, and recorded, for B with B's cookie.
    // Each box is keyed on its account as well as the URL's term (`searchBoxKey`). e2e
    // search.spec.ts ('… 검색창에 적던 검색어 …') holds that order.
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source('../components/layout/nav.tsx')).toContain(
      'key={searchBoxKey(accountId, initialTerm)}',
    );
    const screen = source('../app/search/market-search.tsx');
    expect(screen).toContain('key={searchBoxKey(accountId, filters.q)}');
    expect(screen).toContain(
      '<SearchBox filters={filters} accountId={accountId} onSubmitted={record} />',
    );
  });

  it('says the list could not be read when `GET /me` failed, rather than waiting for good', () => {
    // The list is read for the `Me`'s account only; a `GET /me` that failed without ever answering
    // leaves it unread — its failure rung, with 다시 시도 reading `GET /me` again. e2e
    // search.spec.ts ('`GET /me`를 읽지 못하면 …') drives it.
    const screen = readFileSync(
      new URL('../app/search/market-search.tsx', import.meta.url),
      'utf8',
    );
    expect(screen).toContain(
      'const meFailed = me.isLoggedIn && me.isError && accountId === undefined;',
    );
    expect(screen).toContain("const body = meFailed ? 'failed' : section.body;");
    expect(screen).toContain('onClick={() => void (meFailed ? me.refetch() : recent.refetch())}');
  });
});
