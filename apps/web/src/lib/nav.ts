import { marketListQuerySchema } from '@buddha/shared';
import { type CategoryNode, locateCategory } from './category-tree';

/**
 * Which header item is the page being shown (ADR-0041, Kalshi's two-tier navbar). Pure
 * functions of the URL, kept out of `components/layout/nav.tsx` so they can be tested without
 * a DOM — the same split `bottom-tabs.tsx` makes with `isCurrentTab`. Every answer here ends
 * up as `aria-current="page"` on a link, never as a colour alone (PLAN 11.2).
 */

/** Row 1 of the header: 시장 · 랭킹 · 커뮤니티. */
export type PrimaryNavKey = 'markets' | 'ranking' | 'community';

/**
 * The header's height at md and up, in CSS px: Kalshi's measured 107 (12 + 40 + 12 for row 1,
 * 30 + 12 for row 2, the 1px rule), which `nav.tsx` is built to. One number in one place because
 * two things depend on it — the header's own layout and the home screen's sticky sidebar, which
 * has to stop exactly under it — and a drift between them shows as a sidebar sliding under the
 * header. Below md the header is shorter (no primary links) but nothing sticks under it there.
 */
export const HEADER_HEIGHT_PX = 107;

/**
 * Whether a row-1 item is the page being shown. 시장 owns the home list AND every market detail —
 * `/markets/<slug>` is a market, and a visitor who opened one is still "in the markets" the way
 * Kalshi keeps its Markets item lit on an event page. 랭킹 and 커뮤니티 match their own route and
 * its subtree, so a future `/leaderboard/weekly` keeps 랭킹 marked, but not `/leaderboardish`.
 */
export function isPrimaryCurrent(pathname: string, key: PrimaryNavKey): boolean {
  switch (key) {
    case 'markets':
      return pathname === '/' || pathname.startsWith('/markets/');
    case 'ranking':
      return pathname === '/leaderboard' || pathname.startsWith('/leaderboard/');
    case 'community':
      return pathname === '/community' || pathname.startsWith('/community/');
  }
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
 * filter. Only the home route can light anything in row 2 — the row is rendered on every route,
 * but a `?category=` on `/login` filters nothing, and a lit 전체 on the settings page would claim
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
