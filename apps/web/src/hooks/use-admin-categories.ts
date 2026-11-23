'use client';

import { type QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ADMIN_MARKETS_KEY, ADMIN_MARKET_KEY } from '@/hooks/use-admin-markets';
import { mergeAdminCategories } from '@/lib/admin-categories';
import { type AdminCategory, type AdminCategoryChange, api, unwrap } from '@/lib/api';
import { CATEGORIES_QUERY_KEY } from '@/lib/market-keys';

/**
 * 카테고리 관리 (#17, ADR-0093) for admins: the whole tree, hidden rows included. The key is under
 * the private `['admin']` root, so it is never dehydrated into a page.
 */

export const ADMIN_CATEGORIES_KEY = ['admin', 'categories'] as const;

/**
 * `GET /admin/categories`: every category, hidden ones too, in the public order, each with the
 * markets filed under it. Apart from the hook so its request is testable without a renderer.
 */
export const adminCategoriesQueryOptions = () => ({
  queryKey: ADMIN_CATEGORIES_KEY,
  queryFn: async (): Promise<AdminCategory[]> =>
    unwrap(await api.GET('/api/v1/admin/categories')).data,
});

export function useAdminCategories() {
  return useQuery(adminCategoriesQueryOptions());
}

/**
 * 변경 기록 (#145 part 2, ADR-0164; 145-10): `GET /admin/categories/changes`, newest first, 20 a
 * page with 더 보기. Its key is under ADMIN_CATEGORIES_KEY, so every category write — answered
 * (`applyAdminCategories`) or refused because the tree moved (`refreshAdminCategories`) — marks
 * it with the tree and, mounted, it is read again: the write's record comes first. Nothing polls
 * (ADR-0138).
 */
export const ADMIN_CATEGORY_CHANGES_KEY = [...ADMIN_CATEGORIES_KEY, 'changes'] as const;

/** One page of the category records. */
export interface AdminCategoryChangePage {
  items: AdminCategoryChange[];
  nextCursor: string | null;
}

export const adminCategoryChangesQueryOptions = () => ({
  queryKey: ADMIN_CATEGORY_CHANGES_KEY,
  queryFn: async ({
    pageParam,
  }: {
    pageParam: string | undefined;
  }): Promise<AdminCategoryChangePage> => {
    const { data, meta } = unwrap(
      await api.GET('/api/v1/admin/categories/changes', {
        params: { query: pageParam === undefined ? {} : { cursor: pageParam } },
      }),
    );
    return { items: data, nextCursor: meta.nextCursor };
  },
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: AdminCategoryChangePage) => last.nextCursor ?? undefined,
});

export function useAdminCategoryChanges() {
  return useInfiniteQuery(adminCategoryChangesQueryOptions());
}

/**
 * Every list a category write changes: the admin's, its 변경 기록 with it (a key under it); the
 * public `['categories']` (`useCategories`) that the header's row, the home's sidebar, the explore
 * and search filters, the interest pick, the proposal form and the market form's picker all read;
 * and the admin market reads (`['admin', 'markets']` lists, `['admin', 'market', id]` details),
 * whose category names and `missingOpenItems` follow the tree — a draft's leaf hidden or given its
 * first sub-category stops being one it can open with (#17). Marked rather than written:
 * `refetchType` stays `'active'`, so only a mounted list asks again and the rest ask on their next
 * mount (PLAN 11.5).
 */
function invalidateCategories(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ADMIN_CATEGORIES_KEY }),
    queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: ADMIN_MARKETS_KEY }),
    queryClient.invalidateQueries({ queryKey: ADMIN_MARKET_KEY }),
  ]);
}

/**
 * After a write that answered with rows (an add, a rename, a hide or a show answers the one row; a
 * reorder its group in the new order): show what the server just committed, then mark the lists.
 * The seed and the invalidations stay in one synchronous block, for the reason `applyMarket` gives
 * (hooks/use-admin-markets.ts): a GET already in flight must not land on top of the seed.
 */
export function applyAdminCategories(queryClient: QueryClient, fresh: readonly AdminCategory[]) {
  queryClient.setQueryData<AdminCategory[]>(ADMIN_CATEGORIES_KEY, (held) =>
    mergeAdminCategories(held, fresh),
  );
  return invalidateCategories(queryClient);
}

/**
 * After a refused write that says the tree moved under the screen — a category or parent gone or
 * hidden, a group another admin added to (`categoryWriteErrorMessage`): the lists read again, so
 * the next try starts from what is there.
 */
export function refreshAdminCategories(queryClient: QueryClient) {
  return invalidateCategories(queryClient);
}
