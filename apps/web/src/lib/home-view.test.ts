import { MARKET_SORTS } from '@buddha/shared';
import { hashKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type Category } from './api';
import { groupCategories } from './category-tree';
import {
  filterQuery,
  homeHeading,
  homePath,
  isWatchlistView,
  listEmptyMessage,
  sidebarLinks,
  sortOptions,
  watchlistToggleTarget,
  watchlistViewFilters,
  watchlistViewLoginPath,
  withSort,
} from './home-view';
import {
  DEFAULT_MARKET_FILTERS,
  type HomeFilters,
  type MarketFilters,
  type WatchlistViewFilters,
  watchlistPagesKey,
} from './market-keys';
import { filtersFromSearchParams } from './market-ssr';

/** The 관심 시장 view on its first order, no category. */
const WATCHING: WatchlistViewFilters = { watchlist: true, sort: 'watched' };

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
    expect(homePath(DEFAULT_MARKET_FILTERS)).toBe('/');
  });

  it('carries only what differs from the defaults, and never a status or a search term', () => {
    // The home has no status filter (ADR-0061 decision 1, item 13) and no search (item 14: the
    // search is its own screen, ADR-0066); the old `status` and `q` keys are gone — this PR took
    // the term off the home, so the expectation that carried it is gone with it.
    expect(filterQuery({ sort: 'newest' })).toEqual({ sort: 'newest' });
    expect(filterQuery({ sort: 'recommended' })).toEqual({});
    expect(filterQuery({ ...DEFAULT_MARKET_FILTERS, category: 'jobs' })).toEqual({
      category: 'jobs',
    });
  });

  it('writes every non-default field at once', () => {
    expect(filterQuery({ sort: 'closing', category: 'economy' })).toEqual({
      category: 'economy',
      sort: 'closing',
    });
    expect(homePath({ sort: 'closing', category: 'economy' })).toBe(
      '/?category=economy&sort=closing',
    );
  });

  it('writes the 관심 시장 view as ?watchlist=1, its own default order left out', () => {
    expect(filterQuery(WATCHING)).toEqual({ watchlist: '1' });
    expect(homePath(WATCHING)).toBe('/?watchlist=1');
    expect(filterQuery({ ...WATCHING, sort: 'recommended', category: 'economy' })).toEqual({
      category: 'economy',
      sort: 'recommended',
      watchlist: '1',
    });
  });

  it('round-trips through filtersFromSearchParams for every view and order', () => {
    const views: HomeFilters[] = [
      ...MARKET_SORTS.map((sort) => ({ sort, category: 'jobs' })),
      { sort: 'newest' },
      ...(['watched', ...MARKET_SORTS] as const).map((sort) => ({
        watchlist: true as const,
        sort,
        category: 'economy',
      })),
    ];
    for (const view of views) expect(filtersFromSearchParams(filterQuery(view))).toEqual(view);
  });
});

describe('sortOptions and withSort', () => {
  it('offers 추천 · 신규 · 마감 임박 on the public list, nothing else (ADR-0061 decision 1)', () => {
    expect(sortOptions(DEFAULT_MARKET_FILTERS)).toEqual(['recommended', 'newest', 'closing']);
  });

  it('puts 최근 관심 등록 순 last in the 관심 시장 view (owner decision 2026-10-16)', () => {
    // Last although the view starts on it (decision 3, the #63 row): the three public orders
    // keep their places, whichever order is picked.
    expect(sortOptions(WATCHING)).toEqual(['recommended', 'newest', 'closing', 'watched']);
    expect(sortOptions({ ...WATCHING, sort: 'closing' })).toEqual(sortOptions(WATCHING));
    expect(WATCHING.sort).toBe('watched');
    expect(filtersFromSearchParams({ watchlist: '1' }).sort).toBe('watched');
  });

  it('changes the order and nothing else', () => {
    expect(withSort({ sort: 'recommended', category: 'jobs' }, 'closing')).toEqual({
      sort: 'closing',
      category: 'jobs',
    });
    expect(withSort({ ...WATCHING, category: 'jobs' }, 'newest')).toEqual({
      ...WATCHING,
      category: 'jobs',
      sort: 'newest',
    });
    // `watched` is not an option on the public list; if it ever arrived it would be the default.
    expect(withSort(DEFAULT_MARKET_FILTERS, 'watched')).toEqual(DEFAULT_MARKET_FILTERS);
  });
});

