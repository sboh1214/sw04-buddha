import { type QueryClient, defaultShouldDehydrateQuery, dehydrate } from '@tanstack/react-query';
// `import type`, not the inline `{ type X }` this app usually writes: under verbatimModuleSyntax
// an inline type import still emits `import {}` from the module, and `./ticks` imports `ticksKey`
// back from here — an erased import keeps that a type-level cycle instead of a runtime one, and
// keeps a server component that only wanted a cache key from loading the browser API client.
import type {
  MarketListStatus,
  MarketSort,
  PublicMarketStatus,
  WatchlistSort,
} from '@buddha/shared';
import type { HistoryListFilters } from './my-history';
import type { TickRange } from './ticks';

/**
 * Every market-related query key, in a module with NO `'use client'` directive.
 *
 * The server components seed the cache and the client hooks read it back under the same
 * strings, so both sides have to share one definition — and a server component cannot take it
 * from a hook module: every export of a `'use client'` module is a client reference, which
 * throws when it is called during the server render. Hence a directive-free lib module.
 * `hooks/use-admin-markets.ts` re-exports the two keys the admin screens already import from
 * it, so no admin import site moves. Key shapes follow PLAN 11.5.
 */

/**
 * The key roots. `['markets']` and `['market']` never match each other: react-query compares
 * keys element-wise (`partialMatchKey`), so the list and the detail can carry different
 * `structuralSharing` defaults without one registration swallowing the other.
 */
export const MARKETS_KEY = ['markets'] as const;
export const MARKET_KEY = ['market'] as const;
export const TICKS_KEY = ['ticks'] as const;
export const MARKET_FILLS_KEY = ['market-fills'] as const;
/**
 * 공개 호가 (#179, ADR-0114): `GET /markets/:id/book`, the same for every reader (no cookie), so
 * public and dehydratable. The detail's 호가창 reads it (`useOrderBook`, #122, ADR-0138) in the
 * browser only — the page seeds nothing under it — and the realtime provider restarts it on
 * `market:book` and `market:status` and on a resnapshot.
 */
export const MARKET_BOOK_KEY = ['market-book'] as const;
/** `_QUERY_KEY` rather than `_KEY` because the admin screens already import it under that name. */
export const CATEGORIES_QUERY_KEY = ['categories'] as const;
/**
 * Session-scoped, so never SSR'd (`PRIVATE_QUERY_ROOTS` below). They are declared here anyway
 * because the realtime provider refreshes them beside the market keys (`user:position`).
 */
export const POSITIONS_KEY = ['positions'] as const;
export const ORDERS_KEY = ['orders'] as const;

/**
 * 대기 주문과 주문 상세 (#123, ADR-0141): four shapes under `ORDERS_KEY`, so every duty that root
 * carries reaches them by prefix — `PRIVATE_QUERY_ROOTS`, SessionCacheGuard's reset, the
 * `user:position` re-read of `['orders']` and a reconnect's (realtime-provider.tsx). Each ends in
 * the account the screen shows (`Me`'s id, ADR-0091, as `searchHistoryKey`): an answer names no
 * owner and a cancel acts on the rows drawn, and `['me']` can turn from A to B in place before the
 * session does (ADR-0090 결정 4-2). Ids lower-cased like `marketKey`, so `/my/orders/<UPPER>` and
 * the answer's own id name one entry. `accountId` undefined: the query is off, nothing read.
 * The history's two lists under this root are below (`myOrderHistoryKey`, `myFillHistoryKey`).
 */
export const MY_ORDERS_LIVE_KEY = [...ORDERS_KEY, 'live'] as const;
export const MY_ORDER_DETAIL_KEY = [...ORDERS_KEY, 'detail'] as const;
export const MY_ORDER_FILLS_KEY = [...ORDERS_KEY, 'fills'] as const;
export const MY_MARKET_FILLS_KEY = [...ORDERS_KEY, 'market-fills'] as const;

/** `GET /me/orders?state=live`, every market's (`'all'`) or one market's. */
export const myOrdersLiveKey = (accountId: string | undefined, marketId?: string) =>
  [
    ...MY_ORDERS_LIVE_KEY,
    marketId === undefined ? 'all' : marketId.toLowerCase(),
    accountId,
  ] as const;

