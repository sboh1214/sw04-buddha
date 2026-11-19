'use client';

import { Badge, DataList, Grid, HStack, Link as ChakraLink, Stack, Text } from '@chakra-ui/react';
import { parseCoinAmount } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { EMPTY, HistoryItem as RecapItem, SignedCoin } from '@/components/history/history-parts';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { CoinText } from '@/components/ui/coin-text';
import { copy } from '@/copy';
import { MARKET_RESULT_LABEL, formatContracts } from '@/lib/market-admin';
import { type RecapEntry, marketHistoryLinks } from '@/lib/market-recap';

/**
 * 내 포지션 of a market that has paid out (#34, ADR-0145; ADR-0135 I1, 결과 4): each contract's
 * settlement record with the result beside it, YES first (`settledRecapOf`). Props alone and no
 * query, so a static render draws it as the browser does (the unit test's subject).
 *
 * A contract with a record shows the record's columns as they are — the result, the quantity held
 * at the payout (the record's `qty`, not the row's, which the payout left at 0), the cost that
 * remained, the payout per contract (100, 0, 무효 50), the payout and 정산 손익 — then the row's
 * 실현 손익, the cumulative one (실현 + 정산), which is the one sum ADR-0135 결과 4 keeps: there is no
 * total line. Two times, each its own (N03 §5): 결과 확정 (the market's, '—' when the row carries
 * none) and 지급 완료 (this account's record). A 무효 is a payout with its own P&L, never anything
 * else (N03 §6). A contract with no record — sold out before the payout — says '보유 없음' with its
 * 실현 손익 and nothing of a settlement. The card's last line goes to this market's records on MY
 * once there is one. No market price anywhere: the last price is not the result (ADR-0135 C5).
 */
export function SettledRecap({ entries, marketId }: { entries: RecapEntry[]; marketId: string }) {
  return (
    <Stack gap="4">
      <Stack gap="4" divideY="1px">
        {entries.map((entry) =>
          entry.kind === 'record' ? (
            <RecordBlock key={entry.outcome} entry={entry} />
          ) : (
            <SoldOutBlock key={entry.outcome} entry={entry} />
          ),
        )}
      </Stack>
      {entries.some((entry) => entry.kind === 'record') && (
        <MarketHistoryLink
          href={marketHistoryLinks(marketId).settlements}
          label={copy.marketHistorySettlements}
          testId="market-history-settlements"
        />
      )}
    </Stack>
  );
}

function blockTestId(outcome: RecapEntry['outcome']): string {
  return `market-settled-${outcome === 'YES' ? 'yes' : 'no'}`;
}

function OutcomeBadge({ outcome }: { outcome: RecapEntry['outcome'] }) {
  const yes = outcome === 'YES';
  return (
    <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle" alignSelf="flex-start">
      {yes ? copy.yes : copy.no}
    </Badge>
  );
}

/** 실현 손익 as the row holds it, or '—' for a record whose row is missing. */
function Realized({ amount }: { amount: string | null }) {
  return amount === null ? EMPTY : <SignedCoin amount={parseCoinAmount(amount)} />;
}

function RecordBlock({ entry }: { entry: Extract<RecapEntry, { kind: 'record' }> }) {
  const formatDateTime = useFormatDateTime();
  const { record } = entry;
  return (
    <Stack gap="2" minW="0" data-testid={blockTestId(entry.outcome)}>
      <OutcomeBadge outcome={entry.outcome} />
      {/* One column on a phone, the figures beside the two times from lg up: the history's row
          at the detail's breakpoint, as HoldingRow's detail layout — from md the card sits in
          the column beside the 320px track, too narrow for two label-and-value columns. */}
      <Grid templateColumns={{ base: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' }} gap="4">
        <DataList.Root orientation="horizontal" size="sm">
          <RecapItem label={copy.marketResolvedResult} testId="market-settled-result">
            {MARKET_RESULT_LABEL[record.result]}
          </RecapItem>
          <RecapItem label={copy.historySettlementQty} testId="market-settled-qty">
            {formatContracts(record.qty)}
          </RecapItem>
          <RecapItem label={copy.positionCostBasis} testId="market-settled-cost">
            <CoinText amount={parseCoinAmount(record.costBasisCoin)} />
          </RecapItem>
          <RecapItem label={copy.historyPayoutPerContract} testId="market-settled-each">
            <CoinText amount={BigInt(record.payoutPerContractCoin)} />
          </RecapItem>
          <RecapItem label={copy.historyPayout} testId="market-settled-payout">
            <CoinText amount={parseCoinAmount(record.payoutCoin)} />
          </RecapItem>
          <RecapItem label={copy.historySettlementPnl} testId="market-settled-settlement-pnl">
            <SignedCoin amount={parseCoinAmount(record.settlementPnlCoin)} />
          </RecapItem>
          <RecapItem label={copy.positionRealizedPnl} testId="market-settled-realized">
            <Realized amount={entry.realizedPnlCoin} />
          </RecapItem>
        </DataList.Root>
        <DataList.Root orientation="horizontal" size="sm" alignSelf="start">
          <RecapItem label={copy.historyResolvedAt} testId="market-settled-resolved-at">
            {record.resolvedAt === null ? EMPTY : formatDateTime(record.resolvedAt)}
          </RecapItem>
          <RecapItem label={copy.historySettledAt} testId="market-settled-settled-at">
            {formatDateTime(record.settledAt)}
          </RecapItem>
        </DataList.Root>
      </Grid>
    </Stack>
  );
}

function SoldOutBlock({ entry }: { entry: Extract<RecapEntry, { kind: 'soldOut' }> }) {
  return (
    <Stack gap="2" minW="0" data-testid={blockTestId(entry.outcome)}>
      <HStack gap="2" flexWrap="wrap">
        <OutcomeBadge outcome={entry.outcome} />
        <Text fontSize="sm" color="fg.muted" data-testid="market-settled-no-holding">
          {copy.positionNoHolding}
        </Text>
      </HStack>
      <DataList.Root orientation="horizontal" size="sm">
        {/* YES·NO·무효; a cancelled market ended with no result at all, so it has none to name. */}
        <RecapItem label={copy.marketResolvedResult} testId="market-settled-result">
          {entry.result === null ? EMPTY : MARKET_RESULT_LABEL[entry.result]}
        </RecapItem>
        <RecapItem label={copy.positionRealizedPnl} testId="market-settled-realized">
          <Realized amount={entry.realizedPnlCoin} />
        </RecapItem>
      </DataList.Root>
    </Stack>
  );
}

/**
 * One way from the detail to MY's history of this market (ADR-0135 결과 4 '#34 이력 연결', I3).
 * `prefetch={false}`: `/my/history` is a server page that reads the market's title when `?market=`
 * is set (`historyMarketTitle`) and the app has no loading.tsx, so a prefetch is that page rendered
 * on the server for a link that may never be clicked — the reason the category links into `/` do
 * without one (market-detail.tsx, subcategory-sidebar.tsx).
 */
export function MarketHistoryLink({
  href,
  label,
  testId,
}: {
  href: string;
  label: string;
  testId: string;
}) {
  return (
    <ChakraLink
      asChild
      fontSize="sm"
      colorPalette="brand"
      color="colorPalette.fg"
      alignSelf="flex-start"
    >
      <NextLink href={href as Route} prefetch={false} data-testid={testId}>
        {label}
      </NextLink>
    </ChakraLink>
  );
}
