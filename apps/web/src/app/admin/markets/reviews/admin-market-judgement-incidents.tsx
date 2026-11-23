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
import { useAdminMarketJudgementIncidents } from '@/hooks/use-admin-markets';
import { nicknameShown } from '@/lib/account-closure';
import {
  ANCHOR_SCROLL_MARGIN_TOP,
  MARKET_JUDGEMENT_INCIDENTS_ANCHOR,
} from '@/lib/admin-operations';
import { formatKst } from '@/lib/datetime';
import {
  MARKET_RESULT_LABEL,
  MARKET_STATUS_LABEL,
  MARKET_STATUS_PALETTE,
} from '@/lib/market-admin';

/**
 * 판정 오류 사건 검토 대기 (#144 part 1, ADR-0165; 144-3, 144-4, 144-13): every 판정 오류 사건 waiting
 * for another admin's 오류 확인 or 기각, the one waiting longest first, 20 per page with 더 보기 —
 * after 판정 승인 대기 on 검수 대기. The decision is on each market's detail, where the description,
 * the evidence and the exclusions are. One row per incident: the question (to its admin detail),
 * the market's status (a 오류 확인 waits for 지급 완료, 144-13), the paid result and the correct
 * one, who registered it and when, every time in KST. No polling (ADR-0138): every admin write to a
 * market asks it again (`invalidateMarket`). A refresh that failed after rows exist keeps them
 * under a notice with 다시 시도; a 더 보기 that failed keeps them and says so above its button
 * (`LoadMoreFailed`); only a first read that failed shows the error.
 */
export function AdminMarketJudgementIncidents() {
  const list = useAdminMarketJudgementIncidents();
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack
      gap="4"
      id={MARKET_JUDGEMENT_INCIDENTS_ANCHOR}
      scrollMarginTop={ANCHOR_SCROLL_MARGIN_TOP}
      data-testid="admin-market-judgement-incidents"
    >
      <Heading as="h3" size="lg">
        {copy.adminMarketJudgementIncidents}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminMarketJudgementIncidentsIntro}
      </Text>
      {list.isPending ? (
        <Skeleton height="24" />
      ) : list.isLoadingError ? (
        <Stack gap="2" align="flex-start">
          <Alert.Root status="error" role="alert" data-testid="admin-judgement-incidents-error">
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
        <Text color="fg.muted" data-testid="admin-market-judgement-incidents-empty">
          {copy.adminMarketJudgementIncidentsEmpty}
        </Text>
      ) : (
        <Stack gap="3">
          {list.isRefetchError && (
            <Alert.Root
              status="warning"
              role="status"
              data-testid="admin-market-judgement-incidents-stale"
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
            <Table.Root size="sm" data-testid="admin-market-judgement-incidents-list">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>
                    {copy.adminMarketJudgementIncidentsColTitle}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketJudgementIncidentsColStatus}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketJudgementIncidentsColOriginal}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketJudgementIncidentsColCorrected}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketJudgementIncidentsColRequestedBy}
                  </Table.ColumnHeader>
                  <Table.ColumnHeader>
                    {copy.adminMarketJudgementIncidentsColRequestedAt}
                  </Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => (
                  <Table.Row
                    key={row.requestId}
                    data-testid={`admin-market-judgement-incident-${row.requestId}`}
                    data-market={row.marketId}
                  >
                    <Table.Cell minW="48" wordBreak="break-word">
                      <ChakraLink asChild fontWeight="semibold">
                        <NextLink
                          href={`/admin/markets/${row.marketId}`}
                          data-testid={`admin-market-judgement-incident-link-${row.requestId}`}
                        >
                          {row.title}
                        </NextLink>
                      </ChakraLink>
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap">
                      <Badge
                        colorPalette={MARKET_STATUS_PALETTE[row.status]}
                        variant="subtle"
                        data-testid={`admin-market-judgement-incident-status-${row.requestId}`}
                      >
                        {MARKET_STATUS_LABEL[row.status]}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell
                      whiteSpace="nowrap"
                      data-testid={`admin-market-judgement-incident-original-${row.requestId}`}
                    >
                      {MARKET_RESULT_LABEL[row.originalResult]}
                    </Table.Cell>
                    <Table.Cell
                      whiteSpace="nowrap"
                      data-testid={`admin-market-judgement-incident-result-${row.requestId}`}
                    >
                      {MARKET_RESULT_LABEL[row.correctedResult]}
                    </Table.Cell>
                    <Table.Cell
                      whiteSpace="nowrap"
                      data-testid={`admin-market-judgement-incident-requested-by-${row.requestId}`}
                    >
                      {nicknameShown(row.requestedBy.nickname)}
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap">{formatKst(row.requestedAt)}</Table.Cell>
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
                data-testid="admin-market-judgement-incidents-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                data-testid="admin-market-judgement-incidents-more"
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
