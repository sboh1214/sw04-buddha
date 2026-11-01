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
import { useAdminMarketSupplements } from '@/hooks/use-admin-markets';
import { nicknameShown } from '@/lib/account-closure';
import { formatKst } from '@/lib/datetime';
import {
  MARKET_STATUS_LABEL,
  MARKET_STATUS_PALETTE,
  ruleVersionItemList,
} from '@/lib/market-admin';
import { ruleVersionName } from '@/lib/rule-versions';

/**
 * 규칙 보충 대기 (#80, ADR-0101; ADR-0093 decision 2 #172 item 15): every supplement request waiting
 * for another admin, the one waiting longest first, 20 per page with 더 보기 — on a market in any
 * status, since a request still waiting at the close ends only by its 반려 or 철회. The 승인·반려 is
 * on each market's detail, where the old and new texts are. One row per request: the question (to
 * its admin detail), the market's status, who asked and when, the version it was written against,
 * the items it changes and the close, every time in KST. In a ScrollArea as the 검수 대기 table is.
 * A refresh that failed after rows exist keeps them under a notice with 다시 시도; a 더 보기 that
 * failed keeps them and says so above its button (`LoadMoreFailed`); only a first read that failed
 * shows the error.
 */
export function AdminMarketSupplements() {
  const list = useAdminMarketSupplements();
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack gap="4" data-testid="admin-market-supplements">
      <Heading as="h3" size="lg">
        {copy.adminMarketSupplements}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminMarketSupplementsIntro}
      </Text>
      {list.isPending ? (
        <Skeleton height="24" />
      ) : list.isLoadingError ? (
        <Stack gap="2" align="flex-start">
          <Alert.Root status="error" role="alert" data-testid="admin-market-supplements-error">
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
        <Text color="fg.muted" data-testid="admin-market-supplements-empty">
          {copy.adminMarketSupplementsEmpty}
        </Text>
      ) : (
        <Stack gap="3">
          {list.isRefetchError && (
            <Alert.Root status="warning" role="status" data-testid="admin-market-supplements-stale">
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
            <Table.Root size="sm" data-testid="admin-market-supplements-list">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{copy.adminMarketSupplementsColTitle}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketSupplementsColStatus}</Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketSupplementsColRequestedBy}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketSupplementsColRequestedAt}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketSupplementsColBase}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketSupplementsColItems}</Table.ColumnHeader>
                  <Table.ColumnHeader>{copy.adminMarketSupplementsColCloseAt}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => (
                  <Table.Row
                    key={row.requestId}
                    data-testid={`admin-market-supplement-${row.requestId}`}
                    data-market={row.marketId}
                  >
                    <Table.Cell minW="48" wordBreak="break-word">
                      <ChakraLink asChild fontWeight="semibold">
                        <NextLink
                          href={`/admin/markets/${row.marketId}`}
                          data-testid={`admin-market-supplement-link-${row.requestId}`}
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
                      data-testid={`admin-market-supplement-requested-by-${row.requestId}`}
                    >
                      {nicknameShown(row.requestedBy.nickname)}
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap">{formatKst(row.requestedAt)}</Table.Cell>
                    <Table.Cell whiteSpace="nowrap">{ruleVersionName(row.baseVersion)}</Table.Cell>
                    <Table.Cell
                      minW="40"
                      data-testid={`admin-market-supplement-items-${row.requestId}`}
                    >
                      {ruleVersionItemList(row.items)}
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
                data-testid="admin-market-supplements-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                data-testid="admin-market-supplements-more"
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
