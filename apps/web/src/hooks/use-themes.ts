'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { type Theme, type ThemeSummary, api, unwrap } from '@/lib/api';
import { type MarketPage } from '@/lib/market-live';
import {
  HOME_THEMES_KEY,
  THEME_LIST_KEY,
  type ThemeListPage,
  type ThemeResultPage,
  homeThemesQuery,
  marketThemesKey,
  themeKey,
  themeMarketsKey,
  themePageQuery,
  themeResultsKey,
} from '@/lib/themes';

/**
 * 테마 (#81, ADR-0088) in public: the list, the explore home's theme row, a theme's page, its
 * markets and its results, and the themes a market is in. Every key, request shape and SSR seed is
 * lib/themes.ts's — a module the server pages can call — and the query-option factories are
 * exported apart from the hooks so the unit tests reach them without React (use-markets.ts gives
 * the same reason).
 *
 * All public: the server pages read the first page of each without a cookie and dehydrate it, so
 * the first paint costs no request, and a read that failed there is read here.
 */

/** The public list (`GET /themes`), 20 a page in the API's order (진행 중 → 예정 → 종료). */
export function themeListInfiniteQueryOptions() {
  return {
    queryKey: THEME_LIST_KEY,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<ThemeListPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/themes', { params: { query: themePageQuery(pageParam) } }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ThemeListPage) => last.nextCursor ?? undefined,
  };
}

export function useThemeList() {
  return useInfiniteQuery(themeListInfiniteQueryOptions());
}

/**
 * The explore home's theme row (ADR-0069 decision 4, '탐색 홈 노출'): the first few published
 * themes in the list's order, which `homeThemesRow` reads as the ongoing ones, else the upcoming
 * ones, else none but 모든 테마 (owner decision 2026-10-19, second round). One page: the row is a
 * few links and 모든 테마 leads on.
 */
export function homeThemesQueryOptions() {
  return {
    queryKey: HOME_THEMES_KEY,
    queryFn: async (): Promise<ThemeSummary[]> =>
      unwrap(await api.GET('/api/v1/themes', { params: { query: homeThemesQuery() } })).data,
  };
}

export function useHomeThemes() {
  return useQuery(homeThemesQueryOptions());
}

/**
 * A theme's page (`GET /themes/:idOrSlug`), keyed and asked by the row's lower-cased id: the
 * server page read it by the address's slug and seeded it under the id (`seedTheme`).
 */
export function themeQueryOptions(themeId: string) {
  const id = themeId.toLowerCase();
  return {
    queryKey: themeKey(id),
    queryFn: async (): Promise<Theme> =>
      unwrap(await api.GET('/api/v1/themes/{idOrSlug}', { params: { path: { idOrSlug: id } } }))
        .data,
  };
}

export function useTheme(themeId: string) {
  return useQuery(themeQueryOptions(themeId));
}

/**
 * A theme's markets (`GET /themes/:id/markets`) as the home's cards, 20 a page — under the public
 * market lists' root (`['markets', 'theme', id]`), so the card join, the socket's card writes and
 * the reconnect's re-read reach them as they reach 관련 시장 (lib/themes.ts says why).
 */
export function themeMarketsInfiniteQueryOptions(themeId: string) {
  const id = themeId.toLowerCase();
  return {
    queryKey: themeMarketsKey(id),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<MarketPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/themes/{id}/markets', {
          params: { path: { id }, query: themePageQuery(pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: MarketPage) => last.nextCursor ?? undefined,
  };
}

export function useThemeMarkets(themeId: string) {
  return useInfiniteQuery(themeMarketsInfiniteQueryOptions(themeId));
}

/** A theme's results list (`GET /themes/:id/results`), the latest decided first, 20 a page. */
export function themeResultsInfiniteQueryOptions(themeId: string) {
  const id = themeId.toLowerCase();
  return {
    queryKey: themeResultsKey(id),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<ThemeResultPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/themes/{id}/results', {
          params: { path: { id }, query: themePageQuery(pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ThemeResultPage) => last.nextCursor ?? undefined,
  };
}

export function useThemeResults(themeId: string) {
  return useInfiniteQuery(themeResultsInfiniteQueryOptions(themeId));
}

/** The published themes a market is in (`GET /markets/:id/themes`), for its detail's links. */
export function marketThemesQueryOptions(marketId: string) {
  const id = marketId.toLowerCase();
  return {
    queryKey: marketThemesKey(id),
    queryFn: async (): Promise<ThemeSummary[]> =>
      unwrap(await api.GET('/api/v1/markets/{id}/themes', { params: { path: { id } } })).data,
  };
}

export function useMarketThemes(marketId: string) {
  return useQuery(marketThemesQueryOptions(marketId));
}
