'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  DataList,
  Heading,
  HStack,
  Link,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { formatCoin } from '@buddha/shared';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { useAdminMarketMaker } from '@/hooks/use-admin-market-maker';
import type { AdminMarketMaker } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { formatReleaseSettingState } from '@/lib/release-settings';
import {
  MARKET_MAKER_BLOCKER_LABEL,
  MARKET_MAKER_STAGE_LABEL,
  MARKET_MAKER_STATE_LABEL,
  marketMakerReason,
} from '@/lib/market-maker';

function MarketMakerRecall({ recall }: { recall: AdminMarketMaker['recall'] }) {
  return (
    <Stack gap="2" p="3" borderWidth="1px" borderRadius="l2" data-testid="market-maker-recall">
      <Text fontWeight="medium">{copy.marketMakerRecallTitle}</Text>
      {recall.status === 'not_due' ? (
        <Text fontSize="sm">{copy.marketMakerRecallNotDue}</Text>
      ) : recall.status === 'pending' ? (
        <>
          <Text>{copy.marketMakerRecallPending}</Text>
          <Text fontSize="sm">{copy.marketMakerRecallPendingHint}</Text>
        </>
      ) : (
        <>
          <Text>{copy.marketMakerRecallCompleted}</Text>
          <Text data-testid="market-maker-recall-outcome">
            {
              {
                not_allocated: copy.marketMakerRecallNotAllocated,
                empty: copy.marketMakerRecallEmpty,
                transferred: copy.marketMakerRecallTransferred,
              }[recall.outcome]
            }
          </Text>
          <DataList.Root orientation={{ base: 'vertical', md: 'horizontal' }} size="sm">
            <DataList.Item flexDirection={{ base: 'column', md: 'row' }}>
              <DataList.ItemLabel>{copy.marketMakerRecallAmount}</DataList.ItemLabel>
              <DataList.ItemValue>{formatCoin(BigInt(recall.amountCoin))}</DataList.ItemValue>
            </DataList.Item>
            <DataList.Item flexDirection={{ base: 'column', md: 'row' }}>
              <DataList.ItemLabel>{copy.marketMakerRecallCompletedAt}</DataList.ItemLabel>
              <DataList.ItemValue>{formatKst(recall.completedAt)}</DataList.ItemValue>
            </DataList.Item>
            <DataList.Item flexDirection={{ base: 'column', md: 'row' }}>
              <DataList.ItemLabel>{copy.marketMakerRecallBasis}</DataList.ItemLabel>
              <DataList.ItemValue>
                {recall.terminalStatus === 'settled'
                  ? copy.marketMakerRecallSettled
                  : copy.marketMakerRecallCancelled}
              </DataList.ItemValue>
            </DataList.Item>
          </DataList.Root>
          <Text fontSize="sm" color="fg.muted">
            {copy.marketMakerRecallHistoryHint}
          </Text>
        </>
      )}
    </Stack>
  );
}

