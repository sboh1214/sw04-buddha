'use client';

import { HStack, Tag, Text } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { useMarketThemes } from '@/hooks/use-themes';
import { THEME_LINK_SEPARATOR, THEME_STATUS_LABEL, themeLinkLabel, themePath } from '@/lib/themes';

/**
 * The themes this market is in (ADR-0069 decision 4, '시장 상세의 소속 묶음 링크'): one line at the
 * end of 요약, '테마' and a tag per published theme that opens its page, in the public list's order
 * (진행 중 → 예정 → 종료). Each tag says the theme's status after its name, `노벨상 주간 · 진행 중`,
 * and an ended theme is linked too (owner decision 2026-10-19, second round: `themeLinkLabel`).
 * The place is this PR's (ADR-0088): the market's own facts stay where ADR-0067 put them, and the
 * links sit under them, before the sections, where a reader who came from a theme finds the way
 * back.
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
          {/* The name may be cut to one line (a tag's label is); the status never is, so it is a
              run of its own beside it, in the label's text style — the md tag sets its size on the
              label alone, and the run would otherwise inherit the page's 16px beside a 12px name.
              The link's name is the whole text, as it reads. */}
          <NextLink
            href={themePath(theme.slug) as Route}
            aria-label={themeLinkLabel(theme)}
            data-testid={`market-theme-${theme.id}`}
          >
            <Tag.Label data-testid={`market-theme-name-${theme.id}`}>{theme.name}</Tag.Label>
            <Text
              as="span"
              textStyle="xs"
              flexShrink="0"
              whiteSpace="nowrap"
              color="fg.muted"
              data-testid={`market-theme-status-${theme.id}`}
            >
              {THEME_LINK_SEPARATOR.trimStart()}
              {THEME_STATUS_LABEL[theme.status]}
            </Text>
          </NextLink>
        </Tag.Root>
      ))}
    </HStack>
  );
}
