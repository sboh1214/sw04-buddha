'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { type AdminRegrant, api, unwrap } from '@/lib/api';

/**
 * 재지급 기록 (#74, ADR-0155). Under the `admin` root (`PRIVATE_QUERY_ROOTS`): every account's
 * re-grants, for admins only.
 */
export const ADMIN_REGRANTS_KEY = ['admin', 'regrants'] as const;

/** One page of `GET /admin/regrants`, as the list keeps it. */
export interface AdminRegrantPage {
  items: AdminRegrant[];
  nextCursor: string | null;
}

/**
 * Every re-grant given (`GET /admin/regrants`), newest first, 20 per page with 더 보기 (A-M2-5).
 * Read-only (owner answer 2026-11-21 3: the admin screen reads the records — a re-grant is given in
 * the member's own request, and no admin gives or takes back Coin, ADR-0107).
 */
export function useAdminRegrants() {
  return useInfiniteQuery({
    queryKey: ADMIN_REGRANTS_KEY,
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<AdminRegrantPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/regrants', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AdminRegrantPage) => last.nextCursor ?? undefined,
  });
}
