import { boolean, integer, pgTable, serial, varchar } from 'drizzle-orm/pg-core';

/** Market categories. Seeded with CATEGORY_SLUGS (never sports/elections, PLAN 0.2). */
export const categories = pgTable('categories', {
  id: serial().primaryKey(),
  slug: varchar({ length: 32 }).notNull().unique(),
  nameKo: varchar({ length: 32 }).notNull(),
  sortOrder: integer().notNull().default(0),
  isActive: boolean().notNull().default(true),
});
