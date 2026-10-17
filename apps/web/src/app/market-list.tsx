'use client';

import { Alert, Button, Grid, Skeleton, Stack } from '@chakra-ui/react';
import { type InfiniteData } from '@tanstack/react-query';
import type { Route } from 'next';
import NextLink from 'next/link';
import { MARKET_GRID_COLUMNS, MarketCard } from '@/components/market/market-card';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useMarketSocket } from '@/hooks/use-market-socket';
import { useMarkets } from '@/hooks/use-markets';
import { useWatchlist } from '@/hooks/use-watchlist';
import { rowAnchor } from '@/lib/datetime';
import {
  isWatchlistView,
  listEmptyMessage,
  watchlistViewFilters,
  watchlistViewLoginPath,
} from '@/lib/home-view';
import { type HomeFilters, type MarketFilters, type WatchlistViewFilters } from '@/lib/market-keys';
import { type MarketPage } from '@/lib/market-live';
import { sessionListSection } from '@/lib/query-client';

/**
 * The home grid (PLAN 11.3): one `MarketCard` per row, live. Two sources, one per view of the URL
 * (ADR-0065): the public open markets of `GET /markets` (`PublicMarketList`), or the caller's
 * watched open markets of `GET /me/watchlist` when 관심 시장 is on (`WatchlistViewList`). Both draw
 * the same grid (`MarketGrid`).
 *
 * `filters` arrives as a prop and is passed to the hook untouched, so the public list reads the
 * very entry the server dehydrated — the first paint costs no request, which is half of AC 2. The
 * 관심 시장 view has no such entry and must not: the watchlist is nobody's but the member's (#37),
 * so it is never fetched on the server (`PRIVATE_QUERY_ROOTS`) and the HTML of `/?watchlist=1`
 * is the same placeholder grid for every visitor; the list loads once the session is known.
 *
 * `useMarketSocket(rows.map(...))` subscribes every card that is on screen, which is the other
 * half of AC 1: the provider writes `market:tick` into every `['markets', …]` and
 * `['watchlist', 'pages', …]` page with one `setQueriesData`, this component re-renders, and no
 * card ever issues a request for an event. The room set follows the rows, so 더 보기 extends the
 * subscription and a filter change drops the markets that left the screen (the provider
 * refcounts, so a market the detail screen also holds is not unsubscribed under it).
 *
 * A-M3-31: a market whose close time has passed but is still `open` is NOT filtered out here. It
 * keeps its place in the list and its `CountdownBadge` reads 마감됨 — hiding it would make a
 * market that a reader can still open in another tab vanish from the page it was on, and the
 * server is the one that decides the close. The server `now` is what lets that badge
 * say 마감됨 in the HTML rather than one frame after hydration.
 */

/**
 * Six placeholders at a tile's height (~230px, spec: Kalshi's card): two full rows of the
 * three-across grid at the content width, three of two — enough to hold the fold's height.
 */
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

export interface MarketListProps {
  /** The SAME object the page put in the cache key; never re-derived from the URL here. */
  filters: HomeFilters;
  /**
   * The instant the countdowns measure against — the server's own read time, carried down from
   * the page. Absent (a prefetch that failed, or the 관심 시장 view, which the server never
   * reads), each badge shows the absolute close time until it has mounted rather than inventing
   * a clock of its own.
   */
  now?: number;
  'data-testid'?: string;
}

export function MarketList({
  filters,
  now,
  'data-testid': testId = 'market-list',
}: MarketListProps) {
  return isWatchlistView(filters) ? (
    <WatchlistViewList filters={filters} testId={testId} />
  ) : (
    <PublicMarketList filters={filters} now={now} testId={testId} />
  );
}

function PublicMarketList({
  filters,
  now,
  testId,
}: {
  filters: MarketFilters;
  now: number | undefined;
  testId: string;
}) {
  const markets = useMarkets(filters);
  return (
    <MarketGrid list={markets} now={now} emptyMessage={listEmptyMessage(filters)} testId={testId} />
  );
}

