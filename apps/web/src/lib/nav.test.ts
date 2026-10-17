import { describe, expect, it } from 'vitest';
import { type Category } from './api';
import { groupCategories } from './category-tree';
import { filtersFromSearchParams } from './market-ssr';
import {
  type PrimaryNavKey,
  categoryLinkQuery,
  currentSearchTerm,
  currentTopLevelSlug,
  isAllCategoriesCurrent,
  isPrimaryCurrent,
  primaryNavItems,
  showsCategoryRow,
} from './nav';

const KEYS: readonly PrimaryNavKey[] = ['markets', 'community', 'my'];

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

describe('primaryNavItems', () => {
  it('lists 시장 탐색 · 커뮤니티 · MY, in that order, for a signed-in reader', () => {
    expect(primaryNavItems(true).map((item) => [item.key, item.href, item.label])).toEqual([
      ['markets', '/', '시장 탐색'],
      ['community', '/community', '커뮤니티'],
      ['my', '/my', 'MY'],
    ]);
  });

  it('leaves MY out for a visitor with no session, and nothing else', () => {
    expect(primaryNavItems(false).map((item) => item.key)).toEqual(['markets', 'community']);
  });
});

describe('isPrimaryCurrent', () => {
  it('lights 시장 탐색 on the home list, a market detail and the search screen, nowhere else', () => {
    expect(isPrimaryCurrent('/', 'markets')).toBe(true);
    expect(isPrimaryCurrent('/markets/btc-100k', 'markets')).toBe(true);
    // Owner decision 2026-10-16 (ADR-0066): "시장 탐색을 켠다" on /search, at every width (the
    // header's row 1 and the tab bar read this one rule).
    expect(isPrimaryCurrent('/search', 'markets')).toBe(true);
    expect(isPrimaryCurrent('/community', 'markets')).toBe(false);
    expect(isPrimaryCurrent('/my/settings', 'markets')).toBe(false);
    expect(isPrimaryCurrent('/marketsx', 'markets')).toBe(false);
    expect(isPrimaryCurrent('/searches', 'markets')).toBe(false);
    expect(isPrimaryCurrent('/search/x', 'markets')).toBe(false);
  });

  it('lights 커뮤니티 on its route and its subtree, not on a look-alike prefix', () => {
    expect(isPrimaryCurrent('/community', 'community')).toBe(true);
    expect(isPrimaryCurrent('/community/rules', 'community')).toBe(true);
    expect(isPrimaryCurrent('/communityx', 'community')).toBe(false);
    expect(isPrimaryCurrent('/markets/btc-100k', 'community')).toBe(false);
  });

  it('lights MY on the summary and on every tab under it, not on a look-alike prefix', () => {
    for (const pathname of ['/my', '/my/positions', '/my/wallet', '/my/settings']) {
      expect(isPrimaryCurrent(pathname, 'my'), pathname).toBe(true);
    }
    expect(isPrimaryCurrent('/mysterious', 'my')).toBe(false);
    expect(isPrimaryCurrent('/', 'my')).toBe(false);
    expect(isPrimaryCurrent('/admin/users', 'my')).toBe(false);
  });

  it('never lights two items for one path, and none off the three areas', () => {
    for (const pathname of [
      '/',
      '/markets/x',
      '/search',
      '/community',
      '/my',
      '/my/wallet',
      '/login',
    ]) {
      const lit = KEYS.filter((key) => isPrimaryCurrent(pathname, key));
      expect(lit.length, pathname).toBeLessThanOrEqual(1);
    }
    for (const pathname of ['/login', '/terms', '/onboarding', '/admin/markets']) {
      expect(
        KEYS.filter((key) => isPrimaryCurrent(pathname, key)),
        pathname,
      ).toEqual([]);
    }
  });
});

