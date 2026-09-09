'use client';

import { SimpleGrid, Stack, Text } from '@chakra-ui/react';
import { MarketCard } from '@/components/market/market-card';
import { RulesSection } from '@/components/market/rules-section';
import { copy } from '@/copy';
import { type Category, type MarketSummary } from '@/lib/api';
import { type MarketFormValues, toCreateMarketBody } from '@/lib/market-form';
import { toPreviewMarket } from '@/lib/market-preview';

/**
 * 카드·상세 미리보기 (PLAN 12), the preview ADR-0027 deferred to M4 (Q-M3-6).
 *
 * It draws the REAL `MarketCard` and the REAL `RulesSection` from what the form is holding right
 * now — that deferral is the whole point. A preview assembled out of lookalike markup would drift
 * from the visitor's screen the first time either component changed, and the admin would be
 * approving a picture of a market nobody sees. So nothing here re-implements a card.
 *
 * Read-only in the strict sense: no query, no mutation, and no clock. `CountdownBadge` with no
 * `now` shows the absolute close time until it has mounted (countdown-badge.tsx), which is what a
 * client component that Next also renders on the server needs — a `Date.now()` in this render
 * would put a different string in the server's HTML than in the first client render.
 */

export interface MarketPreviewProps {
  /** The form's live values (`watch()`), so the preview tracks typing. */
  values: MarketFormValues;
  /** The active categories the select was built from; the card's tag needs the Korean name. */
  categories: Category[];
  /**
   * The market being EDITED, when there is one. It carries the history the form cannot express —
   * the traded price above all — so the preview of an already-open market is the card visitors
   * actually see rather than the one it opened as. Absent on 시장 만들기, which has no history.
   */
  base?: MarketSummary;
}

export function MarketPreview({ values, categories, base }: MarketPreviewProps) {
  const body = toCreateMarketBody(values);
  // Nothing worth previewing before the question is typed, and a card without one would put a
  // link with no accessible name on the page — an accessibility failure, not just noise.
  if (body.title === '') return null;

  return (
    <Stack gap="3" borderTopWidth="1px" pt="4" data-testid="market-preview">
      <Text fontWeight="semibold">{copy.adminMarketPreview}</Text>
      <SimpleGrid columns={{ base: 1, md: 2 }} gap="4" alignItems="start">
        <Stack gap="2">
          <Text fontSize="sm" color="fg.muted">
            {copy.adminMarketPreviewCard}
          </Text>
          {/*
            The card is a picture of the form, not a way out of it: `/markets/[slug]` is a page
            that does not exist for an unsaved draft, and following it from 수정 would abandon
            what is typed. `interactive={false}` makes the title plain text; the capture-phase
            `preventDefault` that used to sit on this Stack is gone with it, because cancelling a
            click leaves the anchor in the tab order and in a screen reader's links list — an
            admin reached a link named after the market that did nothing — and never saw the
            middle-click (`auxclick`) that opened the href in a new tab anyway.
          */}
          <MarketCard market={toPreviewMarket(body, categories, base)} interactive={false} />
        </Stack>
        <Stack gap="2">
          <Text fontSize="sm" color="fg.muted">
            {copy.adminMarketPreviewDetail}
          </Text>
          {/* `RulesSection` defaults to `market-rules`, which the 정산 기준 textarea above owns. */}
          <RulesSection
            market={{
              rules: body.rules,
              resolutionSource: body.resolutionSource ?? null,
              closeAt: body.closeAt,
            }}
            data-testid="market-preview-rules"
          />
        </Stack>
      </SimpleGrid>
    </Stack>
  );
}
