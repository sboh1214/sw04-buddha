import { MARKET_SORTS, type WatchlistSort } from '@buddha/shared';
import { copy } from '@/copy';
import { type CategoryNode, locateCategory } from './category-tree';
import {
  DEFAULT_MARKET_FILTERS,
  DEFAULT_WATCHLIST_VIEW_SORT,
  HOME_MARKET_STATUS,
  type HomeFilters,
  WATCHLIST_VIEW_PARAM,
  WATCHLIST_VIEW_PARAM_VALUE,
  type WatchlistFilters,
  type WatchlistViewFilters,
} from './market-keys';
import { loginPathBackToPage } from './next-path';

/**
 * The home screen's derived VIEW (ADR-0041, Kalshi's category page): what the headline says and
 * which rows the sub-category sidebar shows for a given URL. Pure functions of the category tree
 * and the normalised filters, kept out of the components so they can be tested without a DOM —
 * the same split `category-tree.ts` and `market-ssr.ts` make. No `'use client'`: nothing here
 * touches React, and a server component may import it.
 */

/** Whether the URL picked the 관심 시장 view (ADR-0065) rather than the public list. */
export function isWatchlistView(filters: HomeFilters): filters is WatchlistViewFilters {
  return filters.watchlist === true;
}

/**
 * The filters as a query string, with everything that equals the default left out — so the
 * default view's URL is a bare `/` and a shared link carries only what was actually chosen.
 * Dropping them is safe in both directions: `filtersFromSearchParams` falls back to exactly these
 * defaults for a missing param. The sort's default is the view's own: 추천 on the public list,
 * 최근 관심 등록 순 in the 관심 시장 view (`?watchlist=1`, ADR-0061 decision 3, the #63 row).
 *
 * Lived in `app/market-filters.tsx` until the sidebar needed it too; this module is the one
 * home-screen helper both components import, and the one place the decision is tested.
 */
export function filterQuery(filters: HomeFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.category !== undefined) query.category = filters.category;
  if (isWatchlistView(filters)) {
    if (filters.sort !== DEFAULT_WATCHLIST_VIEW_SORT) query.sort = filters.sort;
    query[WATCHLIST_VIEW_PARAM] = WATCHLIST_VIEW_PARAM_VALUE;
    return query;
  }
  if (filters.sort !== DEFAULT_MARKET_FILTERS.sort) query.sort = filters.sort;
  return query;
}

/** `filterQuery` as the path `router.push` and a login `next` take: `/` or `/?…`. */
export function homePath(filters: HomeFilters): string {
  const search = new URLSearchParams(filterQuery(filters)).toString();
  return search === '' ? '/' : `/?${search}`;
}

/**
 * The sort select's options, in order: 추천 · 신규 · 마감 임박 on the public list (ADR-0061
 * decision 1, items 9–11), and in the 관심 시장 view, the one view that has it, 최근 관심 등록 순
 * after them — last (owner decision 2026-10-16, ADR-0065: "맨 뒤"), although it is the order the
 * view starts on (decision 3, the #63 row). The three public orders keep their places in both.
 */
export function sortOptions(filters: HomeFilters): readonly WatchlistSort[] {
  return isWatchlistView(filters) ? [...MARKET_SORTS, DEFAULT_WATCHLIST_VIEW_SORT] : MARKET_SORTS;
}

/**
 * The filters a sort option navigates to: the same view and category with that order. A value
 * the view does not offer (`watched` on the public list, which no option there sends) is the
 * view's default instead.
 */
export function withSort(filters: HomeFilters, sort: WatchlistSort): HomeFilters {
  if (isWatchlistView(filters)) return { ...filters, sort };
  return {
    ...filters,
    sort: sort === DEFAULT_WATCHLIST_VIEW_SORT ? DEFAULT_MARKET_FILTERS.sort : sort,
  };
}

/**
 * Where the 관심 시장 toggle goes (ADR-0061 decision 1, item 12; decision 3, the #63 row).
 *
 * - On → off: the public list of the same category, on its default order 추천, whatever order the
 *   view was on (owner decision 2026-10-16, ADR-0065): each view starts on its own first order, as
 *   turning it on starts on 최근 관심 등록 순. Anyone may, signed in or not.
 * - Off → on: the view of the same category, on 최근 관심 등록 순, whatever was picked on the
 *   public list. A visitor known to be signed
 *   out is sent to the login page instead, told to come back to exactly that view, so a sign-in
 *   lands on it (`signedIn === false`). While the session is still unknown (`undefined`) the view
 *   itself is the answer: it waits for the session and then shows the list, or a sign-in prompt
 *   that links to the same login (`sessionListSection` in app/market-list.tsx).
 */
