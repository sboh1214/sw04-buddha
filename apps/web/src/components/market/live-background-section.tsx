'use client';

import { Card, Heading, Text } from '@chakra-ui/react';
import { copy } from '@/copy';
import { useMarket } from '@/hooks/use-markets';
import { type Market } from '@/lib/api';
import { backgroundText } from '@/lib/market-detail';

/**
 * 배경 (N02 §4 질문·배경·규칙…, #122): the market's `description`, which the public DTO has always
 * carried and no screen drew. Plain text on a `pre-wrap` block exactly like 규칙 (rules-section.tsx):
 * no markdown renderer exists in this repo, and one for a paragraph would be a dependency plus an
 * HTML-injection surface. A market without a description has no 배경 section at all
 * (`backgroundText`).
 *
 * Live for the reason `LiveRulesSection` is: the description is editable while a market is open,
 * and the rest of the screen follows the `['market', id]` row. The server's row is the fallback,
 * and this renders inside the page's `HydrationBoundary`, so the text is in the server's HTML.
 */
export function LiveBackgroundSection({ fallback }: { fallback: Market }) {
  const market = useMarket(fallback.id).data ?? fallback;
  const description = backgroundText(market.description);
  if (description === null) return null;
  return (
    <Card.Root data-testid="market-background">
      <Card.Header>
        <Heading as="h2" size="md">
          {copy.marketBackground}
        </Heading>
      </Card.Header>
      <Card.Body>
        <Text whiteSpace="pre-wrap" wordBreak="break-word" data-testid="market-background-text">
          {description}
        </Text>
      </Card.Body>
    </Card.Root>
  );
}
