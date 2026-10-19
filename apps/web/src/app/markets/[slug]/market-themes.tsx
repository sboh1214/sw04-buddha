'use client';

import { HStack, Tag, Text } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { useMarketThemes } from '@/hooks/use-themes';
import { themePath } from '@/lib/themes';

/**
 * The themes this market is in (ADR-0069 decision 4, '시장 상세의 소속 묶음 링크'): one line at the
 * end of 요약, '테마' and a tag per published theme that opens its page, in the public list's order
 * (진행 중 → 예정 → 종료). The place is this PR's (ADR-0088): the market's own facts stay where
 * ADR-0067 put them, and the links sit under them, before the sections, where a reader who came
 * from a theme finds the way back.
 *
 * Nothing when the market is in no published theme — no label over nothing — and nothing while
 * the links are unknown or their read failed: they are links beside the detail, not a section of
 * it. The page read them on the server, so the HTML has them.
 */
export function MarketThemes({ marketId }: { marketId: string }) {
  const themes = useMarketThemes(marketId);
  const rows = themes.data ?? [];
  if (rows.length === 0) return null;
  return (
    <HStack gap="2" flexWrap="wrap" data-testid="market-themes">
      <Text fontSize="sm" color="fg.muted">
        {copy.marketThemes}
      </Text>
      {rows.map((theme) => (
        <Tag.Root key={theme.id} size="md" variant="outline" asChild>
          <NextLink href={themePath(theme.slug) as Route} data-testid={`market-theme-${theme.id}`}>
            <Tag.Label>{theme.name}</Tag.Label>
          </NextLink>
        </Tag.Root>
      ))}
    </HStack>
  );
}
