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
import { parseCoinAmount } from '@buddha/shared';
import NextLink from 'next/link';
import { type ReactNode } from 'react';
import { EMPTY, SignedCoin } from '@/components/history/history-parts';
import { MarketHistoryLink } from '@/components/market/settled-recap';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { CoinText } from '@/components/ui/coin-text';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { useMyMarketFills } from '@/hooks/use-my-orders';
import { type MyFill } from '@/lib/api';
import { formatContracts } from '@/lib/market-admin';
import { marketHistoryLinks } from '@/lib/market-recap';
import { myOrderPath } from '@/lib/my';
import { formatContractPrice } from '@/lib/order-confirm';
import { sessionListSection } from '@/lib/query-client';

/**
 * 내 거래 on the market detail (#123, ADR-0141 결정 3; ADR-0135 결과 4 #123): this account's fills
 * on this market, newest first, 20 at a time — each as its own order took it: when, YES/NO,
 * 매수/매도, its price per contract in that contract, the quantity, the Coin, and its order's
 * 주문 상세. No counterparty, nor whether it was the 운영 유동성 (B4). A signed-in reader's only:
 * the detail draws it for a member, and it draws nothing for one signed out. Below md it is behind
 * the '거래 내역' switch with 최근 체결.
 *
 * Once it has a fill, its last line goes to this market's fills on MY (#34, ADR-0145; ADR-0135
 * 결과 4 '#34 이력 연결') — on every status, an open market's too.
 */
export function MyMarketTrades({ marketId }: { marketId: string }) {
  const me = useMe();
  const accountId = me.data?.id;
  const fills = useMyMarketFills(marketId, accountId);
  const rows: MyFill[] = fills.data?.pages.flatMap((page) => page.items) ?? [];
  const section = sessionListSection(fills, rows.length);
  if (section.body === 'signedOut') return null;
  const more = fills.hasNextPage && (
    <>
      <LoadMoreFailed
        list={fills}
        message={copy.errUnknown}
        data-testid="market-my-trades-more-failed"
      />
      <Button
        alignSelf="center"
        size="sm"
        variant="ghost"
        mt="1"
        loading={fills.isFetchingNextPage}
        onClick={() => void fills.fetchNextPage()}
        data-testid="market-my-trades-more"
      >
        {copy.loadMore}
      </Button>
    </>
  );
  return (
    <Card.Root data-testid="market-my-trades">
      <Card.Header>
        <Heading as="h2" size="md">
          {copy.marketMyTrades}
        </Heading>
      </Card.Header>
      <Card.Body>
        <Stack gap="3">
          {section.stale && (
            <Alert.Root status="warning" role="status" data-testid="market-my-trades-stale">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
              </Alert.Content>
              <Button size="xs" variant="outline" ml="auto" onClick={() => void fills.refetch()}>
                {copy.retry}
              </Button>
            </Alert.Root>
          )}
          {/* The account is read before its fills (the key ends in it): a `GET /me` that failed
              says so with 다시 시도, as the detail's other personal areas do. */}
          {accountId === undefined && !me.isPending && !me.isFetching ? (
            <Stack gap="2" align="flex-start">
              <Alert.Root status="error" role="alert">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{copy.errProfileLoad}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
              <Button size="sm" variant="outline" onClick={() => void me.refetch()}>
                {copy.retry}
              </Button>
            </Stack>
          ) : section.body === 'pending' || accountId === undefined ? (
            <Skeleton height="12" />
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
            <EmptyState message={copy.marketMyTradesEmpty} data-testid="market-my-trades-empty" />
          ) : (
            <Stack gap="2">
              {rows.map((fill) => (
                <TradeRow key={fill.id} fill={fill} />
              ))}
              {more}
              {rows.length > 0 && (
                <MarketHistoryLink
                  href={marketHistoryLinks(marketId).fills}
                  label={copy.marketHistoryFills}
                  testId="market-history-fills"
                />
              )}
            </Stack>
          )}
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/**
 * One fill of the account's, as its own order took it. A sell line adds its 실현 손익 (N02 §8: 순매도
 * 수령액 − 처분 원가) — the record the server kept for that fill (`MyFill.realizedPnlCoin`, #124), as
 * the history's fill line draws it: '—' for a sell with no record (one the backfill left out), and
 * no such cell on a buy. Lines are never summed: a backfill gap would make a sum disagree with the
 * position's (ADR-0145). Props alone, so a static render draws it.
 */
export function TradeRow({ fill }: { fill: MyFill }) {
  const formatDateTime = useFormatDateTime();
  const yes = fill.outcome === 'YES';
  return (
    <Stack
      gap="2"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid={`market-my-trade-${fill.id}`}
    >
      <HStack gap="2" flexWrap="wrap">
        <Text fontSize="sm" color="fg.muted" fontVariantNumeric="tabular-nums">
          {formatDateTime(fill.createdAt)}
        </Text>
        <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle">
          {yes ? copy.yes : copy.no}
        </Badge>
        <Text fontSize="sm">{fill.side === 'buy' ? copy.buy : copy.sell}</Text>
      </HStack>
      <DataList.Root orientation="horizontal" size="sm">
        <Item label={copy.orderFillPrice}>{formatContractPrice(fill.priceCoin)}</Item>
        <Item label={copy.fillQty}>{formatContracts(fill.qty)}</Item>
        <Item label={copy.orderAmount}>
          <CoinText amount={parseCoinAmount(fill.amountCoin)} />
        </Item>
        {fill.side === 'sell' && (
          <Item label={copy.positionRealizedPnl} testId="market-my-trade-realized">
            {fill.realizedPnlCoin === null ? (
              EMPTY
            ) : (
              <SignedCoin amount={parseCoinAmount(fill.realizedPnlCoin)} />
            )}
          </Item>
        )}
      </DataList.Root>
      <ChakraLink
        asChild
        fontSize="sm"
        colorPalette="brand"
        color="colorPalette.fg"
        alignSelf="flex-start"
      >
        <NextLink href={myOrderPath(fill.orderId)} data-testid="market-my-trade-detail">
          {copy.orderDetail}
        </NextLink>
      </ChakraLink>
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
