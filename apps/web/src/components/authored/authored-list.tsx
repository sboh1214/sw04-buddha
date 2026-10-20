'use client';

import { Alert, Box, Button, Skeleton, Stack } from '@chakra-ui/react';
import { type ReactNode } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import {
  type AuthoredPage,
  type AuthoredTab,
  authoredEmptyMessage,
  authoredRows,
} from '@/lib/authored';
import { postReadErrorMessage } from '@/lib/posts';
import { listSection } from '@/lib/query-client';

/**
 * What a list body reads of its `useInfiniteQuery` (use-authored.ts). `isFetchNextPageError` and
 * `failureReason` are what the community stack's failed-더 보기 notice reads (`LoadMoreFailed`,
 * owner decision 2026-10-20 7), held here already so the restack only draws it (ADR-0080 결과 5).
 */
export interface AuthoredListQuery<Row> {
  data: { pages: AuthoredPage<Row>[] } | undefined;
  error: unknown;
  failureReason: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  isPending: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
  refetch: () => Promise<unknown>;
  fetchNextPage: () => Promise<unknown>;
}

/**
 * One tab's list (#51, ADR-0080) — a profile's, MY '내 글''s and the MY summary's preview of it
 * (`limit`, MY_PREVIEW_ROWS: the newest few and no 더 보기, `authoredRows`) — drawn the way the other
 * lists are (`listSection`, as MY's 관심 시장): a skeleton while the first page loads, a first read
 * that failed (an unreachable server told apart, `postReadErrorMessage`) with 다시 시도, the tab's
 * empty line, the rows newest first with 더 보기 while there are more, and a refresh that failed
 * over rows that are kept under a notice rather than dropping them.
 *
 * Each row is what `renderRow` draws — the community card for a post, `AuthoredCommentCard` for a
 * comment, either under MY's '숨김' line — in a list item, so a screen reader hears how many. The
 * list is named by `labelledBy` where a visible label stands for it (the MY summary's '글'·'댓글',
 * ADR-0080 7-12); on a tab the tab panel already carries the tab's name.
 */
export function AuthoredListBody<Row extends { id: string }>({
  list,
  tab,
  limit,
  testId,
  labelledBy,
  renderRow,
}: {
  list: AuthoredListQuery<Row>;
  tab: AuthoredTab;
  limit?: number;
  testId: string;
  /** The id of the label that names the list (`aria-labelledby` on its `ul`). */
  labelledBy?: string;
  renderRow: (row: Row) => ReactNode;
}) {
  const { rows, more } = authoredRows(list.data?.pages, list.hasNextPage, limit);
  const section = listSection(list, rows.length);
  return (
    <Stack gap="3" data-testid={testId}>
      {section.stale && (
        <Alert.Root status="warning" role="status" data-testid={`${testId}-stale`}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void list.refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {section.body === 'pending' ? (
        <Skeleton height="112px" borderRadius="card" />
      ) : section.body === 'failed' ? (
        <Stack gap="2" align="flex-start" data-testid={`${testId}-error`}>
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{postReadErrorMessage(list.error)}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : section.body === 'empty' ? (
        <EmptyState message={authoredEmptyMessage(tab)} data-testid={`${testId}-empty`} />
      ) : (
        <>
          <Stack as="ul" gap="3" listStyleType="none" aria-labelledby={labelledBy}>
            {rows.map((row) => (
              <Box as="li" key={row.id} minW="0">
                {renderRow(row)}
              </Box>
            ))}
          </Stack>
          {/* Once this sits on the community stack, a 더 보기 that failed says so right above this
              button, inside this condition (`LoadMoreFailed`, owner decision 2026-10-20 7 — MY's
              lists too), as every 더 보기 list does; until then it fails silently, as every 더 보기
              list on this base does (ADR-0080 결과 5). */}
          {more && (
            <Button
              alignSelf="center"
              size="sm"
              variant="ghost"
              loading={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
              data-testid={`${testId}-more`}
            >
              {copy.loadMore}
            </Button>
          )}
        </>
      )}
    </Stack>
  );
}
