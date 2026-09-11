import { type Category } from './api';
import { groupCategories, locateCategory } from './category-tree';

/**
 * The category trail a screen writes next to a market (ADR-0041): the two-level tree turned
 * into the words a reader sees, `['경제', '주택']` for a market filed under a leaf and
 * `['경제']` for one filed at the top level (a parent with no leaves may hold markets — the
 * admin form offers such a parent as a plain option).
 *
 * The row itself only carries `category: { slug, nameKo }` — the LEAF's name, which is all a
 * card needs and the reason twenty fixtures did not have to change when the tree arrived
 * (ADR-0041). The parent's name therefore has to come from the `['categories']` query, and
 * that query has not resolved during the server render or the first client paint. So the
 * list is optional and the third argument is what the row already says: a screen renders
 * `[fallbackName]` — exactly the label it drew before the tree existed — until the query
 * lands, and the same label for good when the slug is not in the active list (a category
 * retired since the market was made). Nothing is ever hidden behind a pending query.
 *
 * Pure and array-valued: the caller decides the separator and the markup, and a test can
 * read the parts without parsing a string. No `'use client'`, no Korean literal — every word
 * in the result came from the API or from the caller.
 */
export function categoryBreadcrumb(
  categories: readonly Category[] | undefined,
  slug: string,
  fallbackName: string,
): string[] {
  if (categories === undefined) return [fallbackName];
  const found = locateCategory(groupCategories(categories), slug);
  if (found === undefined) return [fallbackName];
  return found.leaf === undefined
    ? [found.parent.category.nameKo]
    : [found.parent.category.nameKo, found.leaf.nameKo];
}

/**
 * What joins the parts when they are written as one line: a spaced single right-pointing
 * angle quotation mark (U+203A), the glyph Kalshi's own breadcrumb uses. Punctuation, not
 * copy — it carries no Korean, so it lives beside the function that produces the parts rather
 * than in `copy.ts`. One constant so the detail tag and any future crumb cannot drift apart
 * by a space.
 */
export const CATEGORY_TRAIL_SEPARATOR = ' › ';