/**
 * 관심 시장 on: the caller's watched OPEN markets of the URL's category, in the URL's order
 * (`watchlistViewFilters`). `useWatchlist` holds `isPending` while the session is unknown, so the
 * server render and hydration draw the placeholder grid; a visitor who then turns out to be signed
 * out gets a sign-in prompt in the list's place (`sessionListSection`, ADR-0061 decision 1,
 * item 12) that comes back to this view. Its empty state is its own: watched markets may exist and
 * have ended, which MY still lists.
 */
function WatchlistViewList({ filters, testId }: { filters: WatchlistViewFilters; testId: string }) {
  const watchlist = useWatchlist(watchlistViewFilters(filters));
  const rows = watchlist.data?.pages.flatMap((page) => page.items) ?? [];
  if (sessionListSection(watchlist, rows.length).body === 'signedOut') {
    return (
      <Stack gap="4" data-testid={testId}>
        <EmptyState
          message={copy.watchlistViewSignedOut}
          action={
            <Button asChild size="sm" variant="outline">
              <NextLink href={watchlistViewLoginPath(filters) as Route}>{copy.login}</NextLink>
            </Button>
          }
          data-testid="markets-signed-out"
        />
      </Stack>
    );
  }
  return (
    <MarketGrid
      list={watchlist}
      now={undefined}
      emptyMessage={listEmptyMessage(filters)}
      testId={testId}
    />
  );
}

/** The parts of an infinite list of card pages that the grid reads. */
interface CardList {
  data: InfiniteData<MarketPage> | undefined;
  dataUpdatedAt: number;
  isPending: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
  refetch: () => Promise<unknown>;
}

function MarketGrid({
  list,
  now,
  emptyMessage,
  testId,
}: {
  list: CardList;
  now: number | undefined;
  emptyMessage: string;
  testId: string;
}) {
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  /**
   * Which rows may keep the server's `now` as their countdown anchor (`rowAnchor`): the ones the
   * SERVER rendered, and only while the list still holds its answer for them. A card 더 보기
   * appends adopts the anchor at ITS mount, minutes after it was stamped, and would read that
   * instant as the present — so those tick on the wall clock instead, exactly as every card did
   * before anchoring existed.
   */
  const serverRowCount = list.data?.pages[0]?.items.length ?? 0;
  useMarketSocket(rows.map((row) => row.id));

  return (
    <Stack gap="4" data-testid={testId}>
      {/* A background refetch that failed — `refetchOnWindowFocus` is on — keeps its pages, and
          must keep the grid with them: replacing a screenful of live cards because one 503
          landed on a focus event loses more than the stale prices cost. Only a FIRST load that
          failed leaves nothing to show, and that is `isLoadingError` below. */}
      {list.isRefetchError && (
        <Alert.Root status="warning" role="status" data-testid="markets-refresh-failed">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {list.isPending ? (
        <Grid templateColumns={MARKET_GRID_COLUMNS} gap="4" data-testid="markets-skeleton">
          {SKELETON_ROWS.map((row) => (
            <Skeleton key={row} height="232px" borderRadius="card" />
          ))}
        </Grid>
      ) : list.isLoadingError ? (
        <Stack gap="3" align="flex-start" data-testid="markets-error">
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : rows.length === 0 ? (
        <EmptyState message={emptyMessage} data-testid="markets-empty" />
      ) : (
        <>
          <Grid templateColumns={MARKET_GRID_COLUMNS} gap="4" data-testid="markets-grid">
            {rows.map((row, index) => (
              <MarketCard
                key={row.id}
                market={row}
                now={rowAnchor(index, serverRowCount, list.dataUpdatedAt, now)}
              />
            ))}
          </Grid>
          {list.hasNextPage && (
            // The same pill as the headline bar's controls: 40px, outlined, no fill.
            <Button
              alignSelf="center"
              variant="outline"
              borderRadius="pill"
              borderColor="border.emphasized"
              h="40px"
              px="4"
              textStyle="emphasisSm"
              loading={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
              data-testid="markets-more"
            >
              {copy.loadMore}
            </Button>
          )}
        </>
      )}
    </Stack>
  );
}
