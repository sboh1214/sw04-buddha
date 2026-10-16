'use client';

import { Heading, Stack } from '@chakra-ui/react';
import { copy } from '@/copy';
import { useRelatedMarkets } from '@/hooks/use-markets';
import { MarketGrid } from '../../market-list';

/**
 * 관련 시장 (#65, ADR-0068): the detail's last section (N02 §4), after 토론 at both widths — the
 * markets an admin linked to this one, from either side of the link (ADR-0061 decision 1, item 19).
 *
 * No section card around it (owner decision 2026-10-17, '바깥 카드 없이'): the section's `h2` and,
 * under it, the home's grid as it is (`MarketGrid`, `MarketCard` — the #65 row of decision 3), so
 * the tiles are not boxes inside a box. The `h2` keeps it one section among the detail's for a
 * screen reader's heading list, and the column's gap (market-detail.tsx) spaces it from 토론 as
 * it spaces every section; the heading sits closer to the grid than to 토론, so it reads as the
 * grid's title. The grid brings the home's rungs (skeleton, a first load that failed with 다시
 * 시도, the empty notice — with no card around it either, 관련 시장이 없습니다 under the heading —
 * 더 보기 and the refresh notice), the home's cards with their titles one level down (`h3`), and
 * each card joining its market's room, so a `market:tick` or a `market:status` moves the card
 * without a request (realtime-provider.tsx writes every `['markets', …]` page). With nothing to
 * show — no link, or none in a shown status — the section stays and says so (item 19).
 *
 * Public (item 18): the page reads the first page on the server, without a cookie, and dehydrates
 * it with the detail (page.tsx), so the cards are in the HTML every visitor gets. `now` is that
 * read's own instant, for the countdowns of the cards the server drew (`rowAnchor`); absent when
 * the server's read failed, and the section reads the page itself.
 */
export function RelatedMarkets({ marketId, now }: { marketId: string; now?: number }) {
  const related = useRelatedMarkets(marketId);
  return (
    <Stack gap="4" minW="0" data-testid="market-related">
      <Heading as="h2" size="md">
        {copy.marketRelated}
      </Heading>
      <MarketGrid
        list={related}
        now={now}
        emptyMessage={copy.marketRelatedEmpty}
        cardTitleAs="h3"
        testId="market-related-list"
      />
    </Stack>
  );
}
