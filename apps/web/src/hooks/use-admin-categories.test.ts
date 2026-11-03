import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_MARKETS_KEY, adminMarketKey } from '@/hooks/use-admin-markets';
import { type AdminCategory, api } from '@/lib/api';
import { CATEGORIES_QUERY_KEY } from '@/lib/market-keys';
import {
  ADMIN_CATEGORIES_KEY,
  adminCategoriesQueryOptions,
  applyAdminCategories,
  refreshAdminCategories,
} from './use-admin-categories';

/**
 * 카테고리 관리 (#17, ADR-0093): the admin list's request, and what a category write marks — the
 * admin list, the public `['categories']` every category list on the site reads, and the admin
 * market lists and details whose category names and open items follow the tree — through a real
 * QueryClient. Nothing renders (vitest runs with no DOM here).
 */

const row = (id: number, parentId: number | null, sortOrder: number): AdminCategory => ({
  id,
  slug: `c${String(id)}`,
  nameKo: `카테고리 ${String(id)}`,
  sortOrder,
  parentId,
  isActive: true,
  marketCount: 0,
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The admin market reads a category write marks: a filtered list and one market's detail. */
const ADMIN_MARKETS_LIST = [...ADMIN_MARKETS_KEY, 'draft'] as const;
const ADMIN_MARKET_DETAIL = adminMarketKey('00000000-0000-4000-8000-000000000001');

/**
 * A client holding the admin list, the public list, the admin market reads and an unrelated read,
 * none mounted.
 */
function heldClient(held: AdminCategory[] | undefined) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (held !== undefined) queryClient.setQueryData(ADMIN_CATEGORIES_KEY, held);
  queryClient.setQueryData(CATEGORIES_QUERY_KEY, [{ held: true }]);
  queryClient.setQueryData(ADMIN_MARKETS_LIST, { held: true });
  queryClient.setQueryData(ADMIN_MARKET_DETAIL, { held: true });
  queryClient.setQueryData(['markets', 'list'], { held: true });
  const invalidated = (key: readonly unknown[]) =>
    queryClient.getQueryState(key)?.isInvalidated === true;
  return { queryClient, invalidated };
}

describe('the admin category list', () => {
  it('is `GET /admin/categories` under the private admin root', async () => {
    const spy = vi.spyOn(api, 'GET').mockResolvedValue({
      data: { data: [row(1, null, 10)] },
      response: new Response(null, { status: 200 }),
    } as never);
    const options = adminCategoriesQueryOptions();
    expect(options.queryKey).toEqual(['admin', 'categories']);
    await expect(options.queryFn()).resolves.toEqual([row(1, null, 10)]);
    expect(spy).toHaveBeenCalledWith('/api/v1/admin/categories');
  });
});

describe('what a category write marks', () => {
  it('puts the answer in the admin list and marks it, the public list and the admin markets, no more', async () => {
    const { queryClient, invalidated } = heldClient([row(1, null, 10), row(2, null, 20)]);
    await applyAdminCategories(queryClient, [{ ...row(2, null, 20), nameKo: '새 이름' }]);
    expect(
      queryClient.getQueryData<AdminCategory[]>(ADMIN_CATEGORIES_KEY)?.map((c) => c.nameKo),
    ).toEqual(['카테고리 1', '새 이름']);
    expect(invalidated(ADMIN_CATEGORIES_KEY)).toBe(true);
    expect(invalidated(CATEGORIES_QUERY_KEY)).toBe(true);
    // A market's category name and `missingOpenItems` follow the tree (#17).
    expect(invalidated(ADMIN_MARKETS_LIST)).toBe(true);
    expect(invalidated(ADMIN_MARKET_DETAIL)).toBe(true);
    expect(invalidated(['markets', 'list'])).toBe(false);
    // Marked, never written: each keeps what it held until it asks again.
    expect(queryClient.getQueryData(CATEGORIES_QUERY_KEY)).toEqual([{ held: true }]);
    expect(queryClient.getQueryData(ADMIN_MARKET_DETAIL)).toEqual({ held: true });
  });

  it('adds a new category to the list it holds', async () => {
    const { queryClient } = heldClient([row(1, null, 10)]);
    await applyAdminCategories(queryClient, [row(5, 1, 10)]);
    expect(
      queryClient.getQueryData<AdminCategory[]>(ADMIN_CATEGORIES_KEY)?.map((c) => c.id),
    ).toEqual([1, 5]);
  });

  it('writes nothing into a list not read yet, and still marks the public one', async () => {
    const { queryClient, invalidated } = heldClient(undefined);
    await applyAdminCategories(queryClient, [row(1, null, 10)]);
    expect(queryClient.getQueryData(ADMIN_CATEGORIES_KEY)).toBeUndefined();
    expect(invalidated(CATEGORIES_QUERY_KEY)).toBe(true);
  });

  it('reads the lists again after a refusal that says the tree moved', async () => {
    const { queryClient, invalidated } = heldClient([row(1, null, 10)]);
    await refreshAdminCategories(queryClient);
    expect(invalidated(ADMIN_CATEGORIES_KEY)).toBe(true);
    expect(invalidated(CATEGORIES_QUERY_KEY)).toBe(true);
    expect(invalidated(ADMIN_MARKETS_LIST)).toBe(true);
    expect(invalidated(ADMIN_MARKET_DETAIL)).toBe(true);
    expect(queryClient.getQueryData<AdminCategory[]>(ADMIN_CATEGORIES_KEY)).toHaveLength(1);
  });
});
