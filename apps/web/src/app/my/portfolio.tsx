'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  DataList,
  HStack,
  Heading,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { type OrderStatus, parseCoinAmount } from '@buddha/shared';
import { useQueries } from '@tanstack/react-query';
import type { Route } from 'next';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';
import { CoinText } from '@/components/ui/coin-text';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { listSection, listView, profileView } from '@/lib/query-client';
import { useMarketSocket } from '@/hooks/use-market-socket';
import { marketQueryOptions } from '@/hooks/use-markets';
import { useMe } from '@/hooks/use-me';
import {
  type ListState,
  averageCostCoin,
  combinedListState,
  listState,
  markPriceCoin,
  markToLiveMarket,
  priceIsStale,
  portfolioTotals,
  positionValueCoin,
  realizedPnlAcross,
  unrealizedPnlCoin,
  useOrders,
  usePositions,
} from '@/hooks/use-portfolio';
import { type Market, type Order, type Position } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  MARKET_STATUS_LABEL,
  MARKET_STATUS_PALETTE,
  formatContracts,
  formatPricePerContract,
} from '@/lib/market-admin';
import { MY_ORDERS_PATH, isPendingOrder, orderHistoryEmpty } from '@/lib/my';

/**
 * The old `/portfolio`'s four sections, moved into MY (#16) without being redrawn: 잔고 요약 on
 * the summary (`/my`), 보유 포지션 as 보유 계약 (`/my/positions`), 주문 이력 split by state into
 * 대기 주문 (`/my/orders`) and, with 정산 이력, 거래·정산 이력 (`/my/history`). Every one of them
 * is personal and client-only. The summary shows the first `MY_PREVIEW_ROWS` of each list through
 * the same bodies (`limit`), so a preview cannot read differently from its tab.
 *
 * Not one number here is computed in this file: `markPriceCoin`, `positionValueCoin`,
 * `unrealizedPnlCoin`, `averageCostCoin` and `portfolioTotals` (use-portfolio.ts) own the
 * arithmetic, in `bigint` over the wire's decimal strings. The rule is not tidiness — a NO
 * contract is worth the COMPLEMENT of the market's YES price, and a second copy of that formula
 * is a silent error that produces a plausible number wrong by 100 − 2·price per contract. The
 * same helpers draw 내 포지션 on the detail (my-position.tsx), so the two screens cannot disagree
 * about one row.
 *
 * Each section holds its own query and therefore its own ladder — skeleton, error + 다시 시도,
 * empty, rows — because they fail independently: a failed 주문 이력 must not blank the holdings.
 */

/** The repo's placeholder for a figure that does not exist (admin-market-detail.tsx). */
const EMPTY = '—';

/** PLAN Appendix A: every order state gets plain Korean, and the badge always carries the word. */
const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  open: copy.orderStatusOpen,
  partially_filled: copy.orderStatusPartiallyFilled,
  filled: copy.orderStatusFilled,
  cancelled: copy.orderStatusCancelled,
  rejected: copy.orderStatusRejected,
};

/** Colour only reinforces the label: brand once it is done, `no` only for a refusal. */
const ORDER_STATUS_PALETTE: Record<OrderStatus, 'brand' | 'gray' | 'orange' | 'no'> = {
  open: 'gray',
  partially_filled: 'orange',
  filled: 'brand',
  cancelled: 'gray',
  rejected: 'no',
};

/**
 * Whether the session ended while this screen stayed mounted — another tab signed out, the
 * session expired, or the reader signed out from here and the navigation has not landed yet. MY's
 * session gate is server-side and runs only on navigation, so nothing else moves them off it.
 * Without this, the screen blamed a profile load that never failed AND every list reported an
 * empty account: `listView` answers `ready` for a reset, disabled query holding no rows. One
 * page-level fact, gated once per screen, rather than the same session patched into every ladder.
 */
export function useSessionEnded(): boolean {
  const me = useMe();
  return (
    profileView({
      isLoggedIn: me.isLoggedIn,
      isPending: me.isPending,
      isFetching: me.isFetching,
      hasProfile: me.data !== undefined,
    }) === 'signedOut'
  );
}

