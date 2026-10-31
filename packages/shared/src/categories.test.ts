import { describe, expect, it } from 'vitest';
import {
  CATEGORY_GROUP_MAX,
  CATEGORY_NAME_MAX,
  categoryNameSchema,
  createCategoryBodySchema,
  newCategorySlugSchema,
  reorderCategoriesBodySchema,
} from './categories.js';
import { ALL_CATEGORY_SLUGS } from './enums.js';

describe('admin category bodies (#17)', () => {
  it('takes the seed’s slug shape, and sports and politics too (D10)', () => {
    for (const slug of [...ALL_CATEGORY_SLUGS, 'sports', 'politics', 'k-league', 'f1']) {
      expect(newCategorySlugSchema.safeParse(slug).success, slug).toBe(true);
    }
    for (const slug of ['a', 'Sports', 'k_league', '-x', 'x-', 'a--b', '스포츠', 'x'.repeat(33)]) {
      expect(newCategorySlugSchema.safeParse(slug).success, slug).toBe(false);
    }
  });

  it('normalises a name and bounds it', () => {
    expect(categoryNameSchema.parse('  국내   야구 ')).toBe('국내 야구');
    expect(categoryNameSchema.safeParse('   ').success).toBe(false);
    expect(categoryNameSchema.safeParse('가'.repeat(CATEGORY_NAME_MAX + 1)).success).toBe(false);
  });

  it('makes a top-level category with a null parent and names the admin on screen', () => {
    expect(
      createCategoryBodySchema.parse({
        slug: 'sports',
        nameKo: '스포츠',
        parentId: null,
        expectedAccountId: 'admin-1',
      }),
    ).toEqual({ slug: 'sports', nameKo: '스포츠', parentId: null, expectedAccountId: 'admin-1' });
    expect(
      createCategoryBodySchema.safeParse({
        slug: 'sports',
        nameKo: '스포츠',
        expectedAccountId: 'a',
      }).success,
    ).toBe(false);
  });

  it('lets a reorder name a full group and no more (CATEGORY_GROUP_MAX)', () => {
    const ids = Array.from({ length: CATEGORY_GROUP_MAX }, (_, i) => i + 1);
    const body = { parentId: null, expectedAccountId: 'admin-1' };
    expect(reorderCategoriesBodySchema.safeParse({ ...body, ids }).success).toBe(true);
    expect(
      reorderCategoriesBodySchema.safeParse({ ...body, ids: [...ids, CATEGORY_GROUP_MAX + 1] })
        .success,
    ).toBe(false);
  });

  it('refuses a reorder that repeats an id', () => {
    const body = { parentId: null, ids: [1, 2, 3], expectedAccountId: 'admin-1' };
    expect(reorderCategoriesBodySchema.safeParse(body).success).toBe(true);
    expect(reorderCategoriesBodySchema.safeParse({ ...body, ids: [1, 2, 1] }).success).toBe(false);
    expect(reorderCategoriesBodySchema.safeParse({ ...body, ids: [] }).success).toBe(false);
  });
});
