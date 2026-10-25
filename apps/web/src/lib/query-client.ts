import {
  type Query,
  QueryCache,
  QueryClient,
  hashKey,
  isServer,
  replaceEqualDeep,
} from '@tanstack/react-query';
import { type Market, type Me, type Position, isApiError } from './api';
import {
  type CommentPages,
  type PlacedCommentsOwner,
  COMMENT_PAGES_KEY,
  keepPlacedComments,
  placedWithOwnFace,
} from './comments';
import {
  MARKETS_KEY,
  MARKET_KEY,
  POSITIONS_KEY,
  TICKS_KEY,
  WATCHLIST_PAGES_KEY,
} from './market-keys';
import { type MarketPages, joinMarket, joinMarketPages, joinPositions } from './market-live';
import { type CachedSeries, joinSeries } from './ticks';

function makeQueryClient() {
  const client = new QueryClient({
    // Tells a 더 보기's failure from every other the moment it lands, while the query still says
    // which fetch failed (`moreFailures` below).
    queryCache: new QueryCache({
      onError: (error, query) => {
        noteMoreFailure(error, query.state.fetchMeta);
      },
    }),
    defaultOptions: {
      queries: {
        // Do not refetch immediately on mount; the realtime socket patches the caches with
        // setQueryData instead (PLAN 11.5: an event must not become a request).
        staleTime: 30 * 1000,
        retry: (failureCount, error) => {
          // 4xx never fixes itself by retrying (401 in particular must fail fast).
          if (isApiError(error) && error.status < 500) return false;
          return failureCount < 2;
        },
      },
    },
  });
  // Ordering is enforced on EVERY write to a market, not only in the socket handler: a value
  // written by `setQueryData` and a value answered by a queryFn both route through
  // `replaceData`, which hands a function-valued `structuralSharing` both sides. The
  // race this fixes has nothing to do with sockets — refetchOnWindowFocus and
  // refetchOnReconnect are on, so a refetch that started before a trade and lands after it
  // would roll the probability backwards on its own.
  //
  // Query defaults match by key PREFIX, so `['market']` covers `['market', <any id>]` and
  // never `['markets', filters]` (element-wise comparison; 'market' !== 'markets'), and the
  // two registrations below stay disjoint — market-keys.test.ts pins that. Hydration is the
  // one write that bypasses this path (it sets the query state directly) and carries its own
  // `dataUpdatedAt` guard. `replaceEqualDeep` restores reference equality wherever the join
  // rebuilt an equal subtree, so an untouched list page does not re-render; it is re-exported
  // by @tanstack/react-query, the only specifier that resolves here (node_modules is
  // isolated and query-core is not a direct dependency of apps/web). The casts are the price
  // of query-core typing both sides `unknown`.
  client.setQueryDefaults(MARKET_KEY, {
    structuralSharing: (held, incoming) =>
      replaceEqualDeep(held, joinMarket(held as Market | undefined, incoming as Market)),
  });
  // The home's lists and, under the same root, the search screen's results (ADR-0066) and a
  // detail's 관련 시장 (`['markets', 'related', id]`, ADR-0068).
  client.setQueryDefaults(MARKETS_KEY, {
    structuralSharing: (held, incoming) =>
      replaceEqualDeep(
        held,
        joinMarketPages(held as MarketPages | undefined, incoming as MarketPages),
      ),
  });
  // MY's 관심 시장 holds the same cards in the same page shape (#89, ADR-0064), and the socket
  // writes them the same way (realtime-provider.tsx), so a refetch that left before a trade or
  // a close must not roll a card back either. `['watchlist', 'pages']` and never the root:
  // `['watchlist', 'market', id]` is a `WatchState`, which this join would mangle.
  client.setQueryDefaults(WATCHLIST_PAGES_KEY, {
    structuralSharing: (held, incoming) =>
      replaceEqualDeep(
        held,
        joinMarketPages(held as MarketPages | undefined, incoming as MarketPages),
      ),
  });
  // The same duty for the account's own rows, and for the same reason: `applyPositionEvent`
  // orders `user:position` events by `version`, but a `GET /me/positions` answer went in raw,
  // so a fetch that left before another tab's trade landed after the event and rolled the row
  // back — a stale 내 포지션 on the detail and stale 평가손익 in MY, with nothing
  // scheduled to correct either. `['positions']` covers `['positions', 'open']` and
  // `['positions', 'settled']` by prefix and never reaches `['orders']`.
  client.setQueryDefaults(POSITIONS_KEY, {
    structuralSharing: (held, incoming) =>
      replaceEqualDeep(held, joinPositions(held as Position[] | undefined, incoming as Position[])),
  });
  // And the chart's series, for the third time and the same reason: `appendTickToSeries` orders
  // the socket's ticks by `ts`, but a REST answer went in raw, so a refetch that left before a
  // trade pulled the right edge back to the old probability — while the header, which has
  // `joinMarket` above, kept the new one. Two readings of one trade, disagreeing on one screen.
  // Ordering here is by `tradeCount`, like the three joins above; it was briefly the answer's
  // own clock, which is not a watermark over committed rows (ticks.ts says why).
  client.setQueryDefaults(TICKS_KEY, {
    structuralSharing: (held, incoming) =>
      replaceEqualDeep(
        held,
        joinSeries(held as CachedSeries | undefined, incoming as CachedSeries),
      ),
  });
  // A post's comment pages (#48, ADR-0074), for another reason: the writer's own 댓글 or 대댓글 that
  // its read toward its place left at the end of what is held (`withNewComment`) must stay there
  // through every read of the pages until a read brings the page that holds it (오너 결정
  // 2026-10-24). A read's pages are written over what was held — by the query's refetch (a focus,
  // a reconnection, a stale thread's read again), its 더 보기, or a new 댓글's read — and come
  // without it; this is the one place every one of those writes passes, so `keepPlacedComments`
  // carries it over here and puts it back, or settles it against what the read just brought.
  // `['posts', 'comments']` never reaches `['posts', 'post', id]` or the lists. The writer's own
  // comments placed so take the profile image `['me']` holds once it has changed since they were
  // placed (#141, ADR-0079 7-23): read from this client as each write passes, so a `['me']` read
  // since — a change made in another tab — reaches them on the next write of the pages, and on the
  // write of `['me']` itself (below).
  client.setQueryDefaults(COMMENT_PAGES_KEY, {
    structuralSharing: (held, incoming) =>
      replaceEqualDeep(
        held,
        keepPlacedComments(
          held as CommentPages | undefined,
          incoming as CommentPages,
          placedCommentsOwner(client),
        ),
      ),
  });
  // And as `['me']` itself is written (ADR-0079 7-23): a read of the pages that lands before a read
  // of `['me']` — both due on a window's focus, in either order — carries those comments over with
  // the image `['me']` held then, the old one after a change made in another tab, while it brings
  // the member's other comments with the new one; and no write of the pages need follow `['me']`'s.
  // So each write of `['me']` — its read landing, `setQueryData` — puts the image it now holds on
  // them where it changed, in every post's pages held (`putOwnFace`).
  const meHash = hashKey(ME_KEY);
  client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.query.queryHash !== meHash) return;
    if (event.action.type !== 'success' && event.action.type !== 'setState') return;
    for (const query of client.getQueryCache().findAll({ queryKey: COMMENT_PAGES_KEY })) {
      void putOwnFace(client, query);
    }
  });
  return client;
}

