import { Container } from '@chakra-ui/react';
import { HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';
import { copy } from '@/copy';
import { fetchCategoriesServer, fetchMarketSearchPageServer } from '@/lib/api.server';
import { dehydratePublic, marketSearchKey } from '@/lib/market-keys';
import { type MarketPages } from '@/lib/market-live';
import {
  type SearchSearchParams,
  isMarketSearch,
  searchFiltersFromSearchParams,
  seedsSearchResults,
} from '@/lib/market-search';
import { getQueryClient } from '@/lib/query-client';
import { MarketSearch } from './market-search';

/**
 * Rendered per request, like the home (app/page.tsx says why `cache: 'no-store'` alone does not
 * make it so): the URL's filters are read here.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: `${copy.searchTitle} | ${copy.appName}` };

/**
 * 시장 검색 (#15, ADR-0066): the results of a term on a screen of their own (ADR-0061 decision 1,
 * item 14), with a status filter that starts on every public status (item 13), a category filter
 * and the home's orders. Public (item 18); the header's search box comes here.
 *
 * The URL is normalised ONCE, here (`searchFiltersFromSearchParams`), and the result handed down as
 * a prop — the home's rule: a client that re-derived it from `useSearchParams` would be one
 * default away from a second cache entry.
 *
 * The first page of the results is read here, as the home reads its list, and goes into the HTML
 * when it holds a card (owner decision 2026-10-16, ADR-0066: "서버가 첫 페이지도 그린다"), so the
 * search shows its results without JavaScript too — the two search boxes are `next/form`s, which
 * navigate here without it. `prefetchInfiniteQuery` for the reasons app/page.tsx gives (the page
 * params and the query type dehydrate, and a failure is swallowed rather than a 500). A read that
 * failed is not dehydrated (`dehydratePublic` keeps successful queries), and an empty answer is
 * dropped from the cache before dehydrating (`seedsSearchResults`): in both cases the HTML is the
 * skeleton, and the browser reads the page itself, so loading, '검색 결과가 없습니다.' and a failure
 * the screen must never read as no results (N02 §3) stay the browser's own to show and to retry.
 *
 * No `cookies()` is read and nothing private is fetched — the member's recent searches are read by
 * the browser after the session is known, and before that the screen draws a placeholder — so
 * this HTML is the same for a member and a visitor (decision-ssr-hydration §9). The categories are
 * read here, as the home reads them, for the category select's first paint (a failed read leaves
 * the select its '모든 카테고리' until the client's own read answers).
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchSearchParams>;
}) {
  const filters = searchFiltersFromSearchParams(await searchParams);
  const search = isMarketSearch(filters) ? filters : undefined;
  const queryClient = getQueryClient();
  const [, categories] = await Promise.all([
    search &&
      queryClient.prefetchInfiniteQuery({
        queryKey: marketSearchKey(search),
        queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
          fetchMarketSearchPageServer(search, pageParam),
        // The param the client's own options factory declares (hooks/use-markets.ts), so the
        // seeded page is picked up rather than fetched again.
        initialPageParam: undefined as string | undefined,
      }),
    fetchCategoriesServer().catch(() => undefined),
  ]);

  /**
   * The instant the cards' countdowns measure against: the server's read, as on the home
   * (app/page.tsx says why it is the query's own `dataUpdatedAt`). Nothing seeded, nothing to
   * anchor: the badges show the absolute close time until they have mounted.
   */
  let fetchedAt = 0;
  if (search !== undefined) {
    const key = marketSearchKey(search);
    if (seedsSearchResults(queryClient.getQueryData<MarketPages>(key))) {
      fetchedAt = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
    } else {
      queryClient.removeQueries({ queryKey: key, exact: true });
    }
  }

  return (
    <Container maxW="1320px" px="6" pt="6" pb="10">
      <HydrationBoundary state={dehydratePublic(queryClient)}>
        <MarketSearch
          filters={filters}
          categories={categories}
          now={fetchedAt === 0 ? undefined : fetchedAt}
        />
      </HydrationBoundary>
    </Container>
  );
}
