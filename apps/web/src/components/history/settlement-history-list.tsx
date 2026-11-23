'use client';

import {
  Alert,
  Badge,
  Box,
  Button,
  DataList,
  Grid,
  HStack,
  Link as ChakraLink,
  Skeleton,
  Stack,
} from '@chakra-ui/react';
import { parseCoinAmount } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { CoinText } from '@/components/ui/coin-text';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useSettlementHistory } from '@/hooks/use-my-history';
import type { MySettlement } from '@/lib/api';
import { MARKET_RESULT_LABEL, formatContracts } from '@/lib/market-admin';
import { showMoreOrders } from '@/lib/my';
import { settlementCorrectedText } from '@/lib/judgement-correction';
import { judgingRecordPath } from '@/lib/market-detail';
import { type HistoryListFilters, isHistoryFiltered, myHistoryPath } from '@/lib/my-history';
import { listSection } from '@/lib/query-client';
import { EMPTY, HistoryItem, HistoryMarketLink, OnlyMarketLink, SignedCoin } from './history-parts';

/**
 * 거래·정산 이력's 정산 (#124, ADR-0143 결정 6): the account's settlement records as the server
 * lists them (`GET /me/settlements`), the latest payout first, those the two filters leave. A
 * record exists for every contract held at 1 or more when its market settled — the losing one with
 * its payout of 0 too (N05 §4) — and for nothing else: a contract sold out before the settlement
 * and a cancelled market have none (ADR-0135 F4). The parent keys it by the account (`me.id`).
 *
 * MY's summary draws the same list with no filter and `limit` rows. A settling `user:position`
 * reads the lists of this account again (`ownSettlementKeys`, realtime-provider.tsx), and a
 * reconnect does; nothing is built from an event.
 */
