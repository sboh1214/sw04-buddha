import { CATEGORY_GROUP_MAX, CATEGORY_NAME_MAX, CATEGORY_REFUSALS } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  EMPTY_CATEGORY_FORM,
  adminCategoryState,
  categoryFormError,
  categoryFormSchema,
  categoryRenameFormSchema,
  categoryWriteErrorMessage,
  formatAdminCategoryMeta,
  groupAdminCategories,
  mergeAdminCategories,
  movedOrder,
  siblingIds,
  toCreateCategoryFields,
  toRenameCategoryFields,
} from './admin-categories';
import { type AdminCategory, ApiError, type ErrorEnvelope } from './api';

/**
 * 카테고리 관리 (#17, ADR-0093): the tree the screen lists, the order a move sends, the forms' rules
 * and bodies, and the words for each refusal the API gives (`CATEGORY_REFUSALS`).
 */

const row = (
  id: number,
  parentId: number | null,
  sortOrder: number,
  overrides: Partial<AdminCategory> = {},
): AdminCategory => ({
  id,
  slug: `c${String(id)}`,
  nameKo: `카테고리 ${String(id)}`,
  sortOrder,
  parentId,
  isActive: true,
  marketCount: 0,
  ...overrides,
});

/**
 * Two top-level categories (1 before 2 by sortOrder, though listed after) and their children, a
 * hidden one among them, and a third top-level one tied with the second on sortOrder (id decides).
 */
const ROWS: AdminCategory[] = [
  row(2, null, 20),
  row(1, null, 10),
  row(7, null, 20, { isActive: false }),
  row(12, 2, 10),
  row(11, 1, 30),
  row(10, 1, 10, { isActive: false }),
  row(13, 1, 20),
];

const refused = (
  field: string,
  message: string,
  code: ErrorEnvelope['error']['code'] = 'VALIDATION_ERROR',
  status = 400,
) => new ApiError(status, { code, message: 'refused', details: [{ path: [field], message }] });

describe('groupAdminCategories', () => {
  it('lists each top-level category, hidden ones too, then its sub-categories in order', () => {
    const tree = groupAdminCategories(ROWS);
    expect(tree.map((node) => node.category.id)).toEqual([1, 2, 7]);
    expect(tree.map((node) => node.children.map((child) => child.id))).toEqual([
      [10, 13, 11],
      [12],
      [],
    ]);
  });

  it('drops a sub-category whose parent is not in the list, and leaves the input as it was', () => {
    const rows = [row(1, null, 10), row(5, 99, 10)];
    expect(groupAdminCategories(rows)).toEqual([{ category: rows[0], children: [] }]);
    expect(rows.map((category) => category.id)).toEqual([1, 5]);
  });
});

describe('siblingIds', () => {
  it('names every category of the group, hidden ones included, in display order', () => {
    expect(siblingIds(ROWS, null)).toEqual([1, 2, 7]);
    expect(siblingIds(ROWS, 1)).toEqual([10, 13, 11]);
    expect(siblingIds(ROWS, 2)).toEqual([12]);
    expect(siblingIds(ROWS, 42)).toEqual([]);
  });
});

describe('movedOrder', () => {
  const ids = [10, 13, 11];

  it('swaps the category with its neighbour and keeps the whole group', () => {
    expect(movedOrder(ids, 13, 'up')).toEqual([13, 10, 11]);
    expect(movedOrder(ids, 13, 'down')).toEqual([10, 11, 13]);
    expect(movedOrder(ids, 10, 'down')).toEqual([13, 10, 11]);
    expect(movedOrder(ids, 11, 'up')).toEqual([10, 11, 13]);
    // A new array: the group as read is left alone.
    expect(ids).toEqual([10, 13, 11]);
  });

  it('cannot move the first up, the last down, or one outside the group', () => {
    expect(movedOrder(ids, 10, 'up')).toBeUndefined();
    expect(movedOrder(ids, 11, 'down')).toBeUndefined();
    expect(movedOrder(ids, 99, 'up')).toBeUndefined();
    expect(movedOrder([12], 12, 'down')).toBeUndefined();
  });

  it('moves a hidden category like any other, so the group sent still names it', () => {
    const order = movedOrder(siblingIds(ROWS, 1), 13, 'up');
    expect(order).toEqual([13, 10, 11]);
    const sorted = (ids: readonly number[]) => [...ids].sort((x, y) => x - y);
    expect(sorted(order ?? [])).toEqual(sorted(siblingIds(ROWS, 1)));
  });
});

