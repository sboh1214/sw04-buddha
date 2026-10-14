import { describe, expect, it } from 'vitest';
import { type Category } from './api';
import { groupCategories } from './category-tree';
import {
  currentSearchTerm,
  currentTopLevelSlug,
  isAllCategoriesCurrent,
  isPrimaryCurrent,
} from './nav';

const category = (id: number, slug: string, parentId: number | null): Category => ({
  id,
  slug,
  nameKo: slug,
  sortOrder: id * 10,
  parentId,
});

const TREE = groupCategories([
  category(1, 'economy', null),
  category(2, 'weather', null),
  category(11, 'housing', 1),
  category(21, 'rain', 2),
]);

describe('isPrimaryCurrent', () => {
  it('lights 시장 on the home list and on a market detail, nowhere else', () => {
    expect(isPrimaryCurrent('/', 'markets')).toBe(true);
    expect(isPrimaryCurrent('/markets/btc-100k', 'markets')).toBe(true);
    expect(isPrimaryCurrent('/community', 'markets')).toBe(false);
    expect(isPrimaryCurrent('/settings', 'markets')).toBe(false);
    expect(isPrimaryCurrent('/marketsx', 'markets')).toBe(false);
  });

  it('lights 커뮤니티 on its route and its subtree, not on a look-alike prefix', () => {
    expect(isPrimaryCurrent('/community', 'community')).toBe(true);
    expect(isPrimaryCurrent('/community/rules', 'community')).toBe(true);
    expect(isPrimaryCurrent('/communityx', 'community')).toBe(false);
    expect(isPrimaryCurrent('/markets/btc-100k', 'community')).toBe(false);
  });

  it('never lights two items for one path', () => {
    for (const pathname of ['/', '/markets/x', '/community', '/wallet', '/login']) {
      const lit = (['markets', 'community'] as const).filter((key) =>
        isPrimaryCurrent(pathname, key),
      );
      expect(lit.length, pathname).toBeLessThanOrEqual(1);
    }
  });
});

describe('isAllCategoriesCurrent', () => {
  it('is the home list with no category filter', () => {
    expect(isAllCategoriesCurrent('/', null)).toBe(true);
    expect(isAllCategoriesCurrent('/', undefined)).toBe(true);
  });

  it('treats a value the list itself drops as no filter: blank, whitespace, over-long', () => {
    expect(isAllCategoriesCurrent('/', '')).toBe(true);
    expect(isAllCategoriesCurrent('/', '   ')).toBe(true);
    expect(isAllCategoriesCurrent('/', 'x'.repeat(51))).toBe(true);
  });

  it('is off once a category is filtered on, even one the tree does not know', () => {
    expect(isAllCategoriesCurrent('/', 'economy')).toBe(false);
    expect(isAllCategoriesCurrent('/', 'housing')).toBe(false);
    expect(isAllCategoriesCurrent('/', 'retired')).toBe(false);
  });

  it('is off on every other route, whatever the query says', () => {
    expect(isAllCategoriesCurrent('/login', null)).toBe(false);
    expect(isAllCategoriesCurrent('/markets/btc-100k', null)).toBe(false);
    expect(isAllCategoriesCurrent('/community', '')).toBe(false);
  });
});

describe('currentTopLevelSlug', () => {
  it('answers a top-level slug with itself and a leaf with its parent', () => {
    expect(currentTopLevelSlug('/', TREE, 'weather')).toBe('weather');
    expect(currentTopLevelSlug('/', TREE, 'housing')).toBe('economy');
    expect(currentTopLevelSlug('/', TREE, 'rain')).toBe('weather');
  });

  it('trims the value the way the list does before looking it up', () => {
    expect(currentTopLevelSlug('/', TREE, ' economy ')).toBe('economy');
  });

  it('lights nothing with no filter, an unknown slug, or an empty tree', () => {
    expect(currentTopLevelSlug('/', TREE, null)).toBeUndefined();
    expect(currentTopLevelSlug('/', TREE, '')).toBeUndefined();
    expect(currentTopLevelSlug('/', TREE, 'retired')).toBeUndefined();
    expect(currentTopLevelSlug('/', [], 'economy')).toBeUndefined();
  });

  it('lights nothing off the home route, even for a slug in the tree', () => {
    expect(currentTopLevelSlug('/login', TREE, 'economy')).toBeUndefined();
    expect(currentTopLevelSlug('/markets/btc-100k', TREE, 'housing')).toBeUndefined();
  });
});

describe('currentSearchTerm', () => {
  it("is the home list's own term, trimmed the way the list trims it", () => {
    expect(currentSearchTerm('/', 'rain')).toBe('rain');
    expect(currentSearchTerm('/', '  rain  ')).toBe('rain');
  });

  it('is undefined for no search, a blank one, or one the list would refuse', () => {
    expect(currentSearchTerm('/', null)).toBeUndefined();
    expect(currentSearchTerm('/', undefined)).toBeUndefined();
    expect(currentSearchTerm('/', '')).toBeUndefined();
    expect(currentSearchTerm('/', '   ')).toBeUndefined();
    expect(currentSearchTerm('/', 'a'.repeat(101))).toBeUndefined();
  });

  it('is undefined off the home route, whatever the URL carries', () => {
    // A `q` on /community filters nothing; the box must not claim a search that is not shown.
    expect(currentSearchTerm('/community', 'rain')).toBeUndefined();
    expect(currentSearchTerm('/markets/btc-100k', 'rain')).toBeUndefined();
  });
});
