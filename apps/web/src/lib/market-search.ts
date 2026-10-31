import {
  ALL_MARKET_STATUSES,
  MARKET_SEARCH_TERM_MAX,
  PUBLIC_MARKET_STATUSES,
  type MarketListStatus,
  marketListQuerySchema,
  marketListStatusSchema,
  marketSearchTermSchema,
  marketSortSchema,
} from '@buddha/shared';
import { copy } from '@/copy';
import { isApiUnreachable } from './api';
import { type CategoryNode, locateCategory } from './category-tree';
import { MARKET_STATUS_LABEL } from './market-admin';
import { DEFAULT_SEARCH_FILTERS, type MarketSearch, type SearchFilters } from './market-keys';
import { type MarketPages } from './market-live';
import { firstValue } from './market-ssr';

/**
 * 시장 검색 (#15, ADR-0066): the search screen's URL and the decisions it draws from, as pure
 * functions the node test runner reaches (the rule `market-ssr.ts` states). Owner decisions
 * (ADR-0061): the results are a screen of their own (decision 1, item 14) sorted as the home is
 * (추천 · 신규 · 마감 임박, 추천 first) and matched on the title — or, since #17, on a tag named
 * exactly the term (ADR-0061 result 3, ADR-0066 result 3); the status filter starts on every
 * public status and offers '모든 상태' and one choice per status label (item 13); the search is
 * public (item 18); a signed-in member's submitted term is recorded, and with no term the screen
 * shows the member's recent searches, or a prompt to a visitor (decision 3, the #15 rows).
 */

/** The search screen's address. Its folder (`app/search`) passes the route guard. */
export const SEARCH_PATH = '/search';

/**
 * The `maxLength` of both search boxes (the header's and the screen's), and of the admin 관련 시장
 * picker's box, whose term is the admin list's `q` (#65, ADR-0068): the API's bound on a
 * term. Without it, a longer term (a pasted market title runs to `MARKET_TITLE_MAX`, 120) would
 * read as no term — the screen would answer a search just typed with its prompt, or with the
 * member's recent searches, and record nothing. A browser counts `maxLength` in UTF-16 units and
 * zod counts code points, so the box is never looser than the schema: whatever it holds, trimmed,
 * is a term (market-search.test.ts). A longer `q` typed into the address still reads as none.
 */
export const SEARCH_INPUT_MAX_LENGTH = MARKET_SEARCH_TERM_MAX;

/** The search page's raw `searchParams` (a repeated param arrives as an array). */
export interface SearchSearchParams {
  q?: string | string[];
  status?: string | string[];
  sort?: string | string[];
  category?: string | string[];
}

/** `q` and `category` are normalised by the API's own query schema, never by a local copy. */
const { category: categoryParam, q: qParam } = marketListQuerySchema.shape;

/** The term as the list reads it: the API's own rule, and no NUL, which the API refuses (400). */
function searchTerm(value: string | undefined): string | undefined {
  const parsed = qParam.safeParse(value);
  return parsed.success && parsed.data !== undefined && !parsed.data.includes('\u0000')
    ? parsed.data
    : undefined;
}

/**
 * Normalises the search screen's URL into the filters that are its list's cache key, once, on
 * the server, as `filtersFromSearchParams` does for the home. Nothing throws and nothing
 * redirects: a value the screen cannot show is dropped and the default stands — every public
 * status (`all`), 추천, no category. A blank, over-long or NUL term is no term, so the screen
 * shows what it shows with none. `?status=draft` or `?status=review` is not a public status, and
 * a bookmarked `?status=voided` names a status that is gone (#174): each falls back to all;
 * `?status=open` and the eight other public statuses are the filter's choices.
 */
export function searchFiltersFromSearchParams(searchParams: SearchSearchParams): SearchFilters {
  const q = searchTerm(firstValue(searchParams.q));
  const status = marketListStatusSchema.safeParse(firstValue(searchParams.status));
  const sort = marketSortSchema.safeParse(firstValue(searchParams.sort));
  const category = categoryParam.safeParse(firstValue(searchParams.category));
  return {
    status: status.success ? status.data : DEFAULT_SEARCH_FILTERS.status,
    sort: sort.success ? sort.data : DEFAULT_SEARCH_FILTERS.sort,
    ...(q === undefined ? {} : { q }),
    ...(category.success && category.data !== undefined ? { category: category.data } : {}),
  };
}

/** Whether the URL holds a term, which is when the screen lists results. */
export function isMarketSearch(filters: SearchFilters): filters is MarketSearch {
  return filters.q !== undefined;
}

