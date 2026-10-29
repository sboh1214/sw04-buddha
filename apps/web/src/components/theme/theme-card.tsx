'use client';

import { Badge, Heading, HStack, LinkBox, LinkOverlay, Stack, Text } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { type ThemeSummary } from '@/lib/api';
import { THEME_STATUS_BADGE, THEME_STATUS_LABEL, formatThemePeriod, themePath } from '@/lib/themes';

/**
 * 예정·진행 중·종료 (ADR-0069 decision 4, '진행 기간') as a label: the words say it, the look only
 * repeats it (`THEME_STATUS_BADGE`).
 */
export function ThemeStatusBadge({
  theme,
  testId,
}: {
  theme: Pick<ThemeSummary, 'status'>;
  testId?: string;
}) {
  const look = THEME_STATUS_BADGE[theme.status];
  return (
    <Badge colorPalette={look.colorPalette} variant={look.variant} data-testid={testId}>
      {THEME_STATUS_LABEL[theme.status]}
    </Badge>
  );
}

/**
 * One theme in a list — the public list (`/themes`) and the explore home's theme row: its status,
 * its period in Korean dates and its name, the whole card a link to its page (`/themes/<slug>`).
 * Nothing else: who made it is not public, and a theme has no count, score or reward to show
 * (ADR-0069 decision 4, '이름').
 */
export function ThemeCard({
  theme,
  readAt,
  titleAs = 'h3',
}: {
  theme: ThemeSummary;
  /** When the list was read (its query's `dataUpdatedAt`): the year the period is written against. */
  readAt: number;
  /** The name's heading level, one below the heading of the list the card sits in. */
  titleAs?: 'h3' | 'h4';
}) {
  // `LinkBox`/`LinkOverlay`, as the market card: the whole card takes the click, and the link's
  // accessible name is the theme's name alone.
  return (
    <LinkBox
      as="article"
      borderWidth="1px"
      borderRadius="card"
      bg="surface.card"
      p="4"
      transition="border-color 0.15s"
      _hover={{ borderColor: 'border.emphasized' }}
      data-testid={`theme-card-${theme.id}`}
    >
      <Stack gap="2">
        <HStack gap="2" flexWrap="wrap">
          <ThemeStatusBadge theme={theme} />
          <Text fontSize="sm" color="fg.muted" data-testid={`theme-card-period-${theme.id}`}>
            {formatThemePeriod(theme, readAt)}
          </Text>
        </HStack>
        <Heading as={titleAs} size="md" lineClamp="2">
          <LinkOverlay asChild>
            <NextLink href={themePath(theme.slug) as Route}>{theme.name}</NextLink>
          </LinkOverlay>
        </Heading>
      </Stack>
    </LinkBox>
  );
}

/** The grid the theme cards sit in: one column on a phone, as many 320px ones as fit above. */
export const THEME_GRID_COLUMNS = 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))';