describe('watchlistToggleTarget', () => {
  it('turns the view on for a member and while the session is unknown, on 최근 관심 등록 순', () => {
    for (const signedIn of [true, undefined]) {
      expect(watchlistToggleTarget(DEFAULT_MARKET_FILTERS, signedIn)).toBe('/?watchlist=1');
      // The category stays (they combine, ADR-0061 decision 1, item 12); the public order does
      // not — the view starts on its own order.
      expect(watchlistToggleTarget({ sort: 'closing', category: 'economy' }, signedIn)).toBe(
        '/?category=economy&watchlist=1',
      );
    }
  });

  it('sends a signed-out visitor to sign in and back to the view with the toggle on', () => {
    const target = watchlistToggleTarget({ sort: 'newest', category: 'economy' }, false);
    expect(target).toBe(`/login?next=${encodeURIComponent('/?category=economy&watchlist=1')}`);
    const next = new URL(target, 'https://x.invalid').searchParams.get('next');
    expect(next).toBe('/?category=economy&watchlist=1');
    expect(
      filtersFromSearchParams(Object.fromEntries(new URL(next!, 'https://x.invalid').searchParams)),
    ).toEqual({
      watchlist: true,
      sort: 'watched',
      category: 'economy',
    });
  });

  it('turns the view off for anyone, back to the public list of the category on 추천', () => {
    // Whatever order the view was on (owner decision 2026-10-16): the public list starts over.
    for (const signedIn of [true, false, undefined]) {
      expect(watchlistToggleTarget({ ...WATCHING, sort: 'closing' }, signedIn)).toBe('/');
      expect(watchlistToggleTarget({ ...WATCHING, category: 'jobs' }, signedIn)).toBe(
        '/?category=jobs',
      );
    }
  });
});

describe('the 관심 시장 view’s list and sign-in prompt', () => {
  it('asks GET /me/watchlist for the open markets of the category in the picked order', () => {
    expect(watchlistViewFilters(WATCHING)).toEqual({ status: 'open', sort: 'watched' });
    expect(watchlistViewFilters({ ...WATCHING, sort: 'recommended', category: 'jobs' })).toEqual({
      status: 'open',
      sort: 'recommended',
      category: 'jobs',
    });
    // A different entry from MY's `{}`: MY lists every status, the home only open markets.
    expect(hashKey(watchlistPagesKey(watchlistViewFilters(WATCHING)))).not.toBe(
      hashKey(watchlistPagesKey({})),
    );
  });

  it('brings a signed-out visitor back to the very view, order and category included', () => {
    expect(watchlistViewLoginPath({ ...WATCHING, sort: 'closing', category: 'jobs' })).toBe(
      `/login?next=${encodeURIComponent('/?category=jobs&sort=closing&watchlist=1')}`,
    );
  });

  it('is told apart from the public list by the URL alone', () => {
    expect(isWatchlistView(WATCHING)).toBe(true);
    expect(isWatchlistView(DEFAULT_MARKET_FILTERS)).toBe(false);
  });
});

describe('listEmptyMessage', () => {
  it('says nothing is open on an empty public list, and never that a search found nothing', () => {
    // The home does not search any more (ADR-0066): 'no results' is the search screen's own
    // (copy.marketsSearchEmpty) — the expectation for a home search is gone with the home's `q`.
    expect(listEmptyMessage(DEFAULT_MARKET_FILTERS)).toBe(copy.marketsEmpty);
    expect(listEmptyMessage({ sort: 'closing', category: 'jobs' })).toBe(copy.marketsEmpty);
    expect(listEmptyMessage({ sort: 'newest' })).not.toBe(copy.marketsSearchEmpty);
  });

  it('gives the 관심 시장 view its own, whatever its order and category', () => {
    const views: WatchlistViewFilters[] = [
      WATCHING,
      { ...WATCHING, sort: 'newest', category: 'jobs' },
    ];
    for (const filters of views) expect(listEmptyMessage(filters)).toBe(copy.watchlistViewEmpty);
    // Three different sentences: no view borrows another's.
    expect(
      new Set([copy.marketsEmpty, copy.marketsSearchEmpty, copy.watchlistViewEmpty]).size,
    ).toBe(3);
  });

  it('ends the 관심 시장 view’s on MY’s own hint, word for word (owner decision 2026-10-16)', () => {
    const hint = '시장 상세에서 관심 등록을 누르면 여기에 모입니다.';
    // The status is named by the 거래 중 label since #174 (ADR-0093 decision 1 item 12).
    expect(copy.watchlistViewEmpty).toBe(`거래 중인 관심 시장이 없습니다. ${hint}`);
    expect(copy.watchlistEmpty).toBe(`아직 관심 시장이 없습니다. ${hint}`);
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

  it('carries the sort into every row', () => {
    // The sidebar refines the list the visitor is already looking at; only the category changes.
    // The home has no search term to carry any more (ADR-0066).
    const filters: MarketFilters = { sort: 'closing', category: 'economy' };
    for (const link of sidebarLinks(TREE, filters)) {
      expect(link.query).toMatchObject({ sort: 'closing' });
      expect(link.query).not.toHaveProperty('q');
    }
  });

  it('keeps the 관심 시장 view and its order on every row: they combine (ADR-0061 decision 1)', () => {
    const links = sidebarLinks(TREE, { ...WATCHING, sort: 'newest', category: 'economy' });
    expect(links.map((link) => link.query)).toEqual([
      { category: 'economy', sort: 'newest', watchlist: '1' },
      { category: 'housing', sort: 'newest', watchlist: '1' },
      { category: 'jobs', sort: 'newest', watchlist: '1' },
    ]);
  });

  it('shows 전체 시장 alone for a top-level category with no leaves', () => {
    const links = sidebarLinks(TREE, withCategory('culture'));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ active: true, testId: 'market-subcategory-all' });
  });
});