/**
 * The filters as a query string with every default left out (every status, 추천), so a bare
 * search is `/search?q=…` and a shared link carries only what was picked. The defaults are
 * exactly what `searchFiltersFromSearchParams` falls back to, so dropping them is safe.
 */
export function searchQuery(filters: SearchFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.q !== undefined) query.q = filters.q;
  if (filters.status !== DEFAULT_SEARCH_FILTERS.status) query.status = filters.status;
  if (filters.category !== undefined) query.category = filters.category;
  if (filters.sort !== DEFAULT_SEARCH_FILTERS.sort) query.sort = filters.sort;
  return query;
}

/** `searchQuery` as a path: `/search` or `/search?…`. */
export function searchPath(filters: SearchFilters): string {
  const search = new URLSearchParams(searchQuery(filters)).toString();
  return search === '' ? SEARCH_PATH : `${SEARCH_PATH}?${search}`;
}

/**
 * A tag's own search (#17, ADR-0093 decision 2 #172 item 2): the detail's '#이름' chip links here —
 * the term is the tag's name as stored, and every other filter is the screen's default, so it
 * lists every public market carrying that tag (and any whose title holds the name). Opened by its
 * address, it is not recorded in the reader's recent searches (ADR-0066, `searchToRecord`).
 */
export function tagSearchPath(name: string): string {
  return searchPath({ ...DEFAULT_SEARCH_FILTERS, q: name });
}

/**
 * The fields the screen's own search box submits beside its term: the filters picked, so a new
 * term is searched within them (the screen's box refines; the header's starts afresh). The same
 * defaults are left out, and the box's own `q` is the field the visitor types.
 */
export function searchFormFields(filters: SearchFilters): [string, string][] {
  return Object.entries(searchQuery({ ...filters, q: undefined }));
}

/**
 * A recent search as a link: that term within the filters on screen. A recent search is a term
 * only — the filters were never recorded (ADR-0061 decision 3) — so it keeps what is picked now.
 */
export function recentSearchPath(filters: SearchFilters, query: string): string {
  return searchPath({ ...filters, q: query });
}

/**
 * The status select's choices, in order (ADR-0061 decision 1, item 13): '모든 상태', then one per
 * public status in the order the statuses go, labelled as the status badge is
 * (`MARKET_STATUS_LABEL`): 개장 예정 through 지급 완료, and 취소 (ADR-0093 decision 3, the #174
 * row). Every public status has a label of its own, so one per status is one per label. A result
 * (무효) and a display ('판정 지연') are not statuses and get no choice; grouping the choices is
 * #60·#15's.
 */
export function searchStatusOptions(): readonly { value: MarketListStatus; label: string }[] {
  return [
    { value: ALL_MARKET_STATUSES, label: copy.searchStatusAll },
    ...PUBLIC_MARKET_STATUSES.map((status) => ({
      value: status,
      label: MARKET_STATUS_LABEL[status],
    })),
  ];
}

/** One `<optgroup>` of the category select: a top-level category, itself first, then its leaves. */
export interface CategoryOptionGroup {
  label: string;
  options: { value: string; label: string }[];
}

/**
 * The category select's choices beyond '모든 카테고리': one group per top-level category, whose
 * first option is the category itself — every market under it, as a top-level slug filters on
 * `GET /markets` — and then its leaves, in the API's display order. A slug the tree does not know
 * (a retired category, a link typed by hand) still filters the list, so it is offered as it is
 * (`unlisted`) rather than letting the select claim '모든 카테고리' over a filtered list.
 */
export function searchCategoryOptions(
  tree: readonly CategoryNode[],
  selected: string | undefined,
): { groups: CategoryOptionGroup[]; unlisted: string | undefined } {
  return {
    groups: tree.map((node) => ({
      label: node.category.nameKo,
      options: [
        { value: node.category.slug, label: `${node.category.nameKo} ${copy.marketsAll}` },
        ...node.children.map((leaf) => ({ value: leaf.slug, label: leaf.nameKo })),
      ],
    })),
    unlisted:
      selected !== undefined && locateCategory(tree, selected) === undefined ? selected : undefined,
  };
}

/** What the screen draws under its controls. */
export type SearchScreenBody = 'results' | 'pending' | 'recent' | 'prompt';

/**
 * With a term, the results — for anyone, signed in or not (the search is public). With none, the
 * member's own recent searches, or a prompt to type a term for a visitor (ADR-0061 decision 3, the
 * #15 rows) — and, until the session is known (the server render and hydration), a placeholder,
 * so the HTML is the same for every visitor and names nobody's searches.
 */
export function searchScreenBody(
  filters: SearchFilters,
  session: { pending: boolean; signedIn: boolean },
): SearchScreenBody {
  if (isMarketSearch(filters)) return 'results';
  if (session.pending) return 'pending';
  return session.signedIn ? 'recent' : 'prompt';
}

