'use client';

import {
  Alert,
  Button,
  Card,
  Heading,
  HStack,
  Link,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { useMarketMakerMetrics } from '@/hooks/use-market-maker-metrics';
import type { AdminMarketMakerMetrics } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  MakerConcentration,
  MakerDepth,
  MakerRiskFacts,
  MetricsFields,
} from '../../market-makers/metrics-facts';

export function MarketMakerMetricsFacts({ data }: { data: AdminMarketMakerMetrics }) {
  return (
    <Stack gap="5" data-testid="market-maker-current-metrics">
      <Text fontSize="sm">
        {copy.makerMetricsAsOf}: {formatKst(data.asOf)}
      </Text>
      <MetricsFields
        fields={[
          [copy.marketMakerCurrentVersion, data.configVersion ?? '—'],
          [copy.marketMakerOpenedVersion, data.openedVersion ?? '—'],
        ]}
      />
      <MakerRiskFacts risk={data.risk} />
      <MakerDepth depth={data.depth} />
      <MakerConcentration concentration={data.concentration} />
    </Stack>
  );
}

export function MarketMakerMetricsPanel({ marketId }: { marketId: string }) {
  const query = useMarketMakerMetrics(marketId);
  return (
    <Card.Root data-testid="market-maker-metrics-panel">
      <Card.Body gap="4">
        <HStack justify="space-between" align="start" flexWrap="wrap">
          <Heading as="h3" size="md">
            {copy.makerMetricsTitle}
          </Heading>
          <Button
            size="sm"
            variant="outline"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {copy.retry}
          </Button>
        </HStack>
        <Link asChild>
          <NextLink href="/admin/market-makers">{copy.adminMarketMakers}</NextLink>
        </Link>
        {query.isPending ? (
          <Skeleton height="24" />
        ) : (
          <>
            {query.isError && (
              <Alert.Root status="warning" role="alert">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>
                    {query.data ? copy.adminMarketRefreshFailed : copy.errUnknown}
                  </Alert.Description>
                </Alert.Content>
              </Alert.Root>
            )}
            {query.data && <MarketMakerMetricsFacts data={query.data} />}
          </>
        )}
      </Card.Body>
    </Card.Root>
  );
}