describe('showsCategoryRow', () => {
  it('is on for the home list and a market detail', () => {
    expect(showsCategoryRow('/')).toBe(true);
    expect(showsCategoryRow('/markets/btc-100k')).toBe(true);
  });

  it('is off everywhere else', () => {
    for (const pathname of [
      '/community',
      '/my',
      '/my/wallet',
      '/login',
      '/terms',
      '/onboarding',
      '/admin/markets',
      '/marketsx',
      // The search screen (ADR-0066): the row stays on / and /markets/* only (ADR-0054), though
      // 시장 탐색 is lit there (owner decision 2026-10-16).
      '/search',
    ]) {
      expect(showsCategoryRow(pathname), pathname).toBe(false);
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
  const url = (search: string) => new URLSearchParams(search);

  it("is the search screen's own term, trimmed the way the screen trims it (ADR-0066)", () => {
    expect(currentSearchTerm('/search', url('q=rain'))).toBe('rain');
    expect(currentSearchTerm('/search', url(`q=${encodeURIComponent('  rain  ')}`))).toBe('rain');
    // A filter beside it changes nothing: the results are of that term within it.
    expect(currentSearchTerm('/search', url('q=rain&status=closed&category=weather'))).toBe('rain');
  });

  it('is undefined for no search, a blank one, or one the screen would refuse', () => {
    expect(currentSearchTerm('/search', url(''))).toBeUndefined();
    expect(currentSearchTerm('/search', url('q='))).toBeUndefined();
    expect(currentSearchTerm('/search', url('q=%20%20%20'))).toBeUndefined();
    expect(currentSearchTerm('/search', url(`q=${'a'.repeat(101)}`))).toBeUndefined();
  });

  it('is undefined off the search screen, the home included, whatever the URL carries', () => {
    // The home has not read `q` since the search moved to its own screen (ADR-0066), so an old
    // `/?q=rain` searches nothing and the box must not claim it does — this PR changed what the
    // box reads, and the expectations that read it on `/` changed with it.
    expect(currentSearchTerm('/', url('q=rain'))).toBeUndefined();
    expect(currentSearchTerm('/', url('watchlist=1&q=rain'))).toBeUndefined();
    expect(currentSearchTerm('/community', url('q=rain'))).toBeUndefined();
    expect(currentSearchTerm('/markets/btc-100k', url('q=rain'))).toBeUndefined();
    expect(currentSearchTerm('/searches', url('q=rain'))).toBeUndefined();
  });
});

describe('categoryLinkQuery', () => {
  const url = (search: string) => new URLSearchParams(search);

  it('is a fresh ?category= outside the 관심 시장 view, whatever else the URL carries', () => {
    // A way INTO the list (ADR-0041): the sort and a search term are left behind.
    for (const search of [
      '',
      'sort=newest',
      'q=rain&sort=closing&category=weather',
      'watchlist=yes',
    ]) {
      expect(categoryLinkQuery('/', url(search), 'economy'), search).toEqual({
        category: 'economy',
      });
      expect(categoryLinkQuery('/', url(search), undefined), search).toEqual({});
    }
  });

  it('keeps the 관심 시장 view on, with its order, and changes only the category (owner decision 2026-10-16)', () => {
    expect(categoryLinkQuery('/', url('sort=newest&watchlist=1'), 'economy')).toEqual({
      category: 'economy',
      sort: 'newest',
      watchlist: '1',
    });
    // From one category to another, and 전체 widens back out of it, still in the view.
    expect(
      categoryLinkQuery('/', url('category=housing&sort=closing&watchlist=1'), 'weather'),
    ).toEqual({
      category: 'weather',
      sort: 'closing',
      watchlist: '1',
    });
    expect(
      categoryLinkQuery('/', url('category=housing&sort=closing&watchlist=1'), undefined),
    ).toEqual({
      sort: 'closing',
      watchlist: '1',
    });
    // The view's own first order stays out of the URL, as the view writes it (filterQuery).
    expect(categoryLinkQuery('/', url('watchlist=1'), 'economy')).toEqual({
      category: 'economy',
      watchlist: '1',
    });
    expect(categoryLinkQuery('/', url('watchlist=1&sort=watched'), undefined)).toEqual({
      watchlist: '1',
    });
  });

  it('reads the view the way the list does: an order it does not know, and the term it drops', () => {
    // `volume` is no order (ADR-0061 decision 1, item 11): the list is on 최근 관심 등록 순, and
    // so is the link. The view has no search, so a hand-edited `q` goes nowhere.
    expect(categoryLinkQuery('/', url('watchlist=1&sort=volume&q=rain'), 'economy')).toEqual({
      category: 'economy',
      watchlist: '1',
    });
  });

  it('lands on the view it names, as the home normalises it', () => {
    const query = categoryLinkQuery('/', url('sort=recommended&watchlist=1'), 'economy');
    expect(filtersFromSearchParams(query)).toEqual({
      watchlist: true,
      sort: 'recommended',
      category: 'economy',
    });
  });

  it('is the plain link off the home route, where a ?watchlist=1 shows no list', () => {
    expect(
      categoryLinkQuery('/markets/btc-100k', url('watchlist=1&sort=newest'), 'economy'),
    ).toEqual({ category: 'economy' });
    expect(categoryLinkQuery('/markets/btc-100k', url('watchlist=1'), undefined)).toEqual({});
  });
});
