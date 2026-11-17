'use client';

import {
  Alert,
  Badge,
  Box,
  Button,
  DataList,
  HStack,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { type OrderStatus, parseCoinAmount } from '@buddha/shared';
import NextLink from 'next/link';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { CoinText } from '@/components/ui/coin-text';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useOrderHistory } from '@/hooks/use-my-history';
import { useLiveOrders } from '@/hooks/use-my-orders';
import { orderAveragePriceBp } from '@/hooks/use-portfolio';
import type { Order } from '@/lib/api';
import { formatContracts } from '@/lib/market-admin';
import {
  MY_ORDERS_PATH,
  liveOrdersReading,
  myOrderPath,
  orderHistoryEmpty,
  showMoreOrders,
} from '@/lib/my';
import { type HistoryListFilters, isHistoryFiltered, myHistoryPath } from '@/lib/my-history';
import { averagePriceText } from '@/lib/order-confirm';
import { orderReasonName, orderStatusLabel } from '@/lib/order-reasons';
import { listSection, listView } from '@/lib/query-client';
import { EMPTY, HistoryItem, HistoryMarketLink, OnlyMarketLink } from './history-parts';

/**
 * Colour only reinforces the label, and the four ended states — the ones this list draws — each
 * take their own (N02 §7): brand once it is done, gray for a cancel, orange for an expiry, `no`
 * only for a refusal. The two live states never reach the history (대기 주문 holds them).
 */
export const ORDER_STATUS_PALETTE: Record<OrderStatus, 'brand' | 'gray' | 'orange' | 'no'> = {
  open: 'gray',
  partially_filled: 'gray',
  filled: 'brand',
  cancelled: 'gray',
  expired: 'orange',
  rejected: 'no',
};

/**
 * 거래·정산 이력's 주문 (#124, ADR-0143 결정 6): the account's ended orders — 전량 체결, 취소 완료,
 * 만료, 거절 — as the server lists them (`state=ended`), newest first by arrival, those the two
 * filters leave; 대기 and 부분 체결 are 대기 주문's (#123). The parent keys it by the account
 * (`me.id`), so a turn of `['me']` mounts it afresh.
 *
 * MY's summary draws the same list with no filter and `limit` rows: one entry, read once, cut on
 * the screen (ADR-0141 결정 15's way).
 *
 * The list has no reducer and no event of its own: `restartQueries(queryClient, ORDERS_KEY)`
 * (realtime-provider.tsx) reads it again on a trade's `user:position`, so the rows are always a
 * reading of the server's — a late event can ask again, never write an older row. A refresh that
 * failed keeps the rows and says so above them (`listSection`), the empty rung included.
 */
export function OrderHistoryList({
  accountId,
  filters,
  limit,
  testId,
}: {
  accountId: string;
  filters: HistoryListFilters;
  /** A /my preview's rows (`MY_PREVIEW_ROWS`), cut from the same list and key as the tab's. */
  limit?: number;
  /** The list's own test id: its stale notice, empty line, 더 보기 and its failure hang off it. */
  testId: string;
}) {
  const orders = useOrderHistory(filters, accountId);
  const rows: Order[] = orders.data?.pages.flatMap((page) => page.items) ?? [];
  const section = listSection(orders, rows.length);
  const filtered = isHistoryFiltered(filters);
  const more = showMoreOrders(orders.hasNextPage, rows.length, limit) && (
    <>
      {/* A 더 보기 that failed: the rows stay, the message above the button that asks again (owner
          decision 2026-10-20 7). */}
      <LoadMoreFailed
        list={orders}
        message={copy.errUnknown}
        data-testid={`${testId}-more-failed`}
      />
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
    </>
  );
  return (
    <Box data-testid={testId}>
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
        <Stack gap="2" align="flex-start">
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void orders.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : section.body === 'empty' && !orders.hasNextPage ? (
        filtered ? (
          <EmptyState message={copy.historyFilteredEmpty} data-testid={`${testId}-empty`} />
        ) : (
          <OrderHistoryEmpty accountId={accountId} testId={`${testId}-empty`} />
        )
      ) : (
        <Stack gap="2">
          {rows.slice(0, limit).map((order) => (
            <OrderHistoryRow
              key={order.id}
              order={order}
              onlyMarketHref={
                filters.market === order.marketId.toLowerCase()
                  ? undefined
                  : myHistoryPath({ kind: 'orders', ...filters, market: order.marketId })
              }
            />
          ))}
          {more}
        </Stack>
      )}
    </Box>
  );
}

/**
 * The 주문 list with no row and no filter, in the owner's two wordings (`orderHistoryEmpty`, owner
 * decision 2026-10-13): an account that has never ordered is told so, and one with only 대기 orders
 * is told none has finished and where those are — a link to 대기 주문, the line's one next step.
 * Which of the two is 대기 주문's live list's to say (#123), read here only — mounted only on this
 * rung — under the key that tab and MY's summary hold. While it is read neither is said; when it
 * could not be read, only what is known is: no order has ended.
 */
