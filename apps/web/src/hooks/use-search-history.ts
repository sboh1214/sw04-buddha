'use client';

import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import {
  type RecentSearch,
  type RecordSearchBody,
  api,
  isForAnotherAccount,
  unwrap,
} from '@/lib/api';
import { SEARCH_HISTORY_KEY, searchHistoryKey } from '@/lib/market-keys';
import { searchToRecord } from '@/lib/market-search';
import {
  type SearchHistoryWrite,
  afterSearchHistoryWrite,
  undoSearchHistoryWrite,
} from '@/lib/search-history';
import { useSession } from '@/lib/use-session';

/**
 * 최근 검색 (#15, ADR-0066): the member's recent searches on the search screen, the record a
 * submitted search box makes, and the deletes. Private — the root is in `PRIVATE_QUERY_ROOTS`, so
 * nothing of it is fetched on the server or dehydrated — and kept under the account the screen
 * shows, read only once that account is known (`searchHistoryKey`), so never for a visitor: the
 * routes need the cookie, and a signed-out request would take a 401.
 *
 * Every write names that account — the `Me` the screen was drawn from, which the screen passes in
 * — never the session's: in the render between the session naming another account and
 * SessionCacheGuard's reset the session already says B while the screen is still A's, and a write
 * naming B would be taken with B's cookie — a term searched on A's screen recorded for B, or B's
 * history cleared from A's list (ADR-0091). The server refuses it as another account's. So the
 * hooks here offer no account of their own.
 *
 * The query and mutation options are exported apart from the hooks so they can be tested under
 * the node runner (use-search-history.test.ts), as use-watchlist.ts does.
 */

/**
 * `GET /me/search-history`: the newest 10 distinct terms, newest first — of the account the screen
 * shows (`accountId`, `searchHistoryKey`), and read only once it is known.
 */
export function recentSearchesQueryOptions(accountId: string | undefined) {
  return {
    queryKey: searchHistoryKey(accountId),
    queryFn: async (): Promise<RecentSearch[]> =>
      unwrap(await api.GET('/api/v1/me/search-history')).data,
    enabled: accountId !== undefined,
  };
}

/**
 * The recent list of the account the screen shows (`accountId`, its `Me`'s id). `isPending` covers
 * the session lookup too, as `useWatchlist` does — and, signed in, that account until `GET /me`
 * has answered.
 */
export function useRecentSearches(accountId: string | undefined) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useQuery(recentSearchesQueryOptions(accountId));
  return {
    ...query,
    isPending: sessionPending || (session != null && query.isPending),
    isLoggedIn: session != null,
  };
}

/**
 * `POST /me/search-history` for one submitted term, then the recent list is stale. Never thrown:
 * the search is the visitor's and goes ahead whatever the record does — a record that failed is a
 * missing line in the member's own history, not a failed search. A refusal as another account
 * (another tab signed in as somebody else) asks for the session again (`onSessionChanged`), so
 * SessionCacheGuard puts the real account on screen; nothing was written for either account.
 */
export async function recordSearch(
  queryClient: QueryClient,
  body: RecordSearchBody,
  onSessionChanged: () => void,
  post: (body: RecordSearchBody) => Promise<unknown> = async (record) =>
    unwrap(await api.POST('/api/v1/me/search-history', { body: record })),
): Promise<void> {
  try {
    await post(body);
  } catch (error) {
    if (isForAnotherAccount(error)) onSessionChanged();
  }
  await queryClient.invalidateQueries({
    queryKey: searchHistoryKey(body.expectedAccountId),
    exact: true,
  });
}

/**
 * What a search box calls on its submit with the term as typed, and a recent-search entry on its
 * click with its term (owner decision 2026-10-16, ADR-0066: a picked recent search is a new search,
 * so it moves to the top): it records the term when a signed-in member searched one the list
 * searches (`searchToRecord` — nothing for a visitor, an account not known yet or a blank term),
 * in the background, and returns at once so the navigation to the results is not held up. A
 * filter, an order, 더 보기 or a search opened by its address never calls it (ADR-0066).
 *
 * `accountId` is the account the screen shows — the `Me` it was drawn from, the header's — which
 * the record names (the file's header says why), undefined until `GET /me` has answered.
 */
