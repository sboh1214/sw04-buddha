'use client';

import { RuleVersionsSection } from '@/components/market/rule-versions-section';
import { RulesSection } from '@/components/market/rules-section';
import { useMarket } from '@/hooks/use-markets';
import { type Market } from '@/lib/api';
import { type DetailWidth, copyTestId } from '@/lib/market-detail';

/**
 * 규칙, drawn from the live `['market', id]` row rather than the snapshot the server
 * component happened to fetch, and after it 규칙 버전 (#80, ADR-0101: `RuleVersionsSection`).
 *
 * What this section shows changes while a market is open: since #80 every version item — the
 * title, the rule items (#23) and the times (#22) — by an approved supplement (ADR-0093 decision 2
 * #172 items 14·15), whose approval republishes `market:status` with the status unchanged so the
 * row is read again — and the rest of the detail already follows the row: a focus refetch could
 * move the countdown to a new `closeAt` while this section still quoted the old deadline and the
 * old rules until a full route reload. That is the one panel PLAN 11.1 asks a visitor to trust
 * before spending Coin, so it may not be the last thing on the screen still describing a market
 * that has changed; the version history beside it reads the same row, so the current version it
 * names is always the text above it.
 *
 * The SSR row stays as a guaranteed FALLBACK, and that is what keeps AC 2 intact. This renders
 * inside the page's `HydrationBoundary`, so the server pass reads the seeded row and writes the
 * rules into the HTML exactly as `MarketDetail`'s own header writes the question and the
 * probability — and if the query ever holds nothing, `fallback` is the row the server fetched,
 * so no branch here can leave 규칙 out of view-source.
 *
 * The detail draws 규칙 in a different place at each width, so it renders one copy per width
 * (`DETAIL_SLOTS`), and `width` names this one: the card is `market-rules-<width>` and each row
 * that with its suffix — `-yes`, `-close-at` and the rest (`copyTestId`, `RulesSection`); the
 * history card is `market-rule-versions-<width>`. Both are the copy's: the slot draws no box of its
 * own (`copyDisplay`), so they stand as two cards of the column.
 */
export function LiveRulesSection({ fallback, width }: { fallback: Market; width: DetailWidth }) {
  const market = useMarket(fallback.id).data ?? fallback;
  return (
    <>
      <RulesSection market={market} data-testid={copyTestId('market-rules', width)} />
      <RuleVersionsSection
        market={market}
        data-testid={copyTestId('market-rule-versions', width)}
      />
    </>
  );
}
