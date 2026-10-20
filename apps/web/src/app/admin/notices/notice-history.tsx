'use client';

import {
  Alert,
  Button,
  Card,
  HStack,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useAdminNoticeActions, useAdminNoticeRevisions } from '@/hooks/use-notices';
import { type AdminNoticeAction, type AdminNoticeRevisionSummary } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { adminNoticeRevisionPath, noticeActionLabel, noticeActorName } from '@/lib/notices';
import { listSection } from '@/lib/query-client';

/**
 * The admin's notice screen, under the form (#138, owner decision 2026-10-21: «관리자 공지 화면 →
 * 운영 기록(운영자·시각·동작)과 이전 판을 보임», ADR-0077): the notice's operation records — who
 * wrote, edited, pinned or unpinned it, and when, newest first — and its earlier versions — each
 * title, when and by whom it was written and replaced, newest first, each opened read-only on its
 * own page. One page per 더 보기 each. No reason anywhere: the owner takes none (#138). Times are
 * Korean, as on every admin screen (`formatKst`).
 */
export function NoticeHistory({ noticeId }: { noticeId: string }) {
  return (
    <Stack gap="4">
      <NoticeActions noticeId={noticeId} />
      <NoticeRevisions noticeId={noticeId} />
    </Stack>
  );
}

/** The notice's operation records, newest first. */
function NoticeActions({ noticeId }: { noticeId: string }) {
  const list = useAdminNoticeActions(noticeId);
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const section = listSection(list, rows.length);
  return (
    <Card.Root data-testid="admin-notice-actions">
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminNoticeActions}</Text>
      </Card.Header>
      <Card.Body>
        <Stack gap="3">
          {section.stale && <RefreshFailed />}
          {section.body === 'pending' ? (
            <Skeleton height="16" />
          ) : section.body === 'failed' ? (
            <ReadFailed />
          ) : section.body === 'empty' ? (
            <Text color="fg.muted" data-testid="admin-notice-actions-empty">
              {copy.adminNoticeActionsEmpty}
            </Text>
          ) : (
            <Stack gap="2">
              {rows.map((action) => (
                <ActionRow key={action.id} noticeId={noticeId} action={action} />
              ))}
              {list.hasNextPage && (
                <>
                  <LoadMoreFailed
                    list={list}
                    message={copy.errUnknown}
                    data-testid="admin-notice-actions-more-failed"
                  />
                  <Button
                    alignSelf="center"
                    size="sm"
                    variant="ghost"
                    loading={list.isFetchingNextPage}
                    onClick={() => void list.fetchNextPage()}
                    data-testid="admin-notice-actions-more"
                  >
                    {copy.loadMore}
                  </Button>
                </>
              )}
            </Stack>
          )}
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/**
 * One record: when, what was done and by whom. An edit links the version it replaced, so the
 * record and the version it made earlier read together.
 */
function ActionRow({ noticeId, action }: { noticeId: string; action: AdminNoticeAction }) {
  return (
    <HStack
      justify="space-between"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      gap="3"
      flexWrap="wrap"
      data-testid={`admin-notice-action-${action.id}`}
    >
      <HStack gap="2" flexWrap="wrap" minW="0">
        <Text fontWeight="semibold" data-testid="admin-notice-action-type">
          {noticeActionLabel(action.type)}
        </Text>
        <Text fontSize="sm" wordBreak="break-word" data-testid="admin-notice-action-actor">
          {noticeActorName(action.actor)}
        </Text>
        <Text fontSize="sm" color="fg.muted" data-testid="admin-notice-action-time">
          {formatKst(action.createdAt)}
        </Text>
      </HStack>
      {action.revisionId !== null && (
        <ChakraLink asChild fontSize="sm" colorPalette="brand" color="colorPalette.fg">
          {/* Every edit has one: its name carries the record's time, so a list of the page's
              links does not read the same '바뀌기 전 판' several times over. */}
          <NextLink
            href={adminNoticeRevisionPath(noticeId, action.revisionId) as Route}
            aria-label={`${formatKst(action.createdAt)} ${copy.adminNoticeActionRevision}`}
            data-testid="admin-notice-action-revision"
          >
            {copy.adminNoticeActionRevision}
          </NextLink>
        </ChakraLink>
      )}
    </HStack>
  );
}

/** The notice's earlier versions, newest first. */
function NoticeRevisions({ noticeId }: { noticeId: string }) {
  const list = useAdminNoticeRevisions(noticeId);
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const section = listSection(list, rows.length);
  return (
    <Card.Root data-testid="admin-notice-revisions">
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminNoticeRevisions}</Text>
      </Card.Header>
      <Card.Body>
        <Stack gap="3">
          {section.stale && <RefreshFailed />}
          {section.body === 'pending' ? (
            <Skeleton height="16" />
          ) : section.body === 'failed' ? (
            <ReadFailed />
          ) : section.body === 'empty' ? (
            <Text color="fg.muted" data-testid="admin-notice-revisions-empty">
              {copy.adminNoticeRevisionsEmpty}
            </Text>
          ) : (
            <Stack gap="2">
              {rows.map((revision) => (
                <RevisionRow key={revision.id} noticeId={noticeId} revision={revision} />
              ))}
              {list.hasNextPage && (
                <>
                  <LoadMoreFailed
                    list={list}
                    message={copy.errUnknown}
                    data-testid="admin-notice-revisions-more-failed"
                  />
                  <Button
                    alignSelf="center"
                    size="sm"
                    variant="ghost"
                    loading={list.isFetchingNextPage}
                    onClick={() => void list.fetchNextPage()}
                    data-testid="admin-notice-revisions-more"
                  >
                    {copy.loadMore}
                  </Button>
                </>
              )}
            </Stack>
          )}
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/** One earlier version: its title (to read it whole), who wrote it and who replaced it, and when. */
function RevisionRow({
  noticeId,
  revision,
}: {
  noticeId: string;
  revision: AdminNoticeRevisionSummary;
}) {
  return (
    <Stack
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      gap="1"
      data-testid={`admin-notice-revision-${String(revision.id)}`}
    >
      <ChakraLink asChild fontWeight="semibold" wordBreak="break-word">
        <NextLink
          href={adminNoticeRevisionPath(noticeId, revision.id) as Route}
          data-testid="admin-notice-revision-title"
        >
          {revision.title}
        </NextLink>
      </ChakraLink>
      <Text fontSize="xs" color="fg.muted" data-testid="admin-notice-revision-written">
        {`${copy.adminNoticeRevisionWritten} ${formatKst(revision.writtenAt)} · ${noticeActorName(revision.writtenBy)}`}
      </Text>
      <Text fontSize="xs" color="fg.muted" data-testid="admin-notice-revision-replaced">
        {`${copy.adminNoticeRevisionReplaced} ${formatKst(revision.replacedAt)} · ${noticeActorName(revision.replacedBy)}`}
      </Text>
    </Stack>
  );
}

function ReadFailed() {
  return (
    <Alert.Root status="error" role="alert">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{copy.errUnknown}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}

/** A refresh that failed over rows that are kept (`listSection`'s `stale`). */
function RefreshFailed() {
  return (
    <Alert.Root status="warning" role="status">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{copy.adminNoticeRefreshFailed}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}
