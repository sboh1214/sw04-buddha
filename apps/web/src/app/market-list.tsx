'use client';

import { Alert, Button, SimpleGrid, Skeleton, Stack } from '@chakra-ui/react';
import { MarketCard } from '@/components/market/market-card';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useMarketSocket } from '@/hooks/use-market-socket';
import { useMarkets } from '@/hooks/use-markets';
import { rowAnchor } from '@/lib/datetime';
import { type MarketFilters } from '@/lib/market-keys';

/**
 * The home grid (PLAN 11.3): one `MarketCard` per row of `GET /markets`, live.
 *
 * `filters` arrives as a prop and is passed to `useMarkets` untouched, so this hook reads the very
 * entry the server dehydrated — the first paint costs no request, which is half of AC 2.
 *
 * `useMarketSocket(rows.map(...))` subscribes every card that is on screen, which is the other
 * half of AC 1: the provider writes `market:tick` into every `['markets', …]` page with one
 * `setQueriesData`, this component re-renders, and no card ever issues a request for an event.
 * The room set follows the rows, so 더 보기 extends the subscription and a filter change drops
 * the markets that left the screen (the provider refcounts, so a market the detail screen also
 * holds is not unsubscribed under it).
 *
 * A-M3-31: a market whose close time has passed but is still `open` is NOT filtered out here. It
 * keeps its place in the list and its `CountdownBadge` reads 마감됨 — hiding it would make a
 * market that a trader can still open in another tab vanish from the page it was on, and the API
 * is the one that refuses the trade (`MARKET_CLOSED`). The server `now` is what lets that badge
 * say 마감됨 in the HTML rather than one frame after hydration.
 */

/** Six placeholders: two full rows at md, one at lg — enough to hold the fold's height. */
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

export interface MarketListProps {
  /** The SAME object the page put in the cache key; never re-derived from the URL here. */
  filters: MarketFilters;
  /**
   * The instant the countdowns measure against — the server's own read time, carried down from
   * the page. Absent (a prefetch that failed), each badge shows the absolute close time until it
   * has mounted rather than inventing a clock of its own.
   */
  now?: number;
  'data-testid'?: string;
}

export function MarketList({
  filters,
  now,
  'data-testid': testId = 'market-list',
}: MarketListProps) {
  const markets = useMarkets(filters);
  const rows = markets.data?.pages.flatMap((page) => page.items) ?? [];
  /**
   * Which rows may keep the server's `now` as their countdown anchor (`rowAnchor`): the ones the
   * SERVER rendered, and only while the list still holds its answer for them. A card 더 보기
   * appends adopts the anchor at ITS mount, minutes after it was stamped, and would read that
   * instant as the present — so those tick on the wall clock instead, exactly as every card did
   * before anchoring existed.
   */
  const serverRowCount = markets.data?.pages[0]?.items.length ?? 0;
  useMarketSocket(rows.map((row) => row.id));

  return (
    <Stack gap="4" data-testid={testId}>
      {/* A background refetch that failed — `refetchOnWindowFocus` is on — keeps its pages, and
          must keep the grid with them: replacing a screenful of live cards because one 503
          landed on a focus event loses more than the stale prices cost. Only a FIRST load that
          failed leaves nothing to show, and that is `isLoadingError` below. */}
      {markets.isRefetchError && (
        <Alert.Root status="warning" role="status" data-testid="markets-refresh-failed">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {markets.isPending ? (
        <SimpleGrid columns={{ base: 1, md: 2, lg: 3 }} gap="4" data-testid="markets-skeleton">
          {SKELETON_ROWS.map((row) => (
            <Skeleton key={row} height="32" borderRadius="l2" />
          ))}
        </SimpleGrid>
      ) : markets.isLoadingError ? (
        <Stack gap="3" align="flex-start" data-testid="markets-error">
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void markets.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : rows.length === 0 ? (
        // Two different empties: "nothing is open yet" is the state of the list itself, "no
        // results" is the state of a search someone typed, and telling them apart is the
        // difference between "come back later" and "try another word".
        <EmptyState
          message={filters.q === undefined ? copy.marketsEmpty : copy.marketsSearchEmpty}
          data-testid="markets-empty"
        />
      ) : (
        <>
          <SimpleGrid columns={{ base: 1, md: 2, lg: 3 }} gap="4" data-testid="markets-grid">
            {rows.map((row, index) => (
              // `sparkline` is a separate prop because the card is also the admin's 미리보기,
              // where a draft has no history at all (Q-M3-6).
              <MarketCard
                key={row.id}
                market={row}
                sparkline={row.sparkline}
                now={rowAnchor(index, serverRowCount, markets.dataUpdatedAt, now)}
              />
            ))}
          </SimpleGrid>
          {markets.hasNextPage && (
            <Button
              alignSelf="center"
              size="sm"
              variant="ghost"
              loading={markets.isFetchingNextPage}
              onClick={() => void markets.fetchNextPage()}
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
