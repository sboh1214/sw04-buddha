'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type QueryState,
} from '@tanstack/react-query';
import { type UpdateWatchBody, type WatchState, api, isForAnotherAccount, unwrap } from '@/lib/api';
import {
  WATCHLIST_PAGES_KEY,
  type WatchlistFilters,
  watchStateKey,
  watchlistPagesKey,
} from '@/lib/market-keys';
import { type MarketPage } from '@/lib/market-live';
import { useSession } from '@/lib/use-session';

/**
 * 관심 시장 (#89, ADR-0064): MY's list, the home's 관심 시장 view (#63, ADR-0065) and the detail's
 * button. All are private — the root is in `PRIVATE_QUERY_ROOTS`, so none is ever dehydrated into
 * a page — and all wait for the session like `useOrders` (use-portfolio.ts): the routes need the
 * cookie, and a signed-out request would take a 401 the retry rule refuses to retry. The button's
 * state waits for the account the screen shows, which keys it (`watchStateKey`, ADR-0091).
 *
 * The query and mutation options are exported apart from the hooks so they can be tested under
 * the node runner (use-watchlist.test.ts), as use-phone-verification.ts does.
 */

/** Just enough of better-auth's session to say whether anybody is signed in (use-portfolio.ts). */
type SessionLike = { user: unknown } | null;

/**
 * `GET /me/watchlist` in the order the filters name (newest watch first when they name none, as
 * MY's do), one page per 더 보기 press — the `useOrders` idiom. The
 * pages are `MarketSummary` rows in the home grid's page shape, so the realtime provider writes a
 * `market:tick` or a `market:status` into them as it does into `['markets', …]`, and the list's
 * `structuralSharing` (query-client.ts) keeps a late refetch from rolling a card back. A filter
 * left undefined is omitted rather than sent empty: the API's query schema refuses a blank one.
 */
