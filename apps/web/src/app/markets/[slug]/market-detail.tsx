'use client';

import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  DataList,
  Grid,
  HStack,
  Skeleton,
  Stack,
  Tag,
  Text,
} from '@chakra-ui/react';
import { type MarketStatus, formatCoin, parseCoinAmount } from '@buddha/shared';
import NextLink from 'next/link';
import { type ReactNode } from 'react';
import { CountdownBadge } from '@/components/market/countdown-badge';
import { MyPosition } from '@/components/market/my-position';
import { ProbabilityChart } from '@/components/market/probability-chart';
import { ProbabilityDisplay } from '@/components/market/probability-display';
import { RecentFills } from '@/components/market/recent-fills';
import { copy } from '@/copy';
import { useMarketSocket } from '@/hooks/use-market-socket';
import { useCategories, useMarket, useMarketTicks } from '@/hooks/use-markets';
import { type Market } from '@/lib/api';
import { CATEGORY_TRAIL_SEPARATOR, categoryBreadcrumb } from '@/lib/category-label';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import { HEADER_HEIGHT_PX } from '@/lib/nav';
import { type RecentMove, recentMove } from '@/lib/ticks';

/**
 * The live half of 시장 상세: everything that a `market:tick` or a `market:status` may change
 * while the page is open (PLAN 11.3, AC 1).
 *
 * It takes an id, not a row. The page seeded `['market', id]` and `['ticks', id, '1D']` into
 * the cache it dehydrated, so the first client render reads the server's own values out of
 * that cache — no second fetch, no skeleton beside hydrated content — and every later value
 * arrives through the same key, whether it comes from the socket or from a refetch. Nothing on
 * this screen holds a copy of the row.
 *
 * `useMarketSocket([marketId])` is the whole of the realtime wiring here: the provider owns
 * the connection and writes the caches through the reducers in `lib/market-live.ts`, so a
 * status transition moves the badge and the notice below without one line of event handling in
 * this file.
 *
 * The grid's right column is the order area. There is no way to trade until the CLOB order
 * panel lands (#119, #66; D13), so an open market's holds the 거래 준비 중 notice (owner decision
 * #125 (a)) where the direct-AMM trade panel used to be. Any other status leaves the column
 * empty: the status notice on the left already says what the market is (ADR-0048).
 */

/**
 * What a terminal status leaves a reader able to do (PLAN 11.3). `open` and `draft` are absent
 * on purpose: an open market's state is its countdown, and a draft never reaches this route —
 * the API answers NOT_FOUND for one, so the page 404s before this file renders.
 *
 * The tone is a second, redundant channel: every notice says in words what it is, so nothing
 * here is carried by colour alone (PLAN 11.2, AC 6).
 */
const STATUS_NOTICE: Partial<
  Record<
    MarketStatus,
    { tone: 'info' | 'warning' | 'success' | 'error'; message: string; detail?: string }
  >
> = {
  closed: { tone: 'warning', message: copy.marketClosedNotice },
  // Judged, and the worker's settlement is running (ADR-0046): usually a few seconds before a
  // `market:status` moves it on to settled.
  resolved: { tone: 'info', message: copy.marketResolvedNotice },
  // The second line says where the Coin went: the payout is already in the balance (the worker's
  // finalize wrote it, PLAN 5.5), and 내 손익 is the 내 포지션 card below, not this notice.
  settled: { tone: 'success', message: copy.marketSettledNotice, detail: copy.marketSettledPayout },
  voided: { tone: 'error', message: copy.marketVoidedNotice },
};

export interface MarketDetailProps {
  /** The row's canonical lower-cased uuid — the key the page seeded and the socket writes. */
  marketId: string;
  /**
   * The instant the countdown measures its first render against: the API's own window end,
   * passed down from the page. Never read from the clock here — a `Date.now()` in a render body
   * is a different string on the server and in the browser's first render.
   */
  now?: number;
  /**
   * 규칙, rendered by the SERVER component and passed through. It sits in the left column
   * for reading order, but it is never rendered by this file, so no branch of the ladder below
   * — and no hydration failure — can take it out of the HTML that AC 2 reads.
   */
  children: ReactNode;
}

