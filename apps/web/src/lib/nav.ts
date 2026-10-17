import { marketListQuerySchema } from '@buddha/shared';
import type { Route } from 'next';
import { copy } from '@/copy';
import { type CategoryNode, locateCategory } from './category-tree';
import { filterQuery, isWatchlistView } from './home-view';
import { DEFAULT_MARKET_FILTERS, type HomeFilters, WATCHLIST_VIEW_PARAM } from './market-keys';
import { SEARCH_PATH, searchFiltersFromSearchParams } from './market-search';
import { filtersFromSearchParams } from './market-ssr';
import { MY_PATH } from './my';

/**
 * Which top-level area and which header item is the page being shown. Pure functions of the URL,
 * kept out of `components/layout/nav.tsx` and `bottom-tabs.tsx` so they can be tested without a
 * DOM. Every answer here ends up as `aria-current="page"` on a link, never as a colour alone
 * (PLAN 11.2).
 */

/** The three top-level areas (N02 §2, #16): 시장 탐색 · 커뮤니티 · MY. */
export type PrimaryNavKey = 'markets' | 'community' | 'my';

/**
 * The areas in order, as the desktop header's row 1 and the mobile tab bar both list them — one
 * list, so the two cannot drift apart (#16: every width reaches the same three areas). MY is
 * listed only for a signed-in reader (owner decision 2026-10-13); a visitor who types a MY
 * address is sent to the login page by MY's session gate. 시장 탐색 stays at `/`. Next 16 types
 * `href`, so the list is declared as routes rather than plain strings.
 */
const PRIMARY_NAV: readonly {
  key: PrimaryNavKey;
  href: Route;
  label: string;
  signedInOnly: boolean;
}[] = [
  { key: 'markets', href: '/', label: copy.navExplore, signedInOnly: false },
  { key: 'community', href: '/community', label: copy.navCommunity, signedInOnly: false },
  { key: 'my', href: MY_PATH, label: copy.navMy, signedInOnly: true },
];

export function primaryNavItems(
  signedIn: boolean,
): readonly { key: PrimaryNavKey; href: Route; label: string }[] {
  return PRIMARY_NAV.filter((item) => signedIn || !item.signedInOnly);
}

/**
 * The header's height in CSS px where it has both rows: Kalshi's measured 107 (12 + 40 + 12 for
 * row 1, 30 + 12 for row 2, the 1px rule), which `nav.tsx` is built to. Row 2 is drawn on the
 * home list and the market details only (`showsCategoryRow`), and so is everything that sticks
 * under the header — the home screen's sidebar and the detail screen's 주문 영역, both of which
 * have to stop exactly under it, and a drift shows as a column sliding under the header.
 * Elsewhere (the search screen included) the header is row 1 and its rule (65px) with nothing
 * sticky beneath it; a sticky element added there needs that height, not this one. It is the same on every breakpoint (row 1 keeps its 40px without the
 * primary links) and grows only while the mobile search form is open, when nothing is sticky
 * beneath it.
 */
export const HEADER_HEIGHT_PX = 107;

/**
 * The resting opacity of row 2's inactive category items. Kalshi rests them at 0.5, which puts
 * 15px text at 3.74:1 on the light page (`fg` is gray.950, #09090b, not black) — under the
 * 4.5:1 WCAG 1.4.3 asks of text and the theme file otherwise measures (AC 6). 0.6 is the first
 * tenth that clears it in both modes (light 5.32:1, dark 7.03:1 on `#0a0c0f`), pinned in
 * theme/contrast.test.ts; the difference from Kalshi's value is not visible side by side.
 */
export const CATEGORY_ITEM_OPACITY = 0.6;

