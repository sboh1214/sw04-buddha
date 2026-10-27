import { index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { categories } from './categories.js';
import { createdAt } from './columns.js';
import { profiles } from './profiles.js';

/**
 * An account's interest categories (#58, N04 §2's 관심 카테고리; ADR-0069 decision 1 #57-7 and
 * #37-5): one row per category it picked, top-level or sub-category alike, as many as it likes.
 * Written whole by `PUT /me/interest-categories` (the onboarding's step, and MY 설정's once #41
 * builds it); a public profile item once #41 shows the profile — shown while picked, nothing when
 * none (#37-5). Whether the step was answered at all is `profiles.interests_answered_at`.
 *
 * Both ends cascade: the profile's rows go with it, and a category deleted (operators retire one
 * with `is_active` instead, #17) takes its picks along rather than refusing.
 */
export const profileInterestCategories = pgTable(
  'profile_interest_categories',
  {
    userId: text()
      .notNull()
      .references(() => profiles.userId, { onDelete: 'cascade' }),
    categoryId: integer()
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.categoryId] }),
    // The FK's other end: a category's deletion finds its picks without a scan.
    index('profile_interest_categories_category_id_idx').on(t.categoryId),
  ],
);
