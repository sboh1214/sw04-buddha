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
import { useAdminMarketCancelRequests } from '@/hooks/use-admin-markets';
import { nicknameShown } from '@/lib/account-closure';
import { formatKst } from '@/lib/datetime';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';

/**
 * 시장 취소 대기 (#20, ADR-0117; ADR-0107 결정 5 '#20 운영자의 취소 경로'): every cancel request of a
 * SCHEDULED market waiting for another admin, the one waiting longest first, 20 per page with 더
 * 보기 — on a market in any status, since a request whose market opened or went back to a draft
 * meanwhile ends only by its 반려 or 철회. The 승인·반려 is on each market's detail. One row per
 * request: the question (to its admin detail), the market's status, the request's reason (the
 * cancel's public one), who asked and when, and the scheduled open ('—' without one), every time in
 * KST. Errors and 더 보기 as the 일시 중단 결정 대기 queue's.
 */
export function AdminMarketCancelRequests() {
  const list = useAdminMarketCancelRequests();
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack gap="4" data-testid="admin-market-cancel-requests">
      <Heading as="h3" size="lg">
        {copy.adminMarketCancelRequests}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminMarketCancelRequestsIntro}
      </Text>
      {list.isPending ? (
        <Skeleton height="24" />
      ) : list.isLoadingError ? (
        <Stack gap="2" align="flex-start">
          <Alert.Root status="error" role="alert" data-testid="admin-market-cancel-requests-error">
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
        <Text color="fg.muted" data-testid="admin-market-cancel-requests-empty">
          {copy.adminMarketCancelRequestsEmpty}
        </Text>
      ) : (
        <Stack gap="3">
          {list.isRefetchError && (
            <Alert.Root
              status="warning"
              role="status"
              data-testid="admin-market-cancel-requests-stale"
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
            <Table.Root size="sm" data-testid="admin-market-cancel-requests-list">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{copy.adminMarketPauseDecisionsColTitle}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketPauseDecisionsColStatus}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketCancelReason}</Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketPauseDecisionsColRequestedBy}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketPauseDecisionsColRequestedAt}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketCancelRequestsColOpenAt}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => (
                  <Table.Row
                    key={row.requestId}
                    data-testid={`admin-market-cancel-request-${row.requestId}`}
                    data-market={row.marketId}
                  >
                    <Table.Cell minW="48" wordBreak="break-word">
                      <ChakraLink asChild fontWeight="semibold">
                        <NextLink
                          href={`/admin/markets/${row.marketId}`}
                          data-testid={`admin-market-cancel-request-link-${row.requestId}`}
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
                      minW="48"
                      whiteSpace="pre-wrap"
                      wordBreak="break-word"
                      data-testid={`admin-market-cancel-request-reason-${row.requestId}`}
                    >
                      {row.reason}
                    </Table.Cell>
                    <Table.Cell
                      whiteSpace="nowrap"
                      data-testid={`admin-market-cancel-request-requested-by-${row.requestId}`}
                    >
                      {nicknameShown(row.requestedBy.nickname)}
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap">{formatKst(row.requestedAt)}</Table.Cell>
                    <Table.Cell
                      whiteSpace="nowrap"
                      data-testid={`admin-market-cancel-request-open-at-${row.requestId}`}
                    >
                      {row.scheduledOpenAt === null ? '—' : formatKst(row.scheduledOpenAt)}
                    </Table.Cell>
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
                data-testid="admin-market-cancel-requests-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                data-testid="admin-market-cancel-requests-more"
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