/** The signed-out rung of a MY screen: what happened, and the way back to the same screen. */
export function SessionEnded() {
  const pathname = usePathname();
  return (
    <Card.Root data-testid="my-signed-out">
      <Card.Body>
        <EmptyState
          message={copy.portfolioSignedOut}
          action={
            <Button asChild size="sm" variant="outline">
              <NextLink href={{ pathname: '/login', query: { next: pathname } }}>
                {copy.login}
              </NextLink>
            </Button>
          }
        />
      </Card.Body>
    </Card.Root>
  );
}

/**
 * The open holdings, each marked to its market's LIVE price and status.
 *
 * Every market this screen values is joined for as long as it is mounted, so the gateway pushes
 * `market:tick` for all of them and the queries below re-render with the new price. One
 * `['market', id]` entry per held market — the SAME entry the detail screen and the home grid
 * keep, so this costs one request per market at most and the socket's existing tick handler is
 * what keeps it fresh afterwards. `useQueries` rather than a hook per row because the totals and
 * the rows have to be read against ONE price: computed per row, 총 평가 금액 would be a sum of
 * prices no row on screen was ever drawn with. A screen that shows both (the summary) calls this
 * once and hands the result to both.
 */
export function useHoldings() {
  const open = usePositions('open');
  const held = open.data ?? [];
  // Distinct: one market carries at most a YES row and a NO row, and both mark to one price.
  const marketIds = [...new Set(held.map((row) => row.marketId))];
  useMarketSocket(marketIds);
  const markets = useQueries({ queries: marketIds.map((id) => marketQueryOptions(id)) });
  const live = new Map<string, Market>();
  for (const market of markets) {
    if (market.data !== undefined) live.set(market.data.id, market.data);
  }
  // Price AND status, both marked from the row the socket keeps live: a `market:status` moves
  // `['market', id]` and publishes no `user:position`, so a holding in a market that has just
  // closed would otherwise keep announcing 진행 중 here until an unrelated refetch.
  const positions = held.map((row) => {
    const market = live.get(row.marketId);
    return markToLiveMarket(row, { lastPrice: market?.lastPrice, status: market?.status });
  });
  return {
    open,
    positions,
    /**
     * Whether any market price behind these holdings has stopped being refreshed. The reading
     * itself is `priceIsStale` (use-portfolio.ts) — a node-only runner cannot reach a decision
     * left in this body, and the state this notice must cover was got wrong once already.
     */
    marketsStale: markets.some((market) => priceIsStale(market)),
    /** Re-asks only the ones that failed; a healthy row is already live off the socket. */
    retryStaleMarkets: () => {
      for (const market of markets) {
        if (priceIsStale(market)) void market.refetch();
      }
    },
  };
}

type Holdings = ReturnType<typeof useHoldings>;
type SettledList = ReturnType<typeof usePositions>;
type OrderList = ReturnType<typeof useOrders>;

/** `/my/positions`: 보유 계약, today the old 보유 포지션 list as it was. */
export function MyPositions() {
  const ended = useSessionEnded();
  const holdings = useHoldings();
  if (ended) return <SessionEnded />;
  return (
    <Section title={copy.myPositions} testId="portfolio-positions">
      <PositionsBody holdings={holdings} />
    </Section>
  );
}

/** `/my/orders`: 대기 주문, the open and partially filled rows of the old 주문 이력. */
export function MyOrders() {
  const ended = useSessionEnded();
  const orders = useOrders();
  if (ended) return <SessionEnded />;
  return (
    <Section title={copy.myOrders} testId="my-orders">
      <OrdersBody orders={orders} kind="pending" />
    </Section>
  );
}

/** `/my/history`: 거래·정산 이력, the old 정산 이력 and the rest of the old 주문 이력. */
export function MyHistory() {
  const ended = useSessionEnded();
  const settled = usePositions('settled');
  const orders = useOrders();
  if (ended) return <SessionEnded />;
  return (
    <Stack gap="6">
      <Section title={copy.portfolioSettled} testId="portfolio-settled">
        <SettledBody settled={settled} />
      </Section>
      <Section title={copy.portfolioOrders} testId="my-order-history">
        <OrdersBody orders={orders} kind="history" />
      </Section>
    </Stack>
  );
}

/**
 * 잔고 요약: the balance, and the totals over the holdings.
 *
 * 총 평가 금액/평가손익 come from the open holdings alone — settlement writes no price, so a
 * settled market's `lastPrice` is the last price something traded at, not the 100/0 it resolved
 * to, and marking those rows to it would be fiction. 총 실현 손익 spans BOTH lists, because
 * selling books the profit where the row already is (`realizedPnlAcross`).
 */
