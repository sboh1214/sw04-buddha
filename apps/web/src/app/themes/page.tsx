import { Container, Heading, Stack } from '@chakra-ui/react';
import { HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';
import { copy } from '@/copy';
import { fetchThemeListPageServer } from '@/lib/api.server';
import { dehydratePublic } from '@/lib/market-keys';
import { getQueryClient } from '@/lib/query-client';
import { prefetchThemeList } from '@/lib/themes';
import { ThemeList } from './theme-list';

/**
 * Rendered per request, for the reason app/page.tsx gives: the list is the API's, and a build
 * with no API listening must not prerender it.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: `${copy.themesTitle} | ${copy.appName}` };

/**
 * 공개 테마 목록 (#81, ADR-0069 decision 4, '들어오는 길'), signed out too: every published theme,
 * 진행 중 → 예정 → 종료 (owner decision 2026-10-19), as the API orders them. The first page is read
 * here, without a cookie, and dehydrated, so the HTML is the same for every visitor and the first
 * paint costs no request; a read that failed is the browser's to read again.
 */
export default async function ThemesPage() {
  const queryClient = getQueryClient();
  await prefetchThemeList(queryClient, fetchThemeListPageServer);
  return (
    <Container maxW="1320px" px="6" pt="6" pb="10">
      <HydrationBoundary state={dehydratePublic(queryClient)}>
        <Stack gap="4">
          {/* h2 under the nav's h1, as every screen titles itself (A-M4-31). */}
          <Heading as="h2" size="2xl">
            {copy.themesTitle}
          </Heading>
          <ThemeList />
        </Stack>
      </HydrationBoundary>
    </Container>
  );
}
