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
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import { formatCoin, parseCoinAmount } from '@buddha/shared';
import { useQueryClient } from '@tanstack/react-query';
import type { Route } from 'next';
import NextLink from 'next/link';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { CoinText } from '@/components/ui/coin-text';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useMarketSocket } from '@/hooks/use-market-socket';
import {
  noticeEndedOnDetail,
  useCancelOrder,
  useOrder,
  useOrderFills,
  useOrderToastsOf,
  usePendingCancels,
} from '@/hooks/use-my-orders';
import { type MyFill, type Order, isApiError } from '@/lib/api';
import { formatContracts } from '@/lib/market-admin';
import { MY_HISTORY_PATH, MY_ORDERS_PATH } from '@/lib/my';
import {
  isLiveOrder,
  orderTimeline,
  remainingQty,
  showsCancelling,
  timelineStale,
  watchedReading,
} from '@/lib/my-orders';
import { averagePriceText, formatContractPrice, kindLabel } from '@/lib/order-confirm';
import { detailReasonText, orderStatusLabel } from '@/lib/order-reasons';
import { listSection, refreshFailed } from '@/lib/query-client';
import { OrderCancelDialog } from './order-cancel-dialog';

/**
 * 주문 상세 (#123, ADR-0141 결정 3·7; `/my/orders/<id>`): one of the account's orders in any state
 * — its market (a link to its detail, which is where the rules are: no rule version here,
 * ADR-0135 E4), contract, side, kind and the server's state with its reason; what was ordered,
 * filled, cancelled and still rests, the limits, the Coin, the average; 상태 이력 from the order
 * row and its fills (`orderTimeline`); and the fills themselves, newest first, with no
 * counterparty (B4). A live order has 주문 취소 and '취소 요청 중' as its row does.
 *
 * Another account's order, an id that names none and a malformed id are one screen
 * (`order-detail-not-found`), and the fills are never asked then. The parent keys this by the
 * account (`me.id`).
 */
export function OrderDetail({ orderId, accountId }: { orderId: string; accountId: string }) {
  // No other account's order toast over this account's order (결정 2-6).
  useOrderToastsOf(accountId);
  const query = useOrder(orderId, accountId);
  if (query.isPending) return <Skeleton height="48" />;
  if (query.data === undefined) {
    const refused =
      isApiError(query.error, 'NOT_FOUND') || isApiError(query.error, 'VALIDATION_ERROR');
    if (refused) return <OrderNotFound />;
    return (
      <Stack gap="2" align="flex-start">
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          {copy.retry}
        </Button>
      </Stack>
    );
  }
  return (
    <OrderDetailBody
      order={query.data}
      accountId={accountId}
      watched={watchedReading(query)}
      refreshFailed={refreshFailed(query)}
      refetchOrder={query.refetch}
    />
  );
}

/** No order of this account's under the address: one screen whatever the reason. */
function OrderNotFound() {
  return (
    <Card.Root data-testid="order-detail-not-found">
      <Card.Body>
        <EmptyState
          message={copy.orderNotFound}
          action={
            <Button asChild size="sm" variant="outline">
              <NextLink href={MY_ORDERS_PATH}>{copy.orderBackToPending}</NextLink>
            </Button>
          }
        />
      </Card.Body>
    </Card.Root>
  );
}

/**
 * The detail as drawn from one reading of its order. Exported for its test: the notice a failed
 * refresh puts above the held reading.
 */
