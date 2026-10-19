'use client';

import { type QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  type AdminTheme,
  type AdminThemeMarket,
  type AdminThemeSummary,
  api,
  unwrap,
} from '@/lib/api';
import { THEMES_KEY, THEME_MARKETS_KEY } from '@/lib/themes';

/**
 * 테마 (#81, ADR-0088) for admins: the list, one theme with its notices, and its markets. Every
 * key is under the private `['admin']` root, so nothing here is ever dehydrated into a page.
 */

export const ADMIN_THEMES_KEY = ['admin', 'themes'] as const;
export const ADMIN_THEME_KEY = ['admin', 'theme'] as const;
export const ADMIN_THEME_MARKETS_KEY = ['admin', 'theme-markets'] as const;

export const adminThemeKey = (id: string) => [...ADMIN_THEME_KEY, id.toLowerCase()] as const;
export const adminThemeMarketsKey = (id: string) =>
  [...ADMIN_THEME_MARKETS_KEY, id.toLowerCase()] as const;

/** Every theme, published or not, the newest first, 20 a page (`GET /admin/themes`). */
export function useAdminThemes() {
  return useInfiniteQuery({
    queryKey: ADMIN_THEMES_KEY,
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<{ items: AdminThemeSummary[]; nextCursor: string | null }> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/themes', {
          params: { query: pageParam === undefined ? {} : { cursor: pageParam } },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
  });
}

/** One theme with every notice, hidden ones too (`GET /admin/themes/:id`). */
export function useAdminTheme(id: string, enabled: boolean) {
  return useQuery({
    queryKey: adminThemeKey(id),
    queryFn: async (): Promise<AdminTheme> =>
      unwrap(await api.GET('/api/v1/admin/themes/{id}', { params: { path: { id } } })).data,
    enabled,
  });
}

/** The theme's markets in any status, the latest put in first (`GET /admin/themes/:id/markets`). */
export function useAdminThemeMarkets(id: string, enabled: boolean) {
  return useQuery({
    queryKey: adminThemeMarketsKey(id),
    queryFn: async (): Promise<AdminThemeMarket[]> =>
      unwrap(await api.GET('/api/v1/admin/themes/{id}/markets', { params: { path: { id } } })).data,
    enabled,
  });
}

/**
 * The public theme reads a theme write can change: the list and the home's row (name, period,
 * publication), a page (its notices) and the market detail's links — all under `['themes']` —
 * and, for a write that puts a market in or takes one out, the theme's cards under
 * `['markets', 'theme']`. Marked rather than written: `refetchType` stays `'active'`, so only a
 * mounted list asks again and the rest ask on their next mount (PLAN 11.5).
 */
function invalidatePublicThemes(queryClient: QueryClient, markets: boolean) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: THEMES_KEY }),
    markets ? queryClient.invalidateQueries({ queryKey: THEME_MARKETS_KEY }) : undefined,
  ]);
}

/**
 * After a write that answered with the theme (create, edit, publish, unpublish and every notice
 * write): show what the server just committed, then mark the admin list and the public reads. The
 * seed and the invalidations stay in one synchronous block, for the reason `applyMarket` gives
 * (hooks/use-admin-markets.ts): a GET already in flight must not land on top of the seed.
 */
export function applyAdminTheme(queryClient: QueryClient, fresh: AdminTheme) {
  queryClient.setQueryData(adminThemeKey(fresh.id), fresh);
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: adminThemeKey(fresh.id) }),
    queryClient.invalidateQueries({ queryKey: ADMIN_THEMES_KEY }),
    invalidatePublicThemes(queryClient, false),
  ]);
}

/**
 * After a market was put in or taken out: the theme's markets as the answer says, then the
 * public cards, results and the detail links of the market (`['themes', 'market', id]`), all of
 * which the link changes.
 */
export function applyAdminThemeMarkets(
  queryClient: QueryClient,
  themeId: string,
  fresh: AdminThemeMarket[],
) {
  queryClient.setQueryData(adminThemeMarketsKey(themeId), fresh);
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: adminThemeMarketsKey(themeId) }),
    invalidatePublicThemes(queryClient, true),
  ]);
}