function OrderHistoryEmpty({ accountId, testId }: { accountId: string; testId: string }) {
  const live = useLiveOrders(accountId);
  const holdsRows =
    (live.data?.pages.some((page) => page.items.length > 0) ?? false) || live.hasNextPage;
  const empty = orderHistoryEmpty(0, liveOrdersReading(listView(live), holdsRows));
  if (empty === 'pending') return <Skeleton height="24" />;
  if (empty === 'none') {
    return <EmptyState message={copy.portfolioOrdersEmpty} data-testid={testId} />;
  }
  if (empty === 'endedNone') {
    return <EmptyState message={copy.portfolioOrderHistoryEmpty} data-testid={testId} />;
  }
  return (
    <EmptyState
      message={copy.portfolioOrderHistoryEmpty}
      data-testid={testId}
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
 * 주문 한 줄. `filledQty` and `filledAmountCoin` are what the order actually did (#119: Coin at its
 * own side's prices) and the 평균가 is the one over the other (`orderAveragePriceBp`); a refused or
 * unfilled order has none of them, so the state badge is what explains the row. A market sent back
 * to a draft (#78 되돌리기, ADR-0099) reaches the row with no slug or title, and its line says only
 * '공개되지 않은 시장' — no title or link — until the market is public again.
 *
 * What was left when it ended is kept beside what filled (N02 §7): a quantity order's 취소 수량
 * when it has one — a cancel's and an expiry's alike, the server's `cancelledQty` — and a Coin
 * amount order's '쓰지 않고 푼 금액' (`unspentCoin`, drawn whenever the order carries it, as 주문
 * 상세 draws it), whose `cancelledQty` is always 0.
 *
 * An ended order's reason by its short name (ADR-0140 넘긴 것 #123: 거절's eleven, 취소 완료's
 * seven), 주문 상세 — the way to its `/my/orders/<id>` (#123, ADR-0141 결정 16) — and '이 시장만 보기'
 * unless the list is that market's already (`onlyMarketHref` undefined).
 */
export function OrderHistoryRow({
  order,
  onlyMarketHref,
}: {
  order: Order;
  onlyMarketHref: string | undefined;
}) {
  const yes = order.outcome === 'YES';
  const reason = orderReasonName(order);
  const formatDateTime = useFormatDateTime();
  return (
    <Stack
      gap="2"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      minW="0"
      data-testid={`portfolio-order-${order.id}`}
    >
      <HStack gap="2" flexWrap="wrap">
        {order.marketSlug === null || order.marketTitle === null ? (
          <Text fontWeight="semibold" color="fg.muted" data-testid="portfolio-order-market-hidden">
            {copy.postMarketNotPublic}
          </Text>
        ) : (
          <HistoryMarketLink slug={order.marketSlug} title={order.marketTitle} />
        )}
        <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle">
          {yes ? copy.yes : copy.no}
        </Badge>
        <Text fontSize="sm">{order.side === 'buy' ? copy.buy : copy.sell}</Text>
      </HStack>
      <DataList.Root orientation="horizontal" size="sm">
        <HistoryItem label={copy.orderStatus}>
          <Badge
            colorPalette={ORDER_STATUS_PALETTE[order.status]}
            variant="subtle"
            data-testid="history-order-status"
            data-status={order.status}
          >
            {orderStatusLabel(order.status)}
          </Badge>
        </HistoryItem>
        {reason !== null && (
          <HistoryItem label={copy.orderReason} testId="portfolio-order-reason">
            {reason}
          </HistoryItem>
        )}
        <HistoryItem label={copy.orderFilledQty} testId="history-order-filled">
          {formatContracts(order.filledQty)}
        </HistoryItem>
        {order.cancelledQty > 0 && (
          <HistoryItem label={copy.orderCancelledQty} testId="history-order-cancelled">
            {formatContracts(order.cancelledQty)}
          </HistoryItem>
        )}
        {order.unspentCoin !== null && (
          <HistoryItem label={copy.orderUnspentReleased} testId="history-order-unspent">
            <CoinText amount={parseCoinAmount(order.unspentCoin)} />
          </HistoryItem>
        )}
        <HistoryItem label={copy.fillAvgPrice} testId="history-order-average">
          {averagePriceText(order)}
        </HistoryItem>
        <HistoryItem label={copy.orderAmount} testId="history-order-amount">
          {orderAveragePriceBp(order) === undefined ? (
            EMPTY
          ) : (
            <CoinText amount={parseCoinAmount(order.filledAmountCoin)} />
          )}
        </HistoryItem>
        <HistoryItem label={copy.orderCreatedAt}>{formatDateTime(order.createdAt)}</HistoryItem>
      </DataList.Root>
      <HStack gap="4" flexWrap="wrap">
        <ChakraLink asChild fontSize="sm" colorPalette="brand" color="colorPalette.fg">
          <NextLink href={myOrderPath(order.id)} data-testid="portfolio-order-detail">
            {copy.orderDetail}
          </NextLink>
        </ChakraLink>
        {onlyMarketHref !== undefined && <OnlyMarketLink href={onlyMarketHref} />}
      </HStack>
    </Stack>
  );
}