describe('mergeAdminCategories', () => {
  it('replaces rows by id and adds new ones; the grouping puts them in place', () => {
    const renamed = { ...row(13, 1, 20), nameKo: '새 이름' };
    const added = row(20, 1, 40);
    const merged = mergeAdminCategories(ROWS, [renamed, added]);
    expect(merged).toHaveLength(ROWS.length + 1);
    expect(merged?.find((category) => category.id === 13)?.nameKo).toBe('새 이름');
    expect(groupAdminCategories(merged ?? [])[0]?.children.map((child) => child.id)).toEqual([
      10, 13, 11, 20,
    ]);
  });

  it('moves the rows at once with a reorder’s answer: the group with its new sortOrders', () => {
    const answer = [row(11, 1, 10), row(10, 1, 20, { isActive: false }), row(13, 1, 30)];
    const merged = mergeAdminCategories(ROWS, answer) ?? [];
    expect(siblingIds(merged, 1)).toEqual([11, 10, 13]);
    expect(siblingIds(merged, null)).toEqual([1, 2, 7]);
  });

  it('leaves nothing to merge into while the list has not been read', () => {
    expect(mergeAdminCategories(undefined, [row(1, null, 10)])).toBeUndefined();
  });
});

describe('adminCategoryState', () => {
  it('says hidden for its own flag, and with its parent for a shown child of a hidden one', () => {
    expect(adminCategoryState({ isActive: true })).toBe('shown');
    expect(adminCategoryState({ isActive: false })).toBe('hidden');
    expect(adminCategoryState({ isActive: true }, { isActive: true })).toBe('shown');
    expect(adminCategoryState({ isActive: true }, { isActive: false })).toBe('hiddenByParent');
    expect(adminCategoryState({ isActive: false }, { isActive: false })).toBe('hidden');
  });
});

describe('formatAdminCategoryMeta', () => {
  it('writes the slug and the markets filed under it', () => {
    expect(formatAdminCategoryMeta({ slug: 'economy', marketCount: 3 })).toBe(
      `economy · ${copy.adminCategoryMarkets} 3${copy.adminCategoryMarketsUnit}`,
    );
    expect(formatAdminCategoryMeta({ slug: 'economy', marketCount: 3 })).toBe('economy · 시장 3개');
  });
});

describe('the add form', () => {
  const issues = (values: { slug: string; nameKo: string }) =>
    categoryFormSchema
      .safeParse(values)
      .error?.issues.map((issue) => [issue.path[0], issue.message]);

  it('takes a slug of lower-case letters, digits and single hyphens, 2 to 32, and a name', () => {
    expect(issues({ slug: 'e2e-ab12', nameKo: '경제' })).toBeUndefined();
    expect(issues({ slug: ' real-estate ', nameKo: ' 부동산 ' })).toBeUndefined();
  });

  it('refuses what the API’s schemas refuse, in the admin’s words', () => {
    for (const slug of [
      '',
      'a',
      'Economy',
      'real_estate',
      '-ab',
      'ab-',
      'a--b',
      '부동산',
      'a'.repeat(33),
    ]) {
      expect(issues({ slug, nameKo: '경제' }), slug).toEqual([['slug', copy.adminCategoryErrSlug]]);
    }
    for (const nameKo of ['', '   ', '가'.repeat(CATEGORY_NAME_MAX + 1)]) {
      expect(issues({ slug: 'ok', nameKo }), nameKo).toEqual([
        ['nameKo', copy.adminCategoryErrName],
      ]);
    }
    expect(issues(EMPTY_CATEGORY_FORM)).toEqual([
      ['slug', copy.adminCategoryErrSlug],
      ['nameKo', copy.adminCategoryErrName],
    ]);
  });

  it('sends the slug trimmed, the name as the API stores it, and the parent', () => {
    expect(toCreateCategoryFields({ slug: ' e2e-ab ', nameKo: '  세부   분류 ' }, 3)).toEqual({
      slug: 'e2e-ab',
      nameKo: '세부 분류',
      parentId: 3,
    });
    expect(toCreateCategoryFields({ slug: 'top', nameKo: '상위' }, null)).toEqual({
      slug: 'top',
      nameKo: '상위',
      parentId: null,
    });
  });
});

