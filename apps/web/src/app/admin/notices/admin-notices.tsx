'use client';

import {
  Alert,
  Button,
  Card,
  HStack,
  Heading,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { NOTICE_PIN_LIMIT } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useAdminNotices, usePinNotice, useUnpinNotice } from '@/hooks/use-notices';
import { type AdminNoticeSummary } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  ADMIN_NOTICE_NEW_PATH,
  adminNoticePath,
  noticePath,
  noticeWriteErrorMessage,
} from '@/lib/notices';
import { listSection } from '@/lib/query-client';

/**
 * 운영 공지 (#138, ADR-0077; ADR-0069 decision 2 #45-8 and decision 4 #138): the admin screen of
 * the notices. Above, 공지 쓰기 and what a notice is; then the pinned notices — the community
 * list's fixed area, in its order (the latest pinned first), with how many of NOTICE_PIN_LIMIT
 * are taken — each to unpin; then every other notice, the newest written first, each to pin again
 * (#45-8: an unpinned notice stays here), one page per 더 보기. A title opens the notice's edit
 * screen — with its records and earlier versions — and 공지 보기 a pinned notice's public page: only
 * a pinned notice is public (owner decision 2026-10-21), so an unpinned row has none. Any admin
 * does all of it, with no second admin's approval.
 *
 * The limit is the server's, race-safe (a pin while NOTICE_PIN_LIMIT are pinned is refused with
 * NOTICE_PIN_LIMIT_REACHED, and nothing is unpinned to make room): 고정 stays on every unpinned row
 * and a refusal says to unpin one first — a count this screen read a moment ago is no rule.
 */
export function AdminNotices() {
  const pin = usePinNotice();
  const unpin = useUnpinNotice();
  const busy = pin.isPending || unpin.isPending;
  const onError = (error: Error) =>
    toaster.create({ type: 'error', title: noticeWriteErrorMessage(error) });
  const actions: RowActions = {
    // A finished mutation keeps its variables, so only the one on its way names the row.
    busyId: pin.isPending ? pin.variables : unpin.isPending ? unpin.variables : undefined,
    disabled: busy,
    pin: (id) =>
      pin.mutate(id, {
        onSuccess: () => toaster.create({ type: 'success', title: copy.adminNoticePinnedToast }),
        onError,
      }),
    unpin: (id) =>
      unpin.mutate(id, {
        onSuccess: () => toaster.create({ type: 'success', title: copy.adminNoticeUnpinnedToast }),
        onError,
      }),
  };

  return (
    <Stack gap="6" data-testid="admin-notices">
      <Stack gap="2">
        <HStack justify="space-between" align="center" gap="3" flexWrap="wrap">
          <Heading as="h3" size="lg">
            {copy.adminNotices}
          </Heading>
          <Button asChild size="sm">
            <NextLink href={ADMIN_NOTICE_NEW_PATH} data-testid="admin-notice-write">
              {copy.adminNoticeWrite}
            </NextLink>
          </Button>
        </HStack>
        <Text fontSize="sm" color="fg.muted">
          {copy.adminNoticesIntro}
        </Text>
        <Text fontSize="sm" color="fg.muted">
          {copy.adminNoticeRecordHint}
        </Text>
      </Stack>
      <PinnedNotices actions={actions} />
      <UnpinnedNotices actions={actions} />
    </Stack>
  );
}

/** What a row's 고정 and 고정 해제 do, and which row's is on its way. */
interface RowActions {
  busyId: string | undefined;
  disabled: boolean;
  pin: (noticeId: string) => void;
  unpin: (noticeId: string) => void;
}

/**
 * The pinned notices: one page, since at most NOTICE_PIN_LIMIT are ever pinned (the database holds
 * the limit), so this list has no 더 보기. The heading counts them against the limit.
 */
