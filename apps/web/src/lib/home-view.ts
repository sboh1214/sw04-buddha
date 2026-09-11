import { copy } from '@/copy';
import { type CategoryNode, locateCategory } from './category-tree';
import { DEFAULT_MARKET_FILTERS, type MarketFilters } from './market-keys';

/**
 * The home screen's derived VIEW (ADR-0041, Kalshi's category page): what the headline says and
 * which rows the sub-category sidebar shows for a given URL. Pure functions of the category tree
 * and the normalised filters, kept out of the components so they can be tested without a DOM —
 * the same split `category-tree.ts` and `market-ssr.ts` make. No `'use client'`: nothing here
 * touches React, and a server component may import it.
 */

/**
 * The filters as a query string, with everything that equals the default left out — so the
 * default view's URL is a bare `/` and a shared link carries only what was actually chosen.
 * Dropping them is safe in both directions: `filtersFromSearchParams` falls back to exactly these
 * defaults for a missing param.
 *
 * Lived in `app/market-filters.tsx` until the sidebar needed it too; this module is the one
 * home-screen helper both components import, and the one place the decision is tested.
 */
export function filterQuery(filters: MarketFilters): Record<string, string> {
  return {
    ...(filters.category === undefined ? {} : { category: filters.category }),
    ...(filters.q === undefined ? {} : { q: filters.q }),
    ...(filters.sort === DEFAULT_MARKET_FILTERS.sort ? {} : { sort: filters.sort }),
    ...(filters.status === DEFAULT_MARKET_FILTERS.status ? {} : { status: filters.status }),
  };
}

/**
 * The `h2` over the grid: the leaf's name when `?category=` names a leaf, the top-level name when
 * it names a top-level category, and the plain 예측 시장 otherwise — including for a slug the tree
 * does not know (a retired category, a link typed by hand), where the list still filters on it
 * and reports its own empty state, but there is no name to put in a heading.
 */
export function homeHeading(tree: readonly CategoryNode[], filters: MarketFilters): string {
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
 * Each row's query is built with `filterQuery` over the CURRENT filters, so the sort, the status
 * and a search term survive a change of sub-category: the sidebar is a refinement of the list
 * the visitor is already looking at, unlike the header's category links, which are a way INTO
 * the list from any route and post a fresh `?category=` (nav.tsx).
 *
 * `active` compares slugs rather than objects because the seeded prop and the query's answer are
 * different objects for the same category (market-filters.tsx keeps both).
 */
export function sidebarLinks(tree: readonly CategoryNode[], filters: MarketFilters): SidebarLink[] {
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