/**
 * A write of `['me']` on one post's comment pages (`query`): the image it now holds on the writer's
 * own comments placed at the end of them where it changed (`placedWithOwnFace`, ADR-0079 7-23) —
 * the data alone, as `storeAuthorImage` (hooks/use-me.ts) writes a face: their time, stale mark and
 * a failed read's error kept, no request. Nothing when it changes nothing — `['me']` is written far
 * more often than its image changes (a balance event, a profile write).
 *
 * A read of every page held on its way is let land: its pages are all read, so the placed copy it
 * puts back comes from what is held as it lands — the new image — and the image noted with it is
 * `['me']`'s. A 더 보기 on its way is not: its answer is the pages held as it left, with the next
 * one after them (query-core's `fetchNextPage`), so the placed copy it carries — the one on those
 * pages, or a 대댓글 in a thread on them — is the old image, put back over the new one while the
 * image noted, taken from what is held, says the new one was carried: it stood there, the old
 * (deleted) address, through every read until its own page was read. So it is cancelled first —
 * which puts back the pages it left from, the image on them and the one noted agreeing — and the
 * write made on what that leaves, as `storeAuthorImage` and a comment's write (`writePages`,
 * use-comments.ts) cancel it; its button is there to press again.
 */
async function putOwnFace(client: QueryClient, query: Query): Promise<void> {
  const held = query.state.data as CommentPages | undefined;
  if (held === undefined || placedWithOwnFace(held, placedCommentsOwner(client)) === held) return;
  if (query.state.fetchStatus !== 'idle' && query.state.fetchMeta?.fetchMore !== undefined) {
    await client.cancelQueries({ queryKey: query.queryKey, exact: true });
  }
  // As the cancellation left it, and for the account `['me']` holds now.
  const data = query.state.data as CommentPages | undefined;
  if (data === undefined) return;
  const next = placedWithOwnFace(data, placedCommentsOwner(client));
  if (next !== data) query.setState({ data: next });
}

