'use client';

import { type QueryClient, useQuery } from '@tanstack/react-query';
import { ADMIN_MARKETS_KEY, ADMIN_MARKET_KEY } from '@/hooks/use-admin-markets';
import { mergeAdminCategories } from '@/lib/admin-categories';
import { type AdminCategory, api, unwrap } from '@/lib/api';
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
 * Every list a category write changes: the admin's; the public `['categories']`
 * (`useCategories`) that the header's row, the home's sidebar, the explore and search filters,
 * the interest pick, the proposal form and the market form's picker all read; and the admin
 * market reads (`['admin', 'markets']` lists, `['admin', 'market', id]` details), whose category
 * names and `missingOpenItems` follow the tree — a draft's leaf hidden or given its first
 * sub-category stops being one it can open with (#17). Marked rather than written: `refetchType`
 * stays `'active'`, so only a mounted list asks again and the rest ask on their next mount
 * (PLAN 11.5).
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
