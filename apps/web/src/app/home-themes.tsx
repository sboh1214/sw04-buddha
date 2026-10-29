'use client';

import { Grid, Heading, HStack, Link as ChakraLink, Stack, Text } from '@chakra-ui/react';
import NextLink from 'next/link';
import { THEME_GRID_COLUMNS, ThemeCard } from '@/components/theme/theme-card';
import { copy } from '@/copy';
import { useHomeThemes } from '@/hooks/use-themes';
import { type HomeThemesRow, homeThemesRow } from '@/lib/themes';

/** The row's heading: the status its cards are, or the feature's name over no card. */
const HEADING: Record<NonNullable<HomeThemesRow['status']> | 'none', string> = {
  ongoing: copy.homeThemesOngoing,
  upcoming: copy.homeThemesUpcoming,
  none: copy.homeThemesNone,
};

/**
 * The explore home's theme row (ADR-0069 decision 4, '탐색 홈 노출'; owner decision 2026-10-19,
 * second round): the ongoing themes that end soonest — or, when none is ongoing, the upcoming ones
 * that start soonest — as cards, up to six, with 모든 테마 to the list page. While every public
 * theme has ended the row stays with its heading, a line that nothing is on or coming, and 모든
 * 테마; it is gone only when no theme is public at all (`homeThemesRow`). At the top of the main
 * column, above the list's headline, on 전체 only (`showsHomeThemes`, the page decides) — the place
 * of this PR, which the owner kept (ADR-0088): the market list keeps its headline and its sort
 * controls together below it (ADR-0065).
 *
 * Nothing while the row is unknown or its read failed: it is a few links beside the home's own
 * list, which says its own failures. The page read it on the server, so the HTML already has it.
 */
export function HomeThemes() {
  const themes = useHomeThemes();
  const row = homeThemesRow(themes.data ?? []);
  if (row === null) return null;
  return (
    <Stack as="section" gap="3" data-testid="home-themes">
      <HStack justify="space-between" align="baseline" gap="3" flexWrap="wrap">
        <Heading as="h2" size="lg">
          {HEADING[row.status ?? 'none']}
        </Heading>
        <ChakraLink asChild fontSize="sm" colorPalette="brand" color="colorPalette.fg">
          <NextLink href="/themes" data-testid="home-themes-all">
            {copy.homeThemesAll}
          </NextLink>
        </ChakraLink>
      </HStack>
      {row.themes.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" data-testid="home-themes-none">
          {copy.homeThemesNoneBody}
        </Text>
      ) : (
        <Grid templateColumns={THEME_GRID_COLUMNS} gap="3">
          {row.themes.map((theme) => (
            <ThemeCard key={theme.id} theme={theme} readAt={themes.dataUpdatedAt} />
          ))}
        </Grid>
      )}
    </Stack>
  );
}
