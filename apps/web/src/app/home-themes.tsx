'use client';

import { Grid, Heading, HStack, Link as ChakraLink, Stack } from '@chakra-ui/react';
import NextLink from 'next/link';
import { THEME_GRID_COLUMNS, ThemeCard } from '@/components/theme/theme-card';
import { copy } from '@/copy';
import { useHomeThemes } from '@/hooks/use-themes';

/**
 * 진행 중인 테마 on the explore home (ADR-0069 decision 4, '탐색 홈 노출'): the ongoing themes that
 * end soonest, as cards, with 모든 테마 to the list page. At the top of the main column, above the
 * list's headline, on 전체 only (`showsHomeThemes`, the page decides) — the place of this PR
 * (ADR-0088), so the row the owner asked for is the first thing the home shows and the market
 * list keeps its headline and its sort controls together below it (ADR-0065).
 *
 * Nothing at all while there is no ongoing theme — no heading over an empty row — and nothing
 * while the row is unknown or its read failed: it is a few links beside the home's own list, which
 * says its own failures. The page read it on the server, so the HTML already has it.
 */
export function HomeThemes() {
  const themes = useHomeThemes();
  const rows = themes.data ?? [];
  if (rows.length === 0) return null;
  return (
    <Stack as="section" gap="3" data-testid="home-themes">
      <HStack justify="space-between" align="baseline" gap="3" flexWrap="wrap">
        <Heading as="h2" size="lg">
          {copy.homeThemes}
        </Heading>
        <ChakraLink asChild fontSize="sm" colorPalette="brand" color="colorPalette.fg">
          <NextLink href="/themes" data-testid="home-themes-all">
            {copy.homeThemesAll}
          </NextLink>
        </ChakraLink>
      </HStack>
      <Grid templateColumns={THEME_GRID_COLUMNS} gap="3">
        {rows.map((theme) => (
          <ThemeCard key={theme.id} theme={theme} />
        ))}
      </Grid>
    </Stack>
  );
}
