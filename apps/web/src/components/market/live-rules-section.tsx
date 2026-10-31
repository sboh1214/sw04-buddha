'use client';

import { RulesSection } from '@/components/market/rules-section';
import { useMarket } from '@/hooks/use-markets';
import { type Market } from '@/lib/api';
import { type DetailWidth, copyTestId } from '@/lib/market-detail';

/**
 * 규칙, drawn from the live `['market', id]` row rather than the snapshot the server
 * component happened to fetch.
 *
 * What this section shows is EDITABLE while a market is open — every rule item (#23) until #80's
 * supplements replace that, and the close time (`market-admin.service.ts`) — and the rest of the
 * detail already follows the row: a focus refetch could move the countdown to a new `closeAt`
 * while this section still quoted the old deadline and the old rules until a full route reload.
 * That is the one panel PLAN 11.1 asks a visitor to trust before spending Coin, so it may not be
 * the last thing on the screen still describing a market that has changed.
 *
 * The SSR row stays as a guaranteed FALLBACK, and that is what keeps AC 2 intact. This renders
 * inside the page's `HydrationBoundary`, so the server pass reads the seeded row and writes the
 * rules into the HTML exactly as `MarketDetail`'s own header writes the question and the
 * probability — and if the query ever holds nothing, `fallback` is the row the server fetched,
 * so no branch here can leave 규칙 out of view-source.
 *
 * The detail draws 규칙 in a different place at each width, so it renders one copy per width
 * (`DETAIL_SLOTS`), and `width` names this one: the card is `market-rules-<width>` and each row
 * that with its suffix — `-yes`, `-close-at` and the rest (`copyTestId`, `RulesSection`).
 */
export function LiveRulesSection({ fallback, width }: { fallback: Market; width: DetailWidth }) {
  const market = useMarket(fallback.id).data ?? fallback;
  return <RulesSection market={market} data-testid={copyTestId('market-rules', width)} />;
}
