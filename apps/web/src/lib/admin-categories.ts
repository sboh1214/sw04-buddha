import { CATEGORY_REFUSALS, categoryNameSchema, newCategorySlugSchema } from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';
import {
  type AdminCategory,
  type CreateCategoryBody,
  type RenameCategoryBody,
  isApiError,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';

/**
 * 카테고리 관리 (#17, ADR-0093 decision 2 #172 item 1 and decision 3's #17 rows), the admin half:
 * the tree as the screen draws it, the order a move sends, the forms' rules and bodies, and the
 * words for a refusal — kept out of the components so the node test runner reaches them (vitest
 * runs with no DOM here).
 *
 * Owner decisions: two levels, as today; a category is never deleted, only hidden — hidden leaves
 * new-market entry, the explore categories and the interest pick, while its markets keep it, and
 * hiding a top-level category takes its sub-categories with it; the operators set the order,
 * top-level categories among themselves and sub-categories within their parent, a new one going
 * last. Implementation choices (#17 brief): the slug is chosen at creation and fixed, a rename
 * changes the name only, and no category moves to another parent or level.
 *
 * The rows are `GET /admin/categories`'s, hidden ones included (`AdminCategory`, lib/api.ts).
 */

/** A top-level category with every sub-category of it, hidden ones too, in display order. */
export interface AdminCategoryNode {
  category: AdminCategory;
  children: AdminCategory[];
}

/** The API's display order within one sibling group: `sortOrder`, then `id`. */
function byDisplayOrder(a: AdminCategory, b: AdminCategory): number {
  return a.sortOrder - b.sortOrder || a.id - b.id;
}

/**
 * The tree the screen lists: each top-level category followed by its sub-categories, each group
 * in display order. Sorted here rather than trusted to the list's order, so a row a write's answer
 * put into the cache (`mergeAdminCategories`) lands in its place before the list is read again. A
 * sub-category whose parent is not in the list is dropped — the admin list holds every row, so it
 * has nowhere to go.
 */
export function groupAdminCategories(rows: readonly AdminCategory[]): AdminCategoryNode[] {
  const nodes = new Map<number, AdminCategoryNode>();
  const roots: AdminCategoryNode[] = [];
  for (const category of [...rows].sort(byDisplayOrder)) {
    if (category.parentId === null) {
      const node = { category, children: [] };
      nodes.set(category.id, node);
      roots.push(node);
    }
  }
  for (const category of [...rows].sort(byDisplayOrder)) {
    if (category.parentId !== null) nodes.get(category.parentId)?.children.push(category);
  }
  return roots;
}

/**
 * The ids of one sibling group — the top-level categories for `null`, else that parent's
 * sub-categories — hidden ones included, in display order: what `PUT /admin/categories/order`
 * must name, every one once (`CATEGORY_REFUSALS.orderMismatch` otherwise).
 */
export function siblingIds(rows: readonly AdminCategory[], parentId: number | null): number[] {
  return rows
    .filter((row) => row.parentId === parentId)
    .sort(byDisplayOrder)
    .map((row) => row.id);
}

export type MoveDirection = 'up' | 'down';

/**
 * The group's order after moving `id` one place up or down: the whole group, so the reorder sends
 * every sibling (hidden ones too). `undefined` when it cannot move — first and up, last and down,
 * or not in the group — and the button is then off.
 */
export function movedOrder(
  ids: readonly number[],
  id: number,
  direction: MoveDirection,
): number[] | undefined {
  const from = ids.indexOf(id);
  if (from === -1) return undefined;
  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= ids.length) return undefined;
  const next = [...ids];
  next[from] = ids[to] as number;
  next[to] = id;
  return next;
}

/**
 * The list with a write's answer put in: each row replaced by id, a new one added. `undefined`
 * while nothing is held — the read that follows the write fills it. The order is the grouping's to
 * restore (`groupAdminCategories` sorts each group), so a reorder's answer — the group with its new
 * `sortOrder`s — moves the rows at once.
 */
export function mergeAdminCategories(
  held: readonly AdminCategory[] | undefined,
  fresh: readonly AdminCategory[],
): AdminCategory[] | undefined {
  if (held === undefined) return undefined;
  const byId = new Map(fresh.map((row) => [row.id, row]));
  const merged = held.map((row) => byId.get(row.id) ?? row);
  const known = new Set(held.map((row) => row.id));
  return [...merged, ...fresh.filter((row) => !known.has(row.id))];
}

/**
 * How a row reads: `shown`; `hidden`, its own flag off; or `hiddenByParent`, a sub-category that
 * is on itself but whose top-level category is hidden — out of every public list with it, and back
 * when the parent is shown again (its own flag is never touched by the parent's hide).
 */
export type AdminCategoryState = 'shown' | 'hidden' | 'hiddenByParent';

export function adminCategoryState(
  category: Pick<AdminCategory, 'isActive'>,
  parent?: Pick<AdminCategory, 'isActive'>,
): AdminCategoryState {
  if (!category.isActive) return 'hidden';
  if (parent !== undefined && !parent.isActive) return 'hiddenByParent';
  return 'shown';
}