/**
 * `['me']` — `ME_QUERY_KEY` (hooks/use-me.ts), named here again: that is a client module, and this
 * file runs on the server too (query-client.test.ts pins the two together).
 */
export const ME_KEY = ['me'] as const;

/**
 * The account `client` holds in `['me']`, as `keepPlacedComments` takes it; undefined while it holds
 * none — or anything short of a profile: this runs on every write of every post's comment pages,
 * and throwing there would lose the write.
 */
function placedCommentsOwner(client: QueryClient): PlacedCommentsOwner | undefined {
  const me = client.getQueryData<Partial<Me>>(ME_KEY);
  const profile = me?.profile;
  if (me?.id === undefined || profile === undefined) return undefined;
  return { accountId: me.id, publicId: profile.publicId, imageUrl: profile.imageUrl };
}

let browserQueryClient: QueryClient | undefined;

/**
 * TanStack Query SSR pattern: a fresh client per server request, one lazily created
 * singleton in the browser (so React suspending during the first render cannot discard it).
 */
export function getQueryClient(): QueryClient {
  if (isServer) return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

/**
 * Cancels every query under `queryKey` that has answered NOTHING yet, so the invalidation that
 * follows issues a REQUEST rather than a subscription to the one already in flight.
 *
 * Here rather than beside its caller because it is a cache rule, not a socket one, and the
 * socket's handlers (realtime-provider.tsx) need it for more than one key.
 *
 * `invalidateQueries` restarts a running fetch only where the query already holds data:
 * `refetchQueries` passes `cancelRefetch`, and query-core honours it under
 * `if (this.state.data !== undefined && fetchOptions?.cancelRefetch)` — otherwise it hands
 * back the RUNNING promise (`Query.fetch`). So a trade answered while the account's FIRST
 * `GET /me/positions`, `GET /me` or `GET /me/orders` was still in flight vanished: the seeds
 * decline an absent entry (`mergePosition` and the `Me` updater both answer undefined, which
 * is what keeps a logged-out tab from gaining session state), and the invalidation then waited
 * on the very request that left BEFORE the trade — so a pre-trade `[]` landed and the new row,
 * the new balance and the new order were all missing from the screen until an unrelated
 * refetch happened by.
 *
 * A cancel leaves the retryer `rejected`, which is what lets the next `fetch()` start a second
 * request instead of taking the dedupe branch.
 *
 * The `data === undefined` predicate is what keeps this from COSTING an answer, and the case it
 * saves is not the obvious one. For a MOUNTED list holding rows it changes nothing — the
 * invalidation's own `cancelRefetch` was going to cancel and restart that refetch anyway. An
 * UNMOUNTED one mid-refetch is the one that pays: `cancelQueries` reverts it to the rows it held
 * before, and an `active` invalidation then declines to restart what nobody is watching — so the
 * answer already on the wire is thrown away and the stale row stands until the list is mounted
 * again. The predicate leaves it alone to land (query-client.test.ts pins both halves).
 *
 * That same predicate makes this the WRONG call in front of a SEED, which is the mistake to
 * expect here. A seed does not WAIT for the answer, it REPLACES it, so what has to be cancelled
 * there is a fetch over data every bit as much as a first one — and a key deliberately left out
 * of its own invalidation has no second chance to correct what lands late. Such a call site
 * writes its own unconditional `cancelQueries({ queryKey, exact: true })` and pairs it with the
 * seed rather than with a request; it is not a third helper here because the pair these two
 * enforce is cancel-then-ASK.
 */
export function cancelFirstFetch(queryClient: QueryClient, queryKey: readonly unknown[]): void {
  void queryClient.cancelQueries({
    queryKey,
    predicate: (query) => query.state.data === undefined,
  });
}

/**
 * Cancel whatever has answered nothing, then ask again — and never one without the other.
 *
 * The two halves are a PAIR, which is why they are one function rather than two lines at each
 * call site. A cancel with no invalidation behind it strands the query on `pending` with
 * nothing left fetching (the hazard `applyBalanceEvent` grew its own `refetch` kind to avoid),
 * and an invalidation with no cancel in front of it subscribes to the request already running
 * instead of issuing one — which is the whole bug above. Written apart, either half could be
 * removed and every test would stay green.
 *
 * `refetchType` is left at its default `'active'` (query-core `invalidateQueries`), so only
 * mounted observers ask again and the rest merely go stale — PLAN 11.5's "refetch 남발 금지".
 */
export function restartQueries(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): Promise<void> {
  cancelFirstFetch(queryClient, queryKey);
  return queryClient.invalidateQueries({ queryKey });
}

/** What a section that renders a LIST can say about the query behind it. */
export type ListView = 'pending' | 'failed' | 'stale' | 'ready';

/**
 * Which of the four a list section is in — and `stale` is the one the screens kept missing.
 *
 * THE HAZARD: query-core reports a failure two different ways, and a ladder written on
 * `isLoadingError` alone collapses one of them into `ready`. A FIRST fetch that exhausts its
 * retries has no data and answers `isLoadingError` — the ladders caught that. A refetch that
 * fails after data exists answers `isRefetchError` instead, KEEPS the rows, and was rendered as
 * an ordinary list with nothing to say it had stopped being refreshed (measured: `isLoadingError
 * false, isRefetchError true, rows kept`).
 *
 * That silence costs differently per screen and both are real. 보유 포지션 shows a holding whose
 * membership refresh failed — a void or a settlement asks for both lists (`applyPositionEvent`
 * answers `refetch` when the row must MOVE), so a failed one leaves the row in 보유 포지션, out of
 * 정산 이력, and inside 총 평가 금액 where it no longer belongs. 체결 내역 shows a list one row
 * short, and there the refetch is the ONLY path a new fill can arrive by: `market:trade` carries
 * no `amountCoin`, so it is deliberately never merged into the cache.
 *
 * `stale` is deliberately NOT `failed`: the rows are real and the last answer is worth keeping on
 * screen — dropping a screenful because one refresh failed loses more than the staleness costs,
 * which is the reading `market-list.tsx` already takes. It is the caller's job to render the rows
 * AND say so, with a way back.
 *
 * `stale` is `refreshFailed`, not the bare flag: a refetch running after a failed 더 보기 answers
 * `isRefetchError` while no refresh has failed (`moreFailures`), and must not say one did.
 *
 * `pending` is checked first because a query refetching after a failure reports both.
 */
export function listView(query: {
  isPending: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
  error: unknown;
}): ListView {
  if (query.isPending) return 'pending';
  if (query.isLoadingError) return 'failed';
  return refreshFailed(query) ? 'stale' : 'ready';
}

/**
 * A list section's rungs INCLUDING its empty one, because `stale` is not a rung — it is a notice
 * that rides ABOVE whatever the section would otherwise show.
 *
 * Spending the stale state as one more `:` arm hides the very rows it is describing, which is
 * the loss `listView` refuses. And on an EMPTY list it is worse than a silence: the section goes
 * on printing its own "there is nothing here" copy as though that were current. That empty
 * variant is the one reading that is positively FALSE rather than merely incomplete — an account
 * with no prior rows acts in another tab, the refresh fails, and the screen asserts there is
 * nothing while the balance beside it already moved.
 */
export function listSection(
  query: { isPending: boolean; isLoadingError: boolean; isRefetchError: boolean; error: unknown },
  rowCount: number,
): { stale: boolean; body: 'pending' | 'failed' | 'empty' | 'rows' } {
  const view = listView(query);
  if (view === 'pending') return { stale: false, body: 'pending' };
  if (view === 'failed') return { stale: false, body: 'failed' };
  return { stale: view === 'stale', body: rowCount === 0 ? 'empty' : 'rows' };
}

/**
 * The errors a 더 보기 ended in — the next page refused through the client's retries — told apart
 * from every other failure AT THE MOMENT IT LANDS, by the query cache (`makeQueryClient`), while the
 * query still says which fetch failed.
 *
 * THE HOLE IT FILLS: TanStack reports a failed next page only through flags that later events
 * reset. `isFetchNextPageError` is `isError` plus the direction of the LAST fetch (`fetchMeta`), so:
 * - a cache write — the socket's `setQueriesData` on every held market card (realtime-provider.tsx:
 *   the home's, the search's and 관련 시장's grids and MY 관심 시장, on every `market:tick` and
 *   `market:status` that changes a card on screen), the reader's own comment written into the
 *   comments — dispatches `success`, which sets the status back to `success`: the flag goes false
 *   though no page came and 더 보기 is still there, and the notice above it vanished;
 * - any refetch — a refocus (a failed query is invalidated, so at once), an invalidation, a poll —
 *   resets `fetchMeta` and leaves the status at `error` while it runs: the flag goes false and
 *   `isRefetchError` true, so a list said its refresh had failed (`listView`'s `stale`), and a list
 *   whose rung reads `isError` swapped every held row for its error (`readFailed`), while nothing
 *   but the 더 보기 had failed and the refetch was still on its way.
 *
 * An error OBJECT is what outlives both: a cache write keeps `failureReason` (only a fetch's own
 * success clears it), and a refetch keeps `error` until it lands. So the cache's `onError` marks
 * the error a forward fetch ended in, and the helpers below ask the mark instead of the flags. A
 * WeakSet: an error is never held past its query, and the mark is a fact about that one object —
 * it does not need a per-client home (a server render's client never fetches a next page).
 */
const moreFailures = new WeakSet<object>();

/** Marks `error` as a 더 보기's when the fetch it ended was one (`fetchNextPage`'s `fetchMore`). */
function noteMoreFailure(
  error: unknown,
  fetchMeta: { fetchMore?: { direction: string } } | null,
): void {
  if (fetchMeta?.fetchMore?.direction !== 'forward') return;
  if (typeof error === 'object' && error !== null) moreFailures.add(error);
}

/** Whether `error` is the one a 더 보기 ended in (marked by the client's query cache). */
function isMoreFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && moreFailures.has(error);
}