/**
 * What a submitted search box records (`POST /me/search-history`), or `undefined` for nothing:
 * the term trimmed and bounded as `GET /markets?q=` takes it, by a signed-in member — the account
 * the screen shows is `accountId` (its `Me`'s id, ADR-0091), sent as `expectedAccountId` — and
 * nothing for a visitor, an account not yet known, or a blank, over-long or NUL term (ADR-0061
 * decision 3: a signed-out search is not recorded; a term the list would not search is not a
 * search). A SUBMIT asks this, and so does a recent search picked from the list, with its stored
 * term — a new search of it, so it moves to the top (owner decision 2026-10-16, ADR-0066). A
 * filter, an order, a page of the same search or a search opened by its address records nothing
 * (ADR-0066).
 */
export function searchToRecord(
  raw: unknown,
  accountId: string | undefined,
): { query: string; expectedAccountId: string } | undefined {
  if (accountId === undefined) return undefined;
  const term = marketSearchTermSchema.safeParse(raw);
  if (!term.success || term.data.includes('\u0000')) return undefined;
  return { query: term.data, expectedAccountId: accountId };
}

/**
 * Whose draft a search box holds (nav.tsx `SearchForm`, the search screen's `SearchBox`, kept by
 * `useSearchBoxTurn`): the last account known on screen — the `Me` a submit records the term for
 * (`searchToRecord`) — and how many times, since the box was drawn, the known account turned into
 * another one. The turn keys the box's field (`searchBoxKey`).
 */
export interface SearchBoxOwner {
  /** The last account known; `undefined` until the tab has known one. */
  accountId: string | undefined;
  /** How many times the known account turned into another since the box was drawn. */
  turn: number;
}

/**
 * The owner once `accountId` — the `Me` on screen, `undefined` for a visitor and while `GET /me`
 * has not answered — is drawn (ADR-0091, owner decision 2026-10-26 «첫 답 전에 친 글자는 남김»):
 *
 * - the same owner, the very object, while it is that account or nobody is known (`GET /me`
 *   pending or failed, SessionCacheGuard's reset, a sign-out): nothing to clear;
 * - that account on the same turn when it is the first one known — `GET /me`'s first answer: a term
 *   typed before it stays in the box, and is that account's;
 * - that account on the next turn when another one was known before, even with nobody known in
 *   between (the reset puts `['me']` back to nothing before B's answer comes): a draft typed for A
 *   is never submitted for B. `['me']` can turn from A to B under a box that stays mounted — in
 *   place, before the session does (ADR-0090 결정 4-2), or through SessionCacheGuard's reset — and
 *   B's record would take A's draft with B's cookie.
 */
export function searchBoxOwner(
  owner: SearchBoxOwner,
  accountId: string | undefined,
): SearchBoxOwner {
  if (accountId === undefined || accountId === owner.accountId) return owner;
  return { accountId, turn: owner.accountId === undefined ? owner.turn : owner.turn + 1 };
}

/**
 * The key of a search box's field: the term the URL carries and the box's turn (`searchBoxOwner`),
 * so the box starts again — on the URL's term — when either changes, and keeps what is typed
 * otherwise. One key for each pair: a turn holds no '|', so the first one splits them.
 */
export function searchBoxKey(turn: number, term: string | undefined): string {
  return `${String(turn)}|${term ?? ''}`;
}

/**
 * Whether the server's read of a search's first page goes into the HTML (owner decision
 * 2026-10-16, ADR-0066: "서버가 첫 페이지도 그린다", so a visitor without JavaScript sees the
 * results): only an answer that holds a card. A failed read is never there — `dehydratePublic`
 * keeps successful queries only — and an empty answer is left out too, so that loading, '검색 결과가
 * 없습니다.' and a failure stay three states the BROWSER tells apart, from its own read, with its own
 * 다시 시도 (N02 §3): the HTML of a search is either its cards or the skeleton, never an empty
 * state or an error the server decided. `undefined` is a read that did not answer.
 */
export function seedsSearchResults(data: MarketPages | undefined): boolean {
  return (data?.pages[0]?.items.length ?? 0) > 0;
}

/**
 * The results' first-load failure, said so it is never read as 'no results' (N02 §3): a request
 * that never reached the API (`isApiUnreachable`) — the browser offline, or the API down, which
 * the browser sees as the rewrite proxy's own 500 since it asks the web origin — is '서버에 연결할
 * 수 없습니다.', and an error the API answered is the general one. Both come with 다시 시도.
 */
export function searchErrorMessage(error: unknown): string {
  return isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown;
}
