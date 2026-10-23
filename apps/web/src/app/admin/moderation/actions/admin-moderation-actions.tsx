'use client';

import { Alert, Button, Heading, Skeleton, Stack } from '@chakra-ui/react';
import { useState } from 'react';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useAdminModerationActions } from '@/hooks/use-admin-moderation';
import { moderationRows } from '@/lib/moderation';
import {
  ActionRows,
  type DialogSpec,
  ModerationDialog,
  ModerationNav,
  cancelDialog,
} from '../moderation-parts';

/**
 * 조치 기록 (#50, ADR-0081): every moderation action, newest first — taken from the queue or
 * without a report (decision 4 #50) — with its reason, operator, time and cancellation, and 조치
 * 취소 on one that stands (with the operators' reason; a hidden item shows again, a profile item is
 * not restored). Every admin reads it (ADR-0056 1-2).
 */
export function AdminModerationActions() {
  const list = useAdminModerationActions();
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const rows = moderationRows(list.data?.pages);
  return (
    <Stack gap="5" data-testid="admin-moderation-actions">
      <ModerationNav />
      <Heading as="h3" size="lg">
        {copy.adminModerationActions}
      </Heading>
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
          <ActionRows
            actions={rows}
            showUser
            onCancel={(action) => setDialog(cancelDialog(action))}
          />
          {list.hasNextPage && (
            <>
              {/* A 더 보기 that failed: the rows stay, and this says so above the button that asks
                  again (owner decision 2026-10-20 7, as every 더 보기 list). */}
              <LoadMoreFailed
                list={list}
                message={copy.errUnknown}
                data-testid="admin-moderation-actions-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                data-testid="admin-moderation-actions-more"
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </Stack>
      )}
      {dialog !== null && <ModerationDialog spec={dialog} onClose={() => setDialog(null)} />}
    </Stack>
  );
}