export function useRecordSearch(accountId: string | undefined): (raw: unknown) => void {
  const queryClient = useQueryClient();
  const { refetch } = useSession();
  return useCallback(
    (raw: unknown) => {
      const body = searchToRecord(raw, accountId);
      if (body === undefined) return;
      void recordSearch(queryClient, body, () => void refetch());
    },
    [accountId, queryClient, refetch],
  );
}

async function postWrite(write: SearchHistoryWrite): Promise<RecentSearch[]> {
  const body = { expectedAccountId: write.expectedAccountId };
  if (write.kind === 'clear') {
    return unwrap(await api.POST('/api/v1/me/search-history/clear', { body })).data;
  }
  return unwrap(
    await api.POST('/api/v1/me/search-history/{id}/delete', {
      params: { path: { id: write.id } },
      body,
    }),
  ).data;
}

/** What `onMutate` hands to the rollback: the list at the press and the entries this write hid. */
interface HistorySnapshot {
  before: RecentSearch[];
  removed: RecentSearch[];
}

/**
 * Deleting one entry or all of them, optimistic:
 *
 * - `onMutate` cancels a read in flight (it may have left before this write and would land after
 *   it with the entry still there), keeps the list, and shows it without the entry
 *   (`afterSearchHistoryWrite`), so the row goes on the press.
 * - failure puts back the entries THIS write hid (`undoSearchHistoryWrite`), into the list as it
 *   is then — not the snapshot of the list, which a second delete in flight would have changed.
 *   A refusal as another account also asks for the session again.
 * - when the last of the account's writes in flight settles, that account's list is read again,
 *   so the screen ends on the server's word. Not after each: two quick deletes would otherwise read
 *   the list between them and bring the second entry back for a moment.
 *
 * Every write into the list is into the list of the account the press was sent for — the
 * `expectedAccountId` the server compared with the cookie, and the account of the list the press
 * was made on (`searchHistoryKey`, as the watch's is): a write whose answer lands after the tab
 * switched accounts must not put one account's terms into the list another account's screen
 * draws. The answer itself is not written either — the read after the writes is — so no
 * account's list is ever filled from an answer meant for another.
 */
export function searchHistoryWriteOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (write: SearchHistoryWrite) => Promise<RecentSearch[]> = postWrite,
) {
  return {
    mutationKey: SEARCH_HISTORY_KEY,
    mutationFn: post,
    onMutate: async (write: SearchHistoryWrite): Promise<HistorySnapshot> => {
      const key = searchHistoryKey(write.expectedAccountId);
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      const held = queryClient.getQueryData<RecentSearch[]>(key);
      if (held === undefined) return { before: [], removed: [] };
      const after = afterSearchHistoryWrite(held, write);
      queryClient.setQueryData(key, after);
      return { before: held, removed: held.filter((entry) => !after.includes(entry)) };
    },
    onError: (error: Error, write: SearchHistoryWrite, snapshot: HistorySnapshot | undefined) => {
      if (isForAnotherAccount(error)) onSessionChanged();
      if (snapshot === undefined || snapshot.removed.length === 0) return;
      queryClient.setQueryData<RecentSearch[]>(
        searchHistoryKey(write.expectedAccountId),
        (current) => current && undoSearchHistoryWrite(current, snapshot.removed, snapshot.before),
      );
    },
    onSettled: async (
      _data: RecentSearch[] | undefined,
      _error: Error | null,
      write: SearchHistoryWrite,
    ) => {
      // This write still counts as mutating while its own onSettled runs.
      const inFlight = queryClient.isMutating({
        mutationKey: SEARCH_HISTORY_KEY,
        predicate: (mutation) =>
          (mutation.state.variables as SearchHistoryWrite | undefined)?.expectedAccountId ===
          write.expectedAccountId,
      });
      if (inFlight > 1) return;
      await queryClient.invalidateQueries({
        queryKey: searchHistoryKey(write.expectedAccountId),
        exact: true,
      });
    },
  };
}

/**
 * The recent list's deletes. A press names the account whose list the screen shows (the `Me` it
 * was drawn from, `RecentSearches`' `accountId`), never the session's (the file's header).
 */
export function useSearchHistoryWrite() {
  const queryClient = useQueryClient();
  const { refetch } = useSession();
  return useMutation(searchHistoryWriteOptions(queryClient, () => void refetch()));
}
