'use client';

import { Alert, DataList, Heading, Link, SimpleGrid, Stack, Table, Text } from '@chakra-ui/react';
import { formatCoin } from '@buddha/shared';
import type { ReactNode } from 'react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { copy } from '@/copy';
import type { AdminMarketMakerMetrics } from '@/lib/api';
import { nicknameShown } from '@/lib/account-closure';
import { formatReleaseSettingState } from '@/lib/release-settings';
import { adminUserModerationPath } from '@/lib/moderation';
import { MARKET_MAKER_STAGE_LABEL } from '@/lib/market-maker';
import { metricsCount, metricsPercent, metricsReason } from '@/lib/market-maker-metrics';

export function MetricsFields({ fields }: { fields: readonly (readonly [string, ReactNode])[] }) {
  return (
    <DataList.Root orientation={{ base: 'vertical', md: 'horizontal' }} size="sm">
      {fields.map(([label, value]) => (
        <DataList.Item key={label} flexDirection={{ base: 'column', md: 'row' }}>
          <DataList.ItemLabel>{label}</DataList.ItemLabel>
          <DataList.ItemValue overflowWrap="anywhere">{value}</DataList.ItemValue>
        </DataList.Item>
      ))}
    </DataList.Root>
  );
}

export function MetricsUnavailable({
  risk,
}: {
  risk: Exclude<AdminMarketMakerMetrics['risk'], { kind: 'ready' }>;
}) {
  return (
    <Alert.Root status="warning" role="status" data-testid="maker-metrics-unavailable">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>
          {risk.kind === 'inconsistent'
            ? copy.makerMetricsInconsistent
            : copy.makerMetricsUnavailable}
        </Alert.Title>
        <Alert.Description>{metricsReason(risk.reason)}</Alert.Description>
        <Link asChild>
          <NextLink href="/admin/audit-failures">{copy.adminAuditFailures}</NextLink>
        </Link>
      </Alert.Content>
    </Alert.Root>
  );
}

