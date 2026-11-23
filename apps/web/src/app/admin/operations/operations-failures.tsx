'use client';

import { Badge, Button, HStack, Link as ChakraLink, Stack, Table, Text } from '@chakra-ui/react';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { useAdminOperationsFailures } from '@/hooks/use-admin-operations';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import {
  ADMIN_LEDGER_HOLDS_PATH,
  ADMIN_OPERATIONS_LIST_TEXT,
  OPERATIONS_KIND_LABEL,
  OPERATIONS_RECALL_REASON_TEXT,
  adminMarketPath,
  adminMarketRecallPath,
  attemptsText,
  stuckSinceText,
  stuckStageText,
} from '@/lib/admin-operations';
import { type AdminOperationsFailure } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import { OperationsQueue } from './operations-queue';
import {
  LastErrorText,
  SettlementRetryDialog,
  type SettlementRetryTarget,
} from './settlement-retry-dialog';

const PREFIX = 'admin-operations-failure';

/**
 * 정산 실패 (#145, ADR-0163; 145-4, 145-6, 145-8, 145-14, 145-15; ADR-0118, ADR-0121, ADR-0125): one
 * list, the oldest problem first, of three kinds —
 * - 정산 실패: a 지급 중 market the public detail marks '지급 지연' (a failed step, a step with an
 *   error, a ledger hold), with its attempts, last attempt and last error as stored (145-6, 145-18)
 *   and, under a ledger hold, '대사 보류' with the way to /admin/audit-failures;
 * - 처리 멈춤: an automatic transition (거래 마감·결과 확정·지급 시작·지급 완료) due 30 minutes ago and not
 *   come (145-4), when it was due;
 * - 봇 자금 회수 실패: a recall whose last observation failed (145-15), with its attempts, its code in
 *   the market maker panel's words and a link to that panel's 회수 칸 — no button (145-8).
 * '정산 다시 시도' is on the 지급 중 rows alone (145-14: 정산 실패 and '처리 멈춤 · 지급 완료'), its
 * dialog held for the admin who opened it (`useHeldForOperator`, ADR-0092 answer 1) and off until
 * that admin is known.
 */
export function OperationsFailures() {
  const operatorId = useOperatorId();
  const [retrying, setRetrying] = useHeldForOperator<SettlementRetryTarget>();
  const list = useAdminOperationsFailures();
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <OperationsQueue
        prefix="admin-operations-failures"
        title={ADMIN_OPERATIONS_LIST_TEXT.failures.label}
        empty={ADMIN_OPERATIONS_LIST_TEXT.failures.empty}
        list={list}
        count={rows.length}
        header={
          <Table.Row>
            <Table.ColumnHeader>{copy.adminMarketJudgementsColTitle}</Table.ColumnHeader>
            <Table.ColumnHeader>{copy.adminMarketJudgementsColStatus}</Table.ColumnHeader>
            <Table.ColumnHeader>{copy.adminOperationsColDetail}</Table.ColumnHeader>
          </Table.Row>
        }
      >
        {rows.map((row) => (
          <Table.Row
            key={`${row.kind}-${row.id}`}
            data-testid={`${PREFIX}-${row.kind}-${row.id}`}
            data-market={row.id}
            data-kind={row.kind}
          >
            <Table.Cell minW="48" wordBreak="break-word">
              <ChakraLink asChild fontWeight="semibold">
                <NextLink
                  href={adminMarketPath(row.id)}
                  data-testid={`${PREFIX}-link-${row.kind}-${row.id}`}
                >
                  {row.title}
                </NextLink>
              </ChakraLink>
            </Table.Cell>
            <Table.Cell>
              <HStack gap="2" flexWrap="wrap">
                <Badge colorPalette={MARKET_STATUS_PALETTE[row.status]} variant="subtle">
                  {MARKET_STATUS_LABEL[row.status]}
                </Badge>
                <Badge
                  colorPalette="no"
                  variant="solid"
                  whiteSpace="nowrap"
                  data-testid={`${PREFIX}-kind-${row.kind}-${row.id}`}
                >
                  {row.kind === 'stuck'
                    ? stuckStageText(row.stage)
                    : OPERATIONS_KIND_LABEL[row.kind]}
                </Badge>
              </HStack>
            </Table.Cell>
            <Table.Cell minW="64">
              <Stack gap="2" align="flex-start">
                <FailureDetail row={row} />
                {row.retryable && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={operatorId === undefined}
                    onClick={() => setRetrying({ id: row.id, title: row.title })}
                    data-testid={`${PREFIX}-retry-${row.id}`}
                  >
                    {copy.adminSettlementRetry}
                  </Button>
                )}
              </Stack>
            </Table.Cell>
          </Table.Row>
        ))}
      </OperationsQueue>
      {retrying !== null && (
        <SettlementRetryDialog market={retrying} onClose={() => setRetrying(null)} />
      )}
    </>
  );
}

/** A 정산 실패 row's own facts, by kind. */
function FailureDetail({ row }: { row: AdminOperationsFailure }) {
  const prefix = `${PREFIX}-${row.kind}-${row.id}`;
  if (row.kind === 'stuck') {
    return (
      <Text fontSize="sm" data-testid={`${prefix}-since`}>
        {stuckSinceText(row.since)}
      </Text>
    );
  }
  if (row.kind === 'recall_failed') {
    return (
      <Stack gap="1">
        <Text fontSize="sm" data-testid={`${prefix}-attempts`}>
          {attemptsText(row.recall.recallAttempts)}
          {row.recall.lastFailureAt !== null &&
            ` · ${copy.marketMakerRecallLastFailure} ${formatKst(row.recall.lastFailureAt)}`}
        </Text>
        <Text fontSize="sm" data-testid={`${prefix}-reason`}>
          {OPERATIONS_RECALL_REASON_TEXT[row.recall.recallReason]}
        </Text>
        <ChakraLink asChild fontSize="sm" colorPalette="brand" color="colorPalette.fg">
          <NextLink href={adminMarketRecallPath(row.id)} data-testid={`${prefix}-to-recall`}>
            {copy.adminOperationsToRecall}
          </NextLink>
        </ChakraLink>
      </Stack>
    );
  }
  const { settlement } = row;
  return (
    <Stack gap="1">
      <HStack gap="2" flexWrap="wrap">
        <Text fontSize="sm" data-testid={`${prefix}-attempts`}>
          {attemptsText(settlement.settlementAttempts)}
          {settlement.lastAttemptAt !== null &&
            ` · ${copy.adminOperationsLastAttempt} ${formatKst(settlement.lastAttemptAt)}`}
        </Text>
        {settlement.ledgerHeld && (
          <Badge colorPalette="orange" variant="subtle" data-testid={`${prefix}-ledger-held`}>
            {copy.adminOperationsLedgerHeld}
          </Badge>
        )}
      </HStack>
      {settlement.settlementLastError !== null && (
        <LastErrorText error={settlement.settlementLastError} testId={`${prefix}-error`} />
      )}
      {settlement.ledgerHeld && (
        <ChakraLink asChild fontSize="sm" colorPalette="brand" color="colorPalette.fg">
          <NextLink href={ADMIN_LEDGER_HOLDS_PATH} data-testid={`${prefix}-to-ledger`}>
            {copy.adminOperationsToLedger}
          </NextLink>
        </ChakraLink>
      )}
    </Stack>
  );
}