export function watchlistToggleTarget(filters: HomeFilters, signedIn: boolean | undefined): string {
  const category = filters.category === undefined ? {} : { category: filters.category };
  if (isWatchlistView(filters)) return homePath({ ...DEFAULT_MARKET_FILTERS, ...category });
  const view = homePath({ watchlist: true, sort: DEFAULT_WATCHLIST_VIEW_SORT, ...category });
  return signedIn === false ? loginPathBackToPage(view) : view;
}

/**
 * Where the 관심 시장 view's sign-in prompt sends a signed-out visitor who opened the view's URL
 * (a shared link, a tab left open across a sign-out): the login page, told to come back to this
 * very view — category and order included — as a toggle press would have.
 */
export function watchlistViewLoginPath(filters: WatchlistViewFilters): string {
  return loginPathBackToPage(homePath(filters));
}

/**
 * The 관심 시장 view's list as `GET /me/watchlist` asks for it: open markets only, as on the public
 * list (ADR-0061 decision 1, item 13), of the URL's category, in the URL's order. The status and
 * the order are always written out, so the key does not depend on the API's defaults; MY's `{}`
 * is a different entry, as it is a different list.
 */
export function watchlistViewFilters(filters: WatchlistViewFilters): WatchlistFilters {
  return {
    status: HOME_MARKET_STATUS,
    sort: filters.sort,
    ...(filters.category === undefined ? {} : { category: filters.category }),
  };
}

/**
 * What the grid says when its list is empty, one message per view (ADR-0065). The public list
 * says "nothing is open yet", the state of the list itself; "no results" belongs to the search
 * screen (`copy.marketsSearchEmpty`, ADR-0066), whose list is a word someone typed. The 관심 시장
 * view has its own: watched markets may exist and have ended, which MY still lists, so it says no
 * open one is watched rather than that nothing is — and then how a market gets there, in MY's own
 * sentence (owner decision 2026-10-16, `copy.watchlistViewEmpty`).
 */
export function listEmptyMessage(filters: HomeFilters): string {
  return isWatchlistView(filters) ? copy.watchlistViewEmpty : copy.marketsEmpty;
}

/**
 * The `h2` over the grid: the leaf's name when `?category=` names a leaf, the top-level name when
 * it names a top-level category, and the plain 예측시장 otherwise — including for a slug the tree
 * does not know (a retired category, a link typed by hand), where the list still filters on it
 * and reports its own empty state, but there is no name to put in a heading.
 */
export function homeHeading(tree: readonly CategoryNode[], filters: HomeFilters): string {
  const found = locateCategory(tree, filters.category);
  if (found === undefined) return copy.homeTitle;
  return found.leaf?.nameKo ?? found.parent.category.nameKo;
}

/** One row of the sub-category sidebar (and one chip of its below-md twin). */
export interface SidebarLink {
  label: string;
  /** The `?…` this row navigates to, as `NextLink`'s `query`; the other filters ride along. */
  query: Record<string, string>;
  /** Marked `aria-current="page"` and coloured `brand.fg` (PLAN 11.2: never colour alone). */
  active: boolean;
  testId: string;
  /** The TOP-LEVEL slug whose glyph the row draws — a leaf inherits its parent's (CategoryIcon). */
  iconSlug: string;
}

/**
 * The sidebar's rows for the current URL, in order: 전체 시장 (the top-level category itself,
 * Kalshi's "All markets") and then each of its leaves. Empty when no category is selected and
 * when the slug is not in the tree — the sidebar then has no parent to list under, so it renders
 * nothing rather than a lone 전체 시장 pointing at a slug it cannot name.
 *
 * Each row's query is built with `filterQuery` over the CURRENT filters, so the sort and the
 * 관심 시장 view survive a change of sub-category: the sidebar is a refinement of
 * the list the visitor is already looking at (관심 시장 combines with a category, ADR-0061
 * decision 1, item 12). The header's category links are a way INTO the list from any route and
 * post a fresh `?category=`, except in the 관심 시장 view, which they keep on with its order
 * (`categoryLinkQuery`, lib/nav.ts).
 *
 * `active` compares slugs rather than objects because the seeded prop and the query's answer are
 * different objects for the same category (market-filters.tsx keeps both).
 */
export function sidebarLinks(tree: readonly CategoryNode[], filters: HomeFilters): SidebarLink[] {
  const found = locateCategory(tree, filters.category);
  if (found === undefined) return [];
  const parent = found.parent.category;
  return [
    {
      label: copy.marketsAllInCategory,
      query: filterQuery({ ...filters, category: parent.slug }),
      active: found.leaf === undefined,
      testId: 'market-subcategory-all',
      iconSlug: parent.slug,
    },
    ...found.parent.children.map((leaf) => ({
      label: leaf.nameKo,
      query: filterQuery({ ...filters, category: leaf.slug }),
      active: found.leaf?.slug === leaf.slug,
      testId: `market-subcategory-${leaf.slug}`,
      iconSlug: parent.slug,
    })),
  ];
}
