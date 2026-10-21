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
import { type AdminReportQueue } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { useAdminReportQueue } from '@/hooks/use-admin-moderation';
import { type AdminReportGroup } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  adminReportQueuePath,
  adminTargetPath,
  countText,
  moderationItemStateLabel,
  moderationRows,
  queueEntryText,
  reasonCountsText,
  reportTargetTypeLabel,
} from '@/lib/moderation';
import { ModerationNav, UserName } from '../moderation/moderation-parts';

const QUEUES: readonly { queue: AdminReportQueue; label: string }[] = [
  { queue: 'pending', label: copy.adminReportQueuePending },
  { queue: 'resolved', label: copy.adminReportQueueResolved },
];

/**
 * 신고 목록 (#50, ADR-0081; #50 guidance «grouped by target, pending first»): the reports on one
 * target together — a post, a comment or a profile — each entry with the target as it is now, its
 * member, the counts (pending, all, reporters), the reasons with their counts and the times, and
 * the way to its page, where it is processed. Two halves: 처리 대기 (the default), the target waiting
 * longest first; 처리 완료, the latest processed first. Every admin reads it (ADR-0056 1-2). The
 * counts are for the operator to read — nothing acts on them (#45-10), and nothing orders the
 * queue but time.
 */
export function AdminReports({ queue }: { queue: AdminReportQueue }) {
  const list = useAdminReportQueue(queue);
  const rows = moderationRows(list.data?.pages);
  return (
    <Stack gap="5" data-testid="admin-reports">
      <ModerationNav />
      <Heading as="h3" size="lg">
        {copy.adminReportQueue}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminReportQueueIntro}
      </Text>
      <HStack gap="2" flexWrap="wrap" data-testid="admin-reports-queues">
        {QUEUES.map((item) => (
          <Button
            key={item.queue}
            asChild
            size="sm"
            variant={item.queue === queue ? 'solid' : 'outline'}
          >
            <NextLink
              href={adminReportQueuePath(item.queue) as Route}
              aria-current={item.queue === queue ? 'page' : undefined}
              data-testid={`admin-reports-queue-${item.queue}`}
            >
              {item.label}
            </NextLink>
          </Button>
        ))}
      </HStack>

      {list.isPending ? (
        <Skeleton height="24" />
      ) : list.isLoadingError ? (
        <Stack gap="2" align="flex-start">
          <Alert.Root status="error" role="alert">
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
        <Text color="fg.muted" data-testid="admin-reports-empty">
          {queue === 'pending'
            ? copy.adminReportQueueEmptyPending
            : copy.adminReportQueueEmptyResolved}
        </Text>
      ) : (
        <Stack gap="2">
          <Stack as="ul" gap="2" listStyleType="none" data-testid="admin-reports-list">
            {rows.map((group) => (
              <li key={groupKey(group)}>
                <GroupRow group={group} queue={queue} />
              </li>
            ))}
          </Stack>
          {list.hasNextPage && (
            <Button
              alignSelf="center"
              size="sm"
              variant="ghost"
              loading={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
              data-testid="admin-reports-more"
            >
              {copy.loadMore}
            </Button>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/** One entry's key and test id: its target, which is unique in the queue. */
function groupKey(group: AdminReportGroup): string {
  const { target } = group;
  switch (target.type) {
    case 'post':
      return `post-${target.postId}`;
    case 'comment':
      return `comment-${target.commentId}`;
    case 'profile':
      return `profile-${target.userId}`;
  }
}

function GroupRow({ group, queue }: { group: AdminReportGroup; queue: AdminReportQueue }) {
  return (
    <Stack
      as="article"
      gap="1.5"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid={`admin-report-group-${groupKey(group)}`}
    >
      <HStack justify="space-between" align="start" gap="2" flexWrap="wrap">
        <HStack gap="2" flexWrap="wrap" minW="0">
          <Badge size="sm" variant="outline" colorPalette="gray">
            {reportTargetTypeLabel(group.target.type)}
          </Badge>
          {group.state !== 'published' && (
            <Badge size="sm" variant="subtle" colorPalette="orange">
              {moderationItemStateLabel(group.state)}
            </Badge>
          )}
          <Text fontWeight="semibold" wordBreak="break-word" minW="0">
            {queueEntryText(group)}
          </Text>
        </HStack>
        <ChakraLink asChild colorPalette="brand" color="colorPalette.fg" fontSize="sm">
          <NextLink
            href={adminTargetPath(group.target) as Route}
            data-testid="admin-report-group-open"
          >
            {copy.adminModerationOpen}
          </NextLink>
        </ChakraLink>
      </HStack>
      <HStack gap="2" fontSize="sm" flexWrap="wrap">
        <Text as="span" color="fg.muted">
          {copy.adminModerationMember}
        </Text>
        <UserName user={group.user} link={false} />
      </HStack>
      <HStack gap="3" fontSize="sm" flexWrap="wrap" data-testid="admin-report-group-counts">
        {queue === 'pending' && (
          <Text>
            {countText(
              copy.adminReportPendingCount,
              group.pendingCount,
              copy.adminCountUnitReports,
            )}
          </Text>
        )}
        <Text>
          {countText(copy.adminReportCount, group.reportCount, copy.adminCountUnitReports)}
        </Text>
        <Text>
          {countText(copy.adminReporterCount, group.reporterCount, copy.adminCountUnitPeople)}
        </Text>
      </HStack>
      <Text fontSize="sm" color="fg.muted" data-testid="admin-report-group-reasons">
        {reasonCountsText(group.reasons)}
      </Text>
      <Text fontSize="xs" color="fg.muted">
        {group.firstPendingAt !== null
          ? `${copy.adminReportFirstPendingAt} ${formatKst(group.firstPendingAt)} · `
          : ''}
        {`${copy.adminReportLatestAt} ${formatKst(group.latestReportAt)}`}
        {group.lastResolvedAt !== null
          ? ` · ${copy.adminReportLastResolvedAt} ${formatKst(group.lastResolvedAt)}`
          : ''}
      </Text>
    </Stack>
  );
}