export function SettlementHistoryList({
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
  const settlements = useSettlementHistory(filters, accountId);
  const rows: MySettlement[] = settlements.data?.pages.flatMap((page) => page.items) ?? [];
  const section = listSection(settlements, rows.length);
  const more = showMoreOrders(settlements.hasNextPage, rows.length, limit) && (
    <>
      {/* A 더 보기 that failed: the rows stay, the message above the button that asks again (owner
          decision 2026-10-20 7). */}
      <LoadMoreFailed
        list={settlements}
        message={copy.errUnknown}
        data-testid={`${testId}-more-failed`}
      />
      <Button
        alignSelf="center"
        size="sm"
        variant="ghost"
        mt="1"
        loading={settlements.isFetchingNextPage}
        onClick={() => void settlements.fetchNextPage()}
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
          <Button size="xs" variant="outline" ml="auto" onClick={() => void settlements.refetch()}>
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
          <Button size="sm" variant="outline" onClick={() => void settlements.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : section.body === 'empty' && !settlements.hasNextPage ? (
        <EmptyState
          message={
            isHistoryFiltered(filters) ? copy.historyFilteredEmpty : copy.historySettlementsEmpty
          }
          data-testid={`${testId}-empty`}
        />
      ) : (
        <Stack gap="2">
          {rows.slice(0, limit).map((record) => (
            <SettlementHistoryRow
              key={`${record.marketId}-${record.outcome}`}
              record={record}
              onlyMarketHref={
                filters.market === record.marketId.toLowerCase()
                  ? undefined
                  : myHistoryPath({ kind: 'settlements', ...filters, market: record.marketId })
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
 * 정산 한 줄: one contract of one market as its settlement record holds it — the result, the
 * quantity held then, the cost that remained, the payout per contract (100 for the winning
 * contract, 0 for the losing one, 50 each for 무효), the payout and 정산 손익 (지급액 − 잔여 원가,
 * N02 §8). Every figure is the record's own column, read as it is: a payout of 0 is drawn '0 Coin'
 * and its line stays, and a 무효 line is a payout with its own P&L, never called anything else
 * (N03 §6). No start grant or regrant is in any of them — the record knows the holding alone.
 *
 * Two times, each its own (N03 §5): 결과 확정 is the market's (`resolvedAt`, '—' for a record
 * whose market row carries none) and 지급 완료 is THIS account's record's (`settledAt`), the time
 * the list is ordered and filtered by. 판정 기록 opens the market's detail at its public judging
 * record (`#judging-record`).
 *
 * A market whose 판정 오류 사건 was confirmed after the payout (#144, ADR-0166; 144-17) marks its
 * rows '판정 정정 · 결과 {정정된 결과}' — the mark alone, no amount: the row's result and figures
 * stay the paid ones (the record never moves), the compensation is the wallet's and the recap's,
 * and 판정 기록 leads to the correction.
 */
export function SettlementHistoryRow({
  record,
  onlyMarketHref,
}: {
  record: MySettlement;
  onlyMarketHref: string | undefined;
}) {
  const formatDateTime = useFormatDateTime();
  const yes = record.outcome === 'YES';
  return (
    <Stack
      gap="2"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      minW="0"
      data-testid={`history-settlement-${record.marketId}-${record.outcome}`}
    >
      <HStack gap="2" flexWrap="wrap">
        <HistoryMarketLink slug={record.marketSlug} title={record.marketTitle} />
        <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle">
          {yes ? copy.yes : copy.no}
        </Badge>
        {record.correctedResult !== null && (
          <Badge colorPalette="orange" variant="subtle" data-testid="history-settlement-corrected">
            {settlementCorrectedText(record.correctedResult)}
          </Badge>
        )}
      </HStack>
      {/* Nine cells: one column on a phone, the figures beside the two times from md up. */}
      <Grid templateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }} gap="4">
        <DataList.Root orientation="horizontal" size="sm">
          <HistoryItem label={copy.marketResolvedResult} testId="history-settlement-result">
            {MARKET_RESULT_LABEL[record.result]}
          </HistoryItem>
          <HistoryItem label={copy.historySettlementQty} testId="history-settlement-qty">
            {formatContracts(record.qty)}
          </HistoryItem>
          <HistoryItem label={copy.positionCostBasis} testId="history-settlement-cost">
            <CoinText amount={parseCoinAmount(record.costBasisCoin)} />
          </HistoryItem>
          <HistoryItem label={copy.historyPayoutPerContract} testId="history-settlement-each">
            <CoinText amount={BigInt(record.payoutPerContractCoin)} />
          </HistoryItem>
          <HistoryItem label={copy.historyPayout} testId="history-settlement-payout">
            <CoinText amount={parseCoinAmount(record.payoutCoin)} />
          </HistoryItem>
          <HistoryItem label={copy.historySettlementPnl} testId="history-settlement-pnl">
            <SignedCoin amount={parseCoinAmount(record.settlementPnlCoin)} />
          </HistoryItem>
        </DataList.Root>
        <DataList.Root orientation="horizontal" size="sm" alignSelf="start">
          <HistoryItem label={copy.historyResolvedAt} testId="history-settlement-resolved-at">
            {record.resolvedAt === null ? EMPTY : formatDateTime(record.resolvedAt)}
          </HistoryItem>
          <HistoryItem label={copy.historySettledAt} testId="history-settlement-settled-at">
            {formatDateTime(record.settledAt)}
          </HistoryItem>
        </DataList.Root>
      </Grid>
      <HStack gap="4" flexWrap="wrap">
        <ChakraLink asChild fontSize="sm" colorPalette="brand" color="colorPalette.fg">
          <NextLink
            href={judgingRecordPath(record.marketSlug) as Route}
            data-testid="history-settlement-judging"
          >
            {copy.historyJudgingRecord}
          </NextLink>
        </ChakraLink>
        {onlyMarketHref !== undefined && <OnlyMarketLink href={onlyMarketHref} />}
      </HStack>
    </Stack>
  );
}
