'use client';

import { Badge, HStack, Link as ChakraLink, Stack, Table, Text } from '@chakra-ui/react';
import { type OperationsJudgementFilter } from '@buddha/shared';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { useAdminOperationsJudgements } from '@/hooks/use-admin-operations';
import { disputeHoldingText } from '@/lib/admin-disputes';
import {
  ADMIN_DISPUTES_QUEUE_PATH,
  ADMIN_JUDGEMENT_APPROVALS_PATH,
  ADMIN_OPERATIONS_LIST_TEXT,
  OPERATIONS_STAGE_LABEL,
  adminMarketPath,
  judgementRowLinks,
  noDelayRecordText,
  shownLongDelayDeadline,
} from '@/lib/admin-operations';
import { type AdminAwaitingJudgementMarket } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import { OperationsQueue } from './operations-queue';

const PREFIX = 'admin-operations-judgement';

/**
 * 판정 대기·지연 (#145, ADR-0163; 145-2, 145-11, 145-17; ADR-0093 결정 1 #173 11항, ADR-0106): one
 * list by scheduled judgement (none last) — every 거래 마감 market and every 잠정 결과 market a
 * dispute or a correction holds past its 이의 기한, which reads '판정 지연' by definition — every
 * row or the delayed ones ('지연만'). Each row: its question (to its admin detail, where the 판정 칸
 * and the 지연 기록 dialog are), its status and stage (판정 등록 전 · 판정 승인 대기 · 이의·정정 대기),
 * '판정 지연' when it reads so, the scheduled judgement, the current episode's 지연 사유 and 다음 검토
 * (갱신 대기 once that has passed, ADR-0106 결정 10-2), and on a 거래 마감 row the 장기 지연 기한 and
 * whether it was reached (145-17). Approval stays where it is (145-2): a waiting registration or
 * correction links to 판정 승인 대기, a holding dispute to 이의 접수. Reaching any of these times
 * changes nothing (AC 3): the list only reads.
 */
export function OperationsJudgements({ filter }: { filter: OperationsJudgementFilter }) {
  const list = useAdminOperationsJudgements(filter);
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <OperationsQueue
      prefix="admin-operations-judgements"
      title={ADMIN_OPERATIONS_LIST_TEXT.judgements.label}
      empty={ADMIN_OPERATIONS_LIST_TEXT.judgements.empty}
      list={list}
      count={rows.length}
      header={
        <Table.Row>
          <Table.ColumnHeader>{copy.adminMarketJudgementsColTitle}</Table.ColumnHeader>
          <Table.ColumnHeader>{copy.adminMarketJudgementsColStatus}</Table.ColumnHeader>
          <Table.ColumnHeader>
            {copy.adminMarketJudgementsColScheduledJudgementAt}
          </Table.ColumnHeader>
          <Table.ColumnHeader>{copy.adminOperationsDelayReason}</Table.ColumnHeader>
          <Table.ColumnHeader>{copy.adminMarketJudgementLongDelayDeadline}</Table.ColumnHeader>
        </Table.Row>
      }
    >
      {rows.map((row) => (
        <JudgementRow key={row.id} row={row} />
      ))}
    </OperationsQueue>
  );
}