/**
 * A 더 보기 that failed and is not being asked again: what every 더 보기 list says above its button
 * (owner decision 2026-10-20 7, ADR-0075), through `LoadMoreFailed` (components/ui/load-more-failed.tsx).
 *
 * `listView` and `listSection` never see it — TanStack leaves `isRefetchError` false for it — so a
 * 더 보기 that failed used to stop spinning and say nothing: the screen as it was before the press,
 * nothing for a screen reader. The rows stay (they are real), 더 보기 stays to ask again, and while
 * it is being asked again (`isFetchingNextPage`) the notice is withdrawn, to come back if it fails
 * again. It stays through a cache write (`failureReason` is still the marked error), and goes while
 * a refetch runs (which clears `failureReason`) and with the page that comes: a refetch that lands
 * re-reads the pages held, a 더 보기 that lands brings the next. `isFetchNextPageError` is kept beside
 * the mark so a list on a client without the mark still says it at once.
 */
export function moreFailed(query: {
  isFetchNextPageError: boolean;
  isFetchingNextPage: boolean;
  failureReason: unknown;
}): boolean {
  if (query.isFetchingNextPage) return false;
  return query.isFetchNextPageError || isMoreFailure(query.failureReason);
}

/**
 * For the lists whose failure rung reads `isError` rather than `listSection`'s flags (MY's 거래
 * 내역 and 결제 내역, the admin lists): whether the list failed at its first read or at a refresh —
 * NOT at a 더 보기. `isError` is true after a failed 더 보기 as well (the query's status is `error`
 * with its pages kept), and stays true through any refetch that follows until it lands — so a rung
 * on `isError` alone replaced every row read so far with its error the moment one 더 보기 failed,
 * and `isFetchNextPageError` alone (false once a refetch starts) did it again on the next refocus,
 * invalidation or poll. The marked error is what tells them apart: with this the rows stay, under
 * `moreFailed`'s notice, and through the refetch. A refresh that really failed keeps its rung, also
 * while it is asked again.
 */
