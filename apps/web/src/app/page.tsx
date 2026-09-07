import { Container, Heading, Stack } from '@chakra-ui/react';
import { HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';
import { copy } from '@/copy';
import { fetchCategoriesServer, fetchMarketsPageServer } from '@/lib/api.server';
import { CATEGORIES_QUERY_KEY, dehydratePublic, marketsKey } from '@/lib/market-keys';
import { type MarketSearchParams, filtersFromSearchParams } from '@/lib/market-ssr';
import { getQueryClient } from '@/lib/query-client';
import { MarketFilters } from './market-filters';
import { MarketList } from './market-list';

/**
 * Rendered per request. Next 16 only marks a scope dynamic when `cache: 'no-store'` is read off
 * fetch's SECOND argument (`patch-fetch.js` `const { cache } = init`, guarded by
 * `init && typeof init === 'object'`), and openapi-fetch calls `fetch(request, requestInitExt)`
 * with `requestInitExt` undefined — so the `cache: 'no-store'` set on the server client reaches
 * the Request and never that branch. Without this line `next build`, which runs in `pnpm check`
 * and in CI with no API listening, would try to prerender this page, and a page that did build
 * would serve build-time probabilities out of the Full Route Cache.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: `${copy.homeTitle} | ${copy.appName}` };

/**
 * PLAN 11.3 홈: 카테고리 탭 · 정렬 · 검색 · 마켓 카드 그리드.
 *
 * The whole screen hangs off ONE normalisation of the URL: `filtersFromSearchParams` runs here,
 * the result is the infinite query's cache key, and the same object is handed to both client
 * components as a prop. A client that re-derived its filters from `useSearchParams` would be one
 * default away from a second cache entry, and the second entry would refetch what this render
 * already put in the HTML.
 *
 * `prefetchInfiniteQuery`, never `prefetchQuery`: only the infinite form dehydrates `pageParams`
 * and the query type, which `hydrate` restores as `_type` so `useInfiniteQuery` picks the seeded
 * page up instead of fetching it again. Neither prefetch rejects (both end in `.catch(noop)`), so
 * an API that is down degrades to the client's own error state rather than a 500 on a public page.
 *
 * No `cookies()` is read and `dehydratePublic` drops every private root, so this HTML is
 * byte-identical for a signed-in and an anonymous visitor (decision-ssr-hydration §9).
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<MarketSearchParams>;
}) {
  const filters = filtersFromSearchParams(await searchParams);
  const queryClient = getQueryClient();
  await Promise.all([
    queryClient.prefetchInfiniteQuery({
      queryKey: marketsKey(filters),
      queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
        fetchMarketsPageServer(filters, pageParam),
      // `undefined`, not a literal cursor: it is the param the client's own options factory
      // declares, and a mismatch there is a refetch of the page that is already in the payload.
      initialPageParam: undefined as string | undefined,
    }),
    queryClient.prefetchQuery({
      queryKey: CATEGORIES_QUERY_KEY,
      queryFn: fetchCategoriesServer,
    }),
  ]);

  /**
   * The instant every countdown on the grid measures against: the moment the SERVER read the
   * page, taken from the query's own `dataUpdatedAt` rather than from a fresh `Date.now()`.
   *
   * It is the right instant twice over. It belongs to the data the badge is drawn beside — a
   * countdown next to a price read 200ms ago should describe that read — and nothing in this
   * render calls the clock, so the badge's first client render agrees with the HTML to the
   * millisecond and `react-hooks/purity` has nothing to object to. It is also the instant the
   * client itself hydrates, since it rides along in the dehydrated payload.
   *
   * A prefetch that failed leaves `dataUpdatedAt` at 0; the badge then falls back to the
   * absolute close time until it has mounted (countdown-badge.tsx), which is still true.
   */
  const fetchedAt = queryClient.getQueryState(marketsKey(filters))?.dataUpdatedAt ?? 0;

  return (
    <Container maxW="6xl" py={{ base: '6', md: '10' }}>
      <Stack gap="6">
        {/* The nav owns the h1, so the page's own title is an h2 (wallet/settings do the same). */}
        <Heading as="h2" size="2xl">
          {copy.homeTitle}
        </Heading>
        <HydrationBoundary state={dehydratePublic(queryClient)}>
          <MarketFilters filters={filters} />
          <MarketList filters={filters} now={fetchedAt === 0 ? undefined : fetchedAt} />
        </HydrationBoundary>
      </Stack>
    </Container>
  );
}