export function BalanceSummary({
  holdings,
  settled,
}: {
  holdings: Holdings;
  settled: SettledList;
}) {
  const me = useMe();
  const balanceView = profileView({
    isLoggedIn: me.isLoggedIn,
    isPending: me.isPending,
    isFetching: me.isFetching,
    hasProfile: me.data !== undefined,
  });
  const { open } = holdings;
  const openTotals = portfolioTotals(holdings.positions);
  const settledTotals = portfolioTotals(settled.data);
  const realizedState = combinedListState(listState(open), listState(settled));

  return (
    <Section title={copy.portfolioBalance} testId="portfolio-balance">
      {balanceView === 'pending' ? (
        <Skeleton height="24" />
      ) : !me.data ? (
        <LoadFailed message={copy.errProfileLoad} onRetry={() => void me.refetch()} />
      ) : (
        <Stack gap="4">
          <Stack gap="1">
            <Text fontSize="sm" color="fg.muted">
              {copy.walletBalance}
            </Text>
            <CoinText
              as="p"
              fontSize="3xl"
              fontWeight="bold"
              amount={parseCoinAmount(me.data.balance.availableCoin)}
              data-testid="portfolio-available"
            />
            <HStack gap="2" color="fg.muted" fontSize="sm">
              <Text>{copy.walletLocked}</Text>
              <CoinText
                amount={parseCoinAmount(me.data.balance.lockedCoin)}
                data-testid="portfolio-locked"
              />
            </HStack>
          </Stack>
          <DataList.Root orientation="horizontal" size="sm">
            <Total label={copy.portfolioValue} state={listState(open)} testId="portfolio-value">
              <CoinText amount={openTotals.valueCoin} />
            </Total>
            <Total
              label={copy.portfolioUnrealizedPnl}
              state={listState(open)}
              testId="portfolio-unrealized"
            >
              <Signed amount={openTotals.unrealizedPnlCoin} />
            </Total>
            <Total
              label={copy.portfolioRealizedPnl}
              state={realizedState}
              testId="portfolio-realized"
            >
              <Signed amount={realizedPnlAcross(openTotals, settledTotals)} />
            </Total>
          </DataList.Root>
        </Stack>
      )}
    </Section>
  );
}

/**
 * 보유 계약's list. `stale` is the state the ladder used to fold into `ready`: a refetch that
 * fails after the rows exist keeps them and reports `isRefetchError`, and on THIS list that
 * silence has a shape — a settlement asks for both lists (`applyPositionEvent` answers `refetch`
 * when a row must MOVE), so a failed refresh leaves the holding here, out of 정산 이력, and inside
 * 총 평가 금액 where it no longer belongs. The rows stay on screen and the notice says so; see
 * `listView`.
 */
