import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AdminMarket, type AdminTheme, type AdminThemeMarket, api } from '@/lib/api';
import {
  HOME_THEMES_KEY,
  THEME_LIST_KEY,
  homeThemesQuery,
  marketThemesKey,
  refreshThemeResultsOnStatus,
  themeKey,
  themeMarketsKey,
  themeResultsKey,
} from '@/lib/themes';
import { applyMarket } from './use-admin-markets';
import {
  ADMIN_THEMES_KEY,
  adminThemeKey,
  adminThemeMarketsKey,
  applyAdminTheme,
  applyAdminThemeMarkets,
} from './use-admin-themes';
import {
  homeThemesQueryOptions,
  marketThemesQueryOptions,
  themeListInfiniteQueryOptions,
  themeMarketsInfiniteQueryOptions,
  themeQueryOptions,
  themeResultsInfiniteQueryOptions,
} from './use-themes';

/**
 * 테마 (#81, ADR-0088): the public option factories — keys, requests, page params — and what an
 * admin write marks, through a real QueryClient. Nothing renders (vitest runs with no DOM here).
 */

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const MARKET_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';

const ok = (data: unknown) => ({
  data: { data, meta: { nextCursor: null } },
  response: new Response(null, { status: 200 }),
});

type Call = [string, { params: { path?: unknown; query?: unknown } }];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the public theme reads', () => {
  it('keys each read on the lower-cased id and pages by the wire’s cursor', () => {
    expect(themeQueryOptions(ID.toUpperCase()).queryKey).toEqual(themeKey(ID));
    expect(themeMarketsInfiniteQueryOptions(ID.toUpperCase()).queryKey).toEqual(
      themeMarketsKey(ID),
    );
    expect(themeResultsInfiniteQueryOptions(ID.toUpperCase()).queryKey).toEqual(
      themeResultsKey(ID),
    );
    expect(marketThemesQueryOptions(MARKET_ID.toUpperCase()).queryKey).toEqual(
      marketThemesKey(MARKET_ID),
    );
    expect(themeListInfiniteQueryOptions().queryKey).toEqual(THEME_LIST_KEY);
    expect(homeThemesQueryOptions().queryKey).toEqual(HOME_THEMES_KEY);
    for (const options of [
      themeListInfiniteQueryOptions(),
      themeMarketsInfiniteQueryOptions(ID),
      themeResultsInfiniteQueryOptions(ID),
    ]) {
      expect(options.initialPageParam).toBeUndefined();
      expect(options.getNextPageParam({ items: [], nextCursor: 'c' })).toBe('c');
      expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
    }
  });

  it('sends each route with its path and the page’s cursor', async () => {
    // `as never`: one answer for six routes, whose response types the client keeps apart.
    const spy = vi.spyOn(api, 'GET').mockResolvedValue(ok([]) as never);
    await themeListInfiniteQueryOptions().queryFn({ pageParam: 'c1' });
    await homeThemesQueryOptions().queryFn();
    await themeQueryOptions(ID.toUpperCase()).queryFn();
    await themeMarketsInfiniteQueryOptions(ID).queryFn({ pageParam: undefined });
    await themeResultsInfiniteQueryOptions(ID).queryFn({ pageParam: 'c2' });
    await marketThemesQueryOptions(MARKET_ID).queryFn();
    const calls = spy.mock.calls as unknown as Call[];
    expect(calls.map(([route, init]) => ({ route, ...init.params }))).toEqual([
      { route: '/api/v1/themes', query: { cursor: 'c1' } },
      { route: '/api/v1/themes', query: homeThemesQuery() },
      { route: '/api/v1/themes/{idOrSlug}', path: { idOrSlug: ID } },
      { route: '/api/v1/themes/{id}/markets', path: { id: ID }, query: {} },
      { route: '/api/v1/themes/{id}/results', path: { id: ID }, query: { cursor: 'c2' } },
      { route: '/api/v1/markets/{id}/themes', path: { id: MARKET_ID } },
    ]);
  });
});

const theme: AdminTheme = {
  id: ID,
  slug: '2026-election',
  name: '선거 주간',
  startDate: '2026-10-20',
  endDate: '2026-11-03',
  status: 'upcoming',
  publishedAt: '2026-10-19T00:00:00.000Z',
  firstPublishedAt: '2026-10-19T00:00:00.000Z',
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
  intro: '소개',
  createdBy: { id: 'admin-1', nickname: '운영자' },
  notices: [],
};

