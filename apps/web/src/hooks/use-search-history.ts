'use client';

import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { meBelongsTo } from '@/hooks/use-me';
import {
  type RecentSearch,
  type RecordSearchBody,
  api,
  isForAnotherAccount,
  unwrap,
} from '@/lib/api';
import { SEARCH_HISTORY_KEY } from '@/lib/market-keys';
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
 * nothing of it is fetched on the server or dehydrated — and waiting for the session like
 * `useWatchlist`: the routes need the cookie, and a signed-out request would take a 401.
 *
 * The query and mutation options are exported apart from the hooks so they can be tested under
 * the node runner (use-search-history.test.ts), as use-watchlist.ts does.
 */

/** Just enough of better-auth's session to say whether anybody is signed in (use-portfolio.ts). */
type SessionLike = { user: unknown } | null;

/** `GET /me/search-history`: the newest 10 distinct terms, newest first. */
export function recentSearchesQueryOptions(session?: SessionLike) {
  return {
    queryKey: SEARCH_HISTORY_KEY,
    queryFn: async (): Promise<RecentSearch[]> =>
      unwrap(await api.GET('/api/v1/me/search-history')).data,
    enabled: session != null,
  };
}

/** The recent list. `isPending` covers the session lookup too, as `useWatchlist` does. */
export function useRecentSearches() {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useQuery(recentSearchesQueryOptions(session));
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
  await queryClient.invalidateQueries({ queryKey: SEARCH_HISTORY_KEY });
}

/**
 * What a search box calls on its submit with the term as typed, and a recent-search entry on its
 * click with its term (owner decision 2026-10-16, ADR-0066: a picked recent search is a new search,
 * so it moves to the top): it records the term when a signed-in member searched one the list
 * searches (`searchToRecord` — nothing for a visitor, a session not known yet or a blank term), in
 * the background, and returns at once so the navigation to the results is not held up. A filter,
 * an order, 더 보기 or a search opened by its address never calls it (ADR-0066).
 */
export function useRecordSearch(): (raw: unknown) => void {
  const queryClient = useQueryClient();
  const { data: session, isPending, refetch } = useSession();
  const accountId = isPending ? undefined : session?.user.id;
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
 * - when the last of the writes in flight settles, the list is read again, so the screen ends on
 *   the server's word. Not after each: two quick deletes would otherwise read the list between
 *   them and bring the second entry back for a moment.
 *
 * The rollback is scoped to the account the press was sent for (`meBelongsTo`, as the watch's
 * is): no key under `['search-history']` says whose it is, and a write whose answer lands after
 * the tab switched accounts (SessionCacheGuard reset the cache) must not put one account's terms
 * into the other's list. The answer itself is not written either — the read after the writes is
 * — so no account's list is ever filled from an answer meant for another.
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
      await queryClient.cancelQueries({ queryKey: SEARCH_HISTORY_KEY, exact: true });
      const held = queryClient.getQueryData<RecentSearch[]>(SEARCH_HISTORY_KEY);
      if (held === undefined) return { before: [], removed: [] };
      const after = afterSearchHistoryWrite(held, write);
      queryClient.setQueryData(SEARCH_HISTORY_KEY, after);
      return { before: held, removed: held.filter((entry) => !after.includes(entry)) };
    },
    onError: (error: Error, write: SearchHistoryWrite, snapshot: HistorySnapshot | undefined) => {
      if (isForAnotherAccount(error)) onSessionChanged();
      if (snapshot === undefined || snapshot.removed.length === 0) return;
      if (!meBelongsTo(queryClient, write.expectedAccountId)) return;
      queryClient.setQueryData<RecentSearch[]>(
        SEARCH_HISTORY_KEY,
        (current) => current && undoSearchHistoryWrite(current, snapshot.removed, snapshot.before),
      );
    },
    onSettled: async () => {
      // This write still counts as mutating while its own onSettled runs.
      if (queryClient.isMutating({ mutationKey: SEARCH_HISTORY_KEY }) > 1) return;
      await queryClient.invalidateQueries({ queryKey: SEARCH_HISTORY_KEY });
    },
  };
}

/**
 * The recent list's deletes, plus the account the screen shows (the session's user id), which a
 * press sends as `expectedAccountId`. `accountId` is undefined until better-auth has answered.
 */
export function useSearchHistoryWrite() {
  const queryClient = useQueryClient();
  const { data: session, refetch } = useSession();
  const write = useMutation(searchHistoryWriteOptions(queryClient, () => void refetch()));
  return { write, accountId: session?.user.id };
}
