'use client';

import { Alert, Button, Heading, Skeleton, Stack, Table, Text } from '@chakra-ui/react';
import type { ReactNode } from 'react';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';

/** What the frame reads of a list's infinite query. */
export interface OperationsQueueQuery {
  isPending: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  failureReason: unknown;
  refetch: () => Promise<unknown>;
  fetchNextPage: () => Promise<unknown>;
}

/**
 * One 운영 대기열 list (#145, ADR-0163) on the queue template of 검수 대기's lists (#152's 판정 승인
 * 대기): its heading; a skeleton while the first read is out; that read's failure with 다시 시도
 * (`-error`); its empty sentence (`-empty`); else the table in a ScrollArea (`-list`) — at 375px it
 * scrolls inside, never the page — under a notice with 다시 시도 when a refresh failed over rows
 * held (`-stale`), and 더 보기 (`-more`) while a page follows, with the notice of a 더 보기 that
 * failed above it (`-more-failed`, `LoadMoreFailed`). `prefix` is the list's test id
 * (`admin-operations-closing`…), on the root too.
 */
export function OperationsQueue({
  prefix,
  title,
  empty,
  list,
  count,
  header,
  children,
}: {
  prefix: string;
  title: string;
  empty: string;
  list: OperationsQueueQuery;
  /** How many rows are held: 0 draws the empty sentence. */
  count: number;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack gap="4" data-testid={prefix}>
      <Heading as="h4" size="md">
        {title}
      </Heading>
      {list.isPending ? (
        <Skeleton height="24" />
      ) : list.isLoadingError ? (
        <Stack gap="2" align="flex-start">
          <Alert.Root status="error" role="alert" data-testid={`${prefix}-error`}>
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : count === 0 ? (
        <Text color="fg.muted" data-testid={`${prefix}-empty`}>
          {empty}
        </Text>
      ) : (
        <Stack gap="3">
          {list.isRefetchError && (
            <Alert.Root status="warning" role="status" data-testid={`${prefix}-stale`}>
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
            <Table.Root size="sm" data-testid={`${prefix}-list`}>
              <Table.Header>{header}</Table.Header>
              <Table.Body>{children}</Table.Body>
            </Table.Root>
          </Table.ScrollArea>
          {list.hasNextPage && (
            <>
              <LoadMoreFailed
                list={list}
                message={copy.errUnknown}
                data-testid={`${prefix}-more-failed`}
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                data-testid={`${prefix}-more`}
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
