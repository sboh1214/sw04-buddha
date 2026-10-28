import { Container } from '@chakra-ui/react';
import { HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LiveBackgroundSection } from '@/components/market/live-background-section';
import { LiveQuestionHeading } from '@/components/market/live-question-heading';
import { LiveRulesSection } from '@/components/market/live-rules-section';
import { copy } from '@/copy';
import {
  fetchMarketServer,
  fetchRelatedMarketsPageServer,
  fetchTicksServer,
} from '@/lib/api.server';
import { dehydratePublic, relatedMarketsKey } from '@/lib/market-keys';
import { detailWindowEnd, prefetchRelatedMarkets, seedMarketDetail } from '@/lib/market-ssr';
import { getQueryClient } from '@/lib/query-client';
import { DEFAULT_TICK_RANGE } from '@/lib/ticks';
import { MarketDetail } from './market-detail';
import { RelatedMarkets } from './related-markets';

/**
 * 시장 상세 (PLAN 11.3), server-rendered so the first paint already carries the question, the
 * 규칙 and the current 시장가격 — the three things AC 2 reads out of view-source.
 *
 * The row is fetched here, once, and SEEDED into a per-request query cache rather than passed
 * down as props: the screen has several readers of `['market', id]` (the heading, the header,
 * the chart, the rules), a socket that writes that same key, and a `staleTime` that has to be measured
 * from the server's fetch rather than from mount. `initialData` gives none of that
 * (decision-ssr-hydration, Rejected).
 *
 * Nothing personal is read here. `api.server.ts` forwards no cookie and `dehydratePublic`
 * filters the private roots, so the HTML is byte-identical for a signed-in and an anonymous
 * visitor; 내 포지션, the personal slots (내 거래, 내 대기 주문) — or a signed-out visitor's one
 * sign-in prompt in their place — and the balance chip fill in on the client. 토론's 글쓰기 is one
 * link for everyone (market-discussion.tsx), so it does not tell visitors apart either.
 *
 * 토론's posts are not read here at all (#47, ADR-0075, owner decision 2026-10-20 1): the section
 * reads them in the browser, so neither the HTML nor the dehydrated state carries a post's title,
 * text or author — the post page and the community list are kept out of search, and so are the
 * posts here. `app/robots.ts` keeps crawlers off `/api/`, where the browser reads them. The page
 * itself stays open to search engines (no `robots` in `generateMetadata`).
 */

/**
 * Rendered per request. Next 16 only marks a scope dynamic when it reads `cache: 'no-store'`
 * off fetch's SECOND argument, and openapi-fetch calls `fetch(request, undefined)` — so the
 * option `api.server.ts` sets lands on the Request and never reaches that branch. Without this
 * line `next build` (which runs in `pnpm check` and in CI, with no API listening) would try to
 * prerender this route, and a page that did build would serve build-time probabilities out of
 * the Full Route Cache — which is exactly what AC 2 measures.
 */
export const dynamic = 'force-dynamic';

/** Search engines cut a description around here; the rules are the market's own summary. */
const META_DESCRIPTION_MAX = 160;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  // The same React-cached call the body makes, so metadata costs no second round trip.
  const market = await fetchMarketServer(slug);
  if (market === null) return { title: `${copy.marketNotFound} | ${copy.appName}` };
  return {
    title: `${market.title} | ${copy.appName}`,
    description: market.rules.slice(0, META_DESCRIPTION_MAX),
  };
}