function JudgementRow({ row }: { row: AdminAwaitingJudgementMarket }) {
  const links = judgementRowLinks(row);
  const longDelayDeadline = shownLongDelayDeadline(row);
  return (
    <Table.Row
      data-testid={`${PREFIX}-${row.id}`}
      data-market={row.id}
      data-stage={row.stage}
      data-delayed={row.delayed ? 'true' : 'false'}
    >
      <Table.Cell minW="48" wordBreak="break-word">
        <Stack gap="1">
          <ChakraLink asChild fontWeight="semibold">
            <NextLink href={adminMarketPath(row.id)} data-testid={`${PREFIX}-link-${row.id}`}>
              {row.title}
            </NextLink>
          </ChakraLink>
          {(links.approvals || links.disputes) && (
            <HStack gap="3" flexWrap="wrap" fontSize="sm">
              {links.approvals && (
                <ChakraLink asChild colorPalette="brand" color="colorPalette.fg">
                  <NextLink
                    href={ADMIN_JUDGEMENT_APPROVALS_PATH}
                    data-testid={`${PREFIX}-to-approvals-${row.id}`}
                  >
                    {copy.adminOperationsToApprovals}
                  </NextLink>
                </ChakraLink>
              )}
              {links.disputes && (
                <ChakraLink asChild colorPalette="brand" color="colorPalette.fg">
                  <NextLink
                    href={ADMIN_DISPUTES_QUEUE_PATH}
                    data-testid={`${PREFIX}-to-disputes-${row.id}`}
                  >
                    {copy.adminOperationsToDisputes}
                  </NextLink>
                </ChakraLink>
              )}
            </HStack>
          )}
        </Stack>
      </Table.Cell>
      <Table.Cell>
        <Stack gap="1" align="flex-start">
          <HStack gap="2" flexWrap="wrap">
            <Badge colorPalette={MARKET_STATUS_PALETTE[row.status]} variant="subtle">
              {MARKET_STATUS_LABEL[row.status]}
            </Badge>
            <Badge
              colorPalette="gray"
              variant="outline"
              whiteSpace="nowrap"
              data-testid={`${PREFIX}-stage-${row.id}`}
            >
              {OPERATIONS_STAGE_LABEL[row.stage]}
            </Badge>
            {row.delayed && (
              <Badge
                colorPalette="orange"
                variant="solid"
                whiteSpace="nowrap"
                data-testid={`${PREFIX}-delayed-${row.id}`}
              >
                {copy.adminOperationsDelayed}
              </Badge>
            )}
          </HStack>
          {row.status === 'provisional' && (
            <Text fontSize="sm" color="fg.muted" data-testid={`${PREFIX}-holds-${row.id}`}>
              {row.disputeDeadline !== null &&
                `${copy.marketDisputeDeadline} ${formatKst(row.disputeDeadline)}`}
              {row.holdingDisputes > 0 &&
                `${row.disputeDeadline !== null ? ' · ' : ''}${disputeHoldingText(row.holdingDisputes)}`}
            </Text>
          )}
        </Stack>
      </Table.Cell>
      <Table.Cell whiteSpace="nowrap" data-testid={`${PREFIX}-scheduled-${row.id}`}>
        {row.scheduledJudgementAt === null ? '—' : formatKst(row.scheduledJudgementAt)}
      </Table.Cell>
      <Table.Cell minW="48" data-testid={`${PREFIX}-delay-${row.id}`}>
        {row.delay === null ? (
          <Text fontSize="sm" color="fg.muted" data-testid={`${PREFIX}-no-delay-${row.id}`}>
            {noDelayRecordText(row)}
          </Text>
        ) : (
          <Stack gap="1">
            <Text
              fontSize="sm"
              whiteSpace="pre-wrap"
              wordBreak="break-word"
              data-testid={`${PREFIX}-delay-reason-${row.id}`}
            >
              {row.delay.reason}
            </Text>
            <HStack gap="2" flexWrap="wrap">
              <Text
                fontSize="sm"
                color="fg.muted"
                whiteSpace="nowrap"
                data-testid={`${PREFIX}-next-review-${row.id}`}
              >
                {copy.adminOperationsNextReview} {formatKst(row.delay.nextReviewAt)}
              </Text>
              {row.reviewOverdue && (
                <Badge
                  colorPalette="orange"
                  variant="subtle"
                  whiteSpace="nowrap"
                  data-testid={`${PREFIX}-review-overdue-${row.id}`}
                >
                  {copy.adminOperationsReviewOverdue}
                </Badge>
              )}
            </HStack>
          </Stack>
        )}
      </Table.Cell>
      <Table.Cell whiteSpace="nowrap" data-testid={`${PREFIX}-long-delay-${row.id}`}>
        {longDelayDeadline === null ? (
          '—'
        ) : (
          <HStack gap="2">
            <Text as="span">{formatKst(longDelayDeadline)}</Text>
            {row.longDelayReached && (
              <Badge
                colorPalette="orange"
                variant="solid"
                data-testid={`${PREFIX}-long-delay-reached-${row.id}`}
              >
                {copy.adminOperationsLongDelayReached}
              </Badge>
            )}
          </HStack>
        )}
      </Table.Cell>
    </Table.Row>
  );
}
