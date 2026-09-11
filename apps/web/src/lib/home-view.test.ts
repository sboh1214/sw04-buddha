import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type Category } from './api';
import { groupCategories } from './category-tree';
import { filterQuery, homeHeading, sidebarLinks } from './home-view';
import { DEFAULT_MARKET_FILTERS, type MarketFilters } from './market-keys';

const category = (id: number, slug: string, nameKo: string, parentId: number | null): Category => ({
  id,
  slug,
  nameKo,
  sortOrder: id * 10,
  parentId,
});

/** The API's own order: parents first in display order, then leaves grouped by parent. */
const TREE = groupCategories([
  category(1, 'economy', '경제', null),
  category(2, 'culture', '문화', null),
  category(11, 'housing', '부동산', 1),
  category(12, 'jobs', '고용', 1),
]);

const withCategory = (slug: string | undefined): MarketFilters => ({
  ...DEFAULT_MARKET_FILTERS,
  ...(slug === undefined ? {} : { category: slug }),
});

describe('filterQuery', () => {
  it('leaves a default view with an empty query, so its URL is a bare /', () => {
    expect(filterQuery(DEFAULT_MARKET_FILTERS)).toEqual({});
  });

  it('carries only what differs from the defaults', () => {
    expect(filterQuery({ status: 'open', sort: 'newest' })).toEqual({ sort: 'newest' });
    expect(filterQuery({ status: 'settled', sort: 'volume' })).toEqual({ status: 'settled' });
    expect(filterQuery({ ...DEFAULT_MARKET_FILTERS, category: 'jobs', q: '금리' })).toEqual({
      category: 'jobs',
      q: '금리',
    });
  });

  it('writes every non-default field at once', () => {
    expect(
      filterQuery({ status: 'settled', sort: 'closing', category: 'economy', q: 'x' }),
    ).toEqual({ category: 'economy', q: 'x', sort: 'closing', status: 'settled' });
  });
});

describe('homeHeading', () => {
  it('is the page title when no category is selected', () => {
    expect(homeHeading(TREE, withCategory(undefined))).toBe(copy.homeTitle);
  });

  it('names the top-level category for a top-level slug and the leaf for a leaf slug', () => {
    expect(homeHeading(TREE, withCategory('economy'))).toBe('경제');
    expect(homeHeading(TREE, withCategory('jobs'))).toBe('고용');
  });

  it('falls back to the page title for a slug the tree does not know, or no tree at all', () => {
    // The list still filters on the slug and answers its own empty state; there is simply no
    // name to put in a heading.
    expect(homeHeading(TREE, withCategory('retired'))).toBe(copy.homeTitle);
    expect(homeHeading([], withCategory('economy'))).toBe(copy.homeTitle);
  });
});

describe('sidebarLinks', () => {
  it('is empty when no category is selected and when the slug is not in the tree', () => {
    expect(sidebarLinks(TREE, withCategory(undefined))).toEqual([]);
    expect(sidebarLinks(TREE, withCategory('retired'))).toEqual([]);
    expect(sidebarLinks([], withCategory('economy'))).toEqual([]);
  });

  it('lists 전체 시장 first, active, then the leaves in order for a top-level slug', () => {
    const links = sidebarLinks(TREE, withCategory('economy'));
    expect(links.map((link) => link.label)).toEqual([copy.marketsAllInCategory, '부동산', '고용']);
    expect(links.map((link) => link.active)).toEqual([true, false, false]);
    expect(links.map((link) => link.testId)).toEqual([
      'market-subcategory-all',
      'market-subcategory-housing',
      'market-subcategory-jobs',
    ]);
    expect(links.map((link) => link.query)).toEqual([
      { category: 'economy' },
      { category: 'housing' },
      { category: 'jobs' },
    ]);
  });

  it('marks the leaf active and 전체 시장 inactive for a leaf slug', () => {
    const links = sidebarLinks(TREE, withCategory('jobs'));
    expect(links.map((link) => link.active)).toEqual([false, false, true]);
    // The 전체 시장 row still points at the PARENT, which is how a visitor widens back out.
    expect(links[0]?.query).toEqual({ category: 'economy' });
  });

  it('draws every row with the top-level glyph, leaves included', () => {
    for (const link of sidebarLinks(TREE, withCategory('housing'))) {
      expect(link.iconSlug).toBe('economy');
    }
  });

  it('carries the sort, the status and the search term into every row', () => {
    // The sidebar refines the list the visitor is already looking at; only the category changes.
    const filters: MarketFilters = {
      status: 'settled',
      sort: 'closing',
      category: 'economy',
      q: '금리',
    };
    for (const link of sidebarLinks(TREE, filters)) {
      expect(link.query).toMatchObject({ status: 'settled', sort: 'closing', q: '금리' });
    }
  });

  it('shows 전체 시장 alone for a top-level category with no leaves', () => {
    const links = sidebarLinks(TREE, withCategory('culture'));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ active: true, testId: 'market-subcategory-all' });
  });
});
