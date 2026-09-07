import { Container, Heading, Stack } from '@chakra-ui/react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { copy } from '@/copy';
import { getServerSession } from '@/lib/session.server';
import { Portfolio } from './portfolio';

export const metadata: Metadata = { title: `${copy.portfolioTitle} | ${copy.appName}` };

/**
 * PLAN 11.3 `/portfolio`: 잔고 요약 · 보유 포지션 · 정산 이력 · 주문 이력.
 *
 * The session gate is the wallet's, verbatim (wallet/page.tsx): a signed-out visitor is sent to
 * `/login?next=/portfolio` so they land back here, and reading `cookies()` through
 * `getServerSession()` is also what marks the route dynamic — nothing on this screen may be
 * prerendered.
 *
 * NOTHING is prefetched. Every figure below is personal, `api.server.ts` forwards no cookie and
 * `dehydratePublic` filters `['me']`/`['positions']`/`['orders']` out of the dehydrated payload,
 * so a server prefetch here could only produce an anonymous 401 baked into the HTML. The
 * sections fetch after hydration and each one renders its own skeleton until then.
 */
export default async function PortfolioPage() {
  if (!(await getServerSession())) redirect('/login?next=/portfolio');
  return (
    <Container maxW="4xl" py={{ base: '6', md: '10' }}>
      <Stack gap="6">
        <Heading as="h2" size="2xl">
          {copy.portfolioTitle}
        </Heading>
        <Portfolio />
      </Stack>
    </Container>
  );
}