/**
 * The wallet's own reading of the account's live orders (#69, ADR-0144 결정 2-11): every market's
 * first page, as `myOrdersLiveKey(accountId)` reads it but 100 long (#302, ADR-0146), under a scope
 * of its own, so every duty `MY_ORDERS_LIVE_KEY` carries reaches it by prefix — a `market:book`
 * round, `market:status`, a reconnect, SessionCacheGuard's reset, the live lists' join — while the
 * `user:position` order restart leaves it out on screen and only marks it stale off screen
 * (`positionRestartsOrder`, market-live.ts): a fill already brings the lock with `user:balance`. A
 * fill in a market it does not hold reads it through the book round's window instead
 * (`walletMissesMarket`), so the wallet joins that market's room.
 */
export const walletLiveOrdersKey = (accountId: string | undefined) =>
  [...MY_ORDERS_LIVE_KEY, 'wallet', accountId] as const;

/** Whether `queryKey` is the wallet's live orders (`walletLiveOrdersKey`), of any account. */
export function isWalletLiveOrdersKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === ORDERS_KEY[0] && queryKey[1] === 'live' && queryKey[2] === 'wallet';
}

/** `GET /me/orders/:id`. */
export const myOrderKey = (orderId: string, accountId: string | undefined) =>
  [...MY_ORDER_DETAIL_KEY, orderId.toLowerCase(), accountId] as const;

/** `GET /me/fills?orderId=`: one order's fills, its own side only. */
export const myOrderFillsKey = (orderId: string, accountId: string | undefined) =>
  [...MY_ORDER_FILLS_KEY, orderId.toLowerCase(), accountId] as const;

/** `GET /me/fills?marketId=`: the account's fills on one market (상세의 내 거래). */
export const myMarketFillsKey = (marketId: string, accountId: string | undefined) =>
  [...MY_MARKET_FILLS_KEY, marketId.toLowerCase(), accountId] as const;

/**
 * 거래·정산 이력's 주문 and 체결 (#124, ADR-0143): two more shapes under `ORDERS_KEY`, so the
 * `user:position` re-read of `['orders']` (a trade wrote an order and its fills), a reconnect's and
 * an order's own answer reach them by prefix — and neither is the live list's nor a detail's, whose
 * joins (query-client.ts) never match them. The filters are one object (`marketsKey` says why) and
 * the account the screen shows is last, as above. MY's summary previews read the unfiltered entry
 * the tab holds, so a page size is never part of a key.
 */
export const MY_ORDER_HISTORY_KEY = [...ORDERS_KEY, 'history'] as const;
export const MY_FILL_HISTORY_KEY = [...ORDERS_KEY, 'history-fills'] as const;

/** The filters as a key holds them: what is on only, the market lower-cased like `marketKey`. */
function historyKeyFilters(filters: HistoryListFilters): HistoryListFilters {
  return {
    ...(filters.market === undefined ? {} : { market: filters.market.toLowerCase() }),
    ...(filters.period === undefined ? {} : { period: filters.period }),
  };
}

/** `GET /me/orders?state=ended`: the account's ended orders, those the filters leave. */
export const myOrderHistoryKey = (filters: HistoryListFilters, accountId: string | undefined) =>
  [...MY_ORDER_HISTORY_KEY, historyKeyFilters(filters), accountId] as const;

/** `GET /me/fills`: the account's fills, those the filters leave. */
export const myFillHistoryKey = (filters: HistoryListFilters, accountId: string | undefined) =>
  [...MY_FILL_HISTORY_KEY, historyKeyFilters(filters), accountId] as const;

/**
 * 정산 기록 (#124, ADR-0143; `GET /me/settlements`): the account's settlement records, private. A
 * root of its own, under neither of the two above: a settling `user:position` deliberately leaves
 * `['orders']` alone (`wroteAnOrder` — a settlement writes no order), so under it these would never
 * be read again when one lands; and every entry under `['positions']` is read as a `Position[]` by
 * the socket's handler and joined by row version (query-client.ts), which a page of records is not.
 */
