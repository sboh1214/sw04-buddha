'use client';

import {
  Alert,
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
import { useAdminMarketReviews } from '@/hooks/use-admin-markets';
import { nicknameShown } from '@/lib/account-closure';
import { formatKst } from '@/lib/datetime';

/**
 * 검수 대기 (#78, ADR-0099; ADR-0093 decision 2 #172 item 5): every market in REVIEW with its pending
 * request, the one waiting longest first, 20 per page with 더 보기 — the 승인·반려 of the queue is on
 * each market's detail, where the checklist is. One row per market: the question (to its admin
 * detail), the category, who submitted it and when, who made it, the scheduled open and the close,
 * every time in KST as on every admin screen. In a ScrollArea so the seven columns scroll sideways
 * inside the page at 375px rather than widening it. A refresh that failed after rows exist keeps
 * them under a notice with 다시 시도; a 더 보기 that failed keeps them and says so above its button
 * (`LoadMoreFailed`, owner decision 2026-10-20 7); only a first read that failed shows the error.
 */
export function AdminMarketReviews() {
  const list = useAdminMarketReviews();
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack gap="4" data-testid="admin-market-reviews">
      <Heading as="h3" size="lg">
        {copy.adminMarketReviews}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminMarketReviewsIntro}
      </Text>
      {list.isPending ? (
        <Skeleton height="24" />
      ) : list.isLoadingError ? (
        <Stack gap="2" align="flex-start">
          <Alert.Root status="error" role="alert" data-testid="admin-market-reviews-error">
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
        <Text color="fg.muted" data-testid="admin-market-reviews-empty">
          {copy.adminMarketReviewsEmpty}
        </Text>
      ) : (
        <Stack gap="3">
          {list.isRefetchError && (
            <Alert.Root status="warning" role="status" data-testid="admin-market-reviews-stale">
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
            <Table.Root size="sm" data-testid="admin-market-reviews-list">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{copy.adminMarketReviewsColTitle}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketReviewsColCategory}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketReviewsColRequestedBy}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketReviewsColRequestedAt}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketReviewsColCreatedBy}</Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketReviewsColScheduledOpenAt}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketReviewsColCloseAt}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {/* Keyed by the request (its market and time): a market sent back and submitted
                    again while the list is open is a new row on a later page. */}
                {rows.map((row) => (
                  <Table.Row
                    key={`${row.marketId}:${row.requestedAt}`}
                    data-testid={`admin-market-review-${row.marketId}`}
                  >
                    <Table.Cell minW="48" wordBreak="break-word">
                      <ChakraLink asChild fontWeight="semibold">
                        <NextLink
                          href={`/admin/markets/${row.marketId}`}
                          data-testid={`admin-market-review-link-${row.marketId}`}
                        >
                          {row.title}
                        </NextLink>
                      </ChakraLink>
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap">{row.categoryName}</Table.Cell>
                    <Table.Cell
                      whiteSpace="nowrap"
                      data-testid={`admin-market-review-requested-by-${row.marketId}`}
                    >
                      {nicknameShown(row.requestedBy.nickname)}
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap">{formatKst(row.requestedAt)}</Table.Cell>
                    <Table.Cell
                      whiteSpace="nowrap"
                      data-testid={`admin-market-review-created-by-${row.marketId}`}
                    >
                      {nicknameShown(row.createdBy.nickname)}
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap">
                      {row.scheduledOpenAt === null ? '—' : formatKst(row.scheduledOpenAt)}
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
                data-testid="admin-market-reviews-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                data-testid="admin-market-reviews-more"
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
