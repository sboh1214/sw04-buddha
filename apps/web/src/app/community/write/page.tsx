import { Container } from '@chakra-ui/react';
import type { Metadata } from 'next';
import { copy } from '@/copy';
import { lookUpWriteMarketServer } from '@/lib/api.server';
import { type CommunitySearchParams, communityFiltersFromSearchParams } from '@/lib/posts';
import { WriteScreen } from './write-screen';

/** Rendered per request: the market `?market=` names is read as it is now. */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${copy.postWriteTitle} | ${copy.appName}`,
  robots: { index: false },
};

/**
 * The write screen (#46, ADR-0073): a post on the market `?market=<id>` names, or — opened from
 * the community list with none — a picker that finds one by its title first (#45-1: «두 곳 모두에서»;
 * the market detail's own 글쓰기 comes with its discussion section, #47, and lands here with the
 * market). Any public status takes a post (#45-6); a draft or an unknown id reads as no market, so
 * the picker shows. A read that fails otherwise (the API down for a moment) is said as such
 * (`lookUpWriteMarketServer`): the screen keeps a form it shows, draft and all, or offers to read
 * again.
 *
 * The market is read here (public), so its title is in the first paint; who is writing is the
 * browser's to know (WriteGate), so the HTML is the same for every visitor.
 */
export default async function WritePage({
  searchParams,
}: {
  searchParams: Promise<CommunitySearchParams>;
}) {
  const { market: marketId } = communityFiltersFromSearchParams(await searchParams);
  const lookup = await lookUpWriteMarketServer(marketId);
  return (
    <Container maxW="760px" px="6" py={{ base: '6', md: '10' }}>
      <WriteScreen lookup={lookup} />
    </Container>
  );
}
