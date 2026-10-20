'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  HStack,
  Heading,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { type NoticeFormOptions, PostForm } from '@/components/post/post-form';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import {
  useAdminNotice,
  useCreateNotice,
  usePinNotice,
  useUnpinNotice,
  useUpdateNotice,
} from '@/hooks/use-notices';
import { type AdminNotice } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  ADMIN_NOTICES_PATH,
  adminNoticeMissing,
  noticePath,
  noticeSaveToast,
  noticeWriteErrorMessage,
} from '@/lib/notices';
import { refusedImageIds } from '@/lib/posts';

/**
 * The posts' form as a notice's (#138, ADR-0077 — «글과 같은 서식 편집기»): the same editor, counts
 * and limits (5,000 characters, links and images, ADR-0069 decision 4 #138), with a required title.
 */
const NOTICE_FORM: NoticeFormOptions = {
  titleRequired: true,
  titleLabel: copy.noticeWriteTitleLabel,
  titlePlaceholder: copy.noticeWriteTitlePlaceholder,
  bodyPlaceholder: copy.noticeWriteBodyPlaceholder,
};

function BackLink() {
  return (
    <ChakraLink
      asChild
      fontSize="sm"
      colorPalette="brand"
      color="colorPalette.fg"
      alignSelf="flex-start"
    >
      <NextLink href={ADMIN_NOTICES_PATH} data-testid="admin-notice-back">
        ← {copy.adminNoticeBack}
      </NextLink>
    </ChakraLink>
  );
}

/**
 * The admin on screen, whose uploads the editor sends (`POST /media/images` names the account,
 * `expectedAccountId`): an image a notice takes is an upload of the admin who writes or edits it.
 * Undefined until `GET /me` answers; the form holds its send and the editor its uploads till then.
 */
function useAdminAccountId(): string | undefined {
  return useMe().data?.id;
}

/**
 * 공지 쓰기: the title and the body, sent once. The notice starts unpinned — pinning is its own
 * action and record (this PR's choice, ADR-0077) — so the screen goes back to the list, where the
 * new notice heads the unpinned ones with its 고정.
 */
export function AdminNoticeNew() {
  const router = useRouter();
  const accountId = useAdminAccountId();
  const create = useCreateNotice();
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const sent = create.isPending || create.isSuccess;
  return (
    <Stack gap="4" data-testid="admin-notice-new">
      <BackLink />
      <Heading as="h3" size="lg">
        {copy.adminNoticeNewTitle}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminNoticesIntro}
      </Text>
      <PostForm
        notice={NOTICE_FORM}
        // No draft key: a notice's draft is not kept (ADR-0077 decision 8-20), nor is leaving
        // asked about yet (`leaveGuard`).
        leaveGuard={false}
        accountId={accountId}
        submitLabel={copy.adminNoticeSubmit}
        pending={sent}
        saved={create.isSuccess}
        errorMessage={refusal}
        refusedImageIds={refusedImageIds(create.error)}
        onSubmit={({ title, body }) => {
          if (title === null) return; // the form sends nothing without a title
          setRefusal(undefined);
          create.mutate(
            { title, body },
            {
              onSuccess: () => {
                toaster.create({ type: 'success', title: copy.adminNoticeCreated });
                router.push(ADMIN_NOTICES_PATH);
              },
              onError: (error) => setRefusal(noticeWriteErrorMessage(error)),
            },
          );
        }}
      />
    </Stack>
  );
}

/**
 * 공지 수정: any admin's (#45-8). Above the form, whether the notice is pinned and since when, its
 * 고정 or 고정 해제, and 공지 보기. Saving a change marks the notice '수정됨' and keeps the earlier
 * version for operators; saving the same content changes nothing and says so. The form keeps what
 * is typed through a refresh of the notice in the background — another admin's edit shows when
 * the screen is opened again, and nothing checks which version the form was opened from: two
 * admins' saves take turns and the later one wins, the one it replaced kept in the operators'
 * history (ADR-0077 decision 8-19 — an open question to the owner, not a rule).
 */