export function MarketDetail({ marketId, now, children }: MarketDetailProps) {
  useMarketSocket([marketId]);
  const market = useMarket(marketId);
  // The same seeded series the chart draws (one key, one query, no second request). It is read
  // here for the delta badge only — see `recentDelta`.
  const series = useMarketTicks(marketId);
  const data = market.data;

  return (
    <Grid
      templateColumns={{ base: '1fr', md: '2fr 1fr' }}
      gap={{ base: '6', md: '8' }}
      data-testid="market-detail"
    >
      {/* `minW="0"` so a long question or a wide table cannot blow the column out past the
          grid track and take the order area off screen with it. */}
      <Stack gap="6" minW="0">
        {data === undefined ? (
          market.isLoadingError ? (
            <Stack gap="2" align="flex-start">
              <Alert.Root status="error" role="alert">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{copy.errUnknown}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void market.refetch();
                }}
              >
                {copy.retry}
              </Button>
            </Stack>
          ) : (
            // A sibling skeleton, never a wrapper: `loading` defaults to true, so a Skeleton
            // AROUND the header would hide it for good.
            <Skeleton height="48" />
          )
        ) : (
          <Stack gap="4">
            {/* A failed REFETCH keeps the row that is already drawn — the numbers on screen are
                simply the last ones that arrived, which is what the notice says. */}
            {market.isRefetchError && (
              <Alert.Root status="warning" role="status" data-testid="market-detail-refresh-failed">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
            )}
            <MarketHeader market={data} now={now} move={recentMove(series.data?.points)} />
            <StatusNotice market={data} />
            {/* `currentBp` and `currentTradeCount` come from ONE read of the row, so the
                chart can never draw one fill's price under another's claim. */}
            <ProbabilityChart
              marketId={marketId}
              label={data.title}
              currentBp={data.lastPrice === null ? null : data.lastPrice * 100}
              currentTradeCount={data.tradeCount}
            />
          </Stack>
        )}

        {children}
        {/* Both readings follow the LIVE row rather than the positions list's own copy of it:
            `status` says which of the two position lists this account's rows moved to — a
            settled market's holder is in 정산 이력, and asking the open list would tell them
            they never participated — and `lastPrice` is what 현재가 and 평가손익 are marked
            to, so the card cannot disagree with the price above it. `undefined` while
            the row is unknown, which is each prop's documented default; the page seeds the
            cache before the first client render, so that is a fallback and not the path. */}
        <MyPosition marketId={marketId} status={data?.status} lastPrice={data?.lastPrice} />
        <RecentFills marketId={marketId} />
      </Stack>

      {/* Read off the live row, so a `market:status` that closes the market takes the area
          away with it. From `md` up the right track stays either way: the left column keeps its
          width and nothing on it reflows when the market closes under a reader. */}
      {data?.status === 'open' ? <OrderArea /> : null}
    </Grid>
  );
}

/**
 * 주문 영역 of an open market, while there is no order panel: one line, 거래 준비 중, with no
 * reason or date beside it (owner decisions #125, ADR-0048). Sticky under the two-row header from
 * `md` up, where it is the right column; below that it is an ordinary block at the end of the
 * page, and the tab bar keeps the bottom of the viewport.
 */
function OrderArea() {
  return (
    <Box
      position={{ base: 'static', md: 'sticky' }}
      top={`calc(${String(HEADER_HEIGHT_PX)}px + 16px)`}
      alignSelf="start"
      data-testid="order-area"
    >
      <Card.Root>
        <Card.Body>
          <Alert.Root status="info" role="status">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description data-testid="order-area-notice">
                {copy.tradePreparing}
              </Alert.Description>
            </Alert.Content>
          </Alert.Root>
        </Card.Body>
      </Card.Root>
    </Box>
  );
}

