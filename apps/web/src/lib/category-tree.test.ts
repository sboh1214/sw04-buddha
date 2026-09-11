import { describe, expect, it } from 'vitest';
import { type Category } from './api';
import { groupCategories, locateCategory, parentCategorySlug } from './category-tree';

const category = (
  id: number,
  slug: string,
  parentId: number | null,
  sortOrder = id * 10,
): Category => ({ id, slug, nameKo: slug, sortOrder, parentId });

/** The API's own order: parents first in display order, then leaves grouped by parent. */
const FLAT: Category[] = [
  category(1, 'economy', null),
  category(2, 'weather', null),
  category(11, 'housing', 1, 10),
  category(12, 'jobs', 1, 20),
  category(21, 'rain', 2, 10),
];

describe('groupCategories', () => {
  it('nests each leaf under its parent, keeping both orders as the API sent them', () => {
    const tree = groupCategories(FLAT);
    expect(tree.map((node) => node.category.slug)).toEqual(['economy', 'weather']);
    expect(tree[0]?.children.map((leaf) => leaf.slug)).toEqual(['housing', 'jobs']);
    expect(tree[1]?.children.map((leaf) => leaf.slug)).toEqual(['rain']);
    // The rows are the query's own objects, not copies: a component may key on identity.
    expect(tree[0]?.children[0]).toBe(FLAT[2]);
  });

  it('does not depend on parents preceding their leaves in the list', () => {
    const tree = groupCategories([FLAT[2]!, FLAT[0]!]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children.map((leaf) => leaf.slug)).toEqual(['housing']);
  });

  it('drops a leaf whose parent is absent and yields an empty tree for an empty list', () => {
    expect(groupCategories([category(11, 'housing', 99)])).toEqual([]);
    expect(groupCategories([])).toEqual([]);
  });

  it('gives a parent with no leaves an empty children list rather than omitting it', () => {
    const tree = groupCategories([category(3, 'culture', null)]);
    expect(tree).toEqual([{ category: category(3, 'culture', null), children: [] }]);
  });
});

describe('locateCategory', () => {
  const tree = groupCategories(FLAT);

  it('finds a top-level slug as its own node with no leaf', () => {
    const found = locateCategory(tree, 'weather');
    expect(found?.parent.category.slug).toBe('weather');
    expect(found?.leaf).toBeUndefined();
  });

  it('finds a leaf slug together with the node it hangs under', () => {
    const found = locateCategory(tree, 'jobs');
    expect(found?.parent.category.slug).toBe('economy');
    expect(found?.leaf?.slug).toBe('jobs');
  });

  it('answers undefined for no slug and for a slug that is not in the tree', () => {
    expect(locateCategory(tree, undefined)).toBeUndefined();
    expect(locateCategory(tree, 'retired')).toBeUndefined();
    expect(locateCategory([], 'economy')).toBeUndefined();
  });
});

describe('parentCategorySlug', () => {
  it('answers a top-level slug with itself and a seeded leaf with its parent', () => {
    expect(parentCategorySlug('economy')).toBe('economy');
    expect(parentCategorySlug('housing')).toBe('economy');
    expect(parentCategorySlug('air-quality')).toBe('weather');
  });

  it('answers undefined for a slug the seeded tree does not know', () => {
    expect(parentCategorySlug('retired')).toBeUndefined();
    expect(parentCategorySlug('')).toBeUndefined();
  });
});
