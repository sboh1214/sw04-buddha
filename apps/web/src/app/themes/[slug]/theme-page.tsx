'use client';

import {
  Alert,
  Badge,
  Button,
  Heading,
  HStack,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { ThemeStatusBadge } from '@/components/theme/theme-card';
import { DateTimeText } from '@/components/time-zone/time-zone-provider';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useTheme, useThemeMarkets, useThemeResults } from '@/hooks/use-themes';
import { type Theme, type ThemeNotice } from '@/lib/api';
import { MARKET_STATUS_LABEL } from '@/lib/market-admin';
import { listSection } from '@/lib/query-client';
import { formatThemePeriod, noticeParts, themeResultLabel } from '@/lib/themes';
import { MarketGrid } from '../../market-list';

/**
 * The live half of a theme's page (#81, N05 §7): what the server seeded, kept current by the
 * cache. In N05 §7's order — 진행 기간, 공지, 연결 시장 (the participation links: each card opens
 * its market), 결과 목록 — after the name and the introduction. Headings: the name is the page's
 * `h2` under the nav's `h1`, each section an `h3`, and a market card or a notice title an `h4`
 * (one convention for the outline, A-M4-31).
 */
export function ThemePage({
  themeId,
  fallback,
  marketsNow,
}: {
  themeId: string;
  /** The row the server read, should the cache not hold it (the seed is the path). */
  fallback: Theme;
  /** The server's read of the first market page, for the cards' countdowns (`rowAnchor`). */
  marketsNow?: number;
}) {
  const query = useTheme(themeId);
  const theme = query.data ?? fallback;
  return (
    <Stack gap="10" data-testid="theme-page">
      <Stack gap="3">
        <ChakraLink asChild fontSize="sm" color="fg.muted" alignSelf="flex-start">
          <NextLink href="/themes" data-testid="theme-back">
            {copy.themeBackToList}
          </NextLink>
        </ChakraLink>
        <HStack gap="2" flexWrap="wrap">
          <ThemeStatusBadge theme={theme} testId="theme-status" />
          <Text color="fg.muted" data-testid="theme-period">
            {formatThemePeriod(theme)}
          </Text>
        </HStack>
        <Heading as="h2" size="2xl" data-testid="theme-name">
          {theme.name}
        </Heading>
        {/* Plain text with its line breaks, as the operator wrote it. */}
        <Text whiteSpace="pre-wrap" wordBreak="break-word" data-testid="theme-intro">
          {theme.intro}
        </Text>
      </Stack>

      <ThemeNotices notices={theme.notices} />

      <Stack as="section" gap="4" minW="0" data-testid="theme-markets">
        <Heading as="h3" size="lg">
          {copy.themeMarkets}
        </Heading>
        <ThemeMarkets themeId={themeId} now={marketsNow} />
      </Stack>

      <ThemeResults themeId={themeId} />
    </Stack>
  );
}

/**
 * The theme's markets as the home's cards (ADR-0069 decision 4: every public status but a draft,
 * a voided one too — owner decision 2026-10-19), each joining its market's room so a tick or a
 * status moves it without a request.
 */
function ThemeMarkets({ themeId, now }: { themeId: string; now?: number }) {
  const markets = useThemeMarkets(themeId);
  return (
    <MarketGrid
      list={markets}
      now={now}
      emptyMessage={copy.themeMarketsEmpty}
      cardTitleAs="h4"
      testId="theme-markets-list"
    />
  );
}

/**
 * The theme's own notices (ADR-0069 decision 2, #45 item 8), newest first: plain text whose web
 * addresses are links, and 수정됨 on one edited after it was written (owner decision 2026-10-19).
 * No author: the page speaks for the operators.
 */