/**
 * 카테고리 · 상태 · 마감 카운트다운 · 시장가격 · 거래량 · 참여자.
 *
 * The status badge is rendered for every status, including 진행 중, because it is the one
 * reading that says what the server currently thinks this market is — and it is what a
 * `market:status` visibly moves. The countdown is rendered only while the market is open: a
 * settled market has nothing to count down to, and its badge already says so. The two DO
 * disagree for an open market whose close time has passed (진행 중 + 마감됨), and that is the
 * truth: the close job has not run yet, so the row is still `open` (A-M3-31).
 *
 * The category tag writes the whole trail, 경제 › 주택, rather than the leaf alone (ADR-0041's
 * two-level tree): the row only carries the leaf's `{slug, nameKo}`, so the parent's name is
 * read off the `['categories']` query — the one the header's `Nav` already holds, so this is a
 * second observer of a query in flight, never a second request. Until it resolves (the server
 * render, the first client paint) `categoryBreadcrumb` answers the leaf name the row carries,
 * i.e. exactly what this tag said before the tree existed, so the HTML and the hydrating render
 * agree and nothing waits on the query. The tag is also the way back to that leaf's list, as
 * the card's category header is: `prefetch={false}` because `/` is force-dynamic and a
 * prefetch there is a whole filtered list rendered for a link that may never be clicked — the
 * rule every link into `/` in this app follows (the header's search form, the category rows).
 * A UrlObject rather than a template literal, so `href` takes it without a `Route` cast and
 * Next encodes the slug.
 */
function MarketHeader({
  market,
  now,
  move,
}: {
  market: Market;
  now?: number;
  /** The last move and its monotone identity, read off ONE point — see `recentMove`. */
  move: RecentMove | null;
}) {
  const categories = useCategories();
  const trail = categoryBreadcrumb(
    categories.data,
    market.category.slug,
    market.category.nameKo,
  ).join(CATEGORY_TRAIL_SEPARATOR);
  return (
    <Stack gap="3">
      <HStack gap="2" flexWrap="wrap">
        <Tag.Root size="sm" variant="surface" asChild>
          <NextLink
            href={{ pathname: '/', query: { category: market.category.slug } }}
            prefetch={false}
            data-testid="market-detail-category"
          >
            <Tag.Label>{trail}</Tag.Label>
          </NextLink>
        </Tag.Root>
        <Badge
          colorPalette={MARKET_STATUS_PALETTE[market.status]}
          variant="subtle"
          data-testid="market-status-badge"
        >
          {MARKET_STATUS_LABEL[market.status]}
        </Badge>
        {market.status === 'open' && <CountdownBadge market={market} now={now} />}
      </HStack>

      <ProbabilityDisplay
        lastPrice={market.lastPrice}
        deltaPoints={move?.deltaPoints ?? null}
        moveId={move?.moveId}
      />

      <HStack gap="4" flexWrap="wrap" fontSize="sm" color="fg.muted">
        <Text whiteSpace="nowrap" data-testid="market-detail-volume">
          {copy.marketVolume} {formatCoin(parseCoinAmount(market.volumeCoin))}
        </Text>
        {/* Grouped by `formatCoin` everywhere else; a plain count is written out as it is, and
            deliberately not through `toLocaleString` — the server's ICU data and the
            browser's would then have to agree on this string. */}
        <Text data-testid="market-detail-traders">
          {copy.marketTraders} {String(market.traderCount)}
        </Text>
      </HStack>
    </Stack>
  );
}

/**
 * 상태별 안내 (PLAN 11.3), plus the one read-only fact a decided market carries: the 결과. A
 * settled market adds the line that says the payout has landed. There is no deadline to show
 * any more — the judgement is final at once (ADR-0046) — and the 판정 record itself (note,
 * evidence, instant) is #24's.
 *
 * `role="status"` rather than `role="alert"`: a market closing while someone reads it is worth
 * announcing, but it is not an emergency that should interrupt them mid-sentence.
 *
 * The 결과 row is deliberately NOT gated on the status: it is the market's answer and PLAN 11.3
 * asks for it on a settled screen as much as on a resolved one.
 */
function StatusNotice({ market }: { market: Market }) {
  const notice = STATUS_NOTICE[market.status];
  if (notice === undefined) return null;
  return (
    <Alert.Root status={notice.tone} role="status" data-testid="market-status-notice">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{notice.message}</Alert.Description>
        {notice.detail !== undefined && (
          <Alert.Description data-testid="market-status-notice-detail">
            {notice.detail}
          </Alert.Description>
        )}
        {market.resolvedResult !== null && (
          <DataList.Root orientation="horizontal" size="sm">
            <DataList.Item>
              <DataList.ItemLabel>{copy.marketResolvedResult}</DataList.ItemLabel>
              <DataList.ItemValue data-testid="market-detail-result">
                {market.resolvedResult === 'YES' ? copy.yes : copy.no}
              </DataList.ItemValue>
            </DataList.Item>
          </DataList.Root>
        )}
      </Alert.Content>
    </Alert.Root>
  );
}