describe('the rename form', () => {
  it('takes a name within the bound', () => {
    expect(categoryRenameFormSchema.safeParse({ nameKo: '새 이름' }).success).toBe(true);
    expect(categoryRenameFormSchema.safeParse({ nameKo: ' ' }).error?.issues[0]?.message).toBe(
      copy.adminCategoryErrName,
    );
  });

  it('sends the new name, and nothing when it is the name the category has', () => {
    const category = row(1, null, 10, { nameKo: '세부 분류' });
    expect(toRenameCategoryFields({ nameKo: ' 새  이름 ' }, category)).toEqual({
      nameKo: '새 이름',
    });
    expect(toRenameCategoryFields({ nameKo: '세부 분류' }, category)).toBeUndefined();
    expect(toRenameCategoryFields({ nameKo: '  세부   분류 ' }, category)).toBeUndefined();
  });
});

describe('a refused write', () => {
  it('lands a taken or malformed slug and name on its field', () => {
    const { slugTaken, nameTaken } = CATEGORY_REFUSALS;
    expect(categoryFormError(refused(slugTaken.field, slugTaken.message))).toEqual({
      field: 'slug',
      message: copy.adminCategoryErrSlugTaken,
    });
    expect(categoryFormError(refused('slug', 'Invalid string'))).toEqual({
      field: 'slug',
      message: copy.adminCategoryErrSlug,
    });
    expect(categoryFormError(refused(nameTaken.field, nameTaken.message))).toEqual({
      field: 'nameKo',
      message: copy.adminCategoryErrNameTaken,
    });
    expect(categoryFormError(refused('nameKo', 'Too big'))).toEqual({
      field: 'nameKo',
      message: copy.adminCategoryErrName,
    });
  });

  it('leaves the parent, the order, a missing category and another account to the toast', () => {
    const { parentNotTopLevel, parentInactive, orderMismatch } = CATEGORY_REFUSALS;
    for (const error of [
      refused(parentNotTopLevel.field, parentNotTopLevel.message),
      refused(parentInactive.field, parentInactive.message),
      refused(orderMismatch.field, orderMismatch.message),
      refused('parentId', 'not found', 'NOT_FOUND', 404),
      refused('expectedAccountId', 'another account', 'FORBIDDEN', 403),
      new Error('offline'),
    ]) {
      expect(categoryFormError(error)).toBeUndefined();
    }
  });

  it('words each refusal for the toast', () => {
    const { parentNotTopLevel, parentInactive, groupFull, orderMismatch, slugTaken, nameTaken } =
      CATEGORY_REFUSALS;
    // The cap the copy states is the shared one.
    expect(copy.adminCategoryErrGroupFull).toContain(`${CATEGORY_GROUP_MAX}개`);
    const cases: [unknown, string][] = [
      [
        refused(parentNotTopLevel.field, parentNotTopLevel.message),
        copy.adminCategoryErrParentNotTopLevel,
      ],
      [refused(parentInactive.field, parentInactive.message), copy.adminCategoryErrParentInactive],
      [refused(groupFull.field, groupFull.message), copy.adminCategoryErrGroupFull],
      [refused(orderMismatch.field, orderMismatch.message), copy.adminCategoryErrOrder],
      [refused('ids', 'ids must not repeat'), copy.adminCategoryErrOrder],
      [refused(slugTaken.field, slugTaken.message), copy.adminCategoryErrSlugTaken],
      [refused(nameTaken.field, nameTaken.message), copy.adminCategoryErrNameTaken],
      [refused('parentId', 'not found', 'NOT_FOUND', 404), copy.adminCategoryNotFound],
      [
        new ApiError(404, { code: 'NOT_FOUND', message: 'Category not found' }),
        copy.adminCategoryNotFound,
      ],
      [refused('expectedAccountId', 'another account', 'FORBIDDEN', 403), copy.sessionChanged],
      [new ApiError(403, { code: 'FORBIDDEN', message: 'csrf' }), copy.errUnknown],
      [refused('expectedAccountId', 'Invalid uuid'), copy.errUnknown],
      [new Error('offline'), copy.errUnknown],
    ];
    for (const [index, [error, message]] of cases.entries()) {
      expect(categoryWriteErrorMessage(error), `case ${String(index)}`).toBe(message);
    }
  });
});
