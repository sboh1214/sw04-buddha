import { Container, Flex, Stack } from '@chakra-ui/react';
import { HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';
import { ProposeMarketEntry } from '@/components/proposals/propose-market-entry';
import { copy } from '@/copy';
import {
  fetchCategoriesServer,
  fetchHomeThemesServer,
  fetchMarketsPageServer,
} from '@/lib/api.server';
import { isWatchlistView } from '@/lib/home-view';
import { dehydratePublic, marketsKey } from '@/lib/market-keys';
import { type MarketSearchParams, filtersFromSearchParams } from '@/lib/market-ssr';
import { getQueryClient } from '@/lib/query-client';
import { prefetchHomeThemes, showsHomeThemes } from '@/lib/themes';
import { HomeThemes } from './home-themes';
import { MarketFilters } from './market-filters';
import { MarketList } from './market-list';
import { SubcategorySidebar } from './subcategory-sidebar';

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
 * PLAN 11.3 홈 (ADR-0041, Kalshi's category page): 세부 분류 사이드바 · 제목과 정렬 · 마켓 카드 그리드.
 * The search box and the top-level categories are the header's (nav.tsx).
 *
 * The whole screen hangs off ONE normalisation of the URL: `filtersFromSearchParams` runs here,
 * the result is the infinite query's cache key, and the same object is handed to both client
 * components as a prop. A client that re-derived its filters from `useSearchParams` would be one
 * default away from a second cache entry, and the second entry would refetch what this render
 * already put in the HTML.
 *
 * `prefetchInfiniteQuery`, never `prefetchQuery`: only the infinite form dehydrates `pageParams`
 * and the query type, which `hydrate` restores as `_type` so `useInfiniteQuery` picks the seeded
 * page up instead of fetching it again. It never rejects — a prefetch swallows its own failure —
 * so an API that is down degrades to the client's own error state rather than a 500 on a public
 * page; the categories read below is given the same treatment by hand.
 *
 * The categories go down as a PROP rather than through the query cache, which is the one place
 * this screen cannot use hydration. `Nav` renders above `{children}` in the root layout and its
 * own `useCategories()` builds `['categories']` in the context QueryClient while it renders —
 * before this page's `HydrationBoundary` ever runs. react-query hydrates a query that already
 * exists only from an EFFECT (`existingQueries` → `hydrationQueue`, HydrationBoundary.tsx), and
 * effects do not run during SSR, so a dehydrated `['categories']` would reach the browser but
 * never the HTML. Seeding it above `Nav` instead would mean the root layout prefetching on every
 * route — including the statically prerendered ones, which would bake a build-time category list
 * into /login and friends — for a short, rarely-changing list that no AC measures. So the server
 * value is handed straight to the one consumer whose first paint we care about, and `Nav`'s
 * shortcut row fills in from the client's own fetch a moment later.
 *
 * No `cookies()` is read and `dehydratePublic` drops every private root, so this HTML is
 * byte-identical for a signed-in and an anonymous visitor (decision-ssr-hydration §9) — the
 * 관심 시장 view (`?watchlist=1`, ADR-0065) included, whose list is drawn as placeholders here
 * and read by the browser after the session is known.
 *
 * The home has no status filter (ADR-0061 decision 1, item 13): every list here is of open
 * markets, and a bookmarked `?status=` or `?sort=volume` is normalised away, not redirected.
 *
 * The theme row (#81, ADR-0069 decision 4, '탐색 홈 노출'; ADR-0088) heads the main column on 전체
 * (`showsHomeThemes`): the ongoing themes, else the upcoming ones, with 모든 테마 whenever a theme
 * is public (`homeThemesRow`). Read here beside the list, once (`retry: false`, lib/themes.ts),
 * public and so in every visitor's HTML.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<MarketSearchParams>;
}) {
  const filters = filtersFromSearchParams(await searchParams);
  const queryClient = getQueryClient();
  // The public list is read here; the 관심 시장 view's is the caller's, so nothing of it is — the
  // client asks once the session is known, and this HTML stays the same for every visitor.
  const publicFilters = isWatchlistView(filters) ? undefined : filters;
  const withThemes = showsHomeThemes(filters);
  const [, categories] = await Promise.all([
    publicFilters &&
      queryClient.prefetchInfiniteQuery({
        queryKey: marketsKey(publicFilters),
        queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
          fetchMarketsPageServer(publicFilters, pageParam),
        // `undefined`, not a literal cursor: it is the param the client's own options factory
        // declares, and a mismatch there is a refetch of the page that is already in the payload.
        initialPageParam: undefined as string | undefined,
      }),
    // `undefined` rather than a rejection: the categories are a convenience — the headline
    // falls back to 예측시장, the sidebar renders nothing, and the list still works without
    // them. The prefetch above swallows its failure the same way.
    fetchCategoriesServer().catch(() => undefined),
    withThemes && prefetchHomeThemes(queryClient, fetchHomeThemesServer),
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
  const fetchedAt =
    publicFilters === undefined
      ? 0
      : (queryClient.getQueryState(marketsKey(publicFilters))?.dataUpdatedAt ?? 0);

  return (
    // Kalshi's content width and side padding (`--content-width` 1320px, 24px); the 24px top
    // gap is what the sidebar's sticky offset adds to the header's height.
    <Container maxW="1320px" px="6" pt="6" pb="10">
      <HydrationBoundary state={dehydratePublic(queryClient)}>
        {/* Sidebar beside the main column, both from the top. The sidebar renders nothing when
            no category is selected and hides itself below md, so the main column takes the
            whole width in both cases; `minW="0"` is what lets the grid inside it shrink below
            its content instead of pushing the column out of the container. The h2 the nav's h1
            is followed by is `MarketFilters`' headline. */}
        <Flex align="flex-start" gap="6">
          <SubcategorySidebar filters={filters} categories={categories} />
          <Stack flex="1" minW="0" gap="4">
            {withThemes && <HomeThemes />}
            <MarketFilters filters={filters} categories={categories} />
            <MarketList filters={filters} now={fetchedAt === 0 ? undefined : fetchedAt} />
            {/* 시장 제안하기 at the bottom of the explore home (ADR-0069 decision 4 #77 위치): a
                link, the same for every visitor and every view, so this HTML stays one page. */}
            <ProposeMarketEntry testId="home-propose-market" />
          </Stack>
        </Flex>
      </HydrationBoundary>
    </Container>
  );
}
