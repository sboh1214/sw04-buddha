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
import { type OrderStatus, formatP, parsePAmount } from '@buddha/shared';
import { useQueries } from '@tanstack/react-query';
import type { Route } from 'next';
import NextLink from 'next/link';
import { type ReactNode } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useMarketSocket } from '@/hooks/use-market-socket';
import { marketQueryOptions } from '@/hooks/use-markets';
import { useMe } from '@/hooks/use-me';
import {
  type ListState,
  averageCostP,
  combinedListState,
  listState,
  markPriceP,
  markToLiveMarket,
  portfolioTotals,
  positionValueP,
  realizedPnlAcross,
  unrealizedPnlP,
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

/**
 * The four sections of `/portfolio`, all of them personal and all of them client-only.
 *
 * Not one number here is computed in this file: `markPriceP`, `positionValueP`,
 * `unrealizedPnlP`, `averageCostP` and `portfolioTotals` (use-portfolio.ts) own the arithmetic,
 * in `bigint` over the wire's decimal strings. The rule is not tidiness — a NO contract is worth
 * the COMPLEMENT of the market's YES price, and a second copy of that formula is a silent error
 * that produces a plausible number wrong by 100 − 2·price per contract. The same helpers draw
 * 내 포지션 on the detail (my-position.tsx), so the two screens cannot disagree about one row.
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

export function Portfolio() {
  const me = useMe();
  const open = usePositions('open');
  const settled = usePositions('settled');
  const orders = useOrders();

  const held = open.data ?? [];
  // Distinct: one market carries at most a YES row and a NO row, and both mark to one price.
  const marketIds = [...new Set(held.map((row) => row.marketId))];
  // Every market this screen values is joined for as long as it is mounted, so the gateway
  // pushes `market:tick` for all of them and the queries below re-render with the new price.
  useMarketSocket(marketIds);
  /**
   * One `['market', id]` entry per held market — the SAME entry the detail screen and the home
   * grid keep, so this costs one request per market at most and the socket's existing tick
   * handler is what keeps it fresh afterwards. `useQueries` rather than a hook per row because
   * the totals and the rows have to be read against ONE price: computed per row, 총 평가 금액
   * would be a sum of prices no row on screen was ever drawn with.
   */
  const markets = useQueries({ queries: marketIds.map((id) => marketQueryOptions(id)) });
  const live = new Map<string, Market>();
  for (const market of markets) {
    if (market.data !== undefined) live.set(market.data.id, market.data);
  }
  /**
   * A market whose refetch FAILED keeps the row it last answered (`isRefetchError`), and this
   * screen goes on valuing the holding at it — which is right, since dropping a screenful of
   * prices because one 503 landed loses more than the staleness costs. But the two other screens
   * that keep a retained-stale row SAY so (`market-list.tsx`, `market-detail.tsx`), and this one
   * was the exception: 현재가, 평가 금액 and 총 평가 금액 quietly stopped moving with nothing on
   * screen to explain it. The prices themselves are not re-ordered against the position row's
   * snapshot — see `markToLiveMarket` for why that has no key to order on.
   */
  const marketsStale = markets.some((market) => market.isRefetchError);
  // Price AND status, both marked from the row the socket keeps live: a `market:status` moves
  // `['market', id]` and publishes no `user:position`, so a holding in a market that has just
  // closed would otherwise keep announcing 진행 중 here until an unrelated refetch.
  const positions = held.map((row) => {
    const market = live.get(row.marketId);
    return markToLiveMarket(row, { lastPrice: market?.lastPrice, status: market?.status });
  });

  // 총 평가 금액/평가손익 come from the open holdings alone — settlement writes no price, so a
  // settled market's `lastPrice` is the last price something traded at, not the 100/0 it
  // resolved to, and marking those rows to it would be fiction. 총 실현 손익 spans BOTH lists,
  // because selling books the profit where the row already is (`realizedPnlAcross`).
  const openTotals = portfolioTotals(positions);
  const settledTotals = portfolioTotals(settled.data);
  const realizedState = combinedListState(listState(open), listState(settled));
  const orderRows = orders.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Stack gap="6">
      <Section title={copy.portfolioBalance} testId="portfolio-balance">
        {me.isPending ? (
          <Skeleton height="24" />
        ) : !me.data ? (
          <LoadFailed message={copy.errProfileLoad} onRetry={() => void me.refetch()} />
        ) : (
          <Stack gap="4">
            <Stack gap="1">
              <Text fontSize="sm" color="fg.muted">
                {copy.walletBalance}
              </Text>
              <Text fontSize="3xl" fontWeight="bold" data-testid="portfolio-available">
                {formatP(parsePAmount(me.data.balance.availableP))}
              </Text>
              <HStack gap="2" color="fg.muted" fontSize="sm">
                <Text>{copy.walletLocked}</Text>
                <Text data-testid="portfolio-locked">
                  {formatP(parsePAmount(me.data.balance.lockedP))}
                </Text>
              </HStack>
            </Stack>
            <DataList.Root orientation="horizontal" size="sm">
              <Total label={copy.portfolioValue} state={listState(open)} testId="portfolio-value">
                {formatP(openTotals.valueP)}
              </Total>
              <Total
                label={copy.portfolioUnrealizedPnl}
                state={listState(open)}
                testId="portfolio-unrealized"
              >
                <Signed amount={openTotals.unrealizedPnlP} />
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

      <Section title={copy.portfolioPositions} testId="portfolio-positions">
        {marketsStale && (
          <Alert.Root status="warning" role="status" data-testid="portfolio-markets-stale" mb="4">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}
        {open.isPending ? (
          <Skeleton height="24" />
        ) : open.isLoadingError ? (
          <LoadFailed message={copy.errUnknown} onRetry={() => void open.refetch()} />
        ) : positions.length === 0 ? (
          <EmptyState
            message={copy.portfolioPositionsEmpty}
            action={
              <Button asChild size="sm" variant="outline">
                <NextLink href="/">{copy.predict}</NextLink>
              </Button>
            }
          />
        ) : (
          <Stack gap="2">
            {positions.map((row) => (
              <OpenPositionRow key={`${row.marketId}-${row.outcome}`} position={row} />
            ))}
          </Stack>
        )}
      </Section>

      <Section title={copy.portfolioSettled} testId="portfolio-settled">
        {settled.isPending ? (
          <Skeleton height="24" />
        ) : settled.isLoadingError ? (
          <LoadFailed message={copy.errUnknown} onRetry={() => void settled.refetch()} />
        ) : (settled.data ?? []).length === 0 ? (
          <EmptyState message={copy.portfolioSettledEmpty} />
        ) : (
          <Stack gap="2">
            {(settled.data ?? []).map((row) => (
              <SettledPositionRow key={`${row.marketId}-${row.outcome}`} position={row} />
            ))}
          </Stack>
        )}
      </Section>

      <Section title={copy.portfolioOrders} testId="portfolio-orders">
        {orders.isPending ? (
          <Skeleton height="24" />
        ) : orders.isLoadingError ? (
          <LoadFailed message={copy.errUnknown} onRetry={() => void orders.refetch()} />
        ) : orderRows.length === 0 ? (
          <EmptyState message={copy.portfolioOrdersEmpty} />
        ) : (
          <Stack gap="2">
            {orderRows.map((order) => (
              <OrderRow key={order.id} order={order} />
            ))}
            {orders.hasNextPage && (
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                mt="1"
                loading={orders.isFetchingNextPage}
                onClick={() => void orders.fetchNextPage()}
                data-testid="portfolio-orders-more"
              >
                {copy.loadMore}
              </Button>
            )}
          </Stack>
        )}
      </Section>
    </Stack>
  );
}

/**
 * 보유 포지션 한 줄. Every figure is the shared arithmetic, and the market's own status rides
 * along whenever it is no longer `open`: a holding in a 마감 or 결과 확인 중 market cannot be
 * traded out of, and the row is the only place that says so.
 */
function OpenPositionRow({ position }: { position: Position }) {
  const yes = position.outcome === 'YES';
  const average = averageCostP(position);
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
          {average === undefined ? EMPTY : formatP(average)}
        </Item>
        <Item label={copy.positionCurrentPrice}>{formatP(markPriceP(position))}</Item>
        <Item label={copy.positionValue}>{formatP(positionValueP(position))}</Item>
        <Item label={copy.positionPnl}>
          <Signed amount={unrealizedPnlP(position)} />
        </Item>
      </DataList.Root>
    </Stack>
  );
}

/**
 * 정산 이력 한 줄: 결과 and 실현 손익 only.
 *
 * No 평가 금액 and no 평가손익 — the holding is gone and the payout has already landed in the
 * balance, so `realizedPnlP` is the whole story. 결과 is a word rather than a coloured badge
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
        {/* A voided market resolved to nothing at all, and every P it took was refunded. */}
        <Item label={copy.marketResolvedResult}>
          {result === null ? EMPTY : result === 'YES' ? copy.yes : copy.no}
        </Item>
        <Item label={copy.positionQty}>{formatContracts(position.qty)}</Item>
        <Item label={copy.positionRealizedPnl}>
          <Signed amount={parsePAmount(position.realizedPnlP)} />
        </Item>
      </DataList.Root>
    </Stack>
  );
}

/**
 * 주문 이력 한 줄. `filledQty`/`priceAvgBp`/`amountP` are what the order actually did, and all
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
        <Item label={copy.tradeAmountLabel}>
          {order.amountP === null ? EMPTY : formatP(parsePAmount(order.amountP))}
        </Item>
        <Item label={copy.orderCreatedAt}>{formatKst(order.createdAt)}</Item>
      </DataList.Root>
    </Stack>
  );
}

/** One card with its own heading, so each section is a landmark a screen reader can jump to. */
function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Card.Root data-testid={testId}>
      <Card.Header>
        <Heading as="h3" size="md">
          {title}
        </Heading>
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
function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
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
 * list loads, and a dash if it failed. Never a 0P — the section below already carries the error
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
 * A gain or a loss. `formatP` writes a loss with U+2212 (PLAN 11.1-6), so the colour only
 * repeats what the sign already says — and at exactly 0 it stays on the ordinary foreground
 * rather than claiming a direction.
 */
function Signed({ amount }: { amount: bigint }) {
  if (amount === 0n) return <>{formatP(amount)}</>;
  return (
    <Text as="span" colorPalette={amount > 0n ? 'yes' : 'no'} color="colorPalette.fg">
      {formatP(amount)}
    </Text>
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
