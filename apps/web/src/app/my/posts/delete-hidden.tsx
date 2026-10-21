'use client';

import { Button, Dialog, Portal } from '@chakra-ui/react';
import { useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useDeleteMyItem } from '@/hooks/use-authored';
import { usePostWriter } from '@/hooks/use-posts';
import { type AuthoredTab } from '@/lib/authored';
import { commentWriteErrorMessage } from '@/lib/comments';
import { postWriteErrorMessage } from '@/lib/posts';
import { useSession } from '@/lib/use-session';

/** The words of each tab's 삭제: a post's on the 글 tab, a comment's on the 댓글 tab (a 대댓글 too). */
const WORDS = {
  posts: {
    button: copy.postDelete,
    title: copy.postDeleteTitle,
    body: copy.postDeleteBody,
    confirm: copy.postDeleteConfirm,
    done: copy.postDeletedToast,
  },
  comments: {
    button: copy.commentDelete,
    title: copy.commentDeleteTitle,
    body: copy.commentDeleteBody,
    confirm: copy.commentDeleteConfirm,
    done: copy.commentDeletedToast,
  },
} as const satisfies Record<AuthoredTab, Record<string, string>>;

/**
 * 삭제 beside the '숨김' line of an item an operator hid, on MY '내 글' (owner decision 2026-10-22:
 * «숨긴 내 글·댓글 지우기 단추 → MY 내 글 항목('숨김' 줄 옆, 확인 후)에 #51에서»; #45-5: a hidden
 * item cannot be edited, its author may delete it). The post page's and the comment area's 삭제 as
 * they are — the same button, the same confirm dialog and words (`postDelete*`, `commentDelete*`)
 * and the same toasts — so a deletion reads alike wherever it is made. It is never undone (#45-5),
 * so it asks first; once the server answers, the item leaves the list (`deleteMyItemOptions`).
 *
 * The words on screen are '삭제'; the button's accessible name says which item it deletes (`name`,
 * `hiddenDeleteName`), since a list can hold several and each stands before its card. The dialog's
 * warning is its description (`Dialog.Description`, which Ark points `aria-describedby` at), so a
 * screen reader says that the deletion cannot be undone along with the title — as the post page's
 * and the comment area's dialogs do (ADR-0080 7-19).
 *
 * The account the screen shows rides along (`expectedAccountId`, A-PG-24): the button waits for
 * `GET /me` to say which (disabled until then). The outcome is said from the write's promise, not
 * from per-call callbacks: the answer takes the item out of the list before the mutation settles,
 * which unmounts this component and the observer such callbacks ride on (comments-section.tsx's
 * `DeleteComment` does the same). The toaster is the page's.
 */
export function DeleteHiddenItem({
  tab,
  id,
  postId,
  name,
}: {
  tab: AuthoredTab;
  /** The item: the post itself on the 글 tab, the 댓글 or 대댓글 on the 댓글 tab. */
  id: string;
  /** The post the item is or sits under. */
  postId: string;
  /** The button's accessible name: the item, then '삭제' (`hiddenDeleteName`). */
  name: string;
}) {
  const words = WORDS[tab];
  const writer = usePostWriter();
  const { refetch: refetchSession } = useSession();
  const remove = useDeleteMyItem(() => void refetchSession());
  const [confirming, setConfirming] = useState(false);
  const accountId = writer.accountId;

  return (
    <>
      <Button
        size="xs"
        variant="outline"
        colorPalette="no"
        flexShrink="0"
        disabled={accountId === undefined}
        onClick={() => setConfirming(true)}
        aria-label={name}
        data-testid="authored-hidden-delete"
      >
        {words.button}
      </Button>
      <Dialog.Root
        open={confirming}
        onOpenChange={(details) => {
          if (!details.open && !remove.isPending) setConfirming(false);
        }}
        role="alertdialog"
        lazyMount
        unmountOnExit
        closeOnInteractOutside={!remove.isPending}
        closeOnEscape={!remove.isPending}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content data-testid="authored-hidden-delete-dialog">
              <Dialog.Header>
                <Dialog.Title>{words.title}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Dialog.Description color="fg">{words.body}</Dialog.Description>
              </Dialog.Body>
              <Dialog.Footer>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => setConfirming(false)}
                  data-testid="authored-hidden-delete-cancel"
                >
                  {copy.cancel}
                </Button>
                <Button
                  size="sm"
                  colorPalette="no"
                  loading={remove.isPending}
                  onClick={() => {
                    if (accountId === undefined) return;
                    void remove.mutateAsync({ tab, id, postId, expectedAccountId: accountId }).then(
                      () => {
                        setConfirming(false);
                        toaster.create({ type: 'success', title: words.done });
                      },
                      (error: unknown) => {
                        setConfirming(false);
                        toaster.create({
                          type: 'error',
                          title:
                            tab === 'posts'
                              ? postWriteErrorMessage(error)
                              : commentWriteErrorMessage(error, 'delete'),
                        });
                      },
                    );
                  }}
                  data-testid="authored-hidden-delete-confirm"
                >
                  {words.confirm}
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
