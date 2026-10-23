'use client';

import { Alert, Button, HStack, Heading, Skeleton, Stack, Text } from '@chakra-ui/react';
import { type AccountRestrictionRequestQueue } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useState } from 'react';
import { copy } from '@/copy';
import { useAdminAccountRequests } from '@/hooks/use-admin-moderation';
import { adminAccountRequestQueuePath, moderationRows } from '@/lib/moderation';
import { type DialogSpec, ModerationDialog, ModerationNav, RequestRows } from '../moderation-parts';

const QUEUES: readonly { queue: AccountRestrictionRequestQueue; label: string; empty: string }[] = [
  {
    queue: 'pending',
    label: copy.adminAccountRequestsPending,
    empty: copy.adminAccountRequestsEmptyPending,
  },
  {
    queue: 'decided',
    label: copy.adminAccountRequestsDecided,
    empty: copy.adminAccountRequestsEmptyDecided,
  },
  {
    queue: 'retracted',
    label: copy.adminAccountRequestsRetracted,
    empty: copy.adminAccountRequestsEmptyRetracted,
  },
];

/**
 * 계정 제한 요청 (#139, ADR-0085; ADR-0056 decision 1-7 «계정 제한·해제는 다른 운영자의 승인»): every
 * request to restrict a member's account, to bring a restriction's end forward, to lift it early or
 * to cancel it — the brief's «pending requests list in admin». Three parts: 승인 대기 (the
 * default), the request waiting longest first, each with 승인 and 거절 for an admin who neither
 * asked nor is the member (거절 alone while the request is moot — ADR-0085 7-3) and 요청 철회 for
 * the admin who asked (owner decision 2026-10-23); 결정함, the latest decision first, with who
 * decided, when and why; 철회됨, the latest retraction first, with when. A request has no expiry.
 * Every admin reads it (ADR-0056 1-2), and a request about the admin reading it withholds its
 * asking and deciding admins and the operators' memo from them.
 */
export function AdminAccountRequests({ queue }: { queue: AccountRestrictionRequestQueue }) {
  const list = useAdminAccountRequests(queue);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const rows = moderationRows(list.data?.pages);
  return (
    <Stack gap="5" data-testid="admin-account-requests">
      <ModerationNav />
      <Heading as="h3" size="lg">
        {copy.adminAccountRequests}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminAccountRequestsIntro}
      </Text>
      <HStack gap="2" flexWrap="wrap" data-testid="admin-account-requests-queues">
        {QUEUES.map((item) => (
          <Button
            key={item.queue}
            asChild
            size="sm"
            variant={item.queue === queue ? 'solid' : 'outline'}
          >
            <NextLink
              href={adminAccountRequestQueuePath(item.queue) as Route}
              aria-current={item.queue === queue ? 'page' : undefined}
              data-testid={`admin-account-requests-queue-${item.queue}`}
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
      ) : (
        <Stack gap="2">
          <RequestRows
            requests={rows}
            showUser
            onOpen={setDialog}
            empty={QUEUES.find((item) => item.queue === queue)?.empty ?? ''}
          />
          {list.hasNextPage && (
            <Button
              alignSelf="center"
              size="sm"
              variant="ghost"
              loading={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
              data-testid="admin-account-requests-more"
            >
              {copy.loadMore}
            </Button>
          )}
        </Stack>
      )}
      {dialog !== null && <ModerationDialog spec={dialog} onClose={() => setDialog(null)} />}
    </Stack>
  );
}