export function watchlistInfiniteQueryOptions(
  filters: WatchlistFilters = {},
  session?: SessionLike,
) {
  return {
    queryKey: watchlistPagesKey(filters),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<MarketPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/me/watchlist', {
          params: {
            query: {
              ...(filters.status === undefined ? {} : { status: filters.status }),
              ...(filters.category === undefined ? {} : { category: filters.category }),
              ...(filters.sort === undefined ? {} : { sort: filters.sort }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: MarketPage) => last.nextCursor ?? undefined,
    enabled: session != null,
  };
}

/**
 * MY's 관심 시장 list (`{}`) and the home's 관심 시장 view (`watchlistViewFilters`, lib/home-view.ts:
 * open markets, a category, the order picked) — one hook, so a change to its options reaches both
 * screens. `isPending` covers the session lookup too, as `useOrders` does; the home's view waits on
 * it (`WatchlistViewList`, app/market-list.tsx).
 */
export function useWatchlist(filters: WatchlistFilters = {}) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery(watchlistInfiniteQueryOptions(filters, session));
  return {
    ...query,
    isPending: sessionPending || (session != null && query.isPending),
    isLoggedIn: session != null,
  };
}

/**
 * `GET /me/watchlist/:marketId`: whether the caller watches this market — kept under the account
 * the screen shows (`accountId`, the `Me` it was drawn from: `watchStateKey`), and read only once
 * that account is known, so never for a visitor.
 */
export function watchStateQueryOptions(marketId: string, accountId: string | undefined) {
  const id = marketId.toLowerCase();
  return {
    queryKey: watchStateKey(id, accountId),
    queryFn: async (): Promise<WatchState> =>
      unwrap(
        await api.GET('/api/v1/me/watchlist/{marketId}', { params: { path: { marketId: id } } }),
      ).data,
    enabled: accountId !== undefined,
  };
}

/** What a press sends: the market, the state to set, and the account the screen shows. */
export interface WatchVariables extends UpdateWatchBody {
  marketId: string;
}

async function putWatch({ marketId, ...body }: WatchVariables): Promise<WatchState> {
  return unwrap(
    await api.PUT('/api/v1/me/watchlist/{marketId}', {
      params: { path: { marketId: marketId.toLowerCase() } },
      body,
    }),
  ).data;
}

/**
 * What `onMutate` hands to the rollback: the state entry as it was before the press
 * (`getQueryState`), `undefined` when there was none.
 */
interface WatchSnapshot {
  entry: QueryState<WatchState> | undefined;
}

/**
 * Puts a state entry that held no state back to what its reads had answered before the press
 * (its first read failed): no data, that read's error and its answer counts. Not
 * `resetQueries`: a reset zeroes the counts, so the button — whose placeholder is for before the
 * first answer (`watchButtonView`) — would swap the toggle a keyboard user just pressed for the
 * placeholder and drop the focus. The fetch fields are left alone: a read started meanwhile owns
 * them. With no entry before the press there is nothing to put back, and the optimistic one goes.
 */
function restoreRead(
  queryClient: QueryClient,
  key: QueryKey,
  entry: QueryState<WatchState> | undefined,
) {
  if (entry === undefined) {
    queryClient.removeQueries({ queryKey: key, exact: true });
    return;
  }
  const { data, dataUpdatedAt, dataUpdateCount, error, errorUpdatedAt, errorUpdateCount, status } =
    entry;
  queryClient.getQueryCache().find<WatchState>({ queryKey: key, exact: true })?.setState({
    data,
    dataUpdatedAt,
    dataUpdateCount,
    error,
    errorUpdatedAt,
    errorUpdateCount,
    status,
  });
}

/**
 * `PUT /me/watchlist/:marketId` as mutation options, optimistic:
 *
 * - `onMutate` cancels a state read in flight (it may have left before this write and would land
 *   after it with the old state), keeps what the cache held, and writes the state being asked for,
 *   so the button moves on the press.
 * - success writes the server's answer; failure puts back what was held — or, when nothing was
 *   held (the press came after a failed read), the failed read itself (`restoreRead`), so the
 *   entry is not left showing a write that did not happen and the toggle keeps its focus while
 *   the state is read again. A refusal as another account also asks for the session again
 *   (`onSessionChanged`), as the verification and time-zone writes do.
 * - either way the list and this market's state are invalidated: the list's membership changed
 *   (it is usually not mounted here, so that only marks it stale for MY), and the state is read
 *   again so the screen ends on the server's word, whatever the answer was.
 *
 * Every write is into the state of the account the press was sent for — the `expectedAccountId`
 * the server compared with the cookie, and the account of the entry the toggle drew
 * (`watchStateKey`): a press whose answer lands after the tab switched accounts writes nothing
 * into the state another account's screen draws. The list's invalidation still runs, and it asks
 * with the cookie.
 */
export function updateWatchOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  put: (variables: WatchVariables) => Promise<WatchState> = putWatch,
) {
  const keyOf = ({ marketId, expectedAccountId }: WatchVariables) =>
    watchStateKey(marketId, expectedAccountId);
  const settle = async (variables: WatchVariables) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: WATCHLIST_PAGES_KEY }),
      queryClient.invalidateQueries({ queryKey: keyOf(variables), exact: true }),
    ]);
  };
  return {
    mutationFn: put,
    onMutate: async (variables: WatchVariables): Promise<WatchSnapshot> => {
      const key = keyOf(variables);
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      const entry = queryClient.getQueryState<WatchState>(key);
      queryClient.setQueryData<WatchState>(key, { watched: variables.watched });
      return { entry };
    },
    onSuccess: async (state: WatchState, variables: WatchVariables) => {
      queryClient.setQueryData<WatchState>(keyOf(variables), state);
      await settle(variables);
    },
    onError: async (
      error: Error,
      variables: WatchVariables,
      snapshot: WatchSnapshot | undefined,
    ) => {
      if (isForAnotherAccount(error)) onSessionChanged();
      // No snapshot: `onMutate` did not finish, so no optimistic state was written.
      if (snapshot !== undefined) {
        const previous = snapshot.entry?.data;
        if (previous === undefined) {
          restoreRead(queryClient, keyOf(variables), snapshot.entry);
        } else {
          queryClient.setQueryData<WatchState>(keyOf(variables), previous);
        }
      }
      await settle(variables);
    },
  };
}

/**
 * The detail's button: the state of one market for the account the screen shows (`accountId`, the
 * `Me` it was drawn from — which a press sends as `expectedAccountId`), and its toggle. Never the
 * session's account: in the render between the session naming another account and
 * SessionCacheGuard's reset the session already says B while the toggle still shows A's state, and
 * a press naming B would set B's watch to the opposite of A's (ADR-0091). So it offers no account
 * of its own; the state waits for that account to be known, and `sessionPending` and `signedIn`
 * only say whether anybody is signed in (`watchButtonView`).
 */
export function useWatch(marketId: string, accountId: string | undefined) {
  const queryClient = useQueryClient();
  const { data: session, isPending: sessionPending, refetch: refetchSession } = useSession();
  const state = useQuery(watchStateQueryOptions(marketId, accountId));
  const toggle = useMutation(updateWatchOptions(queryClient, () => void refetchSession()));
  return { state, toggle, sessionPending, signedIn: session != null };
}
