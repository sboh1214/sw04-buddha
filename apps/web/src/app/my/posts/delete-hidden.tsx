'use client';

import { Button, Dialog, Portal, Text } from '@chakra-ui/react';
import { useId, useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useDeleteMyItem } from '@/hooks/use-authored';
import { usePostWriter } from '@/hooks/use-posts';
import {
  type AuthoredTab,
  type HiddenItem,
  hiddenDeleteName,
  hiddenItemName,
} from '@/lib/authored';
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
 * Both say which item (owner decision 2026-10-22, 3rd: «MY 내 글의 숨긴 항목 삭제 확인창 → 항목을
 * 말함(글 제목/첫 줄·댓글 첫 줄, 단추 이름에도)»), named as `hiddenItemName` names it: the words on
 * screen are '삭제' and the button's accessible name is the item and '삭제' (`hiddenDeleteName`),
 * since a list can hold several and each stands before its card; the dialog shows the item on a
 * line of its own between the title and the warning — what the post page's and the comment area's
 * dialogs have no need of, standing on the item they delete. A screen reader hears the item with
 * the title, as the dialog's name (`aria-labelledby`: the title, then the item's line), and the
 * warning alone as its description (`Dialog.Description`, which Ark points `aria-describedby` at,
 * as the other two dialogs do) — a member's line seldom ends in a stop, and read as one
 * description with the warning it would run on into '삭제한 …' (ADR-0080 7-19). The item is at
 * most the first 300 characters of its text (`hiddenItemName`: `postFirstLine`, `postExcerpt`'s
 * cut), so a longer first line — a comment's can be 1,000 characters — is named by its first 300;
 * on screen it keeps to the three lines a comment's card shows, a cut of the look only, so a
 * screen reader hears all of those 300 and nothing past them.
 *
 * The account the screen shows rides along (`expectedAccountId`, A-PG-24): the button waits for
 * `GET /me` to say which (disabled until then). The outcome is said from the write's promise, not
 * from per-call callbacks: the answer takes the item out of the list before the mutation settles,
 * which unmounts this component and the observer such callbacks ride on (comments-section.tsx's
 * `DeleteComment` does the same). The toaster is the page's.
 */
export function DeleteHiddenItem({
  id,
  postId,
  item,
}: {
  /** The item: the post itself on the 글 tab, the 댓글 or 대댓글 on the 댓글 tab. */
  id: string;
  /** The post the item is or sits under. */
  postId: string;
  /** What names the item, and its tab (`hiddenItemName`). */
  item: HiddenItem;
}) {
  const tab: AuthoredTab = item.tab;
  const words = WORDS[tab];
  const writer = usePostWriter();
  const { refetch: refetchSession } = useSession();
  const remove = useDeleteMyItem(() => void refetchSession());
  const [confirming, setConfirming] = useState(false);
  const accountId = writer.accountId;
  const titleId = useId();
  const itemId = useId();

  return (
    <>
      <Button
        size="xs"
        variant="outline"
        colorPalette="no"
        flexShrink="0"
        disabled={accountId === undefined}
        onClick={() => setConfirming(true)}
        aria-label={hiddenDeleteName(item)}
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
        ids={{ title: titleId }}
        lazyMount
        unmountOnExit
        closeOnInteractOutside={!remove.isPending}
        closeOnEscape={!remove.isPending}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content
              aria-labelledby={`${titleId} ${itemId}`}
              data-testid="authored-hidden-delete-dialog"
            >
              <Dialog.Header>
                <Dialog.Title>{words.title}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body display="flex" flexDirection="column" gap="2">
                <Text
                  id={itemId}
                  color="fg"
                  fontWeight="medium"
                  lineClamp="3"
                  overflowWrap="anywhere"
                  data-testid="authored-hidden-delete-item"
                >
                  {hiddenItemName(item)}
                </Text>
                <Dialog.Description color="fg" data-testid="authored-hidden-delete-description">
                  {words.body}
                </Dialog.Description>
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
