'use client';

import {
  Alert,
  Badge,
  Button,
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
import { useAdminMarketPauseDecisions } from '@/hooks/use-admin-markets';
import { nicknameShown } from '@/lib/account-closure';
import { formatKst } from '@/lib/datetime';
import {
  MARKET_STATUS_LABEL,
  MARKET_STATUS_PALETTE,
  PAUSE_REASON_LABEL,
  PAUSE_REVIEW_RESULT_LABEL,
} from '@/lib/market-admin';
import { PAUSE_PATH_LABEL } from '@/lib/market-pause';

/**
 * 일시 중단 결정 대기 (#114, ADR-0102; ADR-0093 decision 1 #173 items 2·4): every next-path request of
 * a paused market waiting for another admin, the one waiting longest first, 20 per page with 더 보기
 * — on a market in any status, since a request still waiting at the close (the worker closes a
 * paused market on schedule, #173 item 3) ends only by its 반려 or 철회. The 승인·반려 is on each
 * market's detail, where the pause and its note are. One row per request: the question (to its
 * admin detail), the market's status, the pause's reason, the path asked for and the review result
 * ('—' without one), who asked and when, and the close, every time in KST. In a ScrollArea as the
 * other queues' tables are. A refresh that failed after rows exist keeps them under a notice with
 * 다시 시도; a 더 보기 that failed keeps them and says so above its button (`LoadMoreFailed`); only a
 * first read that failed shows the error.
 */
export function AdminMarketPauseDecisions() {
  const list = useAdminMarketPauseDecisions();
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack gap="4" data-testid="admin-market-pause-decisions">
      <Heading as="h3" size="lg">
        {copy.adminMarketPauseDecisions}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminMarketPauseDecisionsIntro}
      </Text>
      {list.isPending ? (
        <Skeleton height="24" />
      ) : list.isLoadingError ? (
        <Stack gap="2" align="flex-start">
          <Alert.Root status="error" role="alert" data-testid="admin-market-pause-decisions-error">
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
        <Text color="fg.muted" data-testid="admin-market-pause-decisions-empty">
          {copy.adminMarketPauseDecisionsEmpty}
        </Text>
      ) : (
        <Stack gap="3">
          {list.isRefetchError && (
            <Alert.Root
              status="warning"
              role="status"
              data-testid="admin-market-pause-decisions-stale"
            >
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
            <Table.Root size="sm" data-testid="admin-market-pause-decisions-list">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{copy.adminMarketPauseDecisionsColTitle}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketPauseDecisionsColStatus}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketPauseDecisionsColReason}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketPauseDecisionsColPath}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketPauseDecisionsColReview}</Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketPauseDecisionsColRequestedBy}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketPauseDecisionsColRequestedAt}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketPauseDecisionsColCloseAt}
                  </Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => (
                  <Table.Row
                    key={row.requestId}
                    data-testid={`admin-market-pause-decision-${row.requestId}`}
                    data-market={row.marketId}
                  >
                    <Table.Cell minW="48" wordBreak="break-word">
                      <ChakraLink asChild fontWeight="semibold">
                        <NextLink
                          href={`/admin/markets/${row.marketId}`}
                          data-testid={`admin-market-pause-decision-link-${row.requestId}`}
                        >
                          {row.title}
                        </NextLink>
                      </ChakraLink>
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap">
                      <Badge colorPalette={MARKET_STATUS_PALETTE[row.status]} variant="subtle">
                        {MARKET_STATUS_LABEL[row.status]}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell
                      whiteSpace="nowrap"
                      data-testid={`admin-market-pause-decision-reason-${row.requestId}`}
                    >
                      {PAUSE_REASON_LABEL[row.reason]}
                    </Table.Cell>
                    <Table.Cell
                      whiteSpace="nowrap"
                      data-testid={`admin-market-pause-decision-path-${row.requestId}`}
                    >
                      {PAUSE_PATH_LABEL[row.path]}
                    </Table.Cell>
                    <Table.Cell
                      whiteSpace="nowrap"
                      data-testid={`admin-market-pause-decision-review-${row.requestId}`}
                    >
                      {row.reviewResult === null
                        ? '—'
                        : PAUSE_REVIEW_RESULT_LABEL[row.reviewResult]}
                    </Table.Cell>
                    <Table.Cell
                      whiteSpace="nowrap"
                      data-testid={`admin-market-pause-decision-requested-by-${row.requestId}`}
                    >
                      {nicknameShown(row.requestedBy.nickname)}
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap">{formatKst(row.requestedAt)}</Table.Cell>
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
                data-testid="admin-market-pause-decisions-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                data-testid="admin-market-pause-decisions-more"
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
