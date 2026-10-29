'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { api, type RetentionPurge, unwrap } from '@/lib/api';

/**
 * 보존기간 처리 기록 (#184, ADR-0087). Under the `admin` root (`PRIVATE_QUERY_ROOTS`): an operational
 * record, for admins only.
 */
export const ADMIN_RETENTION_PURGES_KEY = ['admin', 'retention-purges'] as const;

interface RetentionPurgePage {
  items: RetentionPurge[];
  nextCursor: string | null;
}

/**
 * What the worker's daily retention runs recorded (`GET /admin/retention-purges`), newest run
 * first, 20 records per page with 더 보기 (A-M2-5) — the API completes each page to the end of its
 * last run, so no run is split across pages. Read-only: the worker writes the records, and the
 * periods are release settings.
 */
export function useRetentionPurges() {
  return useInfiniteQuery({
    queryKey: ADMIN_RETENTION_PURGES_KEY,
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<RetentionPurgePage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/retention-purges', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: RetentionPurgePage) => last.nextCursor ?? undefined,
  });
}
