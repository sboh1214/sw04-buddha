'use client';

import { RulesSection } from '@/components/market/rules-section';
import { useMarket } from '@/hooks/use-markets';
import { type Market } from '@/lib/api';

/**
 * 정산 기준, drawn from the live `['market', id]` row rather than the snapshot the server
 * component happened to fetch.
 *
 * The three fields this section shows are all EDITABLE while a market is open
 * (`market-admin.service.ts` allows 문안·마감 시각·카테고리), and the rest of the detail already
 * follows the row: a focus refetch could move the countdown to a new `closeAt` while this
 * section still quoted the old deadline and the old rules until a full route reload. That is
 * the one panel PLAN 11.1 asks a visitor to trust before spending P, so it may not be the last
 * thing on the screen still describing a market that has changed.
 *
 * The SSR row stays as a guaranteed FALLBACK, and that is what keeps AC 2 intact. This renders
 * inside the page's `HydrationBoundary`, so the server pass reads the seeded row and writes the
 * rules into the HTML exactly as `MarketDetail`'s own header writes the question and the
 * probability — and if the query ever holds nothing, `fallback` is the row the server fetched,
 * so no branch here can leave 정산 기준 out of view-source.
 */
export function LiveRulesSection({ fallback }: { fallback: Market }) {
  const market = useMarket(fallback.id).data ?? fallback;
  return <RulesSection market={market} settlementAt={market.disputeUntil} />;
}
