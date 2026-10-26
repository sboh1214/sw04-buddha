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
import { type ReactNode, useCallback, useState } from 'react';
import { type NoticeFormOptions, PostForm } from '@/components/post/post-form';
import { EmptyState } from '@/components/ui/empty-state';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  useAdminNotice,
  useCreateNotice,
  usePinNotice,
  useUnpinNotice,
  useUpdateNotice,
} from '@/hooks/use-notices';
import { useOperatorId } from '@/hooks/use-operator';
import { usePostWriter } from '@/hooks/use-posts';
import { type AdminNotice } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  ADMIN_NOTICES_PATH,
  adminNoticeImagePath,
  adminNoticeReadView,
  noticeEditConflict,
  noticePath,
  noticeSaveToast,
  noticeWriteErrorMessage,
} from '@/lib/notices';
import { refusedImageIds } from '@/lib/posts';
import { NoticeHistory } from './notice-history';

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
 * A notice's form, drawn once the admin on screen is known: whose uploads the editor sends (`POST
 * /media/images` names the account, `expectedAccountId` — an image a notice takes is an upload of
 * the admin who writes or edits it), and whose draft the form takes back. The form reads the draft
 * the onboarding gate kept for its screen once, when it is made, for that account (`PostForm`), so
 * it waits for `GET /me` as the post screens' form does (`WriteGate`): a form made before it
 * answered — on a load of the page, which `GET /me` is not in, while the onboarding gate draws the
 * page as it reads it — would skip the draft and leave it in the tab, for a later visit within the
 * hour to take back unasked (ADR-0077 decision 8-20). A placeholder till then; `GET /me` failing
 * before it ever answered, the post screens' sentence. A session gone while the page is open is the
 * API's 401s (app/admin/layout.tsx), not this.
 */
function NoticeWriterGate({ children }: { children: (accountId: string) => ReactNode }) {
  const writer = usePostWriter();
  if (writer.failed) {
    return <EmptyState message={copy.errProfileLoad} data-testid="admin-notice-writer-failed" />;
  }
  if (writer.accountId === undefined) {
    return (
      <Skeleton height="320px" borderRadius="card" data-testid="admin-notice-writer-pending" />
    );
  }
  return children(writer.accountId);
}

/**
 * 공지 쓰기: the title and the body, sent once. The notice starts unpinned — pinning is its own
 * action and record (the owner kept it so, 2026-10-21, ADR-0077) — so the screen goes back to the
 * list, where the new notice heads the unpinned ones with its 고정. Unpinned, it is not public.
 *
 * Leaving with something typed asks first, as a post's form does ('쓰던 내용이 사라집니다.
 * 나갈까요?', owner decision 2026-10-21 8), and a link's leave keeps nothing. The form stays locked
 * from the send through the move to the list (`pending`), so that move asks nothing. The
 * onboarding gate taking the admin to a step left (a re-consent) asks nothing, and keeps what was
 * typed in this tab for an hour, as a post's draft: this screen opened again after the step takes
 * it back (오너 결정 2026-10-21 (3차), ADR-0077 decision 8-20 — the key `notice-new`).
 */
export function AdminNoticeNew() {
  const router = useRouter();
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
      <NoticeWriterGate>
        {(accountId) => (
          <PostForm
            notice={NOTICE_FORM}
            // Kept across the onboarding gate's move only (ADR-0077 decision 8-20).
            draftKey={{ kind: 'notice-new' }}
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
                // The admin the form is drawn for: the write names it (`expectedAccountId`,
                // ADR-0092) and its landing is that admin's.
                { title, body, accountId },
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
        )}
      </NoticeWriterGate>
    </Stack>
  );
}

/**
 * 공지 수정: any admin's (#45-8). Above the form, whether the notice is pinned and since when, its
 * 고정 or 고정 해제, and 공지 보기 while it is pinned (only a pinned notice is public, owner decision
 * 2026-10-21). Saving a change marks the notice '수정됨' and keeps the earlier version for
 * operators; saving the same content changes nothing and says so. Under the form, the notice's
 * operation records and earlier versions (`NoticeHistory`, owner decision 2026-10-21).
 *
 * The screen opens on a read made after it opened, never on a copy the cache held from before
 * (`openedAt`, `adminNoticeReadView`): the form saves with the version it was opened from, and
 * the owner's rule is about saves made since the screen opened. The form keeps what is typed
 * through a refresh of the notice in the background, and when the notice was saved since — by
 * another admin, or by this one in another tab — the save is refused ('그사이 공지가 고쳐졌습니다.
 * 최신 내용을 불러와 주세요.', owner decisions 2026-10-21), what is typed stays, and 최신 내용
 * 불러오기 opens the form again on the latest version (`generation`) — once that version is read —
 * with the focus on its title. That is no leaving: it asks nothing (the hint before the button
 * says what is typed goes), and the form it opens holds nothing to lose.
 */
export function AdminNoticeEdit({ noticeId }: { noticeId: string }) {
  const notice = useAdminNotice(noticeId);
  // When the screen opened: the form waits for a read that landed since (`adminNoticeReadView`).
  // Only ever compared with the query's own clock, in the browser — the server draws the skeleton
  // either way (the admin's reads are never made there).
  const [openedAt] = useState(() => Date.now());
  // Bumped to open the form again on the version just read (최신 내용 불러오기).
  const [generation, setGeneration] = useState(0);
  const view = adminNoticeReadView(notice, openedAt);
  // An unknown id, or a segment that is not a uuid (`adminNoticeMissing`).
  if (view === 'missing') {
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
  if (view === 'failed') {
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
  if (view === 'pending' || notice.data === undefined) return <Skeleton height="48" />;
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
      <NoticeWriterGate>
        {(accountId) => (
          // Keyed by the notice and the opening: the form holds its draft, and the version it was
          // opened from, from the notice it was opened with. Opened again, it takes the focus the
          // press of 최신 내용 불러오기 left behind.
          <EditForm
            key={`${notice.data.id}:${String(generation)}`}
            notice={notice.data}
            accountId={accountId}
            autoFocusTitle={generation > 0}
            onReload={async () => {
              const latest = await notice.refetch();
              if (latest.isError) {
                // The answer to the press, which the form keeps through: not the refresh warning
                // above (which says what is shown is the last read — the form shows the draft).
                toaster.create({ type: 'error', title: copy.errUnknown });
                return;
              }
              setGeneration((count) => count + 1);
            }}
          />
        )}
      </NoticeWriterGate>
      <NoticeHistory noticeId={notice.data.id} />
    </Stack>
  );
}

/**
 * Whether the notice is pinned and since when, with 고정 or 고정 해제 and — while it is pinned —
 * 공지 보기. Both name the admin on screen (`useOperatorId`, ADR-0092), so they wait for
 * `GET /me`; the cookie of another account is refused (`copy.sessionChanged`) and the session
 * asked again.
 */
function PinCard({ notice }: { notice: AdminNotice }) {
  const pin = usePinNotice();
  const unpin = useUnpinNotice();
  const operatorId = useOperatorId();
  const busy = pin.isPending || unpin.isPending || operatorId === undefined;
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
            {/* Only a pinned notice has a public page (owner decision 2026-10-21). */}
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
                loading={unpin.isPending}
                disabled={busy}
                onClick={() => {
                  if (operatorId === undefined) return;
                  unpin.mutate(
                    { noticeId: notice.id, expectedAccountId: operatorId },
                    {
                      onSuccess: () =>
                        toaster.create({ type: 'success', title: copy.adminNoticeUnpinnedToast }),
                      onError,
                    },
                  );
                }}
                data-testid="admin-notice-unpin"
              >
                {copy.adminNoticeUnpin}
              </Button>
            ) : (
              <Button
                size="sm"
                loading={pin.isPending}
                disabled={busy}
                onClick={() => {
                  if (operatorId === undefined) return;
                  pin.mutate(
                    { noticeId: notice.id, expectedAccountId: operatorId },
                    {
                      onSuccess: () =>
                        toaster.create({ type: 'success', title: copy.adminNoticePinnedToast }),
                      onError,
                    },
                  );
                }}
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

/**
 * The title and the body, filled with the notice's, saved over it with the version the form was
 * opened from (`opened`: the notice's `editedAt` then, moved to each save's answer — never by a
 * refresh in the background, which the draft does not follow). A save another save overtook —
 * whoever made it — is refused: the refusal says so above the button with 최신 내용 불러오기
 * (`onReload`), and what is typed stays until then. The editor draws the notice's images through
 * the admin route, which serves them pinned or not.
 *
 * Leaving with something changed asks first ('쓰던 내용이 사라집니다. 나갈까요?', owner decision
 * 2026-10-21 8), and a link's leave keeps nothing. The screen stays on the form after a save, and
 * what a save sent is the form's start from then on (`saved`, `PostForm`): leaving after it asks
 * nothing until something changes again. A refused save keeps it changed. The onboarding gate's
 * move asks nothing and keeps what was typed in this tab for an hour, with the version it was
 * typed on (오너 결정 2026-10-21 (3차), ADR-0077 decision 8-20 — the key `notice-edit` per notice): the
 * screen opened again after the step takes it back, and its save sends that version
 * (`PostFormValues['version']`) — not the one the screen opened on after the step — so a save made
 * meanwhile still refuses it. A discard puts back the notice as this form opened on it (`base`),
 * whose version `opened` still is: nothing taken back is left once a save lands.
 */
function EditForm({
  notice,
  accountId,
  autoFocusTitle,
  onReload,
}: {
  notice: AdminNotice;
  /** The admin on screen (`NoticeWriterGate`). */
  accountId: string;
  autoFocusTitle: boolean;
  onReload: () => Promise<void>;
}) {
  const update = useUpdateNotice();
  // The notice as the form opened on it: what a discard of a draft taken back draws again (not a
  // copy read since in the background, whose version the form does not hold).
  const [base] = useState(notice);
  const [opened, setOpened] = useState(base.editedAt);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const imageSrc = useCallback(
    (mediaId: string) => adminNoticeImagePath(notice.id, mediaId),
    [notice.id],
  );
  return (
    <PostForm
      notice={NOTICE_FORM}
      initialTitle={base.title}
      initialDocument={base.body}
      // As the new notice's form: kept across the onboarding gate's move only.
      draftKey={{ kind: 'notice-edit', noticeId: base.id }}
      draftVersion={opened}
      accountId={accountId}
      submitLabel={copy.adminNoticeSave}
      pending={update.isPending || reloading}
      saved={update.isSuccess}
      errorMessage={refusal}
      refusedImageIds={refusedImageIds(update.error)}
      imageSrc={imageSrc}
      autoFocusTitle={autoFocusTitle}
      errorAction={
        conflict ? (
          <Stack gap="2" mt="2" align="flex-start">
            <Text fontSize="sm">{copy.adminNoticeEditConflictHint}</Text>
            <Button
              size="sm"
              variant="outline"
              loading={reloading}
              onClick={() => {
                setReloading(true);
                void onReload().finally(() => setReloading(false));
              }}
              data-testid="admin-notice-reload"
            >
              {copy.adminNoticeReloadLatest}
            </Button>
          </Stack>
        ) : undefined
      }
      onSubmit={({ title, body, version }) => {
        if (title === null) return; // the form sends nothing without a title
        setRefusal(undefined);
        setConflict(false);
        update.mutate(
          // The version what is sent was typed on: a draft taken back's own, else `opened` (null
          // is a version — never edited — so it is not replaced).
          {
            noticeId: notice.id,
            title,
            body,
            expectedEditedAt: version === undefined ? opened : version,
            // The admin the form is drawn for: the save names it (`expectedAccountId`,
            // ADR-0092) and its landing is that admin's.
            accountId,
          },
          {
            onSuccess: (result) => {
              // This save's version is the one the form now holds.
              setOpened(result.notice.editedAt);
              // What the server did, not a guess (`noticeSaveToast`).
              toaster.create(noticeSaveToast(result));
            },
            onError: (error) => {
              setConflict(noticeEditConflict(error));
              setRefusal(noticeWriteErrorMessage(error));
            },
          },
        );
      }}
    />
  );
}