export function AdminNoticeEdit({ noticeId }: { noticeId: string }) {
  const notice = useAdminNotice(noticeId);
  // An unknown id, or a segment that is not a uuid (`adminNoticeMissing`).
  if (notice.isError && adminNoticeMissing(notice.error)) {
    return (
      <Stack gap="4">
        <BackLink />
        <Alert.Root status="error" role="alert" data-testid="admin-notice-not-found">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminNoticeNotFound}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      </Stack>
    );
  }
  if (notice.isPending) return <Skeleton height="48" />;
  if (notice.isLoadingError) {
    return (
      <Stack gap="4">
        <BackLink />
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      </Stack>
    );
  }
  return (
    <Stack gap="4" data-testid="admin-notice-edit">
      <BackLink />
      <Heading as="h3" size="lg">
        {copy.adminNoticeEditTitle}
      </Heading>
      {notice.isRefetchError && (
        <Alert.Root status="warning" role="status">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminNoticeRefreshFailed}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <PinCard notice={notice.data} />
      {/* Keyed by the notice: the form holds its draft from the notice it was opened with. */}
      <EditForm key={notice.data.id} notice={notice.data} />
    </Stack>
  );
}

/** Whether the notice is pinned and since when, with 고정 or 고정 해제 and 공지 보기. */
function PinCard({ notice }: { notice: AdminNotice }) {
  const pin = usePinNotice();
  const unpin = useUnpinNotice();
  const busy = pin.isPending || unpin.isPending;
  const onError = (error: Error) =>
    toaster.create({ type: 'error', title: noticeWriteErrorMessage(error) });
  const pinned = notice.pinnedAt !== null;
  return (
    <Card.Root data-testid="admin-notice-pin-card">
      <Card.Body>
        <HStack justify="space-between" gap="3" flexWrap="wrap">
          <Stack gap="1" minW="0">
            <HStack gap="2" flexWrap="wrap">
              <Badge
                variant="subtle"
                colorPalette={pinned ? 'brand' : 'gray'}
                data-testid="admin-notice-state"
              >
                {pinned ? copy.adminNoticeStatePinned : copy.adminNoticeStateUnpinned}
              </Badge>
              {notice.pinnedAt !== null && (
                <Text fontSize="sm" color="fg.muted">
                  {`${copy.adminNoticePinnedAt} ${formatKst(notice.pinnedAt)}`}
                </Text>
              )}
            </HStack>
            <Text fontSize="xs" color="fg.muted">
              {`${copy.adminNoticeCreatedAt} ${formatKst(notice.createdAt)}`}
              {notice.editedAt !== null && ` · ${copy.postEdited}`}
            </Text>
          </Stack>
          <HStack gap="2">
            <Button asChild size="sm" variant="ghost">
              <NextLink href={noticePath(notice.id) as Route} data-testid="admin-notice-view">
                {copy.adminNoticeView}
              </NextLink>
            </Button>
            {pinned ? (
              <Button
                size="sm"
                variant="outline"
                loading={unpin.isPending}
                disabled={busy}
                onClick={() =>
                  unpin.mutate(notice.id, {
                    onSuccess: () =>
                      toaster.create({ type: 'success', title: copy.adminNoticeUnpinnedToast }),
                    onError,
                  })
                }
                data-testid="admin-notice-unpin"
              >
                {copy.adminNoticeUnpin}
              </Button>
            ) : (
              <Button
                size="sm"
                loading={pin.isPending}
                disabled={busy}
                onClick={() =>
                  pin.mutate(notice.id, {
                    onSuccess: () =>
                      toaster.create({ type: 'success', title: copy.adminNoticePinnedToast }),
                    onError,
                  })
                }
                data-testid="admin-notice-pin"
              >
                {copy.adminNoticePin}
              </Button>
            )}
          </HStack>
        </HStack>
      </Card.Body>
    </Card.Root>
  );
}

/** The title and the body, filled with the notice's, saved over it. */
function EditForm({ notice }: { notice: AdminNotice }) {
  const accountId = useAdminAccountId();
  const update = useUpdateNotice();
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  return (
    <PostForm
      notice={NOTICE_FORM}
      // As the new notice's form: no draft key, and no leave confirm yet.
      leaveGuard={false}
      initialTitle={notice.title}
      initialDocument={notice.body}
      accountId={accountId}
      submitLabel={copy.adminNoticeSave}
      pending={update.isPending}
      saved={update.isSuccess}
      errorMessage={refusal}
      refusedImageIds={refusedImageIds(update.error)}
      onSubmit={({ title, body }) => {
        if (title === null) return; // the form sends nothing without a title
        setRefusal(undefined);
        update.mutate(
          { noticeId: notice.id, title, body },
          {
            // What the server did, not a guess from `editedAt` (`noticeSaveToast`).
            onSuccess: (result) => toaster.create(noticeSaveToast(result)),
            onError: (error) => setRefusal(noticeWriteErrorMessage(error)),
          },
        );
      }}
    />
  );
}