export function PositionsBody({ holdings, limit }: { holdings: Holdings; limit?: number }) {
  const { open, positions } = holdings;
  const openView = listView(open);
  return (
    <>
      {holdings.marketsStale && (
        <Alert.Root status="warning" role="status" data-testid="portfolio-markets-stale" mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          {/* The holdings stay on screen behind this — dropping them because one price failed
              loses more than the staleness costs — so the retry is an action beside the notice
              rather than the `LoadFailed` ladder the other sections use, which replaces what it
              reports on. */}
          <Button size="xs" variant="outline" ml="auto" onClick={holdings.retryStaleMarkets}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {openView === 'stale' && (
        <Alert.Root status="warning" role="status" data-testid="portfolio-positions-stale" mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void open.refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {openView === 'pending' ? (
        <Skeleton height="24" />
      ) : openView === 'failed' ? (
        <LoadFailed message={copy.errUnknown} onRetry={() => void open.refetch()} />
      ) : positions.length === 0 ? (
        <EmptyState
          message={copy.portfolioPositionsEmpty}
          action={
            <Button asChild size="sm" variant="outline">
              <NextLink href="/">{copy.tradeCta}</NextLink>
            </Button>
          }
        />
      ) : (
        <Stack gap="2">
          {positions.slice(0, limit).map((row) => (
            <OpenPositionRow key={`${row.marketId}-${row.outcome}`} position={row} />
          ))}
        </Stack>
      )}
    </>
  );
}

/** 정산 이력's list, with the same `stale` notice for the same reason (see `PositionsBody`). */
export function SettledBody({ settled, limit }: { settled: SettledList; limit?: number }) {
  const settledView = listView(settled);
  const rows = settled.data ?? [];
  return (
    <>
      {settledView === 'stale' && (
        <Alert.Root status="warning" role="status" data-testid="portfolio-settled-stale" mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void settled.refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {settledView === 'pending' ? (
        <Skeleton height="24" />
      ) : settledView === 'failed' ? (
        <LoadFailed message={copy.errUnknown} onRetry={() => void settled.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message={copy.portfolioSettledEmpty} />
      ) : (
        <Stack gap="2">
          {rows.slice(0, limit).map((row) => (
            <SettledPositionRow key={`${row.marketId}-${row.outcome}`} position={row} />
          ))}
        </Stack>
      )}
    </>
  );
}

/**
 * One side of the old 주문 이력: `pending` is 대기 주문 (`isPendingOrder`), `history` every
 * other state.
 *
 * Both read the ONE `GET /me/orders` list and split it here, because the route has no state
 * filter: a page can hold none of one side's rows while older pages still do. So an empty side
 * says it is empty only once the list has no further page, and offers 더 보기 until then — which
 * is also the only moment 거래·정산 이력 can tell an account that never ordered from one whose
 * every order is still 대기 (`orderHistoryEmpty`). The split itself moves to the server with the
 * tabs' own issues (#123, #124).
 *
 * The list has no reducer and no event of its own — `restartQueries(queryClient, ORDERS_KEY)`
 * (realtime-provider.tsx) is the ONLY path a new order arrives by, so a failed refresh is a list
 * one row short. On an account with no prior orders it is worse than short: the section
 * positively says it has none about an order the balance already shows. Hence `listSection`,
 * which keeps the empty rung and puts the notice ABOVE it rather than in place of it.
 */
export function OrdersBody({
  orders,
  kind,
  limit,
}: {
  orders: OrderList;
  kind: 'pending' | 'history';
  limit?: number;
}) {
  const all = orders.data?.pages.flatMap((page) => page.items) ?? [];
  const rows = all.filter((order) => isPendingOrder(order.status) === (kind === 'pending'));
  const section = listSection(orders, rows.length);
  const testId = kind === 'pending' ? 'my-orders' : 'my-order-history';
  const more = orders.hasNextPage && (limit === undefined || rows.length === 0) && (
    <Button
      alignSelf="center"
      size="sm"
      variant="ghost"
      mt="1"
      loading={orders.isFetchingNextPage}
      onClick={() => void orders.fetchNextPage()}
      data-testid={`${testId}-more`}
    >
      {copy.loadMore}
    </Button>
  );
  return (
    <>
      {section.stale && (
        <Alert.Root status="warning" role="status" data-testid={`${testId}-stale`} mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void orders.refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {section.body === 'pending' ? (
        <Skeleton height="24" />
      ) : section.body === 'failed' ? (
        <LoadFailed message={copy.errUnknown} onRetry={() => void orders.refetch()} />
      ) : section.body === 'empty' && !orders.hasNextPage ? (
        kind === 'pending' ? (
          <EmptyState message={copy.portfolioPendingOrdersEmpty} />
        ) : (
          <OrderHistoryEmpty pendingOnly={orderHistoryEmpty(all) === 'pendingOnly'} />
        )
      ) : (
        <Stack gap="2">
          {rows.slice(0, limit).map((order) => (
            <OrderRow key={order.id} order={order} />
          ))}
          {more}
        </Stack>
      )}
    </>
  );
}

/**
 * 거래·정산 이력's 주문 이력 with no row, in the owner's two wordings (`orderHistoryEmpty`): an
 * account that has never ordered is told so, and one with only 대기 orders is told none has
 * finished and where those are — a link to 대기 주문, the line's one next step.
 */
function OrderHistoryEmpty({ pendingOnly }: { pendingOnly: boolean }) {
  if (!pendingOnly) return <EmptyState message={copy.portfolioOrdersEmpty} />;
  return (
    <EmptyState
      message={copy.portfolioOrderHistoryEmpty}
      action={
        <Text color="fg.muted">
          {copy.portfolioPendingOrdersHintBefore}{' '}
          <ChakraLink asChild colorPalette="brand" color="colorPalette.fg">
            <NextLink href={MY_ORDERS_PATH}>{copy.myOrders}</NextLink>
          </ChakraLink>
          {copy.portfolioPendingOrdersHintAfter}
        </Text>
      }
    />
  );
}

/**
 * 보유 계약 한 줄. Every figure is the shared arithmetic, and the market's own status rides
 * along whenever it is no longer `open`: a holding in a 마감 or 결과 확인 중 market cannot be
 * traded out of, and the row is the only place that says so.
 */
function OpenPositionRow({ position }: { position: Position }) {
  const yes = position.outcome === 'YES';
  const average = averageCostCoin(position);
  // All three `undefined` together, for a market with no fill to mark to (체결 없음, N02 §5).
  const mark = markPriceCoin(position);
  const value = positionValueCoin(position);
  const unrealized = unrealizedPnlCoin(position);
  return (
    <Stack
      gap="2"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid={`portfolio-position-${position.marketId}-${position.outcome}`}
    >
      <HStack gap="2" flexWrap="wrap">
        <MarketLink slug={position.marketSlug} title={position.marketTitle} />
        <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle">
          {yes ? copy.yes : copy.no}
        </Badge>
        {position.marketStatus !== 'open' && (
          <Badge colorPalette={MARKET_STATUS_PALETTE[position.marketStatus]} variant="subtle">
            {MARKET_STATUS_LABEL[position.marketStatus]}
          </Badge>
        )}
      </HStack>
      <DataList.Root orientation="horizontal" size="sm">
        <Item label={copy.positionQty}>{formatContracts(position.qty)}</Item>
        {/* A row sold out of keeps its realised PnL visible at qty 0, and then has no average. */}
        <Item label={copy.positionAvgPrice}>
          {average === undefined ? EMPTY : <CoinText amount={average} />}
        </Item>
        <Item label={copy.positionCurrentPrice}>
          {mark === undefined ? copy.noFills : <CoinText amount={mark} />}
        </Item>
        <Item label={copy.positionValue}>
          {value === undefined ? EMPTY : <CoinText amount={value} />}
        </Item>
        <Item label={copy.positionPnl}>
          {unrealized === undefined ? EMPTY : <Signed amount={unrealized} />}
        </Item>
      </DataList.Root>
    </Stack>
  );
}

/**
 * 정산 이력 한 줄: 결과 and 실현 손익 only.
 *
 * No 평가 금액 and no 평가손익 — the holding is gone and the payout has already landed in the
 * balance, so `realizedPnlCoin` is the whole story. 결과 is a word rather than a coloured badge
 * because the row already carries the account's own side as one; two colours side by side would
 * be read as agreement or disagreement, which is exactly what the PnL states in numbers.
 */
function SettledPositionRow({ position }: { position: Position }) {
  const yes = position.outcome === 'YES';
  const result = position.resolvedResult;
  return (
    <Stack
      gap="2"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid={`portfolio-settled-${position.marketId}-${position.outcome}`}
    >
      <HStack gap="2" flexWrap="wrap">
        <MarketLink slug={position.marketSlug} title={position.marketTitle} />
        <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle">
          {yes ? copy.yes : copy.no}
        </Badge>
        {position.marketStatus !== 'settled' && (
          <Badge colorPalette={MARKET_STATUS_PALETTE[position.marketStatus]} variant="subtle">
            {MARKET_STATUS_LABEL[position.marketStatus]}
          </Badge>
        )}
      </HStack>
      <DataList.Root orientation="horizontal" size="sm">
        {/* A voided market resolved to nothing at all, so it has no result to name. */}
        <Item label={copy.marketResolvedResult}>
          {result === null ? EMPTY : result === 'YES' ? copy.yes : copy.no}
        </Item>
        <Item label={copy.positionQty}>{formatContracts(position.qty)}</Item>
        <Item label={copy.positionRealizedPnl}>
          <Signed amount={parseCoinAmount(position.realizedPnlCoin)} />
        </Item>
      </DataList.Root>
    </Stack>
  );
}

/**
 * 주문 이력 한 줄. `filledQty`/`priceAvgBp`/`amountCoin` are what the order actually did, and all
 * three are null-or-zero on a refusal, so the state badge is what explains the row.
 */
function OrderRow({ order }: { order: Order }) {
  const yes = order.outcome === 'YES';
  return (
    <Stack
      gap="2"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid={`portfolio-order-${order.id}`}
    >
      <HStack gap="2" flexWrap="wrap">
        <MarketLink slug={order.marketSlug} title={order.marketTitle} />
        <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle">
          {yes ? copy.yes : copy.no}
        </Badge>
        <Text fontSize="sm">{order.side === 'buy' ? copy.buy : copy.sell}</Text>
      </HStack>
      <DataList.Root orientation="horizontal" size="sm">
        <Item label={copy.orderStatus}>
          <Badge colorPalette={ORDER_STATUS_PALETTE[order.status]} variant="subtle">
            {ORDER_STATUS_LABEL[order.status]}
          </Badge>
        </Item>
        <Item label={copy.fillQty}>{formatContracts(order.filledQty)}</Item>
        <Item label={copy.fillAvgPrice}>
          {order.priceAvgBp === null ? EMPTY : formatPricePerContract(order.priceAvgBp)}
        </Item>
        <Item label={copy.orderAmount}>
          {order.amountCoin === null ? (
            EMPTY
          ) : (
            <CoinText amount={parseCoinAmount(order.amountCoin)} />
          )}
        </Item>
        <Item label={copy.orderCreatedAt}>{formatKst(order.createdAt)}</Item>
      </DataList.Root>
    </Stack>
  );
}

/**
 * One card with its own heading, so each section is a landmark a screen reader can jump to. A
 * preview on the summary passes `href`, its tab, for the 전체 보기 beside the heading.
 */
export function Section({
  title,
  testId,
  href,
  children,
}: {
  title: string;
  testId: string;
  href?: Route;
  children: ReactNode;
}) {
  return (
    <Card.Root data-testid={testId}>
      <Card.Header>
        <HStack justify="space-between" gap="3">
          <Heading as="h3" size="md">
            {title}
          </Heading>
          {href !== undefined && (
            <ChakraLink
              asChild
              fontSize="sm"
              colorPalette="brand"
              color="colorPalette.fg"
              flexShrink="0"
            >
              {/* Named after its section: the summary has one "전체 보기" per preview. */}
              <NextLink href={href} aria-label={`${title} ${copy.myViewAll}`}>
                {copy.myViewAll}
              </NextLink>
            </ChakraLink>
          )}
        </HStack>
      </Card.Header>
      <Card.Body>{children}</Card.Body>
    </Card.Root>
  );
}

/**
 * The whole market is the destination, and `as Route` rather than a bare template literal: the
 * `/markets/[slug]` route lands with the detail screen, and typedRoutes only accepts the literal
 * once that directory exists in the generated route map (market-card.tsx does the same).
 */
function MarketLink({ slug, title }: { slug: string; title: string }) {
  return (
    <ChakraLink asChild fontWeight="semibold">
      <NextLink href={`/markets/${slug}` as Route}>{title}</NextLink>
    </ChakraLink>
  );
}

/** The list ladder's error rung: what failed, and the one button that retries it. */
export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Stack gap="2" align="flex-start">
      <Alert.Root status="error" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{message}</Alert.Description>
        </Alert.Content>
      </Alert.Root>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {copy.retry}
      </Button>
    </Stack>
  );
}

/**
 * A summary figure that depends on a list the balance card does not own: a skeleton while that
 * list loads, and a dash if it failed. Never a 0 Coin — the section below already carries the error
 * and its 다시 시도, and a zero here would read as "you hold nothing" instead of "not known".
 */
function Total({
  label,
  state,
  testId,
  children,
}: {
  label: string;
  state: ListState;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Item label={label} testId={testId}>
      {state === 'ready' ? (
        children
      ) : state === 'pending' ? (
        <Skeleton height="5" width="20" />
      ) : (
        EMPTY
      )}
    </Item>
  );
}

/**
 * A gain or a loss. `formatCoin` writes a loss with U+2212 (PLAN 11.1-6), so the colour only
 * repeats what the sign already says — and at exactly 0 it stays on the ordinary foreground
 * rather than claiming a direction.
 */
function Signed({ amount }: { amount: bigint }) {
  if (amount === 0n) return <CoinText amount={amount} />;
  return (
    <CoinText amount={amount} colorPalette={amount > 0n ? 'yes' : 'no'} color="colorPalette.fg" />
  );
}

function Item({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue data-testid={testId}>{children}</DataList.ItemValue>
    </DataList.Item>
  );
}
