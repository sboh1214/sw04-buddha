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
  Text,
} from '@chakra-ui/react';
import { type AdminDisputeListStatus } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useAdminMarketDisputes } from '@/hooks/use-admin-markets';
import { ADMIN_DISPUTE_QUEUES, adminDisputeQueuePath } from '@/lib/admin-disputes';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import { DisputeRecord } from './dispute-record';

/**
 * 이의 접수 (#175, ADR-0104; ADR-0093 decision 1 #173 items 2·7·13, N03 §8): the members' 판정 이의
 * in two halves — 검토 대기, the one waiting longest first, and 처리됨 (기각·수용·철회), the latest
 * decision or 철회 first — 20 per page with 더 보기, every admin's (ADR-0056 1-2). Each row is its
 * market (the question, to its admin detail, with the market's status), the judgement version, who
 * submitted it and when, its links and reason, and how it ended (`DisputeRecord`). The 기각 and the
 * 수용 are on each market's detail, in its 판정 panel, where the judgement disputed is — and no market
 * price, volume or majority anywhere (N03 §5, #152 AC 8). A refresh that failed after rows exist
 * keeps them under a notice with 다시 시도; a 더 보기 that failed keeps them and says so above its
 * button (`LoadMoreFailed`); only a first read that failed shows the error.
 */
export function AdminDisputes({ status }: { status: AdminDisputeListStatus }) {
  const list = useAdminMarketDisputes(status);
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const half = ADMIN_DISPUTE_QUEUES.find((queue) => queue.status === status);
  return (
    <Stack gap="5" data-testid="admin-disputes" data-status={status}>
      <Heading as="h3" size="lg">
        {copy.adminDisputes}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminDisputesIntro}
      </Text>
      <HStack gap="2" flexWrap="wrap" data-testid="admin-disputes-queues">
        {ADMIN_DISPUTE_QUEUES.map((queue) => (
          <Button
            key={queue.status}
            asChild
            size="sm"
            variant={queue.status === status ? 'solid' : 'outline'}
          >
            <NextLink
              href={adminDisputeQueuePath(queue.status) as Route}
              aria-current={queue.status === status ? 'page' : undefined}
              data-testid={`admin-disputes-queue-${queue.status}`}
            >
              {queue.label}
            </NextLink>
          </Button>
        ))}
      </HStack>

      {list.isPending ? (
        <Skeleton height="24" />
      ) : list.isLoadingError ? (
        <Stack gap="2" align="flex-start">
          <Alert.Root status="error" role="alert" data-testid="admin-disputes-error">
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
        <Text color="fg.muted" data-testid="admin-disputes-empty">
          {half?.empty}
        </Text>
      ) : (
        <Stack gap="3">
          {list.isRefetchError && (
            <Alert.Root status="warning" role="status" data-testid="admin-disputes-stale">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.adminMarketRefreshFailed}</Alert.Description>
              </Alert.Content>
              <Button size="xs" variant="outline" ml="auto" onClick={() => void list.refetch()}>
                {copy.retry}
              </Button>
            </Alert.Root>
          )}
          <Stack as="ul" gap="3" listStyleType="none" data-testid="admin-disputes-list">
            {rows.map((row) => (
              <li key={row.id}>
                <DisputeRecord
                  dispute={row}
                  prefix={`admin-dispute-${row.id}`}
                  heading={
                    <HStack gap="2" flexWrap="wrap" minW="0">
                      <ChakraLink asChild fontWeight="semibold" wordBreak="break-word">
                        <NextLink
                          href={`/admin/markets/${row.market.id}` as Route}
                          data-testid={`admin-dispute-${row.id}-market`}
                        >
                          {row.market.title}
                        </NextLink>
                      </ChakraLink>
                      <Badge
                        colorPalette={MARKET_STATUS_PALETTE[row.market.status]}
                        variant="outline"
                        data-testid={`admin-dispute-${row.id}-market-status`}
                      >
                        {MARKET_STATUS_LABEL[row.market.status]}
                      </Badge>
                    </HStack>
                  }
                />
              </li>
            ))}
          </Stack>
          {list.hasNextPage && (
            <>
              <LoadMoreFailed
                list={list}
                message={copy.errUnknown}
                data-testid="admin-disputes-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                data-testid="admin-disputes-more"
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
