'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  Heading,
  HStack,
  Link,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { formatCoin } from '@buddha/shared';
import NextLink from 'next/link';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import {
  useMarketMakerMetricsList,
  useMarketMakerOverview,
} from '@/hooks/use-market-maker-metrics';
import type { AdminMarketMakerMetricsListItem, AdminMarketMakerMetricsOverview } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { MARKET_STATUS_LABEL } from '@/lib/market-admin';
import { MARKET_MAKER_STATE_LABEL, marketMakerReason } from '@/lib/market-maker';
import { metricsCount, metricsReason } from '@/lib/market-maker-metrics';
import { TreasuryBalance } from '../treasury/admin-treasury';
import { MakerRiskFacts, MetricsFields } from './metrics-facts';

export function MakerOverview({ data }: { data: AdminMarketMakerMetricsOverview }) {
  return (
    <Stack gap="4" data-testid="maker-metrics-overview">
      <Heading as="h3" size="lg">
        {copy.makerMetricsAllFunded}
      </Heading>
      <Text fontSize="sm">
        {copy.makerMetricsAsOf}: {formatKst(data.asOf)}
      </Text>
      <Text fontWeight="medium" data-testid="maker-overview-completeness">
        {data.complete ? copy.makerMetricsComplete : copy.makerMetricsPartial}
      </Text>
      <MetricsFields
        fields={[
          [
            copy.makerMetricsCoverage,
            `${metricsCount(data.readyCount)} / ${metricsCount(data.marketCount)}`,
          ],
          [copy.makerMetricsWorstLossSum, formatCoin(BigInt(data.totals.worstLossCoin))],
          [copy.makerMetricsReservedLossSum, formatCoin(BigInt(data.totals.reservedWorstLossCoin))],
          [copy.makerMetricsMaxLossSum, formatCoin(BigInt(data.totals.maxLossCoin))],
          [copy.makerMetricsInvested, formatCoin(BigInt(data.totals.investedCoin))],
          [copy.makerMetricsRecovered, formatCoin(BigInt(data.totals.recoveredCoin))],
          [copy.makerMetricsFunds, formatCoin(BigInt(data.totals.fundsCoin))],
        ]}
      />
      {data.missing.length > 0 && (
        <Stack gap="2" data-testid="maker-overview-missing">
          <Text fontWeight="medium">{copy.makerMetricsMissing}</Text>
          {data.missing.map((row, index) => (
            <Stack key={row.marketId} gap="1">
              <Link asChild>
                <NextLink href={`/admin/markets/${row.marketId}`}>
                  {copy.makerMetricsMarket} {index + 1}
                </NextLink>
              </Link>
              <Text fontSize="sm">
                {row.kind === 'inconsistent'
                  ? copy.makerMetricsInconsistent
                  : copy.makerMetricsUnavailable}
                : {metricsReason(row.reason)}
              </Text>
            </Stack>
          ))}
        </Stack>
      )}
      <Heading as="h3" size="lg">
        {copy.adminTreasury}
      </Heading>
      <TreasuryBalance treasury={data.treasury} />
      <HStack gap="4" flexWrap="wrap">
        <Link asChild>
          <NextLink href="/admin/treasury">{copy.adminTreasury}</NextLink>
        </Link>
        <Link asChild>
          <NextLink href="/admin/audit-failures">{copy.adminAuditFailures}</NextLink>
        </Link>
      </HStack>
    </Stack>
  );
}

export function MakerMetricsRow({ data }: { data: AdminMarketMakerMetricsListItem }) {
  return (
    <Card.Root data-testid={`maker-metrics-market-${data.marketId}`}>
      <Card.Body gap="3">
        <Link asChild fontWeight="semibold">
          <NextLink href={`/admin/markets/${data.marketId}`}>{data.title}</NextLink>
        </Link>
        <HStack flexWrap="wrap">
          <Badge>{MARKET_STATUS_LABEL[data.status]}</Badge>
          {data.runtime && <Badge>{MARKET_MAKER_STATE_LABEL[data.runtime.state]}</Badge>}
        </HStack>
        <Text fontSize="sm">
          {copy.makerMetricsAsOf}: {formatKst(data.asOf)}
        </Text>
        {data.runtime === null ? (
          <Text fontSize="sm">{copy.marketMakerNoRuntime}</Text>
        ) : (
          <>
            {!data.runtime.desiredEnabled && <Text fontSize="sm">{copy.marketMakerDisabled}</Text>}
            {data.runtime.reason && (
              <Text fontSize="sm">{marketMakerReason(data.runtime.reason)}</Text>
            )}
          </>
        )}
        <MakerRiskFacts risk={data.risk} compact />
      </Card.Body>
    </Card.Root>
  );
}

export function AdminMarketMakersScreen() {
  const overview = useMarketMakerOverview();
  const list = useMarketMakerMetricsList();
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack gap="6" data-testid="admin-market-makers">
      <Heading as="h2" size="xl">
        {copy.adminMarketMakers}
      </Heading>
      <Text color="fg.muted">{copy.makerMetricsIntro}</Text>
      <Card.Root>
        <Card.Body gap="4">
          <Button
            size="sm"
            variant="outline"
            alignSelf="end"
            loading={overview.isFetching}
            onClick={() => void overview.refetch()}
          >
            {copy.retry}
          </Button>
          {overview.isPending ? (
            <Skeleton height="24" />
          ) : (
            <>
              {overview.isError && (
                <Alert.Root status="warning" role="alert">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>
                      {overview.data ? copy.adminMarketRefreshFailed : copy.errUnknown}
                    </Alert.Description>
                  </Alert.Content>
                </Alert.Root>
              )}
              {overview.data && <MakerOverview data={overview.data} />}
            </>
          )}
        </Card.Body>
      </Card.Root>
      <HStack justify="space-between" flexWrap="wrap">
        <Heading as="h3" size="lg">
          {copy.makerMetricsMarkets}
        </Heading>
        <Button
          size="sm"
          variant="outline"
          loading={list.isRefetching}
          onClick={() => void list.refetch()}
        >
          {copy.retry}
        </Button>
      </HStack>
      {list.isPending ? (
        <Skeleton height="24" />
      ) : list.isLoadingError ? (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : (
        <>
          {list.isRefetchError && (
            <Alert.Root status="warning" role="status">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.adminMarketRefreshFailed}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
          )}
          {items.length === 0 && <Text>{copy.makerMetricsEmpty}</Text>}
          {items.map((item) => (
            <MakerMetricsRow key={item.marketId} data={item} />
          ))}
          {list.hasNextPage && (
            <>
              <LoadMoreFailed
                list={list}
                message={copy.errUnknown}
                data-testid="maker-metrics-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </>
      )}
    </Stack>
  );
}
