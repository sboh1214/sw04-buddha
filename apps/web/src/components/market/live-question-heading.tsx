'use client';

import { Heading } from '@chakra-ui/react';
import { useMarket } from '@/hooks/use-markets';
import { type Market } from '@/lib/api';

/**
 * 시장 상세의 질문, drawn from the live `['market', id]` row rather than the snapshot the server
 * component happened to fetch — the same shape, and for the same reason, as `LiveRulesSection`.
 *
 * `title` is EDITABLE while a market is open (`market-admin.service.ts` refuses only `slug` on
 * an open row), and the rest of the screen already follows the cache: the chart's accessible
 * label reads `useMarket`. So
 * an admin's correction left the page's own heading quoting the OLD question beside a chart
 * labelled with the new one, and only a full route reload reconciled them — no `market:updated`
 * event exists, so the row moves on a focus refetch, a reconnect `resnapshot`, or a mount past
 * `staleTime`, none of which touch a value the server component baked in.
 *
 * The SSR row stays as a guaranteed FALLBACK, and that is what keeps AC 2 intact — the question
 * must be in view-source. It renders INSIDE the page's `HydrationBoundary`, which is not a
 * detail: the boundary hydrates a not-yet-present query synchronously during render, so the
 * server pass reads the seeded row and writes the question into the HTML. Placed OUTSIDE it,
 * this component would render before the seed existed and — measured — take 시장가격, the status
 * badge and the chart path out of the first paint with it.
 *
 * `generateMetadata` is a residue this cannot reach: the document `<title>` and the description
 * are produced by a server-only render with no client cache to follow, so a title edit still
 * needs a reload to move them (A-M4-34).
 */
export function LiveQuestionHeading({ fallback }: { fallback: Market }) {
  const market = useMarket(fallback.id).data ?? fallback;
  return (
    <Heading as="h2" size="2xl" data-testid="market-detail-question">
      {market.title}
    </Heading>
  );
}