export function OrderDetailBody({
  order,
  accountId,
  watched,
  refreshFailed: orderRefreshFailed,
  refetchOrder,
}: {
  order: Order;
  accountId: string;
  /** A read after mount, or a fresh reading the cache drew at mount (`watchedReading`). */
  watched: boolean;
  /**
   * A read again of the order failed and the last reading is drawn (`refreshFailed`): a market
   * that recovered still drawn 복구 대기 with 주문 취소 off, an order that ended still drawn live.
   * Said above it with '다시 시도', as the lists say theirs (`listSection`'s `stale`).
   */
  refreshFailed: boolean;
  refetchOrder: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const formatDateTime = useFormatDateTime();
  const live = isLiveOrder(order);
  // Its market's room while it rests: a fill, a pause and the book's signal reach it there. An
  // ended order changes no more (0062 `orders_keep_record`), so the room is left.
  useMarketSocket(live ? [order.marketId] : []);
  const fills = useOrderFills(order.id, accountId, true);
  const fillRows: MyFill[] = fills.data?.pages.flatMap((page) => page.items) ?? [];
  // Read whole once a page is held and none is left — a refresh that failed keeps what was read.
  // Not read at all (the first read out or failed): the history draws no line from fills.
  const complete = fills.data !== undefined && !fills.hasNextPage;
  const timeline = orderTimeline(order, fillRows, fills.data === undefined ? null : complete);
  const fillsSection = listSection(fills, fillRows.length);

  // The two readings disagree once every fill is read: the older one is read again, once.
  const stale = timelineStale(order, fillRows, complete);
  const staleKey = stale === null ? null : `${stale}:${String(order.filledQty)}:${fillRows.length}`;
  const askedFor = useRef<string | null>(null);
  const refetchFills = fills.refetch;
  useEffect(() => {
    if (staleKey === null || askedFor.current === staleKey) return;
    askedFor.current = staleKey;
    if (staleKey.startsWith('order')) void refetchOrder();
    else void refetchFills();
  }, [staleKey, refetchOrder, refetchFills]);

  // An order seen live in a watched reading since the screen mounted that is now seen ended: told
  // once (`noticeOnce`, with the cancel's answer and the lists' read back), and what its end moves
  // read again.
  const seenLive = useRef(false);
  useEffect(() => {
    if (live) {
      if (watched) seenLive.current = true;
      return;
    }
    if (!seenLive.current) return;
    seenLive.current = false;
    noticeEndedOnDetail(queryClient, accountId, order);
  }, [live, watched, queryClient, accountId, order]);

  const pending = usePendingCancels(accountId);
  const inFlight = pending.has(order.id.toLowerCase());
  const cancelling = showsCancelling(inFlight, order);
  const cancel = useCancelOrder();
  const [confirming, setConfirming] = useState(false);
  const statusRef = useRef<HTMLHeadingElement>(null);

  const reason = detailReasonText(order);
  const remaining = remainingQty(order);
  const amount = parseCoinAmount(order.filledAmountCoin);
  const yes = order.outcome === 'YES';
  const more = fills.hasNextPage && (
    <>
      <LoadMoreFailed
        list={fills}
        message={copy.errUnknown}
        data-testid="order-detail-fills-more-failed"
      />
      <Button
        alignSelf="center"
        size="sm"
        variant="ghost"
        mt="1"
        loading={fills.isFetchingNextPage}
        onClick={() => void fills.fetchNextPage()}
        data-testid="order-detail-fills-more"
      >
        {copy.loadMore}
      </Button>
    </>
  );

  return (
    <Stack gap="6" data-testid="order-detail" data-status={order.status}>
      {orderRefreshFailed && (
        <Alert.Root status="warning" role="status" data-testid="order-detail-stale">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void refetchOrder()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      <Card.Root>
        <Card.Header>
          <Stack gap="2">
            <Heading as="h3" size="md" tabIndex={-1} ref={statusRef} outline="none">
              {copy.orderDetail}
            </Heading>
            {order.marketSlug === null || order.marketTitle === null ? (
              <Text fontWeight="semibold" color="fg.muted" data-testid="order-detail-market-hidden">
                {copy.postMarketNotPublic}
              </Text>
            ) : (
              <ChakraLink
                asChild
                fontWeight="semibold"
                wordBreak="break-word"
                colorPalette="brand"
                color="colorPalette.fg"
              >
                <NextLink
                  href={`/markets/${order.marketSlug}` as Route}
                  data-testid="order-detail-market-link"
                >
                  {order.marketTitle}
                </NextLink>
              </ChakraLink>
            )}
            <HStack gap="2" flexWrap="wrap">
              <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle">
                {yes ? copy.yes : copy.no}
              </Badge>
              <Text fontSize="sm">{order.side === 'buy' ? copy.buy : copy.sell}</Text>
              <Text fontSize="sm" color="fg.muted">
                {kindLabel(order.timeInForce)}
              </Text>
              <Badge
                variant="subtle"
                colorPalette={
                  order.status === 'rejected'
                    ? 'no'
                    : order.status === 'partially_filled'
                      ? 'orange'
                      : order.status === 'filled'
                        ? 'brand'
                        : 'gray'
                }
                data-testid="order-detail-status"
                data-status={order.status}
              >
                {orderStatusLabel(order.status)}
              </Badge>
            </HStack>
            {reason !== null && (
              <Text
                fontSize="sm"
                color={order.status === 'rejected' ? 'fg.warning' : 'fg.muted'}
                data-testid="order-detail-reason"
              >
                {reason}
              </Text>
            )}
          </Stack>
        </Card.Header>
        <Card.Body>
          <Stack gap="4">
            <DataList.Root orientation="horizontal" size="sm" data-testid="order-detail-qty">
              {order.qty === null ? (
                <Item label={copy.orderBudgetInput} testId="order-detail-budget">
                  {order.budgetCoin === null
                    ? copy.orderNone
                    : formatCoin(parseCoinAmount(order.budgetCoin))}
                </Item>
              ) : (
                <Item label={copy.orderOrderedQty} testId="order-detail-ordered">
                  {formatContracts(order.qty)}
                </Item>
              )}
              <Item label={copy.orderFilledQty} testId="order-detail-filled">
                {formatContracts(order.filledQty)}
              </Item>
              <Item label={copy.orderCancelledQty} testId="order-detail-cancelled">
                {formatContracts(order.cancelledQty)}
              </Item>
              {live && remaining !== null && (
                <Item label={copy.orderRemainingQty} testId="order-detail-remaining">
                  {formatContracts(remaining)}
                </Item>
              )}
              {order.qty !== null && (
                <Item label={copy.orderLimit} testId="order-detail-limit">
                  {formatContractPrice(order.limitPriceCoin)}
                </Item>
              )}
              {order.timeInForce === 'ioc' && order.qty !== null && (
                <Item label={copy.orderProtectedLimit} testId="order-detail-protected">
                  {formatContractPrice(order.protectedLimitPriceCoin)}
                </Item>
              )}
              <Item label={copy.orderFilledAmountLabel} testId="order-detail-amount">
                <CoinText amount={amount} />
              </Item>
              <Item label={copy.orderAvgPrice} testId="order-detail-avg">
                {averagePriceText(order)}
              </Item>
              {order.unspentCoin !== null && (
                <Item label={copy.orderUnspentReleased} testId="order-detail-unspent">
                  <CoinText amount={parseCoinAmount(order.unspentCoin)} />
                </Item>
              )}
            </DataList.Root>
            {live &&
              (order.awaitingRecovery ? (
                <Text fontSize="sm" color="fg.warning" data-testid="order-detail-held">
                  {copy.orderHeldMarket}
                </Text>
              ) : (
                <Text fontSize="sm" color="fg.muted" data-testid="order-detail-gtc">
                  {copy.orderUnfilledGtc}
                </Text>
              ))}
            {live &&
              (cancelling ? (
                <Badge
                  size="lg"
                  minH="11"
                  justifyContent="center"
                  gap="2"
                  variant="subtle"
                  colorPalette="orange"
                  role="status"
                  alignSelf="flex-start"
                  data-testid="order-detail-cancelling"
                >
                  <Spinner size="xs" />
                  {copy.orderCancelling}
                </Badge>
              ) : (
                <Button
                  size="sm"
                  minH="11"
                  variant="outline"
                  colorPalette="red"
                  alignSelf={{ base: 'stretch', md: 'flex-start' }}
                  disabled={order.awaitingRecovery || inFlight}
                  onClick={() => {
                    setConfirming(true);
                  }}
                  data-testid="order-detail-cancel"
                >
                  {copy.orderCancel}
                </Button>
              ))}
          </Stack>
        </Card.Body>
      </Card.Root>

      <Card.Root data-testid="order-detail-timeline">
        <Card.Header>
          <Heading as="h4" size="sm">
            {copy.orderTimeline}
          </Heading>
        </Card.Header>
        <Card.Body>
          {fillsSection.body === 'pending' ? (
            <Skeleton height="12" data-testid="order-detail-timeline-pending" />
          ) : (
            <Stack as="ol" gap="2" listStyleType="none" m="0" p="0">
              {timeline.map((row) => (
                <HStack
                  as="li"
                  key={row.id}
                  gap="3"
                  align="baseline"
                  flexWrap="wrap"
                  data-testid="order-detail-timeline-row"
                >
                  <Text fontSize="sm" color="fg.muted" fontVariantNumeric="tabular-nums">
                    {formatDateTime(row.at)}
                  </Text>
                  <Text fontSize="sm">{row.label}</Text>
                </HStack>
              ))}
            </Stack>
          )}
        </Card.Body>
      </Card.Root>

      <Card.Root data-testid="order-detail-fills">
        <Card.Header>
          <Heading as="h4" size="sm">
            {copy.orderFills}
          </Heading>
        </Card.Header>
        <Card.Body>
          {fillsSection.stale && (
            <Alert.Root
              status="warning"
              role="status"
              mb="4"
              data-testid="order-detail-fills-stale"
            >
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
              </Alert.Content>
              <Button size="xs" variant="outline" ml="auto" onClick={() => void fills.refetch()}>
                {copy.retry}
              </Button>
            </Alert.Root>
          )}
          {fillsSection.body === 'pending' ? (
            <Skeleton height="12" />
          ) : fillsSection.body === 'failed' ? (
            <Stack gap="2" align="flex-start">
              <Alert.Root status="error" role="alert">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{copy.errUnknown}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
              <Button size="sm" variant="outline" onClick={() => void fills.refetch()}>
                {copy.retry}
              </Button>
            </Stack>
          ) : fillsSection.body === 'empty' && !fills.hasNextPage ? (
            <EmptyState message={copy.orderFillsEmpty} data-testid="order-detail-fills-empty" />
          ) : (
            <Stack gap="2">
              {fillRows.map((fill) => (
                <DataList.Root
                  key={fill.id}
                  orientation="horizontal"
                  size="sm"
                  borderWidth="1px"
                  borderRadius="l2"
                  p="3"
                  data-testid={`order-detail-fill-${fill.id}`}
                >
                  <Item label={copy.orderFillTime}>{formatDateTime(fill.createdAt)}</Item>
                  <Item label={copy.orderFillPrice}>{formatContractPrice(fill.priceCoin)}</Item>
                  <Item label={copy.fillQty}>{formatContracts(fill.qty)}</Item>
                  <Item label={copy.orderAmount}>
                    <CoinText amount={parseCoinAmount(fill.amountCoin)} />
                  </Item>
                  <Item label={copy.orderFee}>
                    <CoinText amount={parseCoinAmount(fill.feeCoin)} />
                  </Item>
                </DataList.Root>
              ))}
              {more}
            </Stack>
          )}
        </Card.Body>
      </Card.Root>

      <Button
        asChild
        size="sm"
        variant="outline"
        alignSelf="flex-start"
        data-testid="order-detail-back"
      >
        <NextLink href={live ? MY_ORDERS_PATH : MY_HISTORY_PATH}>
          {live ? copy.orderBackToPending : copy.orderBackToHistory}
        </NextLink>
      </Button>

      <OrderCancelDialog
        orderId={confirming ? order.id : null}
        accountId={accountId}
        order={order}
        onClose={() => {
          setConfirming(false);
        }}
        finalFocusEl={() => statusRef.current}
        onConfirm={(confirmed) => {
          setConfirming(false);
          cancel.mutate({ orderId: confirmed.id, accountId, marketId: confirmed.marketId });
        }}
      />
    </Stack>
  );
}

/** One label and value of a DataList, the value's test id when it is asserted. */
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
      <DataList.ItemValue fontVariantNumeric="tabular-nums" data-testid={testId}>
        {children}
      </DataList.ItemValue>
    </DataList.Item>
  );
}