export function readFailed(query: {
  isError: boolean;
  isFetchNextPageError: boolean;
  error: unknown;
}): boolean {
  return query.isError && !query.isFetchNextPageError && !isMoreFailure(query.error);
}

/**
 * A refresh that failed over rows that are kept — `isRefetchError`, save the one TanStack reports
 * by mistake: a refetch running after a failed 더 보기 answers `isRefetchError` (the status is still
 * `error`, the direction already reset) while no refresh has failed (see `moreFailures`). `listView`
 * reads it, and so does a list that draws the refresh notice from the query itself.
 */
export function refreshFailed(query: { isRefetchError: boolean; error: unknown }): boolean {
  return query.isRefetchError && !isMoreFailure(query.error);
}

/**
 * A list section that sits behind a SESSION gate, which `listSection` cannot see — the same hole
 * `profileView` exists for: three query flags cannot tell a signed-out reader from an empty one.
 *
 * `signedOut` is answered before `stale` so a notice can never ride above a sign-in prompt: a
 * query `SessionCacheGuard` reset has no rows to be stale ABOUT, and the 다시 시도 beside such a
 * notice could only 401. `pending` still wins over both, because `useSession` pins `isPending`
 * through hydration and a bare `!isLoggedIn` would flash the prompt on every single load.
 */
