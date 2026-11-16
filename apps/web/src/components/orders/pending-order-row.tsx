'use client';

import {
  Badge,
  Button,
  DataList,
  HStack,
  Link as ChakraLink,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { type ReactNode } from 'react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { type Order } from '@/lib/api';
import { formatContracts } from '@/lib/market-admin';
import { myOrderPath } from '@/lib/my';
import { remainingQty } from '@/lib/my-orders';
import { averagePriceText, formatContractPrice } from '@/lib/order-confirm';
import { orderStatusLabel } from '@/lib/order-reasons';

/**
 * 대기 주문 한 줄 (#123, ADR-0141 결정 3): MY's 대기 주문 and the detail's 내 대기 주문 draw the same
 * row — the detail without its market line. The market (or '공개되지 않은 시장'), YES/NO, 매수/매도
 * and the server's state (대기 or 부분 체결: never 취소 완료 while a cancel is in flight, 결정 4);
 * 한도가격, 주문·체결·남은 수량, 평균가 ('—' before a fill) and the server's 접수 시각; the condition
 * line '시장 마감 때 만료' (#177) — or, in a market waiting for a ledger recovery, the line that
 * says why it cannot be cancelled now in its place (ADR-0135 결과 4 #123). Then 주문 취소, or
 * '취소 요청 중' while one is in flight, and 상세.
 *
 * 주문 취소 asks a session alone (결정 4, ADR-0113 12-8): none of the order panel's blocks — an
 * account restriction, the admin role, a re-consent, intake closed — turns it off; only a market
 * awaiting its recovery and a cancel already in flight do. A market whose bot supply alone
 * stopped reads like any other (B4): the row never asks the market's state.
 */
export function PendingOrderRow({
  order,
  testId,
  showMarket,
  cancelling,
  cancelDisabled,
  onCancel,
}: {
  order: Order;
  /** The row's own test id and DOM id: `portfolio-order-<id>` (MY), `market-my-order-<id>`. */
  testId: string;
  /** MY lists every market's orders; the detail's are all its own market's. */
  showMarket: boolean;
  /** '취소 요청 중' in place of the button (`showsCancelling`). */
  cancelling: boolean;
  /** Off while another cancel of the same order is in flight or the screen's account is unknown. */
  cancelDisabled: boolean;
  onCancel: () => void;
}) {
  const yes = order.outcome === 'YES';
  const formatDateTime = useFormatDateTime();
  const remaining = remainingQty(order);
  return (
    <Stack
      gap="2"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      id={testId}
      tabIndex={-1}
      outline="none"
      aria-busy={cancelling}
      data-testid={testId}
    >
      <HStack gap="2" flexWrap="wrap">
        {showMarket &&
          (order.marketSlug === null || order.marketTitle === null ? (
            <Text
              fontWeight="semibold"
              color="fg.muted"
              data-testid="portfolio-order-market-hidden"
            >
              {copy.postMarketNotPublic}
            </Text>
          ) : (
            <ChakraLink asChild fontWeight="semibold" wordBreak="break-word">
              <NextLink href={`/markets/${order.marketSlug}` as Route}>
                {order.marketTitle}
              </NextLink>
            </ChakraLink>
          ))}
        <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle">
          {yes ? copy.yes : copy.no}
        </Badge>
        <Text fontSize="sm">{order.side === 'buy' ? copy.buy : copy.sell}</Text>
        <Badge
          colorPalette={order.status === 'partially_filled' ? 'orange' : 'gray'}
          variant="subtle"
          data-testid="order-row-status"
          data-status={order.status}
        >
          {orderStatusLabel(order.status)}
        </Badge>
      </HStack>
      <DataList.Root orientation="horizontal" size="sm" data-testid="order-row-terms">
        <Item label={copy.orderLimit} testId="order-row-limit">
          {formatContractPrice(order.limitPriceCoin)}
        </Item>
        <Item label={copy.orderOrderedQty} testId="order-row-qty">
          {order.qty === null ? copy.orderNone : formatContracts(order.qty)}
        </Item>
        <Item label={copy.orderFilledQty} testId="order-row-filled">
          {formatContracts(order.filledQty)}
        </Item>
        <Item label={copy.orderRemainingQty} testId="order-row-remaining">
          {remaining === null ? copy.orderNone : formatContracts(remaining)}
        </Item>
        <Item label={copy.orderAvgPrice} testId="order-row-avg">
          {averagePriceText(order)}
        </Item>
        <Item label={copy.orderAcceptedAt} testId="order-row-at">
          {formatDateTime(order.createdAt)}
        </Item>
      </DataList.Root>
      {order.awaitingRecovery ? (
        <Text fontSize="sm" color="fg.warning" data-testid="order-row-held">
          {copy.orderHeldMarket}
        </Text>
      ) : (
        <Text fontSize="sm" color="fg.muted" data-testid="order-row-gtc">
          {copy.orderUnfilledGtc}
        </Text>
      )}
      <Stack direction={{ base: 'column', md: 'row' }} gap="2">
        {cancelling ? (
          <Badge
            size="lg"
            minH="11"
            justifyContent="center"
            gap="2"
            variant="subtle"
            colorPalette="orange"
            role="status"
            data-testid="order-row-cancelling"
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
            w={{ base: 'full', md: 'auto' }}
            disabled={order.awaitingRecovery || cancelDisabled}
            onClick={onCancel}
            data-testid="order-row-cancel"
          >
            {copy.orderCancel}
          </Button>
        )}
        <Button
          asChild
          size="sm"
          minH="11"
          variant="ghost"
          w={{ base: 'full', md: 'auto' }}
          data-testid="order-row-detail"
        >
          <NextLink href={myOrderPath(order.id)}>{copy.orderDetailShort}</NextLink>
        </Button>
      </Stack>
    </Stack>
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
      <DataList.ItemValue fontVariantNumeric="tabular-nums" data-testid={testId}>
        {children}
      </DataList.ItemValue>
    </DataList.Item>
  );
}
