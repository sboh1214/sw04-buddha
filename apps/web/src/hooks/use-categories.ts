'use client';

import { useQuery } from '@tanstack/react-query';
import { type Category, api, unwrap } from '@/lib/api';
import { CATEGORIES_QUERY_KEY } from '@/lib/market-keys';

/**
 * Active categories in display order (`GET /categories`, public), under the one key every screen
 * shares (`CATEGORIES_QUERY_KEY`). Its own module so the market card (#61, ADR-0136), which reads
 * it for its glyph (`cardIconSlug`), pulls in this query alone and not the admin hooks; a screen's
 * cards share one request, and the client's staleTime holds it. `use-admin-markets.ts` and
 * `use-markets.ts` re-export it, so no import site moved.
 */
export function useCategories() {
  return useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: async (): Promise<Category[]> => unwrap(await api.GET('/api/v1/categories')).data,
  });
}