export function sessionListSection(
  query: {
    isLoggedIn: boolean;
    isPending: boolean;
    isLoadingError: boolean;
    isRefetchError: boolean;
    error: unknown;
  },
  rowCount: number,
): { stale: boolean; body: 'signedOut' | 'pending' | 'failed' | 'empty' | 'rows' } {
  if (!query.isLoggedIn && !query.isPending) return { stale: false, body: 'signedOut' };
  return listSection(query, rowCount);
}

/** What a screen that needs the signed-in profile can say about it. */
export type ProfileView = 'pending' | 'signedOut' | 'failed' | 'ready';

/**
 * Which of the four a screen that needs the profile is in — and `signedOut` is the rung
 * `listView` cannot have, because three query flags cannot see a session.
 *
 * THE HAZARD: when a session ends UNDER a mounted screen, every private query is disabled during
 * the same render (`enabled: session != null`) and `SessionCacheGuard` then resets the cache, so
 * the observer settles at `status: 'pending', fetchStatus: 'idle', data: undefined` while the
 * hooks' own override collapses `isPending` to false. "Settled, no data" then reads as a LOAD
 * FAILURE — a screen blaming a fetch that never ran and never failed — and every list beside it
 * answers `ready` with no rows, so the screen also asserts the account holds nothing. The server
 * gate on these routes only runs on NAVIGATION, so nothing moves the reader off the page.
 *
 * A HELD profile answers `ready` before anything else is asked, and that ordering is not a
 * detail. `isFetching` is true for every background refetch — a focus refetch, an expired
 * staleTime — so testing it ahead of the data would replace a perfectly good balance with a
 * skeleton several times an hour (measured: `isPending false, isFetching true, hasData true`).
 * The flags below decide what to say when there is NO profile to show, which is the only
 * question this function exists to answer.
 *
 * Among those, `pending` comes first and includes `isFetching`, and both halves are
 * load-bearing. `useSession` pins `isPending` through hydration, so a bare `!isLoggedIn` would
 * flash a sign-in prompt on every single load — an always-on regression worse than the bug. And
 * the tab that signs out clears `['me']` while better-auth's atom still holds the old session,
 * which without `isFetching` flashed a false error on every ordinary logout (recorded in
 * DECISIONS.md, M1 PR #2 round 3, reproduced 3/3).
 *
 * `failed` therefore keeps its honest meaning and only that: signed in, settled, and the profile
 * really did not arrive.
 */
export function profileView(me: {
  isLoggedIn: boolean;
  isPending: boolean;
  isFetching: boolean;
  hasProfile: boolean;
}): ProfileView {
  if (me.hasProfile) return 'ready';
  if (me.isPending || me.isFetching) return 'pending';
  return me.isLoggedIn ? 'failed' : 'signedOut';
}