export default async function MarketPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // `null` is every address that cannot name a public market: an unknown slug, a slug the route
  // schema refuses, and a draft — which the API answers as NOT_FOUND because it is invisible
  // outside the admin. All three are one 404 to a visitor.
  const market = await fetchMarketServer(slug);
  if (market === null) notFound();

  // Every sub-resource of the detail is a uuid-only route, so everything below the row speaks
  // `market.id` and never the slug the URL carried (A-M3-29).
  //
  // `null` when the ticks read failed, and the page renders anyway: the chart is one region of
  // this screen and it reports its own failure, while the question and the 규칙 below are
  // already in hand. Only the row may 404 or 500 this route (api.server.ts).
  //
  // 관련 시장 (#65) is read beside it, as the home reads its list (`prefetchRelatedMarkets`), so
  // the section's first page is in the HTML. It is public (ADR-0061 decision 1, item 18), so this
  // is the same page for every visitor. The two reads run together, so the page waits for the
  // slower; the section's read is tried once, never retried here, and a failure is swallowed — the
  // section then reads its page in the browser and shows its own failure (lib/market-ssr.ts).
  // 토론 (#47) is NOT read here: it loads in the browser only (owner decision 2026-10-20 1, the
  // header comment above), its loading state in the HTML.
  const queryClient = getQueryClient();
  const [series] = await Promise.all([
    fetchTicksServer(market.id, DEFAULT_TICK_RANGE),
    prefetchRelatedMarkets(queryClient, market.id, fetchRelatedMarketsPageServer),
  ]);
  seedMarketDetail(queryClient, market, series);
  // The related cards' countdowns measure against the server's read of them, as the home's do
  // (app/page.tsx says why it is the query's own `dataUpdatedAt`); 0 is a read that failed.
  const relatedFetchedAt =
    queryClient.getQueryState(relatedMarketsKey(market.id))?.dataUpdatedAt ?? 0;

  return (
    // The home's and the header's width and side padding (1320px, 24px), so the two columns
    // from md up — the sections and the order panel (market-detail.tsx) — line up with the
    // header's edges (ADR-0067). The bottom tab bar's clearance is the footer's (footer.tsx); the
    // 매수 bar below md keeps its own place in the flow (order-entry-bar.tsx).
    <Container maxW="1320px" px="6" py={{ base: '6', md: '10' }}>
      {/* Every AC 2 string reaches view-source through the SAME door: this boundary. It
          hydrates a not-yet-present query synchronously during render, so the server pass of
          each client component below already reads the seeded row — the question, the 시장가격
          and the 규칙 alike — while each still follows the live cache afterwards.
          The heading is INSIDE it for exactly that reason and must stay: rendered above the
          boundary it would run before the seed existed, and measurement showed that takes
          시장가격, the status badge and the chart path out of the first paint with it. Each
          component carries the server row as its own `fallback` besides, so no branch can leave
          an AC 2 string out even if the query is unreadable. */}
      <HydrationBoundary state={dehydratePublic(queryClient)}>
        {/* `now` is the server's own window end, never a clock read in this render body — see
            `detailWindowEnd`. It is absent when the series is. The nodes are rendered HERE and
            only placed by `MarketDetail`, outside every branch it takes. 배경 and 규칙 are
            rendered once for each width: md and up draws them before the chart, below md after
            the 호가·거래 내역 switch, and each width reads its own copy where it is drawn
            (lib/market-detail.ts `DETAIL_SLOTS`). Both copies are in the HTML. Written out
            rather than built with `perWidth`: lib/market-detail.ts loads the app's Chakra system,
            which fails to load in a server component. */}
        <MarketDetail
          marketId={market.id}
          now={detailWindowEnd(series)}
          // h2, not h1: `Nav` renders the site name as this document's only h1 on every screen
          // (nav.tsx, since M1), and MY and / both title themselves h2 under it. A second h1
          // here would give the page two, and heading level is not a place for one screen to
          // have its own convention (A-M4-31). The row fetched here is the FALLBACK, not the
          // source: `title` is editable while a market is open, and the chart's label already
          // follows the live row.
          question={<LiveQuestionHeading fallback={market} />}
          // 배경 (N02 §4), the market's description, when it has one.
          background={{
            md: <LiveBackgroundSection fallback={market} width="md" />,
            base: <LiveBackgroundSection fallback={market} width="base" />,
          }}
          // PLAN 11.1's Kalshi principle: 규칙 is never collapsed on the detail. It promises no
          // 판정 schedule (#22's '일정' panel will). The row fetched here is the FALLBACK, not
          // the source: the section follows the live cache so an admin's edit to the rules or
          // the close time cannot leave this panel describing a market the countdown above has
          // already moved past.
          rules={{
            md: <LiveRulesSection fallback={market} width="md" />,
            base: <LiveRulesSection fallback={market} width="base" />,
          }}
          // 관련 시장 (#65, ADR-0068), the last section at both widths, so one node: the home's
          // cards for the markets an admin linked to this one, first page read above. 토론 (#47)
          // needs nothing from here: `MarketDetail` builds it from the id, and it reads its posts
          // in the browser.
          related={
            <RelatedMarkets
              marketId={market.id}
              now={relatedFetchedAt === 0 ? undefined : relatedFetchedAt}
            />
          }
        />
      </HydrationBoundary>
    </Container>
  );
}
