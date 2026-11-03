import * as z from 'zod';
import { INT4_MAX } from './constants.js';
import { expectedAccountIdSchema } from './expected-account.js';

/**
 * 카테고리 관리 (#17, ADR-0093 decision 2 #172 item 1 and decision 3's #17 rows): operators keep
 * the two-level tree on `/admin/categories`. They add a category (top-level, or a sub-category of
 * a top-level one), rename it, set its place among its siblings, and hide it or show it again —
 * each write recorded with the actor, the time and the value before and after (`category_*` in
 * ADMIN_ACTION_TYPES), with no reason and no second admin. A category is never deleted: one with
 * markets must not be (#172 item 1), and one without is hidden like any other, so the record of
 * what existed stays whole and no member's interest pick or proposal loses its category.
 *
 * Hidden leaves new-market entry, the explore categories and the interest pick; existing markets
 * keep it. Hiding a top-level category hides its sub-categories with it — `GET /categories` leaves
 * them out and none can be picked (`categoryUnselectableReason`) — without touching their own
 * `is_active`, so showing it again brings back exactly the ones that were showing.
 */

/** Chosen at creation and fixed: `?category=<slug>` links keep working after a rename. */
export const CATEGORY_SLUG_MAX = 32;
/** Lower-case Latin letters and digits in words joined by single hyphens, like the seed's. */
export const CATEGORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `categories.name_ko` is varchar(32). */
export const CATEGORY_NAME_MAX = 32;
/**
 * The most categories one sibling group holds — the top level, or one parent's sub-categories,
 * hidden ones counted. A reorder names the whole group and nothing is ever deleted, so a group
 * the reorder could not name in full could never be reordered again: creation stops here instead
 * (`CATEGORY_REFUSALS.groupFull`). Far above any explore row or picker that still reads well.
 */
export const CATEGORY_GROUP_MAX = 200;

export const newCategorySlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(CATEGORY_SLUG_MAX)
  .regex(CATEGORY_SLUG_PATTERN, 'only a-z, 0-9 and single hyphens between them');

/** Trimmed, inner whitespace one space. Unique among its siblings (`CATEGORY_REFUSALS`). */
export const categoryNameSchema = z
  .string()
  .transform((name) => name.normalize('NFC').trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(CATEGORY_NAME_MAX));

const categoryIdSchema = z.number().int().positive().max(INT4_MAX);

/**
 * Why a category write is refused, each a VALIDATION_ERROR naming `field`, so the screen says
 * which in words that fit. An unknown category is NOT_FOUND.
 */
export const CATEGORY_REFUSALS = {
  slugTaken: { field: 'slug', message: 'already exists' },
  nameTaken: { field: 'nameKo', message: 'already used by a sibling' },
  /** The tree stays two levels deep: a parent is a top-level category. */
  parentNotTopLevel: { field: 'parentId', message: 'must be a top-level category' },
  parentInactive: { field: 'parentId', message: 'is hidden' },
  /** A reorder names every sibling of the group once, hidden ones included. */
  orderMismatch: { field: 'ids', message: 'must list every category of the group once' },
  /** The group already holds CATEGORY_GROUP_MAX categories, hidden ones included. */
  groupFull: { field: 'parentId', message: 'the group is full' },
} as const;

/** One row of `GET /admin/categories`: hidden ones too, with how many markets it holds. */
export const adminCategorySchema = z
  .object({
    id: z.number().int(),
    slug: z.string(),
    nameKo: z.string(),
    sortOrder: z.number().int(),
    /** `null` for a top-level category; a sub-category names its parent's `id`. */
    parentId: z.number().int().nullable(),
    isActive: z.boolean(),
    /** Markets filed under this category itself, in any status (not its sub-categories'). */
    marketCount: z.number().int(),
  })
  .meta({ id: 'AdminCategory' });
export type AdminCategory = z.infer<typeof adminCategorySchema>;

/**
 * `POST /admin/categories`: a top-level category (`parentId` null) or a sub-category of an active
 * top-level one. It goes last among its siblings.
 */
export const createCategoryBodySchema = z
  .object({
    slug: newCategorySlugSchema,
    nameKo: categoryNameSchema,
    parentId: categoryIdSchema.nullable(),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'CreateCategoryBody' });
export type CreateCategoryBody = z.infer<typeof createCategoryBodySchema>;

/** `PATCH /admin/categories/:id`: the name, the one thing about a category that changes. */
export const renameCategoryBodySchema = z
  .object({ nameKo: categoryNameSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'RenameCategoryBody' });
export type RenameCategoryBody = z.infer<typeof renameCategoryBodySchema>;

/**
 * `PUT /admin/categories/order`: one group's new order — the top-level categories (`parentId`
 * null) or one parent's sub-categories — as every id of the group, hidden ones included, first to
 * last (ADR-0093 decision 3, the #17 '카테고리 순서' row).
 */
export const reorderCategoriesBodySchema = z
  .object({
    parentId: categoryIdSchema.nullable(),
    ids: z
      .array(categoryIdSchema)
      .min(1)
      .max(CATEGORY_GROUP_MAX)
      .refine((ids) => new Set(ids).size === ids.length, 'ids must not repeat'),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'ReorderCategoriesBody' });
export type ReorderCategoriesBody = z.infer<typeof reorderCategoriesBodySchema>;
