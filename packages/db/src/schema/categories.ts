import { type AnyPgColumn, boolean, integer, pgTable, serial, varchar } from 'drizzle-orm/pg-core';

/**
 * Market categories, two levels deep (Kalshi's "Economics → Housing / Jobs" shape). Seeded
 * with CATEGORY_SLUGS as the top level and SUBCATEGORY_SLUGS under each (never sports or
 * elections, PLAN 0.2). A top-level row has `parent_id` NULL; a sub-category names its parent.
 *
 * The depth is a convention the seed and the API keep, not a constraint the database checks:
 * a self-referencing CHECK cannot see the parent row, and a trigger for a table of ~30 rows
 * that only the seed writes would be more code than the rule it guards. `ON DELETE RESTRICT`
 * so a parent with children cannot vanish under them; `is_active` is the admin knob for
 * retiring one instead.
 */
export const categories = pgTable('categories', {
  id: serial().primaryKey(),
  slug: varchar({ length: 32 }).notNull().unique(),
  nameKo: varchar({ length: 32 }).notNull(),
  sortOrder: integer().notNull().default(0),
  isActive: boolean().notNull().default(true),
  // The type annotation is what drizzle asks for on a self-reference: without it TypeScript
  // sees `categories` used in its own initializer and infers `any`.
  parentId: integer().references((): AnyPgColumn => categories.id, { onDelete: 'restrict' }),
});
