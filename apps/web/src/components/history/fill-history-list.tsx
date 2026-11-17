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
import { parseCoinAmount } from '@buddha/shared';
import NextLink from 'next/link';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { CoinText } from '@/components/ui/coin-text';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useFillHistory } from '@/hooks/use-my-history';
import type { MyFill } from '@/lib/api';
import { formatContracts } from '@/lib/market-admin';
import { myOrderPath } from '@/lib/my';
import { type HistoryListFilters, isHistoryFiltered, myHistoryPath } from '@/lib/my-history';
import { formatContractPrice } from '@/lib/order-confirm';
import { listSection } from '@/lib/query-client';
import { EMPTY, HistoryItem, HistoryMarketLink, OnlyMarketLink, SignedCoin } from './history-parts';

/**
 * 거래·정산 이력's 체결 (#124, ADR-0143 결정 6): the account's fills as the server lists them
 * (`GET /me/fills`), newest first, those the two filters leave — one line per fill, so an order
 * that walked several price levels is several lines and none is folded away. The parent keys it by
 * the account (`me.id`).
 *
 * Under `['orders']`, so a trade's `user:position` reads it again with the order lists; nothing is
 * built from an event. A refresh that failed keeps the rows and says so above them.
 */
export function FillHistoryList({
  accountId,
  filters,
  testId,
}: {
  accountId: string;
  filters: HistoryListFilters;
  /** The list's own test id: its stale notice, empty line, 더 보기 and its failure hang off it. */
  testId: string;
}) {
  const fills = useFillHistory(filters, accountId);
  const rows: MyFill[] = fills.data?.pages.flatMap((page) => page.items) ?? [];
  const section = listSection(fills, rows.length);
  const more = fills.hasNextPage && (
    <>
      {/* A 더 보기 that failed: the rows stay, the message above the button that asks again (owner
          decision 2026-10-20 7). */}
      <LoadMoreFailed
        list={fills}
        message={copy.errUnknown}
        data-testid={`${testId}-more-failed`}
      />
      <Button
        alignSelf="center"
        size="sm"
        variant="ghost"
        mt="1"
        loading={fills.isFetchingNextPage}
        onClick={() => void fills.fetchNextPage()}
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
          <Button size="xs" variant="outline" ml="auto" onClick={() => void fills.refetch()}>
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
          <Button size="sm" variant="outline" onClick={() => void fills.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : section.body === 'empty' && !fills.hasNextPage ? (
        <EmptyState
          message={isHistoryFiltered(filters) ? copy.historyFilteredEmpty : copy.historyFillsEmpty}
          data-testid={`${testId}-empty`}
        />
      ) : (
        <Stack gap="2">
          {rows.map((fill) => (
            <FillHistoryRow
              key={fill.id}
              fill={fill}
              onlyMarketHref={
                filters.market === fill.marketId.toLowerCase()
                  ? undefined
                  : myHistoryPath({ kind: 'fills', ...filters, market: fill.marketId })
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
 * 체결 한 줄, as the account's own order took it: the market, YES/NO, 매수/매도, the price per
 * contract in that contract, the quantity, the Coin and the server's time. No counterparty, no
 * account type and nothing that tells a 운영 유동성 fill apart (B4, N01 §5) — the answer carries
 * none of them.
 *
 * 실현 손익 is a SELL line's cell alone (N02 §8: 순매도 수령액 − 처분 원가), and its value is the
 * record the server kept when that fill was booked (`realizedPnlCoin`) — never worked out here. A
 * sell with no record (one from before the records, or one the backfill left out) says '—': not 0,
 * which would be a claim. A buy line has no such cell.
 */
export function FillHistoryRow({
  fill,
  onlyMarketHref,
}: {
  fill: MyFill;
  onlyMarketHref: string | undefined;
}) {
  const formatDateTime = useFormatDateTime();
  const yes = fill.outcome === 'YES';
  return (
    <Stack
      gap="2"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      minW="0"
      data-testid={`history-fill-${fill.id}`}
      data-fill-side={fill.side}
    >
      <HStack gap="2" flexWrap="wrap">
        <HistoryMarketLink slug={fill.marketSlug} title={fill.marketTitle} />
        <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle">
          {yes ? copy.yes : copy.no}
        </Badge>
        <Text fontSize="sm">{fill.side === 'buy' ? copy.buy : copy.sell}</Text>
      </HStack>
      <DataList.Root orientation="horizontal" size="sm">
        <HistoryItem label={copy.orderFillPrice} testId="history-fill-price">
          {formatContractPrice(fill.priceCoin)}
        </HistoryItem>
        <HistoryItem label={copy.fillQty} testId="history-fill-qty">
          {formatContracts(fill.qty)}
        </HistoryItem>
        <HistoryItem label={copy.orderAmount} testId="history-fill-amount">
          <CoinText amount={parseCoinAmount(fill.amountCoin)} />
        </HistoryItem>
        {fill.side === 'sell' && (
          <HistoryItem label={copy.positionRealizedPnl} testId="history-fill-pnl">
            {fill.realizedPnlCoin === null ? (
              EMPTY
            ) : (
              <SignedCoin amount={parseCoinAmount(fill.realizedPnlCoin)} />
            )}
          </HistoryItem>
        )}
        <HistoryItem label={copy.historyFillTime} testId="history-fill-at">
          {formatDateTime(fill.createdAt)}
        </HistoryItem>
      </DataList.Root>
      <HStack gap="4" flexWrap="wrap">
        <ChakraLink asChild fontSize="sm" colorPalette="brand" color="colorPalette.fg">
          <NextLink href={myOrderPath(fill.orderId)} data-testid="history-fill-detail">
            {copy.orderDetail}
          </NextLink>
        </ChakraLink>
        {onlyMarketHref !== undefined && <OnlyMarketLink href={onlyMarketHref} />}
      </HStack>
    </Stack>
  );
}