export function MakerRiskFacts({
  risk,
  compact = false,
}: {
  risk: AdminMarketMakerMetrics['risk'];
  compact?: boolean;
}) {
  if (risk.kind !== 'ready') return <MetricsUnavailable risk={risk} />;
  const pnl = risk.pnl;
  const stage =
    risk.stage === null
      ? MARKET_MAKER_STAGE_LABEL[risk.stageStatus]
      : {
          normal: copy.makerMetricsNormal,
          reduce: copy.makerMetricsReduce,
          halt: copy.makerMetricsHalt,
        }[risk.stage];
  return (
    <Stack gap="4" data-testid="maker-metrics-risk">
      {!compact && (
        <>
          <Heading as="h4" size="sm">
            {copy.makerMetricsInventory}
          </Heading>
          <MetricsFields
            fields={[
              [copy.makerMetricsCoin, formatCoin(BigInt(risk.assets.coin))],
              [copy.makerMetricsAvailable, formatCoin(BigInt(risk.assets.availableCoin))],
              [copy.makerMetricsLocked, formatCoin(BigInt(risk.assets.lockedCoin))],
              [copy.makerMetricsYesQty, metricsCount(risk.assets.yesQty)],
              [copy.makerMetricsNoQty, metricsCount(risk.assets.noQty)],
              [copy.makerMetricsYesLocked, metricsCount(risk.assets.yesLockedQty)],
              [copy.makerMetricsNoLocked, metricsCount(risk.assets.noLockedQty)],
            ]}
          />
          <Heading as="h4" size="sm">
            {copy.makerMetricsCapital}
          </Heading>
          <MetricsFields
            fields={[
              [copy.makerMetricsInvested, formatCoin(BigInt(risk.capital.investedCoin))],
              [copy.makerMetricsRecovered, formatCoin(BigInt(risk.capital.recoveredCoin))],
            ]}
          />
        </>
      )}
      <Heading as="h4" size="sm">
        {copy.makerMetricsRisk}
      </Heading>
      <MetricsFields
        fields={[
          [copy.makerMetricsMaxLoss, formatCoin(BigInt(risk.maxLossCoin))],
          [copy.makerMetricsWorstLoss, formatCoin(BigInt(risk.worstLossCoin))],
          [copy.makerMetricsReservedLoss, formatCoin(BigInt(risk.reservedWorstLossCoin))],
          [copy.makerMetricsUtilization, metricsPercent(risk.utilizationBp)],
          [copy.makerMetricsStage, stage],
        ]}
      />
      {!compact &&
        (pnl.kind === 'actual' ? (
          <Stack gap="2" data-testid="maker-metrics-actual-pnl">
            <Heading as="h4" size="sm">
              {copy.makerMetricsActualPnl}
            </Heading>
            <Text>{formatCoin(BigInt(pnl.amountCoin))}</Text>
            <Text fontSize="sm">
              {pnl.reason === 'paid' ? copy.makerMetricsPaid : copy.makerMetricsCancelled}
            </Text>
            {pnl.result !== null && <Text>{pnl.result}</Text>}
          </Stack>
        ) : (
          <Stack gap="2" data-testid="maker-metrics-scenario-pnl">
            <Heading as="h4" size="sm">
              {copy.makerMetricsPnl}
            </Heading>
            {pnl.provisionalResult !== null && (
              <Text>
                {copy.makerMetricsProvisional}: {pnl.provisionalResult}
              </Text>
            )}
            <Table.Root size="sm" tableLayout="fixed">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader width="20%">{copy.makerMetricsOutcome}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.makerMetricsHoldingsPnl}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.makerMetricsReservedPnl}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {(['YES', 'NO', 'VOID'] as const).map((result) => (
                  <Table.Row key={result}>
                    <Table.Cell>{result}</Table.Cell>
                    <Table.Cell overflowWrap="anywhere">
                      {formatCoin(BigInt(pnl.holdings[result]))}
                    </Table.Cell>
                    <Table.Cell overflowWrap="anywhere">
                      {formatCoin(BigInt(pnl.reserved[result]))}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Stack>
        ))}
    </Stack>
  );
}

function DepthLevels({
  levels,
}: {
  levels: AdminMarketMakerMetrics['depth']['bot']['YES']['bids'];
}) {
  if (levels.length === 0) return <Text fontSize="sm">{copy.makerMetricsNoOrders}</Text>;
  return (
    <Table.Root size="sm" tableLayout="fixed">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>{copy.makerMetricsPrice}</Table.ColumnHeader>
          <Table.ColumnHeader>{copy.makerMetricsQuantity}</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {levels.map((level) => (
          <Table.Row key={level.priceCoin}>
            <Table.Cell>{level.priceCoin}</Table.Cell>
            <Table.Cell overflowWrap="anywhere">{metricsCount(level.qty)}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}

export function MakerDepth({ depth }: { depth: AdminMarketMakerMetrics['depth'] }) {
  return (
    <Stack gap="3" data-testid="maker-metrics-depth">
      <Heading as="h4" size="sm">
        {copy.makerMetricsDepth}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.makerMetricsDepthHint}
      </Text>
      {(['bot', 'human'] as const).map((actor) => (
        <Stack key={actor} gap="3">
          <Text fontWeight="medium">
            {actor === 'bot' ? copy.makerMetricsBotDepth : copy.makerMetricsHumanDepth}
          </Text>
          <SimpleGrid columns={{ base: 1, md: 2 }} gap="3">
            {(['YES', 'NO'] as const).map((outcome) => (
              <Stack
                key={outcome}
                p="3"
                borderWidth="1px"
                borderRadius="l2"
                minW="0"
                data-testid={`maker-depth-${actor}-${outcome}`}
              >
                <Text fontWeight="medium">{outcome}</Text>
                <Text fontSize="sm">{copy.makerMetricsBid}</Text>
                <DepthLevels levels={depth[actor][outcome].bids} />
                <Text fontSize="sm">{copy.makerMetricsAsk}</Text>
                <DepthLevels levels={depth[actor][outcome].asks} />
              </Stack>
            ))}
          </SimpleGrid>
        </Stack>
      ))}
    </Stack>
  );
}

export function MakerConcentration({
  concentration,
}: {
  concentration: AdminMarketMakerMetrics['concentration'];
}) {
  const configured =
    concentration.setting.status !== 'undecided' && concentration.setting.value !== null;
  return (
    <Stack gap="3" data-testid="maker-metrics-concentration">
      <Heading as="h4" size="sm">
        {copy.makerMetricsConcentration}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.makerMetricsConcentrationHint}
      </Text>
      <MetricsFields
        fields={[[copy.makerMetricsTopN, formatReleaseSettingState(concentration.setting)]]}
      />
      {!configured && <Text>{copy.makerMetricsTopNUndecided}</Text>}
      {(['YES', 'NO'] as const).map((outcome) => {
        const side = concentration[outcome];
        const complete = configured && side.topQty !== null && side.holders !== null;
        return (
          <Stack key={outcome} gap="2" data-testid={`maker-concentration-${outcome}`}>
            <Text fontWeight="medium">{outcome}</Text>
            <MetricsFields fields={[[copy.makerMetricsTotalQty, metricsCount(side.totalQty)]]} />
            {configured && !complete && <Text>{copy.makerMetricsTopUnavailable}</Text>}
            {complete && (
              <>
                <MetricsFields
                  fields={[
                    [copy.makerMetricsTopQty, metricsCount(side.topQty!)],
                    [
                      copy.makerMetricsShare,
                      side.topShareBp === null ? '—' : metricsPercent(side.topShareBp),
                    ],
                  ]}
                />
                {side.holders!.length === 0 && (
                  <Text fontSize="sm">{copy.makerMetricsNoHolders}</Text>
                )}
                {side.holders!.map((holder) => (
                  <Stack key={holder.userId} gap="1" p="2" borderWidth="1px" borderRadius="l2">
                    <Link asChild>
                      <NextLink href={adminUserModerationPath(holder.userId) as Route}>
                        {nicknameShown(holder.nickname)}
                      </NextLink>
                    </Link>
                    <Text fontSize="sm">
                      {copy.makerMetricsQuantity}: {metricsCount(holder.qty)} ·{' '}
                      {copy.makerMetricsShare}: {metricsPercent(holder.shareBp)}
                    </Text>
                  </Stack>
                ))}
              </>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}