function PinnedNotices({ actions }: { actions: RowActions }) {
  const list = useAdminNotices('pinned');
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const section = listSection(list, rows.length);
  return (
    <Card.Root data-testid="admin-notices-pinned">
      <Card.Header>
        <HStack gap="2" align="baseline">
          <Text fontWeight="semibold">{copy.adminNoticesPinned}</Text>
          {section.body === 'rows' || section.body === 'empty' ? (
            <Text fontSize="sm" color="fg.muted" data-testid="admin-notices-pinned-count">
              {`${String(rows.length)} / ${String(NOTICE_PIN_LIMIT)}`}
            </Text>
          ) : null}
        </HStack>
      </Card.Header>
      <Card.Body>
        <Stack gap="3">
          {section.stale && <RefreshFailed />}
          {section.body === 'pending' ? (
            <Skeleton height="16" />
          ) : section.body === 'failed' ? (
            <ReadFailed />
          ) : section.body === 'empty' ? (
            <Text color="fg.muted" data-testid="admin-notices-pinned-empty">
              {copy.adminNoticesPinnedEmpty}
            </Text>
          ) : (
            <Stack gap="2">
              {rows.map((notice) => (
                <NoticeRow key={notice.id} notice={notice} actions={actions} />
              ))}
            </Stack>
          )}
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/** Every notice not pinned, the newest written first, one page per 더 보기. */
function UnpinnedNotices({ actions }: { actions: RowActions }) {
  const list = useAdminNotices('unpinned');
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const section = listSection(list, rows.length);
  return (
    <Card.Root data-testid="admin-notices-unpinned">
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminNoticesUnpinned}</Text>
      </Card.Header>
      <Card.Body>
        <Stack gap="3">
          {section.stale && <RefreshFailed />}
          {section.body === 'pending' ? (
            <Skeleton height="16" />
          ) : section.body === 'failed' ? (
            <ReadFailed />
          ) : section.body === 'empty' ? (
            <Text color="fg.muted" data-testid="admin-notices-unpinned-empty">
              {copy.adminNoticesUnpinnedEmpty}
            </Text>
          ) : (
            <Stack gap="2">
              {rows.map((notice) => (
                <NoticeRow key={notice.id} notice={notice} actions={actions} />
              ))}
              {list.hasNextPage && (
                <>
                  <LoadMoreFailed
                    list={list}
                    message={copy.errUnknown}
                    data-testid="admin-notices-more-failed"
                  />
                  <Button
                    alignSelf="center"
                    size="sm"
                    variant="ghost"
                    loading={list.isFetchingNextPage}
                    onClick={() => void list.fetchNextPage()}
                    data-testid="admin-notices-more"
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
 * One notice: its title (to its edit screen), when it was written, '수정됨' once edited and since
 * when it is pinned; 공지 보기 (its public page, while it is pinned) and 고정 or 고정 해제.
 */
function NoticeRow({ notice, actions }: { notice: AdminNoticeSummary; actions: RowActions }) {
  const pinned = notice.pinnedAt !== null;
  return (
    <HStack
      justify="space-between"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      gap="3"
      flexWrap="wrap"
      data-testid={`admin-notice-${notice.id}`}
    >
      <Stack gap="0.5" minW="0">
        <ChakraLink asChild fontWeight="semibold" wordBreak="break-word">
          <NextLink href={adminNoticePath(notice.id) as Route} data-testid="admin-notice-title">
            {notice.title}
          </NextLink>
        </ChakraLink>
        <Text fontSize="xs" color="fg.muted">
          {`${copy.adminNoticeCreatedAt} ${formatKst(notice.createdAt)}`}
          {notice.editedAt !== null && ` · ${copy.postEdited}`}
          {notice.pinnedAt !== null &&
            ` · ${copy.adminNoticePinnedAt} ${formatKst(notice.pinnedAt)}`}
        </Text>
      </Stack>
      <HStack gap="2">
        {pinned && (
          <Button asChild size="sm" variant="ghost">
            <NextLink href={noticePath(notice.id) as Route} data-testid="admin-notice-view">
              {copy.adminNoticeView}
            </NextLink>
          </Button>
        )}
        {pinned ? (
          <Button
            size="sm"
            variant="outline"
            loading={actions.busyId === notice.id}
            disabled={actions.disabled}
            onClick={() => actions.unpin(notice.id)}
            data-testid="admin-notice-unpin"
          >
            {copy.adminNoticeUnpin}
          </Button>
        ) : (
          <Button
            size="sm"
            loading={actions.busyId === notice.id}
            disabled={actions.disabled}
            onClick={() => actions.pin(notice.id)}
            data-testid="admin-notice-pin"
          >
            {copy.adminNoticePin}
          </Button>
        )}
      </HStack>
    </HStack>
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
