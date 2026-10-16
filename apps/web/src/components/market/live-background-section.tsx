'use client';

import { Card, Heading, Text } from '@chakra-ui/react';
import { copy } from '@/copy';
import { useMarket } from '@/hooks/use-markets';
import { type Market } from '@/lib/api';
import { type DetailWidth, backgroundText, copyTestId } from '@/lib/market-detail';

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
 *
 * The detail draws 배경 in a different place at each width, so it renders one copy per width
 * (`DETAIL_SLOTS`), and `width` names this one: the card is `market-background-<width>` and its
 * text that with `-text` (`copyTestId`).
 */
export function LiveBackgroundSection({
  fallback,
  width,
}: {
  fallback: Market;
  width: DetailWidth;
}) {
  const market = useMarket(fallback.id).data ?? fallback;
  const testId = copyTestId('market-background', width);
  const description = backgroundText(market.description);
  if (description === null) return null;
  return (
    <Card.Root data-testid={testId}>
      <Card.Header>
        <Heading as="h2" size="md">
          {copy.marketBackground}
        </Heading>
      </Card.Header>
      <Card.Body>
        <Text whiteSpace="pre-wrap" wordBreak="break-word" data-testid={`${testId}-text`}>
          {description}
        </Text>
      </Card.Body>
    </Card.Root>
  );
}