/** A client holding one entry of each theme read, none mounted. */
function heldClient() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const key of [
    THEME_LIST_KEY,
    HOME_THEMES_KEY,
    themeKey(ID),
    themeResultsKey(ID),
    marketThemesKey(MARKET_ID),
    themeMarketsKey(ID),
    ADMIN_THEMES_KEY,
    adminThemeMarketsKey(ID),
  ]) {
    queryClient.setQueryData(key, { held: true });
  }
  const invalidated = (key: readonly unknown[]) =>
    queryClient.getQueryState(key)?.isInvalidated === true;
  return { queryClient, invalidated };
}

describe('what an admin theme write marks', () => {
  it('seeds the theme and marks the admin list and every public theme read, not the cards', async () => {
    const { queryClient, invalidated } = heldClient();
    await applyAdminTheme(queryClient, theme);
    expect(queryClient.getQueryData(adminThemeKey(ID))).toEqual(theme);
    for (const key of [
      ADMIN_THEMES_KEY,
      THEME_LIST_KEY,
      HOME_THEMES_KEY,
      themeKey(ID),
      themeResultsKey(ID),
      marketThemesKey(MARKET_ID),
    ]) {
      expect(invalidated(key), JSON.stringify(key)).toBe(true);
    }
    // A name, a period, a notice or the publication moves no card.
    expect(invalidated(themeMarketsKey(ID))).toBe(false);
    expect(invalidated(adminThemeMarketsKey(ID))).toBe(false);
    // Marked, never written: the public entries keep what they held until they ask again.
    expect(queryClient.getQueryData(themeKey(ID))).toEqual({ held: true });
  });

  it('puts the answer of a link on screen and marks the cards, the results and the links', async () => {
    const { queryClient, invalidated } = heldClient();
    const fresh: AdminThemeMarket[] = [];
    await applyAdminThemeMarkets(queryClient, ID, fresh);
    expect(queryClient.getQueryData(adminThemeMarketsKey(ID))).toBe(fresh);
    for (const key of [themeMarketsKey(ID), themeResultsKey(ID), marketThemesKey(MARKET_ID)]) {
      expect(invalidated(key), JSON.stringify(key)).toBe(true);
    }
  });

  it('marks every theme’s cards and results when an admin moves a market', async () => {
    // A market's status decides whether it is a result, and its title is on its card: which
    // themes hold it is the server's to say, so every one is marked.
    const { queryClient, invalidated } = heldClient();
    await applyMarket(queryClient, MARKET_ID, {
      id: MARKET_ID,
    } as unknown as AdminMarket);
    for (const key of [themeMarketsKey(ID), themeResultsKey(ID), adminThemeMarketsKey(ID)]) {
      expect(invalidated(key), JSON.stringify(key)).toBe(true);
    }
    // The list, the page and the links hold nothing of a market's own.
    expect(invalidated(THEME_LIST_KEY)).toBe(false);
    expect(invalidated(themeKey(ID))).toBe(false);
  });
});

describe('what a market status event marks (realtime-provider.tsx)', () => {
  const OTHER_ID = '5d2f2a38-91f3-4c3e-8a7e-1f1c0d6f0a11';

  it('marks every theme’s results when a market’s result is confirmed, paid or settled', async () => {
    // THEME_RESULT_STATUSES (ADR-0093 decision 3, the #174 row): 결과 확정·지급 중·지급 완료.
    for (const status of ['resolved', 'settling', 'settled'] as const) {
      const { queryClient, invalidated } = heldClient();
      queryClient.setQueryData(themeResultsKey(OTHER_ID), { held: true });
      await refreshThemeResultsOnStatus(queryClient, status);
      // Which themes hold the market is the server's to say.
      for (const key of [themeResultsKey(ID), themeResultsKey(OTHER_ID)]) {
        expect(invalidated(key), `${status} ${JSON.stringify(key)}`).toBe(true);
      }
      // Nothing else of a theme: the cards move with the event itself.
      for (const key of [THEME_LIST_KEY, themeKey(ID), themeMarketsKey(ID)]) {
        expect(invalidated(key), `${status} ${JSON.stringify(key)}`).toBe(false);
      }
    }
  });

  it('marks nothing for a status before a confirmed result, nor for a cancelled market', () => {
    // A provisional result may still be corrected (not in the list), and a cancelled market has
    // no result at all.
    for (const status of [
      'draft',
      'scheduled',
      'open',
      'paused',
      'closed',
      'provisional',
      'cancelled',
    ] as const) {
      const { queryClient, invalidated } = heldClient();
      expect(refreshThemeResultsOnStatus(queryClient, status)).toBeUndefined();
      expect(invalidated(themeResultsKey(ID)), status).toBe(false);
    }
  });
});
