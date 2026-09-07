'use client';

import {
  Badge,
  Box,
  HStack,
  Image,
  LinkBox,
  LinkOverlay,
  Stack,
  Tag,
  Text,
} from '@chakra-ui/react';
import { formatP, parsePAmount } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useState } from 'react';
import { copy } from '@/copy';
import { type MarketSummary } from '@/lib/api';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE, formatYesPrice } from '@/lib/market-admin';
import { CountdownBadge } from './countdown-badge';
import { MarketSparkline } from './market-sparkline';

/**
 * One market in the home grid (PLAN 11.4 MarketCard, PLAN 11.1's Polymarket note): 질문 · 확률
 * 배지 · 스파크라인 · 거래량 · 마감 · 카테고리, the whole card a link to the detail.
 *
 * The probability is plain text, never `RollingNumber`. AC 1 requires a card to UPDATE within a
 * second, not to animate; PLAN 11.1-1 says a card shows "63%" only; and the rolling markup
 * would cost ten spans per digit in every card of the server's HTML for a page nobody stares
 * at. The socket writes the list cache, this text re-renders, and that is the whole of AC 1
 * here.
 *
 * `market` is a `MarketSummary` rather than the list's `MarketListItem`, and the sparkline is a
 * separate optional prop, so the admin's 카드 미리보기 (Q-M3-6) can render the REAL card from a
 * draft that has no history at all — the preview must show what a visitor will see, not a
 * lookalike that drifts from it.
 *
 * `LinkBox`/`LinkOverlay` rather than an anchor wrapped round the card: the accessible name of
 * the link is then the question alone, while the whole card stays clickable. An anchor around
 * everything would announce the category, the price, the volume and the countdown as one name.
 *
 * The picture is a Chakra `Image` — a plain `<img>` — and never `next/image`: `next.config.ts`
 * declares no `images` block, so the optimizer answers 400 for the off-origin URLs an admin
 * types, and `output: 'standalone'` does not bundle the `sharp` it wants either. The trade is
 * that a broken URL has to be handled here, which is what `failedImage` below is for.
 */

export interface MarketCardProps {
  market: MarketSummary;
  /**
   * `MarketListItem.sparkline` — oldest-first hourly pYesBp. Absent for a draft preview, and
   * `[]` for a market with no tick at all; both render as an empty box of the same height.
   */
  sparkline?: number[];
  /**
   * The instant the countdown measures against, from the caller's server render. Omitted, the
   * badge shows the absolute close time until it has mounted (countdown-badge.tsx).
   */
  now?: number;
  'data-testid'?: string;
}

export function MarketCard({ market, sparkline, now, 'data-testid': testId }: MarketCardProps) {
  /**
   * The URL that failed, not a boolean: a card whose image is replaced (an admin edit arriving
   * over the socket, or the preview being typed into) then tries the new one instead of staying
   * broken, and no effect is needed to reset it.
   */
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const imageUrl = market.imageUrl;
  /**
   * `typedRoutes` only accepts an inline template literal once `/markets/[slug]` exists in the
   * generated route map, and the route directory lands with the detail screen; a `string` with
   * the cast the repo already uses for `redirect(nextPath as Route)` is correct either way.
   */
  const href = `/markets/${market.slug}` as Route;

  return (
    <LinkBox
      as="article"
      borderWidth="1px"
      borderRadius="l2"
      p="4"
      bg="bg"
      _hover={{ bg: 'bg.subtle' }}
      data-testid={testId ?? `market-card-${market.id}`}
    >
      <HStack align="start" gap="3">
        {imageUrl === null ? null : imageUrl === failedImage ? (
          // A dead URL keeps its box rather than collapsing it: a card that reflows a second
          // after it painted is worse than one that never had a picture. A market with no
          // image at all renders neither, so the grid is not a field of grey squares.
          <Box boxSize="12" borderRadius="l2" bg="bg.muted" flexShrink="0" aria-hidden="true" />
        ) : (
          <Image
            src={imageUrl}
            // Decorative: the question below is the card's meaning, and an admin-entered image
            // carries no alternative text for a screen reader to read.
            alt=""
            boxSize="12"
            borderRadius="l2"
            fit="cover"
            flexShrink="0"
            loading="lazy"
            onError={() => {
              setFailedImage(imageUrl);
            }}
          />
        )}

        <Stack gap="2" flex="1" minW="0">
          <HStack gap="2" flexWrap="wrap">
            <Tag.Root size="sm" variant="surface">
              <Tag.Label>{market.category.nameKo}</Tag.Label>
            </Tag.Root>
            {/* An open market's state is the countdown below; anything else is worth naming. */}
            {market.status !== 'open' && (
              <Badge colorPalette={MARKET_STATUS_PALETTE[market.status]} variant="subtle">
                {MARKET_STATUS_LABEL[market.status]}
              </Badge>
            )}
          </HStack>

          <LinkOverlay asChild>
            <NextLink href={href}>
              <Text fontWeight="semibold" lineClamp="2">
                {market.title}
              </Text>
            </NextLink>
          </LinkOverlay>

          <HStack gap="3" justify="space-between">
            <Badge
              size="lg"
              variant="subtle"
              colorPalette="brand"
              data-testid="market-card-probability"
            >
              {formatYesPrice(market.lastPrice)}
            </Badge>
            {sparkline === undefined ? null : <MarketSparkline points={sparkline} />}
          </HStack>

          <HStack gap="2" flexWrap="wrap" fontSize="xs" color="fg.muted">
            <Text>
              {copy.marketVolume} {formatP(parsePAmount(market.volumeP))}
            </Text>
            <CountdownBadge market={market} now={now} size="xs" />
          </HStack>
        </Stack>
      </HStack>
    </LinkBox>
  );
}
