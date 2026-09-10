import { Container, Heading, Stack } from '@chakra-ui/react';
import { HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';
import { copy } from '@/copy';
import { fetchLeaderboardServer } from '@/lib/api.server';
import { LEADERBOARD_KEY, dehydratePublic } from '@/lib/market-keys';
import { getQueryClient } from '@/lib/query-client';
import { Leaderboard } from './leaderboard';

/**
 * Rendered per request, for the home page's reason verbatim: openapi-fetch's `cache: 'no-store'`
 * never reaches the branch Next 16 marks a scope dynamic on, so without this line `next build`
 * — which runs in `pnpm check` and in CI with no API listening — would try to prerender a page
 * whose whole content is a live aggregate.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: `${copy.leaderboardTitle} | ${copy.appName}` };

/**
 * PLAN M6 선택: the global ranking by realized profit and loss.
 *
 * Public and prefetched into the HTML, like the home grid: `dehydratePublic` keeps
 * `['leaderboard']` because the board holds nothing session-scoped, so the first paint carries
 * the table rather than a skeleton. The prefetch swallows its own failure — an API that is down
 * degrades to the client's error state instead of a 500 on a public page.
 */
export default async function LeaderboardPage() {
  const queryClient = getQueryClient();
  await queryClient.prefetchQuery({ queryKey: LEADERBOARD_KEY, queryFn: fetchLeaderboardServer });

  return (
    <Container maxW="3xl" py={{ base: '6', md: '10' }}>
      <Stack gap="6">
        <Heading as="h2" size="2xl">
          {copy.leaderboardTitle}
        </Heading>
        <HydrationBoundary state={dehydratePublic(queryClient)}>
          <Leaderboard />
        </HydrationBoundary>
      </Stack>
    </Container>
  );
}
