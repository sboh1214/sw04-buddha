import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  integer,
  pgTable,
  serial,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Market categories, two levels deep (Kalshi's "Economics → Housing / Jobs" shape; ADR-0093
 * decision 2 #172 item 1). The seed starts the tree with CATEGORY_SLUGS as the top level and
 * SUBCATEGORY_SLUGS under each; from there the operators keep it on `/admin/categories` (#17) —
 * add, rename, reorder, hide — and any category may be added, sports and politics included (D10).
 * A top-level row has `parent_id` NULL; a sub-category names its parent.
 *
 * The depth is a convention the API keeps (a parent must be a top-level row), not a constraint the
 * database checks: a self-referencing CHECK cannot see the parent row, and a trigger for a table
 * of a few dozen rows that one admin service writes would be more code than the rule it guards.
 * A category is never deleted — `is_active` hides it, and its markets keep it — so `ON DELETE
 * RESTRICT` only backs that up. `slug` is fixed once made; `sort_order` places a row among its
 * siblings (top-level rows among themselves, sub-categories within their parent).
 */
export const categories = pgTable(
  'categories',
  {
    id: serial().primaryKey(),
    slug: varchar({ length: 32 }).notNull().unique(),
    nameKo: varchar({ length: 32 }).notNull(),
    sortOrder: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),
    // The type annotation is what drizzle asks for on a self-reference: without it TypeScript
    // sees `categories` used in its own initializer and infers `any`.
    parentId: integer().references((): AnyPgColumn => categories.id, { onDelete: 'restrict' }),
  },
  (t) => [
    // Two siblings never share a name (#17) — the pickers would show two the same. The top level
    // is the group of parent 0, which no row has.
    uniqueIndex('categories_parent_name_ko_unique').on(sql`coalesce(${t.parentId}, 0)`, t.nameKo),
  ],
);
