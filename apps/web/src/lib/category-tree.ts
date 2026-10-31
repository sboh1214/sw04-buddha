import { CATEGORY_SLUGS, SUBCATEGORY_SLUGS, type CategorySlug } from '@buddha/shared';
import { type Category } from './api';

/**
 * The two-level category tree the header, the home screen and the admin form all read
 * (Kalshi's "Economics → Housing / Jobs" shape). `GET /categories` answers FLAT — every active
 * row with a `parentId` — and this module is the one place the tree is assembled from it, so the
 * three screens cannot each group it a little differently. No `'use client'`: pure functions of
 * a list, usable from a server component and testable without a DOM.
 */

/** A top-level category with its active sub-categories, in the API's display order. */
export interface CategoryNode {
  category: Category;
  children: Category[];
}

/**
 * Groups the flat list: top-level rows (`parentId === null`) in the order the API sent them, each
 * carrying the leaves whose `parentId` names it, in THEIR order. A leaf whose parent is not in
 * the list is dropped — the API already withholds the children of a retired parent, and a client
 * that received one anyway has nowhere to put it. The result is a new array; the rows are the
 * same objects the query holds.
 */
export function groupCategories(categories: readonly Category[]): CategoryNode[] {
  const nodes = new Map<number, CategoryNode>();
  const roots: CategoryNode[] = [];
  for (const category of categories) {
    if (category.parentId === null) {
      const node = { category, children: [] };
      nodes.set(category.id, node);
      roots.push(node);
    }
  }
  for (const category of categories) {
    if (category.parentId !== null) nodes.get(category.parentId)?.children.push(category);
  }
  return roots;
}

/**
 * Where a `?category=<slug>` sits in the tree: the top-level node it belongs to and, when the
 * slug names a leaf, that leaf. `undefined` for a slug that is not in the tree (a link typed by
 * hand, or a category retired since the link was shared) — the list below still filters on it
 * and answers its own empty state, and the header simply marks nothing as current.
 */
export function locateCategory(
  tree: readonly CategoryNode[],
  slug: string | undefined,
): { parent: CategoryNode; leaf: Category | undefined } | undefined {
  if (slug === undefined) return undefined;
  for (const node of tree) {
    if (node.category.slug === slug) return { parent: node, leaf: undefined };
    const leaf = node.children.find((child) => child.slug === slug);
    if (leaf !== undefined) return { parent: node, leaf };
  }
  return undefined;
}

/**
 * The top-level slug a slug belongs to, from the SEEDED tree in `@buddha/shared` rather than
 * from a query: a top-level slug is its own answer, a seeded leaf answers its parent, anything
 * else `undefined`. Static on purpose — a card needs the parent to pick its glyph
 * (`CategoryIcon`) inside the server's HTML, where no `['categories']` query has resolved yet.
 * Since #17 admins add categories (/admin/categories), and the glyphs stay keyed to the seed's
 * slugs: a category added there, or a leaf added under a seeded parent, answers `undefined` and
 * draws the neutral glyph (cards are #61's; #17 implementation choice 16). `locateCategory` is
 * the live answer for the screens that hold the query.
 */
export function parentCategorySlug(slug: string): CategorySlug | undefined {
  for (const parent of CATEGORY_SLUGS) {
    if (parent === slug) return parent;
    if ((SUBCATEGORY_SLUGS[parent] as readonly string[]).includes(slug)) return parent;
  }
  return undefined;
}
