'use client';

import { Alert, Button, Grid, Skeleton, Stack } from '@chakra-ui/react';
import NextLink from 'next/link';
import { MARKET_GRID_COLUMNS, MarketCard } from '@/components/market/market-card';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useMarketSocket } from '@/hooks/use-market-socket';
import { useWatchlist } from '@/hooks/use-watchlist';
import { listSection } from '@/lib/query-client';
import { watchlistRows } from '@/lib/watchlist';
import { LoadFailed, Section, SessionEnded, useSessionEnded } from '../portfolio';

type Watchlist = ReturnType<typeof useWatchlist>;

/**
 * `/my/watchlist`: MY's 관심 시장 (#89, ADR-0064). The owner's list (ADR-0061 decision 3): newest
 * watch first, every item the home grid's market card, an ended market kept with its status (the
 * card's badge) until the member unwatches it on its detail, and no cap — 더 보기 pages through
 * all of them. Personal and client-only like every MY list.
 */
export function MyWatchlist() {
  const ended = useSessionEnded();
  const watchlist = useWatchlist();
  if (ended) return <SessionEnded />;
  return (
    <Section title={copy.myWatchlist} testId="my-watchlist">
      <WatchlistBody watchlist={watchlist} />
    </Section>
  );
}

/**
 * The list's body, for the tab and for its preview on `/my` (`limit`, MY_PREVIEW_ROWS) — one body,
 * so the preview cannot read differently from the tab (ADR-0054). Which rows and whether 더 보기
 * is drawn is `watchlistRows` (lib/watchlist.ts): the preview has the newest three and no 더 보기.
 *
 * The ladder is the other MY lists' (`listSection`): skeleton, error and 다시 시도, empty, cards, and
 * a refresh that failed after the cards exist keeps them under a notice instead of dropping them.
 * Every card on screen joins its market's room, as the home grid's do: the provider writes a
 * `market:tick` or a `market:status` into these pages too (realtime-provider.tsx), so a watched
 * market that closes moves its badge here without a request.
 */
export function WatchlistBody({ watchlist, limit }: { watchlist: Watchlist; limit?: number }) {
  const { rows, more } = watchlistRows(watchlist.data?.pages, watchlist.hasNextPage, limit);
  useMarketSocket(rows.map((row) => row.id));
  const section = listSection(watchlist, rows.length);
  return (
    <>
      {section.stale && (
        <Alert.Root status="warning" role="status" data-testid="my-watchlist-stale" mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void watchlist.refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {section.body === 'pending' ? (
        <Skeleton height="232px" borderRadius="card" />
      ) : section.body === 'failed' ? (
        <LoadFailed message={copy.errUnknown} onRetry={() => void watchlist.refetch()} />
      ) : section.body === 'empty' ? (
        <EmptyState
          message={copy.watchlistEmpty}
          action={
            <Button asChild size="sm" variant="outline">
              <NextLink href="/">{copy.navExplore}</NextLink>
            </Button>
          }
          data-testid="my-watchlist-empty"
        />
      ) : (
        <Stack gap="4">
          <Grid templateColumns={MARKET_GRID_COLUMNS} gap="4" data-testid="my-watchlist-grid">
            {rows.map((row) => (
              // `h4`: under the section's `h3` on the tab and on the summary alike.
              <MarketCard key={row.id} market={row} titleAs="h4" />
            ))}
          </Grid>
          {more && (
            <Button
              alignSelf="center"
              size="sm"
              variant="ghost"
              loading={watchlist.isFetchingNextPage}
              onClick={() => void watchlist.fetchNextPage()}
              data-testid="my-watchlist-more"
            >
              {copy.loadMore}
            </Button>
          )}
        </Stack>
      )}
    </>
  );
}