export const SETTLEMENTS_KEY = ['settlements'] as const;

/** `GET /me/settlements`: the account's settlement records, those the filters leave. */
export const mySettlementsKey = (filters: HistoryListFilters, accountId: string | undefined) =>
  [...SETTLEMENTS_KEY, historyKeyFilters(filters), accountId] as const;

/**
 * 매도 가능액 (#179, `GET /me/markets/:id/sellable`): the caller's holding on one market, its
 * resting sells and the rest, read by the order panel (#66, ADR-0140). Owner only, so private.
 */
export const SELLABLE_KEY = ['sellable'] as const;

/**
 * 관심 시장 (#89, ADR-0064): the caller's watchlist, private like the two above — nobody but the
 * member sees it (#37), so it is never SSR'd and the detail's button draws no state in the HTML.
 * One root, two shapes under it: `['watchlist', 'pages', filters]` is MY's infinite list of
 * `MarketSummary` pages (the home grid's page shape, so the card and the realtime reducers serve
 * it), and `['watchlist', 'market', id, accountId]` is whether the caller watches one market. The
 * two never match each other's prefix, so the list's `structuralSharing` (query-client.ts) never
 * reaches a state (market-keys.test.ts pins it).
 */
export const WATCHLIST_KEY = ['watchlist'] as const;
export const WATCHLIST_PAGES_KEY = [...WATCHLIST_KEY, 'pages'] as const;

/**
 * The list's filters, which are its cache key as `MarketFilters` are the home's. MY asks for none
 * (`{}`: every public status, ended markets included, newest watch first — ADR-0061 decision 3);
 * the home's 관심 시장 view (#63, ADR-0065) asks for the open markets of its category in the order
 * picked (`watchlistViewFilters`, lib/home-view.ts).
 */
export interface WatchlistFilters {
  status?: PublicMarketStatus;
  category?: string;
  sort?: WatchlistSort;
}

export const watchlistPagesKey = (filters: WatchlistFilters) =>
  [...WATCHLIST_PAGES_KEY, filters] as const;

/**
 * One account's state of one market (`GET /me/watchlist/:id`), on the canonical lower-cased uuid
 * like `marketKey` (A-M3-29), under the account the screen shows — the `Me` it was drawn from
 * (ADR-0091). The answer names no owner, and a press sends the opposite of the state drawn: the
 * toggle has to draw the state of the account its press names, and an entry read for another one
 * — `['me']` turned from A to B in place, before the session did and so with no reset of
 * SessionCacheGuard's (ADR-0090 결정 4-2) — is not that state. `accountId` is undefined while that
 * account is not known: the query is disabled then, and nothing is read into the entry.
 */
export const watchStateKey = (marketId: string, accountId: string | undefined) =>
  [...WATCHLIST_KEY, 'market', marketId.toLowerCase(), accountId] as const;

/**
 * The status the home lists, always (ADR-0061 decision 1, item 13): open markets only, with no
 * status filter on the screen — the other statuses are the search screen's (#15). Sent by the
 * public list's query (`publicListQuery`, for its SSR prefetch and its queryFn) and by the 관심
 * 시장 view, never part of a key's choices.
 */
export const HOME_MARKET_STATUS = 'open' satisfies PublicMarketStatus;

/**
 * The public list's filter set, which IS its cache key. Normalised once, on the server
 * (`filtersFromSearchParams`), and handed to the client as a prop: two independent derivations
 * of the same `searchParams` would be one default away from a second cache entry, and the
 * second entry would refetch what the SSR payload already carries. No status: the home lists
 * `HOME_MARKET_STATUS` only (ADR-0065). No search term: search is a screen of its own
 * (`SearchFilters`, ADR-0066).
 *
 * `watchlist?: undefined` is what tells it apart from the 관심 시장 view (`HomeFilters`), whose
 * list is the caller's and so has no entry under this key at all.
 */
export interface MarketFilters {
  sort: MarketSort;
  category?: string;
  watchlist?: undefined;
}

export const DEFAULT_MARKET_FILTERS: MarketFilters = { sort: 'recommended' };

