'use client';

import {
  Alert,
  Badge,
  Button,
  HStack,
  Heading,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Table,
  Text,
} from '@chakra-ui/react';
import NextLink from 'next/link';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useAdminMarketJudgements } from '@/hooks/use-admin-markets';
import { nicknameShown } from '@/lib/account-closure';
import { formatKst } from '@/lib/datetime';
import {
  MARKET_RESULT_LABEL,
  MARKET_STATUS_LABEL,
  MARKET_STATUS_PALETTE,
  judgementVersionMove,
} from '@/lib/market-admin';
import { judgementEarly } from '@/lib/market-judgement';

/**
 * 판정 승인 대기 (#152, ADR-0103; ADR-0093 decision 1 #173 item 1, decision 3 the #152 rows): every
 * judgement registration waiting for another admin, the one waiting longest first, 20 per page
 * with 더 보기 — on a market in any status, since one still waiting once the market moved on ends
 * only by its 반려 or 철회. The 승인·반려 is on each market's detail, where the source, the evidence
 * and what was confirmed are — and no market price (#152 AC 8). One row per registration: the
 * question (to its admin detail), the market's status — and, for a 판정 정정 (#176, ADR-0105: the
 * same approval kind), '판정 정정 v1 → v2' beside it — the result registered, who registered it
 * and when, the scheduled judgement (marked 예정 판정 전 while it is still ahead: the approver then
 * confirms the event deadline, decision 3 '등록 시점') and the close, every time in KST. In a
 * ScrollArea as the other queues' tables are. A refresh that failed after rows exist keeps them
 * under a notice with 다시 시도; a 더 보기 that failed keeps them and says so above its button
 * (`LoadMoreFailed`); only a first read that failed shows the error.
 */
export function AdminMarketJudgements() {
  const list = useAdminMarketJudgements();
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack gap="4" data-testid="admin-market-judgements">
      <Heading as="h3" size="lg">
        {copy.adminMarketJudgements}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminMarketJudgementsIntro}
      </Text>
      {list.isPending ? (
        <Skeleton height="24" />
      ) : list.isLoadingError ? (
        <Stack gap="2" align="flex-start">
          <Alert.Root status="error" role="alert" data-testid="admin-market-judgements-error">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : rows.length === 0 ? (
        <Text color="fg.muted" data-testid="admin-market-judgements-empty">
          {copy.adminMarketJudgementsEmpty}
        </Text>
      ) : (
        <Stack gap="3">
          {list.isRefetchError && (
            <Alert.Root status="warning" role="status" data-testid="admin-market-judgements-stale">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.adminMarketRefreshFailed}</Alert.Description>
              </Alert.Content>
              <Button size="xs" variant="outline" ml="auto" onClick={() => void list.refetch()}>
                {copy.retry}
              </Button>
            </Alert.Root>
          )}
          <Table.ScrollArea borderWidth="1px" borderRadius="l2">
            <Table.Root size="sm" data-testid="admin-market-judgements-list">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{copy.adminMarketJudgementsColTitle}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketJudgementsColStatus}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketJudgementsColResult}</Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketJudgementsColRequestedBy}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketJudgementsColRequestedAt}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketJudgementsColScheduledJudgementAt}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketJudgementsColCloseAt}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => (
                  <Table.Row
                    key={row.requestId}
                    data-testid={`admin-market-judgement-${row.requestId}`}
                    data-market={row.marketId}
                  >
                    <Table.Cell minW="48" wordBreak="break-word">
                      <ChakraLink asChild fontWeight="semibold">
                        <NextLink
                          href={`/admin/markets/${row.marketId}`}
                          data-testid={`admin-market-judgement-link-${row.requestId}`}
                        >
                          {row.title}
                        </NextLink>
                      </ChakraLink>
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap">
                      <HStack gap="2">
                        <Badge colorPalette={MARKET_STATUS_PALETTE[row.status]} variant="subtle">
                          {MARKET_STATUS_LABEL[row.status]}
                        </Badge>
                        {row.correction !== null && (
                          <Badge
                            colorPalette="orange"
                            variant="outline"
                            data-testid={`admin-market-judgement-correction-${row.requestId}`}
                          >
                            {copy.adminMarketJudgementsCorrection}{' '}
                            {judgementVersionMove(row.correction.baseVersion)}
                          </Badge>
                        )}
                      </HStack>
                    </Table.Cell>
                    <Table.Cell
                      whiteSpace="nowrap"
                      data-testid={`admin-market-judgement-result-${row.requestId}`}
                    >
                      {MARKET_RESULT_LABEL[row.result]}
                    </Table.Cell>
                    <Table.Cell
                      whiteSpace="nowrap"
                      data-testid={`admin-market-judgement-requested-by-${row.requestId}`}
                    >
                      {nicknameShown(row.requestedBy.nickname)}
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap">{formatKst(row.requestedAt)}</Table.Cell>
                    <Table.Cell
                      whiteSpace="nowrap"
                      data-testid={`admin-market-judgement-scheduled-${row.requestId}`}
                    >
                      <HStack gap="2">
                        <Text as="span">
                          {row.scheduledJudgementAt === null
                            ? '—'
                            : formatKst(row.scheduledJudgementAt)}
                        </Text>
                        {judgementEarly(row) && (
                          <Badge
                            colorPalette="orange"
                            variant="subtle"
                            data-testid={`admin-market-judgement-early-${row.requestId}`}
                          >
                            {copy.adminMarketJudgementsEarly}
                          </Badge>
                        )}
                      </HStack>
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap">{formatKst(row.closeAt)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Table.ScrollArea>
          {list.hasNextPage && (
            <>
              <LoadMoreFailed
                list={list}
                message={copy.errUnknown}
                data-testid="admin-market-judgements-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                data-testid="admin-market-judgements-more"
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
}