export function MarketMakerFacts({ data }: { data: AdminMarketMaker }) {
  const { runtime, lastOpenAttempt: opening } = data;
  const versions = [
    [copy.marketMakerCurrentVersion, data.config?.version],
    [copy.marketMakerOpenedVersion, data.openedVersion],
    [copy.marketMakerAppliedVersion, runtime?.lastConfigVersion],
  ] as const;
  return (
    <Stack gap="4" data-testid="market-maker-facts">
      <Stack gap="2">
        {runtime === null ? (
          <Text>{copy.marketMakerNoRuntime}</Text>
        ) : (
          <>
            <Badge
              alignSelf="start"
              colorPalette={
                runtime.state === 'error' ? 'red' : runtime.state === 'ready' ? 'green' : 'orange'
              }
              data-testid="market-maker-state"
            >
              {MARKET_MAKER_STATE_LABEL[runtime.state]}
            </Badge>
            {runtime.reason && <Text fontSize="sm">{marketMakerReason(runtime.reason)}</Text>}
            {BigInt(runtime.generation) > BigInt(runtime.completedGeneration) && (
              <Text fontSize="sm" data-testid="market-maker-pending">
                {copy.marketMakerPending}
              </Text>
            )}
          </>
        )}
      </Stack>
      <Stack gap="2" data-testid="market-maker-readiness">
        <Text fontWeight="medium">{copy.marketMakerCurrentConditions}</Text>
        {data.readiness.blockers.length === 0 ? (
          <Text fontSize="sm">{copy.marketMakerNoBlockers}</Text>
        ) : (
          data.readiness.blockers.map((blocker) => (
            <Text key={blocker} fontSize="sm">
              {MARKET_MAKER_BLOCKER_LABEL[blocker]}
            </Text>
          ))
        )}
      </Stack>
      <DataList.Root orientation={{ base: 'vertical', md: 'horizontal' }} size="sm">
        {versions.map(([label, version]) => (
          <DataList.Item key={label} flexDirection={{ base: 'column', md: 'row' }}>
            <DataList.ItemLabel>{label}</DataList.ItemLabel>
            <DataList.ItemValue>{version ?? '—'}</DataList.ItemValue>
          </DataList.Item>
        ))}
        <DataList.Item flexDirection={{ base: 'column', md: 'row' }}>
          <DataList.ItemLabel>{copy.marketMakerStageSettings}</DataList.ItemLabel>
          <DataList.ItemValue>
            {MARKET_MAKER_STAGE_LABEL[data.stageSettings.status]}
          </DataList.ItemValue>
        </DataList.Item>
        {(
          [
            [copy.marketMakerReduceAt, data.stageSettings.reduceAtBp],
            [copy.marketMakerHaltAt, data.stageSettings.haltAtBp],
            [copy.marketMakerReduceRatio, data.stageSettings.reduceRatioBp],
          ] as const
        ).map(([label, reading]) => (
          <DataList.Item key={label} flexDirection={{ base: 'column', md: 'row' }}>
            <DataList.ItemLabel>{label}</DataList.ItemLabel>
            <DataList.ItemValue>{formatReleaseSettingState(reading)}</DataList.ItemValue>
          </DataList.Item>
        ))}
        {runtime &&
          (
            [
              [copy.marketMakerLastAttempt, runtime.lastAttemptAt],
              [copy.marketMakerLastSuccess, runtime.lastSuccessAt],
              [copy.marketMakerLastFailure, runtime.lastFailureAt],
            ] as const
          ).map(([label, time]) => (
            <DataList.Item key={label} flexDirection={{ base: 'column', md: 'row' }}>
              <DataList.ItemLabel>{label}</DataList.ItemLabel>
              <DataList.ItemValue>{time === null ? '—' : formatKst(time)}</DataList.ItemValue>
            </DataList.Item>
          ))}
      </DataList.Root>
      {runtime?.lastError && (
        <Stack gap="1" data-testid="market-maker-last-error">
          <Text fontWeight="medium">{copy.marketMakerLastError}</Text>
          <Text fontSize="sm" whiteSpace="pre-wrap" overflowWrap="anywhere">
            {marketMakerReason(runtime.lastError, copy.marketMakerUnknownError)}
          </Text>
        </Stack>
      )}
      {opening && (
        <Stack
          gap="2"
          p="3"
          borderWidth="1px"
          borderRadius="l2"
          data-testid="market-maker-last-open"
        >
          <Text fontWeight="medium">{copy.marketMakerLastOpenAttempt}</Text>
          <Text fontSize="sm">{formatKst(opening.lastAttemptAt)}</Text>
          <Text>
            {opening.succeededAt === null
              ? copy.marketMakerOpenPending
              : copy.marketMakerOpenSucceeded}
          </Text>
          {opening.reason && <Text fontSize="sm">{marketMakerReason(opening.reason)}</Text>}
          {opening.requiredCoin !== null && (
            <Text fontSize="sm">
              {copy.marketMakerRequiredCoin} {formatCoin(BigInt(opening.requiredCoin))}
            </Text>
          )}
          {opening.availableCoin !== null && (
            <Text fontSize="sm">
              {copy.marketMakerAvailableCoin} {formatCoin(BigInt(opening.availableCoin))}
            </Text>
          )}
        </Stack>
      )}
      <MarketMakerRecall recall={data.recall} />
      <HStack gap="4" flexWrap="wrap">
        <Link asChild>
          <NextLink href="/admin/treasury">{copy.adminTreasury}</NextLink>
        </Link>
        <Link asChild>
          <NextLink href="/admin/settings">{copy.adminReleaseSettings}</NextLink>
        </Link>
        <Link asChild>
          <NextLink href="/admin/audit-failures">{copy.adminAuditFailures}</NextLink>
        </Link>
      </HStack>
    </Stack>
  );
}

export function MarketMakerPanel({ marketId }: { marketId: string }) {
  const query = useAdminMarketMaker(marketId);
  return (
    <Card.Root data-testid="market-maker-panel">
      <Card.Body gap="4">
        <HStack justify="space-between" align="start" flexWrap="wrap">
          <Heading as="h3" size="md">
            {copy.marketMakerTitle}
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
        <Text color="fg.muted" fontSize="sm">
          {copy.marketMakerIntro}
        </Text>
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
            {query.data && <MarketMakerFacts data={query.data} />}
          </>
        )}
      </Card.Body>
    </Card.Root>
  );
}