function ThemeNotices({ notices }: { notices: ThemeNotice[] }) {
  return (
    <Stack as="section" gap="4" data-testid="theme-notices">
      <Heading as="h3" size="lg">
        {copy.themeNotices}
      </Heading>
      {notices.length === 0 ? (
        <Text color="fg.muted" data-testid="theme-notices-empty">
          {copy.themeNoticesEmpty}
        </Text>
      ) : (
        <Stack gap="3">
          {notices.map((notice) => (
            <Stack
              key={notice.id}
              as="article"
              gap="2"
              borderWidth="1px"
              borderRadius="l2"
              p="4"
              data-testid={`theme-notice-${notice.id}`}
            >
              <Heading as="h4" size="sm">
                {notice.title}
              </Heading>
              <HStack gap="2" fontSize="xs" color="fg.muted" flexWrap="wrap">
                <Text as="span">
                  <DateTimeText iso={notice.createdAt} />
                </Text>
                {notice.editedAt !== null && (
                  <Text as="span" data-testid={`theme-notice-edited-${notice.id}`}>
                    {copy.themeNoticeEdited}
                  </Text>
                )}
              </HStack>
              <Text whiteSpace="pre-wrap" wordBreak="break-word">
                <NoticeText text={notice.body} />
              </Text>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * A notice's body with its web addresses as links (`noticeParts`): a new tab, and no referrer,
 * opener or ranking credit handed to an address an operator pasted.
 */
function NoticeText({ text }: { text: string }) {
  return (
    <>
      {noticeParts(text).map((part, index) =>
        part.kind === 'text' ? (
          // The runs never move, so their place is their identity.
          <span key={index}>{part.text}</span>
        ) : (
          <ChakraLink
            key={index}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
            colorPalette="brand"
            color="colorPalette.fg"
            textDecoration="underline"
            wordBreak="break-all"
          >
            {part.text}
          </ChakraLink>
        ),
      )}
    </>
  );
}

/**
 * 결과 목록 (ADR-0069 decision 4): the theme's markets that are 판정 완료·정산 완료·무효, each with
 * its status label, its result — YES, NO or 무효 — and when it was decided, the latest first. The
 * markets' own outcome only: nobody's trades, performance or PnL. A row opens its market.
 */
function ThemeResults({ themeId }: { themeId: string }) {
  const results = useThemeResults(themeId);
  const rows = results.data?.pages.flatMap((page) => page.items) ?? [];
  const section = listSection(results, rows.length);
  return (
    <Stack as="section" gap="4" data-testid="theme-results">
      <Heading as="h3" size="lg">
        {copy.themeResults}
      </Heading>
      {section.stale && (
        <Alert.Root status="warning" role="status" data-testid="theme-results-refresh-failed">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {section.body === 'pending' ? (
        <Skeleton height="16" />
      ) : section.body === 'failed' ? (
        <Stack gap="3" align="flex-start">
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void results.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : section.body === 'empty' ? (
        <EmptyState message={copy.themeResultsEmpty} data-testid="theme-results-empty" />
      ) : (
        <Stack gap="2" data-testid="theme-results-list">
          {rows.map((row) => (
            <HStack
              key={row.marketId}
              justify="space-between"
              align="flex-start"
              borderWidth="1px"
              borderRadius="l2"
              p="3"
              gap="3"
              data-testid={`theme-result-${row.marketId}`}
            >
              <Stack gap="1" minW="0">
                <ChakraLink asChild fontWeight="semibold">
                  <NextLink href={`/markets/${row.slug}` as Route}>{row.title}</NextLink>
                </ChakraLink>
                <Text fontSize="xs" color="fg.muted">
                  {MARKET_STATUS_LABEL[row.status]} · <DateTimeText iso={row.decidedAt} />
                </Text>
              </Stack>
              <Badge
                variant="outline"
                size="lg"
                flexShrink="0"
                data-testid={`theme-result-outcome-${row.marketId}`}
              >
                {themeResultLabel(row)}
              </Badge>
            </HStack>
          ))}
          {results.hasNextPage && (
            <Button
              alignSelf="center"
              size="sm"
              variant="ghost"
              loading={results.isFetchingNextPage}
              onClick={() => void results.fetchNextPage()}
              data-testid="theme-results-more"
            >
              {copy.loadMore}
            </Button>
          )}
        </Stack>
      )}
    </Stack>
  );
}