/** The query of one public list page, as `GET /markets` takes it (`publicListQuery`). */
export interface PublicListQuery {
  status: typeof HOME_MARKET_STATUS;
  sort: MarketSort;
  category?: string;
  cursor?: string;
}

/**
 * One page of the public list as `GET /markets` is asked for it, by the SSR prefetch
 * (`fetchMarketsPageServer`, api.server.ts) and by the client's queryFn (hooks/use-markets.ts)
 * alike — one spelling, so the two cannot drift, the way `watchlistViewFilters` is the 관심 시장
 * view's. The home's status always, the order picked always (the API's default is 추천 too, so a
 * request that lost its order would still answer, in the wrong order — market-keys.test.ts pins
 * every sort through), and the category and cursor only when there is one: the API's query
 * schema refuses a blank one. Never a search term: the home does not search (ADR-0066).
 */
export function publicListQuery(filters: MarketFilters, cursor?: string): PublicListQuery {
  return {
    status: HOME_MARKET_STATUS,
    sort: filters.sort,
    ...(filters.category === undefined ? {} : { category: filters.category }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/**
 * 시장 검색 (#15, ADR-0066): the search screen's results, under the public list's root so every
 * duty `['markets']` carries reaches them by prefix — the card join of query-client.ts (a late
 * answer never rolls a card back), the socket's `market:tick` and `market:status` writes and a
 * reconnect's re-read (realtime-provider.tsx). Never the home's entry: the second element is
 * this string, the home's is its filter object, and react-query compares keys element-wise.
 */
export const MARKET_SEARCH_KEY = [...MARKETS_KEY, 'search'] as const;

/**
 * The search screen's URL, normalised once on the server (`searchFiltersFromSearchParams`,
 * lib/market-search.ts) and handed to the client as a prop, as the home's filters are. `q` absent
 * is the screen with no search yet: the member's recent searches or a prompt (ADR-0061 decision
 * 3, the #15 rows), and no list at all. The status starts on every public status (`all`, decision
 * 1, item 13) and the order on 추천 (item 14, the home's orders).
 */
export interface SearchFilters {
  q?: string;
  status: MarketListStatus;
  sort: MarketSort;
  category?: string;
}

export const DEFAULT_SEARCH_FILTERS: SearchFilters = { status: 'all', sort: 'recommended' };

/** A search the screen lists: its filters with a term. The list's cache key. */
export type MarketSearch = SearchFilters & { q: string };

export const marketSearchKey = (search: MarketSearch) => [...MARKET_SEARCH_KEY, search] as const;

/** The query of one page of results, as `GET /markets` takes it (`searchListQuery`). */
export interface SearchListQuery {
  status: MarketListStatus;
  sort: MarketSort;
  q: string;
  category?: string;
  cursor?: string;
}

/**
 * One page of results as `GET /markets` is asked for it. The status and the order are always
 * written out — the API's own default status is the home's `open`, so a search that lost its
 * status would quietly hide every ended market — and the category and cursor only when there is
 * one. Pinned per status and order by market-keys.test.ts, as `publicListQuery` is.
 */
export function searchListQuery(search: MarketSearch, cursor?: string): SearchListQuery {
  return {
    status: search.status,
    sort: search.sort,
    q: search.q,
    ...(search.category === undefined ? {} : { category: search.category }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/**
 * 관련 시장 (#65, ADR-0068): a detail's related markets, `GET /markets/:id/related`, under the
 * public list's root like the search's results — so every duty `['markets']` carries reaches them
 * by prefix: the card join of query-client.ts, the socket's `market:tick` and `market:status`
 * writes into the cards, and a reconnect's re-read (realtime-provider.tsx). Public (ADR-0061
 * decision 1, item 18): the detail page reads its first page on the server. The market is the
 * canonical lower-cased uuid, like `marketKey`; the second element is this string, never a filter
 * object, so it never matches the home's or the search's entries.
 */
export const MARKET_RELATED_KEY = [...MARKETS_KEY, 'related'] as const;

export const relatedMarketsKey = (marketId: string) =>
  [...MARKET_RELATED_KEY, marketId.toLowerCase()] as const;

/**
 * One page of a detail's related markets as `GET /markets/:id/related` is asked for it, by the
 * SSR prefetch (`fetchRelatedMarketsPageServer`) and the client's queryFn alike: the cursor only
 * when there is one, and no order — the owner fixed it to 추천 (ADR-0061 decision 1, item 19).
 */
export function relatedMarketsQuery(cursor?: string): { cursor?: string } {
  return cursor === undefined ? {} : { cursor };
}

/**
 * 최근 검색 (#15, ADR-0066): the caller's recent searches, the member's own (ADR-0061 decision 3:
 * shown to the member) and read with the member's cookie, so the root is in `PRIVATE_QUERY_ROOTS`:
 * never fetched on the server, never dehydrated. SessionCacheGuard resets it on an account change.
 */
export const SEARCH_HISTORY_KEY = ['search-history'] as const;

/**
 * The recent searches of the account the screen shows — the `Me` it was drawn from (ADR-0091).
 * The answer names no owner, and the deletes act on the list drawn (the entry picked, every entry
 * for 전체 삭제): the list has to be the one of the account they name, and an entry read for
 * another one — `['me']` turned from A to B in place, before the session did and so with no reset
 * of SessionCacheGuard's (ADR-0090 결정 4-2) — is not that list. `accountId` is undefined while
 * that account is not known: the read is disabled then, and nothing is read into the entry.
 */
export const searchHistoryKey = (accountId: string | undefined) =>
  [...SEARCH_HISTORY_KEY, accountId] as const;

/**
 * The home's 관심 시장 view (#63, ADR-0065): the caller's watched open markets, of the category
 * the URL names if any, in the order picked — 최근 관심 등록 순 unless another is (ADR-0061
 * decision 3, the #63 row). No `q`: the watchlist has no title search, and the header's search
 * goes to the search screen (`/search`, ADR-0066).
 */
export interface WatchlistViewFilters {
  watchlist: true;
  sort: WatchlistSort;
  category?: string;
}

export const DEFAULT_WATCHLIST_VIEW_SORT = 'watched' satisfies WatchlistSort;

/**
 * The URL that turns the view on: `?watchlist=1`, and no other value (`filtersFromSearchParams`).
 * A word of the URL, not of an API answer — the `watchlist` item of PRIVATE_DATA keeps public
 * response fields from naming a watchlist; the page address names the caller's own view.
 */
export const WATCHLIST_VIEW_PARAM = 'watchlist';
export const WATCHLIST_VIEW_PARAM_VALUE = '1';

/** What the home's URL normalises to (`filtersFromSearchParams`): one of the two views. */
export type HomeFilters = MarketFilters | WatchlistViewFilters;

/**
 * `hashKey` sorts a plain object's keys and `JSON.stringify` drops undefined-valued properties
 * (query-core `utils.ts`), so field order here is irrelevant and an absent `category` hashes
 * identically to `category: undefined`. The filters travel as one object rather than as
 * positional segments so a new filter cannot silently reorder every existing key.
 */
export const marketsKey = (filters: MarketFilters) => [...MARKETS_KEY, filters] as const;

/**
 * The detail key, always on the row's canonical lower-cased uuid and never on the slug
 * (A-M3-29).
 *
 * `uuidSchema` lower-cases every request-supplied uuid, so the API answers with the row's own
 * lower-case id. A screen keyed on the URL segment as typed would hold a row whose `market.id`
 * names a different key, and every write that goes through that id — a `market:tick`, an
 * invalidation — would land on a key nothing on the screen reads. The slug is worse still: the
 * ticks and fills routes both speak uuids, so a slug-keyed entry would never be written to by
 * the live path at all.
 */
export const marketKey = (marketId: string) => [...MARKET_KEY, marketId.toLowerCase()] as const;

/**
 * `range` is a token ('1D'), never a timestamp: a refetch under the same key reads a fresh
 * window from the server, which is what keeps the chart's right edge live.
 */
export const ticksKey = (marketId: string, range: TickRange) =>
  [...TICKS_KEY, marketId, range] as const;

export const marketFillsKey = (marketId: string) => [...MARKET_FILLS_KEY, marketId] as const;

/**
 * One market's public book, on the canonical lower-cased uuid like `marketKey`: the
 * `market:book` signal names the row's own id, and a key on the id as typed would never be
 * restarted by it.
 */
export const marketBookKey = (marketId: string) =>
  [...MARKET_BOOK_KEY, marketId.toLowerCase()] as const;

/**
 * One market's 매도 가능액, on the canonical lower-cased uuid like `marketKey`: the prefix every
 * read again (`user:position`, an order's end) invalidates, whoever's entry is under it.
 */
export const marketSellableKey = (marketId: string) =>
  [...SELLABLE_KEY, marketId.toLowerCase()] as const;

/**
 * The 매도 가능액 entry of one account on one market, under `marketSellableKey`: the account the
 * screen shows (`Me`'s id), like `watchStateKey`. The answer names no owner, and `['me']` can turn
 * from A to B in place before the session does — and so before SessionCacheGuard's reset (ADR-0090
 * 결정 4-2) — so an entry read for A is never drawn as B's holding (ADR-0140 결정 2-22).
 * `accountId` is undefined while that account is not known: the query is disabled then.
 */
export const sellableKey = (marketId: string, accountId: string | undefined) =>
  [...marketSellableKey(marketId), accountId] as const;

/**
 * Key roots that need the session cookie. They are never fetched on the server (`api.server.ts`
 * forwards no cookie), and this is the second lock: `dehydrate` serialises the WHOLE
 * per-request client (`getQueryCache().getAll()`), so a `['me']` that got in would ride the RSC
 * payload into the HTML and refill exactly the cache the session guard exists to empty — with
 * no ordering key on `Balance` to tell that stale payload from a fresh client answer.
 */
export const PRIVATE_QUERY_ROOTS: ReadonlySet<string> = new Set([
  'me',
  'positions',
  'orders',
  'ledger',
  'reconciliation-corrections',
  'payments',
  'charge-packages',
  'admin',
  'watchlist',
  'search-history',
  // 좋아요 (#49, ADR-0076): what the reader liked on a post page (`LIKES_KEY`, lib/likes.ts). The
  // counts are public and ride on the post and its comments; whose like is nobody else's.
  'likes',
  // MY '내 글' (#51, ADR-0080): the member's own posts and comments with the hidden ones and their
  // reasons (`MY_AUTHORED_KEY`, lib/authored.ts). A profile's lists are public (`['authored']`).
  'my-authored',
  // 조치·신고 내역 (#50, ADR-0081): the member's own reports and the actions taken on them
  // (`MY_MODERATION_KEY`, lib/moderation.ts) — theirs and operators' alone (PRIVATE_DATA `reports`,
  // `moderation`). The operators' reads are under `admin`.
  'my-moderation',
  // 내 제안 (#77, ADR-0089): only the proposer and the operators see a proposal (ADR-0069
  // decision 4), read with the member's cookie (lib/proposals.ts `PROPOSALS_KEY`).
  'proposals',
  // 판정 이의 (#175, ADR-0104): the member's own disputes and standing on a market — the links and
  // the reason are the submitter's and the operators' alone (#173 item 13, PRIVATE_DATA `dispute`),
  // read with the member's cookie (lib/disputes.ts `DISPUTES_KEY`). The operators' under `admin`.
  'disputes',
  // 매도 가능액 (#66, ADR-0140): the caller's holding and resting sells on one market, read with
  // the member's cookie (`SELLABLE_KEY`) for the order panel.
  'sellable',
  // 정산 기록 (#124, ADR-0143): the account's settlement records (`SETTLEMENTS_KEY`) — what it held
  // and was paid, nobody else's to see (N04 §7). The history's orders and fills are under 'orders'.
  'settlements',
]);

export function isPrivateQueryKey(queryKey: readonly unknown[]): boolean {
  const [root] = queryKey;
  return typeof root === 'string' && PRIVATE_QUERY_ROOTS.has(root);
}

/** `dehydrate` for an SSR page: successful PUBLIC queries only. */
export function dehydratePublic(queryClient: QueryClient) {
  return dehydrate(queryClient, {
    shouldDehydrateQuery: (query) =>
      defaultShouldDehydrateQuery(query) && !isPrivateQueryKey(query.queryKey),
  });
}