function isUnder(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

/** The home list and every market detail under it: where the header's row 2 is drawn. */
function isMarketsBrowse(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/markets/');
}

/**
 * Whether an area is the page being shown, for the header's row 1 and the tab bar alike.
 * 시장 탐색 owns the home list AND every market detail — `/markets/<slug>` is a market, and a
 * visitor who opened one is still "in the markets" the way Kalshi keeps its Markets item lit on
 * an event page — and the search screen (`/search`, owner decision 2026-10-16, ADR-0066: "시장
 * 탐색을 켠다"), whose results are markets too; not a look-alike (`/searches`). 커뮤니티 and MY
 * match their own route and its subtree — every MY tab keeps MY lit — but not a look-alike
 * prefix (`/communityx`, `/mysterious`).
 */
export function isPrimaryCurrent(pathname: string, key: PrimaryNavKey): boolean {
  switch (key) {
    case 'markets':
      return isMarketsBrowse(pathname) || pathname === SEARCH_PATH;
    case 'community':
      return isUnder(pathname, '/community');
    case 'my':
      return isUnder(pathname, MY_PATH);
  }
}

/**
 * Whether the header draws row 2, 전체 and the top-level categories (owner decision 2026-10-13):
 * on the home list it filters and the market details under it — and not on the search screen,
 * although 시장 탐색 is lit there (`isPrimaryCurrent`; the screen has a category filter of its
 * own, ADR-0066), nor on 커뮤니티, MY, the auth and legal pages or /admin.
 */
export function showsCategoryRow(pathname: string): boolean {
  return isMarketsBrowse(pathname);
}

/**
 * The `?category=` value AS THE LIST READS IT. The home page normalises its URL with the API's
 * own query schema (`filtersFromSearchParams`, lib/market-ssr.ts) and drops a value the schema
 * refuses — blank, whitespace, over-long — so the list is then unfiltered. The header's notion
 * of "no filter" has to be the same one, or `?category=` (blank) would show every market under
 * a row that marks nothing as current. Taken from the schema, never re-implemented.
 */
const categoryParam = marketListQuerySchema.shape.category;

function filteredCategory(category: string | null | undefined): string | undefined {
  const parsed = categoryParam.safeParse(category ?? undefined);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Whether 전체, the first item of row 2, is the page being shown: the home list with no category
 * filter. Only the home route can light anything in row 2 — the row is also drawn on a market
 * detail, but a `?category=` there filters nothing, and a lit 전체 over one market would claim
 * the visitor is looking at a list they are not.
 */
export function isAllCategoriesCurrent(
  pathname: string,
  category: string | null | undefined,
): boolean {
  return pathname === '/' && filteredCategory(category) === undefined;
}

/**
 * The top-level category the home list is filtered on, or `undefined` when nothing in row 2 is
 * current: another route, no filter (that is 전체's case above), or a slug the tree does not know.
 *
 * A LEAF slug lights its parent: `?category=housing` lists housing markets, which are economy
 * markets, and row 2 only shows the top level — the leaf itself is marked in the home screen's
 * own sidebar. An unknown slug (a link typed by hand, a category retired since it was shared)
 * lights nothing: the list is filtered on it and answers its own empty state, and 전체 is not
 * what is showing either.
 */
export function currentTopLevelSlug(
  pathname: string,
  tree: readonly CategoryNode[],
  category: string | null | undefined,
): string | undefined {
  if (pathname !== '/') return undefined;
  return locateCategory(tree, filteredCategory(category))?.parent.category.slug;
}

/** What `useSearchParams()` hands the header: the URL's query, read one name at a time. */
export interface UrlSearchParams {
  get(name: string): string | null;
}

/**
 * The home's filters AS THE LIST READS THEM, from the URL the header sees: the page's own
 * normalisation (`filtersFromSearchParams`, the function the page builds its list from), never a
 * copy of it. `get` answers a repeated param with its first value, which is the value
 * `filtersFromSearchParams` keeps of the array the page receives, so the two agree on that too.
 * Only meaningful on `/`; the callers check the route first.
 */
function homeFiltersOf(searchParams: UrlSearchParams): HomeFilters {
  const value = (name: string) => searchParams.get(name) ?? undefined;
  return filtersFromSearchParams({
    sort: value('sort'),
    category: value('category'),
    [WATCHLIST_VIEW_PARAM]: value(WATCHLIST_VIEW_PARAM),
  });
}

/**
 * The term AS THE SEARCH SCREEN READS IT, for the header's search box: the term the results on
 * screen are for, or `undefined` when there is none — or when the visitor is not on the search
 * screen (`/search`, ADR-0066), where a `q` in the URL searches nothing (the home has not read
 * `q` since search moved off it) and a box that still showed it would describe results that are
 * not on screen. Read off the screen's own normalisation (`searchFiltersFromSearchParams`): blank
 * and whitespace-only are "no search", over-long is dropped. The box and the results then agree
 * on what was searched. This is what the box's `key`/`defaultValue` follow (nav.tsx `SearchForm`).
 */
export function currentSearchTerm(
  pathname: string,
  searchParams: UrlSearchParams,
): string | undefined {
  if (pathname !== SEARCH_PATH) return undefined;
  return searchFiltersFromSearchParams({ q: searchParams.get('q') ?? undefined }).q;
}

/**
 * The query a row-2 item links to: `slug` for a top-level category, `undefined` for 전체. Next's
 * `href` takes it as `{ pathname: '/', query }`.
 *
 * Outside the 관심 시장 view it is a fresh `?category=` (전체: a bare `/`), as the header has
 * always posted (ADR-0041): row 2 is drawn on every 시장 탐색 route, so it is a way INTO the
 * list, not a refinement of one the visitor may not be looking at — a sort in the URL is left
 * behind.
 *
 * In the view (`/?watchlist=1`) it moves the view to that category and keeps it on, in the order
 * picked (owner decision 2026-10-16, ADR-0065: "켜 둔 채로 옮긴다") — from
 * `/?sort=newest&watchlist=1`, 경제 is `/?category=economy&sort=newest&watchlist=1` and 전체 is
 * the URL itself. The view's own default order is left out of the URL as everywhere
 * (`filterQuery`).
 *
 * A pure function of the route and the URL, never of the session: the header renders into every
 * visitor's HTML from the URL alone, so a member and a visitor who open the same address get the
 * same links (a signed-out visitor in the view is shown the sign-in prompt by the list, which a
 * category change keeps).
 */
export function categoryLinkQuery(
  pathname: string,
  searchParams: UrlSearchParams,
  slug: string | undefined,
): Record<string, string> {
  const category = slug === undefined ? {} : { category: slug };
  const filters = pathname === '/' ? homeFiltersOf(searchParams) : DEFAULT_MARKET_FILTERS;
  if (isWatchlistView(filters)) {
    return filterQuery({ watchlist: true, sort: filters.sort, ...category });
  }
  return filterQuery({ ...DEFAULT_MARKET_FILTERS, ...category });
}
