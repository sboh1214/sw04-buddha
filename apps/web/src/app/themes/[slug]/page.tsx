import { Container } from '@chakra-ui/react';
import { HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { copy } from '@/copy';
import {
  fetchThemeMarketsPageServer,
  fetchThemeResultsPageServer,
  fetchThemeServer,
} from '@/lib/api.server';
import { dehydratePublic } from '@/lib/market-keys';
import { getQueryClient } from '@/lib/query-client';
import {
  prefetchThemeMarkets,
  prefetchThemeResults,
  seedTheme,
  themeMarketsKey,
  themeSlugParam,
} from '@/lib/themes';
import { ThemePage } from './theme-page';

/** Rendered per request, for the reason app/markets/[slug]/page.tsx gives. */
export const dynamic = 'force-dynamic';

/** Search engines cut a description around here; the introduction is the theme's own summary. */
const META_DESCRIPTION_MAX = 160;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  // The same React-cached call the body makes.
  const theme = await fetchThemeServer(themeSlugParam(slug));
  if (theme === null) return { title: `${copy.themeNotFound} | ${copy.appName}` };
  return {
    title: `${theme.name} | ${copy.appName}`,
    description: theme.intro.slice(0, META_DESCRIPTION_MAX),
  };
}

/**
 * 테마 소개 페이지 (#81, N05 §7), at the slug the operator chose (owner decision 2026-10-19), signed
 * out too: the name, the period and its status, the introduction, the theme's notices, its
 * markets as the home's cards — the participation links: a card opens the market, where trading
 * is that market's own (N05 §7) — and the results list. No sign-up, no ranking, no reward, and no
 * notice that says so (ADR-0069 decision 4, '이름').
 *
 * The row is read here to decide on the 404 — an unknown slug, an unpublished theme and a segment
 * the route refuses are one 404, as a draft market's detail is — and seeded under the row's id;
 * the first page of the markets and of the results is read beside each other and dehydrated, so
 * the HTML is the same for every visitor and the cards are in it. Those two reads are tried once
 * (`retry: false`) and a failure is swallowed: the section reads its page in the browser.
 */
export default async function ThemeRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // The slug itself, however the segment arrived (`themeSlugParam`).
  const theme = await fetchThemeServer(themeSlugParam(slug));
  if (theme === null) notFound();

  const queryClient = getQueryClient();
  await Promise.all([
    prefetchThemeMarkets(queryClient, theme.id, fetchThemeMarketsPageServer),
    prefetchThemeResults(queryClient, theme.id, fetchThemeResultsPageServer),
  ]);
  seedTheme(queryClient, theme);
  // The cards' countdowns measure against the server's read of them, as the home's do; 0 is a
  // read that failed.
  const marketsFetchedAt = queryClient.getQueryState(themeMarketsKey(theme.id))?.dataUpdatedAt ?? 0;

  return (
    <Container maxW="1320px" px="6" py={{ base: '6', md: '10' }}>
      <HydrationBoundary state={dehydratePublic(queryClient)}>
        <ThemePage
          themeId={theme.id}
          fallback={theme}
          marketsNow={marketsFetchedAt === 0 ? undefined : marketsFetchedAt}
        />
      </HydrationBoundary>
    </Container>
  );
}
