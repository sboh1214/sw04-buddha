'use client';

import { Badge, HStack, Link as ChakraLink, Table, Text } from '@chakra-ui/react';
import { type OperationsClosingWindow } from '@buddha/shared';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { useAdminOperationsClosing } from '@/hooks/use-admin-operations';
import { ADMIN_OPERATIONS_LIST_TEXT, adminMarketPath } from '@/lib/admin-operations';
import { formatKst } from '@/lib/datetime';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import { OperationsQueue } from './operations-queue';

const PREFIX = 'admin-operations-closing';

/**
 * 마감 예정 (#145, ADR-0163; 145-1): the OPEN and PAUSED markets whose scheduled close is within the
 * window picked (24시간·3일·7일, 24시간 first), the nearest first — PAUSED ones too, since 145-3 keeps
 * no list of its own for them. A market whose close time has passed and whose close has not run
 * stays on top marked '마감 시각 지남' (145-18): no lower bound, so it is never out of sight in the
 * 30 minutes before it is also 처리 멈춤. Each row is its question (to its admin detail, where the
 * close and the pause are), its status, the close and the scheduled judgement in KST.
 */
export function OperationsClosing({ within }: { within: OperationsClosingWindow }) {
  const list = useAdminOperationsClosing(within);
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <OperationsQueue
      prefix={PREFIX}
      title={ADMIN_OPERATIONS_LIST_TEXT.closing.label}
      empty={ADMIN_OPERATIONS_LIST_TEXT.closing.empty}
      list={list}
      count={rows.length}
      header={
        <Table.Row>
          <Table.ColumnHeader>{copy.adminMarketJudgementsColTitle}</Table.ColumnHeader>
          <Table.ColumnHeader>{copy.adminMarketJudgementsColStatus}</Table.ColumnHeader>
          <Table.ColumnHeader>{copy.adminMarketJudgementsColCloseAt}</Table.ColumnHeader>
          <Table.ColumnHeader>
            {copy.adminMarketJudgementsColScheduledJudgementAt}
          </Table.ColumnHeader>
        </Table.Row>
      }
    >
      {rows.map((row) => (
        <Table.Row
          key={row.id}
          data-testid={`${PREFIX}-${row.id}`}
          data-market={row.id}
          data-overdue={row.overdue ? 'true' : 'false'}
        >
          <Table.Cell minW="48" wordBreak="break-word">
            <ChakraLink asChild fontWeight="semibold">
              <NextLink href={adminMarketPath(row.id)} data-testid={`${PREFIX}-link-${row.id}`}>
                {row.title}
              </NextLink>
            </ChakraLink>
          </Table.Cell>
          <Table.Cell whiteSpace="nowrap">
            <HStack gap="2">
              <Badge colorPalette={MARKET_STATUS_PALETTE[row.status]} variant="subtle">
                {MARKET_STATUS_LABEL[row.status]}
              </Badge>
              {row.overdue && (
                <Badge
                  colorPalette="orange"
                  variant="solid"
                  data-testid={`${PREFIX}-overdue-${row.id}`}
                >
                  {copy.adminOperationsOverdue}
                </Badge>
              )}
            </HStack>
          </Table.Cell>
          <Table.Cell whiteSpace="nowrap" data-testid={`${PREFIX}-close-at-${row.id}`}>
            {formatKst(row.closeAt) || '—'}
          </Table.Cell>
          <Table.Cell whiteSpace="nowrap">
            <Text as="span">
              {row.scheduledJudgementAt === null ? '—' : formatKst(row.scheduledJudgementAt)}
            </Text>
          </Table.Cell>
        </Table.Row>
      ))}
    </OperationsQueue>
  );
}
