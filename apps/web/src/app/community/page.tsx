import { Container } from '@chakra-ui/react';
import { HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';
import { copy } from '@/copy';
import {
  fetchCategoriesServer,
  fetchMarketServer,
  fetchPinnedNoticesServer,
  fetchPostsPageServer,
} from '@/lib/api.server';
import { dehydratePublic } from '@/lib/market-keys';
import { PINNED_NOTICES_KEY } from '@/lib/notices';
import {
  type CommunitySearchParams,
  communityFiltersFromSearchParams,
  communityPostsKey,
} from '@/lib/posts';
import { getQueryClient } from '@/lib/query-client';
import { CommunityScreen } from './community-screen';

/**
 * Rendered per request, like the home and the search (app/page.tsx says why `cache: 'no-store'`
 * alone does not make it so): the URL's filters are read here.
 */
export const dynamic = 'force-dynamic';

/**
 * Not for search engines (owner decision 2026-10-19, ADR-0073): the list shows members' nicknames
 * and posts, kept out of search results as the profiles are (#37-1). The post pages and the write
 * and edit screens say the same.
 */
export const metadata: Metadata = {
  title: `${copy.communityTitle} | ${copy.appName}`,
  robots: { index: false },
};

/**
 * `/community`: 커뮤니티, one of the three top-level areas (N02 §2, #16) — every market's 근거 글,
 * newest first (#46, ADR-0073; ADR-0069 decision 2 #45-7), narrowed by a market, a category and a
 * term searched in the title and the text. Public: anyone reads (N05 §2), and 글쓰기 asks a visitor
 * to sign in on the write screen.
 *
 * The URL is normalised ONCE, here, and handed down (the home's rule). The pinned notices (#138,
 * ADR-0077) and the first page of the list are read here and dehydrated, so the fixed area and the
 * cards are in the HTML — without JavaScript too, the search box being a plain form — and the
 * client picks them up under the same keys; a failed read is not dehydrated, and the browser then
 * reads it itself and shows its own failure. The market a `?market=` names is read for its title
 * (the filter's chip), and the categories for the category select's first paint; either failing
 * leaves the screen its fallbacks. Nothing personal is read: this HTML is the same for every
 * visitor.
 */
export default async function CommunityPage({
  searchParams,
}: {
  searchParams: Promise<CommunitySearchParams>;
}) {
  const filters = communityFiltersFromSearchParams(await searchParams);
  const queryClient = getQueryClient();
  const [, , categories, market] = await Promise.all([
    queryClient.prefetchInfiniteQuery({
      queryKey: communityPostsKey(filters),
      queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
        fetchPostsPageServer(filters, pageParam),
      // The param the client's own options declare (hooks/use-posts.ts), so the seeded page is
      // picked up rather than fetched again.
      initialPageParam: undefined as string | undefined,
    }),
    // The pinned notices' fixed area (#138): public, the same for every visitor, so in the HTML
    // too. A failed read is not dehydrated, and the browser reads the area itself.
    queryClient.prefetchQuery({ queryKey: PINNED_NOTICES_KEY, queryFn: fetchPinnedNoticesServer }),
    fetchCategoriesServer().catch(() => undefined),
    filters.market === undefined
      ? Promise.resolve(null)
      : fetchMarketServer(filters.market).catch(() => null),
  ]);

  return (
    <Container maxW="1320px" px="6" py={{ base: '6', md: '10' }}>
      <HydrationBoundary state={dehydratePublic(queryClient)}>
        <CommunityScreen filters={filters} categories={categories} marketTitle={market?.title} />
      </HydrationBoundary>
    </Container>
  );
}
