import { Container } from '@chakra-ui/react';
import { HydrationBoundary } from '@tanstack/react-query';
import type { Metadata, Route } from 'next';
import { notFound, redirect } from 'next/navigation';
import { copy } from '@/copy';
import { fetchMarketServer } from '@/lib/api.server';
import { disputeLoginPath } from '@/lib/disputes';
import { dehydratePublic, marketKey } from '@/lib/market-keys';
import { seedMarketDetail } from '@/lib/market-ssr';
import { getQueryClient } from '@/lib/query-client';
import { getServerSession } from '@/lib/session.server';
import { DisputeScreen } from './dispute-screen';

export const metadata: Metadata = { title: `${copy.disputeTitle} | ${copy.appName}` };

/**
 * Rendered per request: it reads the session's cookie and the public market (the detail's reason
 * for `force-dynamic` too — openapi-fetch's `cache` never reaches Next's branch).
 */
export const dynamic = 'force-dynamic';

/**
 * 판정 이의 제출 (`/markets/[slug]/dispute`, #175, ADR-0104; ADR-0093 decision 1 #173 item 6 '접수':
 * 서비스 안의 제출 화면). No session → the login screen, told to come back here, as `/proposals/new`
 * (the detail's link is drawn for every visitor, #173 item 6). An account with an onboarding step
 * left meets the onboarding gate here like on every page (#57-8: the server's `OnboardedGuard`
 * keeps the submission); a restricted account may dispute (#173 item 6). Who may — a fill on the
 * market, not an admin, one per judgement version — is the member's standing, read in the browser
 * (`GET /me/disputes/markets/:id`, private); the market is public and read here once, seeded under
 * the key the detail uses so the screen draws it at once and the socket keeps it live. A market
 * that is not public is a 404, as its detail.
 */
export default async function DisputePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!(await getServerSession())) redirect(disputeLoginPath(slug) as Route);
  const market = await fetchMarketServer(slug);
  if (market === null) notFound();
  const queryClient = getQueryClient();
  seedMarketDetail(queryClient, market, null);
  // The server's instant at the read, which the deadline's timer counts from (`useDisputeOpen`):
  // the query's own `dataUpdatedAt`, never a clock read in render (app/page.tsx).
  const readAt = queryClient.getQueryState(marketKey(market.id))?.dataUpdatedAt ?? 0;
  return (
    <Container maxW="2xl" py={{ base: '6', md: '10' }}>
      <HydrationBoundary state={dehydratePublic(queryClient)}>
        <DisputeScreen marketId={market.id} now={readAt === 0 ? undefined : readAt} />
      </HydrationBoundary>
    </Container>
  );
}