/** The line under a row's name: its slug and how many markets are filed under it, '시장 3개'. */
export function formatAdminCategoryMeta(
  category: Pick<AdminCategory, 'slug' | 'marketCount'>,
): string {
  const markets = `${copy.adminCategoryMarkets} ${String(category.marketCount)}`;
  return `${category.slug} · ${markets}${copy.adminCategoryMarketsUnit}`;
}

/** The add form's values: the strings the inputs hold. */
export interface CategoryFormValues {
  slug: string;
  nameKo: string;
}

export const EMPTY_CATEGORY_FORM: CategoryFormValues = { slug: '', nameKo: '' };

/** The rename form: the name alone (the slug never changes). */
export type CategoryRenameValues = Pick<CategoryFormValues, 'nameKo'>;

/**
 * The name as the API stores it (`categoryNameSchema`'s transform: NFC, trimmed, inner whitespace
 * one space), or the typed text trimmed when it is not a name at all — the form refuses that one
 * before anything is sent.
 */
function normalisedName(value: string): string {
  return categoryNameSchema.safeParse(value).data ?? value.trim();
}

const nameField = z
  .string()
  .refine((value) => categoryNameSchema.safeParse(value).success, copy.adminCategoryErrName);

/**
 * The add form's rules, the API's own schemas (`newCategorySlugSchema`, `categoryNameSchema`)
 * restated in the admin's words. The API checks everything again; what it alone can refuse — a slug
 * any category has, a name a sibling has, a parent hidden meanwhile — lands through
 * `categoryFormError` or the toast.
 */
export const categoryFormSchema = z.object({
  slug: z
    .string()
    .refine((value) => newCategorySlugSchema.safeParse(value).success, copy.adminCategoryErrSlug),
  nameKo: nameField,
});

export const categoryRenameFormSchema = z.object({ nameKo: nameField });

/**
 * `POST /admin/categories`: the slug trimmed, the name normalised, and the parent — `null` for a
 * top-level category. The fields alone; the press adds the admin on screen (`useOperatorId`,
 * ADR-0092), as on every category write.
 */
export function toCreateCategoryFields(
  values: CategoryFormValues,
  parentId: number | null,
): Omit<CreateCategoryBody, 'expectedAccountId'> {
  return { slug: values.slug.trim(), nameKo: normalisedName(values.nameKo), parentId };
}

/**
 * `PATCH /admin/categories/:id`: the new name, or `undefined` when it is the name the category has
 * (the API would change nothing and record nothing, so the save is no request).
 */
export function toRenameCategoryFields(
  values: CategoryRenameValues,
  category: Pick<AdminCategory, 'nameKo'>,
): Omit<RenameCategoryBody, 'expectedAccountId'> | undefined {
  const nameKo = normalisedName(values.nameKo);
  return nameKo === category.nameKo ? undefined : { nameKo };
}

export type CategoryFormField = keyof CategoryFormValues;

/**
 * Where a refused add or rename lands on its form: the field the API named, with words the admin
 * can act on — a slug any category has, hidden ones included (`CATEGORY_REFUSALS.slugTaken`), or a
 * malformed one; a name a sibling has (`nameTaken`), or one out of bounds. `undefined` for anything
 * else, which is the toast's (`categoryWriteErrorMessage`).
 */
export function categoryFormError(
  error: unknown,
): { field: CategoryFormField; message: string } | undefined {
  if (!isApiError(error, 'VALIDATION_ERROR')) return undefined;
  const field = validationField(error);
  const reason = validationMessage(error);
  if (field === CATEGORY_REFUSALS.slugTaken.field) {
    return {
      field,
      message:
        reason === CATEGORY_REFUSALS.slugTaken.message
          ? copy.adminCategoryErrSlugTaken
          : copy.adminCategoryErrSlug,
    };
  }
  if (field === CATEGORY_REFUSALS.nameTaken.field) {
    return {
      field,
      message:
        reason === CATEGORY_REFUSALS.nameTaken.message
          ? copy.adminCategoryErrNameTaken
          : copy.adminCategoryErrName,
    };
  }
  return undefined;
}

/**
 * A refused category write in words, for the toast: the cookie of another account
 * (`copy.sessionChanged` — every write names the admin on screen and the caller asks for the
 * session again, ADR-0092); a parent that is a sub-category or hidden (`parentNotTopLevel`,
 * `parentInactive` — another admin may have just hidden it); a group already holding
 * CATEGORY_GROUP_MAX categories (`groupFull`); a reorder whose group changed
 * meanwhile (`orderMismatch`: a sibling added by another admin); a category or parent that is not
 * there (NOT_FOUND); anything else. The caller reads the list again after each of these.
 */
export function categoryWriteErrorMessage(error: unknown): string {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    const reason = validationMessage(error);
    if (field === CATEGORY_REFUSALS.parentNotTopLevel.field) {
      if (reason === CATEGORY_REFUSALS.groupFull.message) return copy.adminCategoryErrGroupFull;
      return reason === CATEGORY_REFUSALS.parentInactive.message
        ? copy.adminCategoryErrParentInactive
        : copy.adminCategoryErrParentNotTopLevel;
    }
    if (field === CATEGORY_REFUSALS.orderMismatch.field) return copy.adminCategoryErrOrder;
    const onForm = categoryFormError(error);
    if (onForm !== undefined) return onForm.message;
  }
  if (isApiError(error, 'NOT_FOUND')) return copy.adminCategoryNotFound;
  return copy.errUnknown;
}
