'use client';

import {
  Alert,
  Box,
  Button,
  Dialog,
  HStack,
  Heading,
  Portal,
  Skeleton,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { COMMENT_BODY_MAX_LENGTH } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  useComments,
  useCreateComment,
  useDeleteComment,
  useUpdateComment,
} from '@/hooks/use-comments';
import { usePostWriter } from '@/hooks/use-posts';
import { type CommentThread, type Post, type PostComment, type PublishedComment } from '@/lib/api';
import {
  commentCountText,
  commentDraft,
  commentLengthText,
  commentPlaceholderMessage,
  commentThreadsOf,
  commentWriteErrorMessage,
  commentsClosedMessage,
  isStaleThreadRefusal,
  type CommentWrite,
} from '@/lib/comments';
import { loginPathBackTo } from '@/lib/next-path';
import { isOwnPost, postPath, postReadErrorMessage } from '@/lib/posts';
import { useSession } from '@/lib/use-session';
import { CommentText } from './comment-text';
import { PostByline } from './post-author';

/** Who reads the page, once `GET /me` has said: the account the writes name and its public id. */
interface Viewer {
  accountId: string;
  publicId: string;
}

/** Placeholders at a comment's height while the first page loads. */
const SKELETON_ROWS = [0, 1];

/**
 * A post's comments (#48, ADR-0074), under the post — or under its placeholder: the comments of a
 * hidden post and of a deleted one stay readable (N04 §6: the replies keep their context). The
 * heading counts what the public reads ('댓글 N', the post's `commentCount`). Each 댓글 comes with
 * every 대댓글 under it, both oldest first (#45-2), 20 댓글 a page with 더 보기; then the box for a
 * new 댓글.
 *
 * The box is for an account that `GET /me` names — a visitor reads and is asked to sign in, coming
 * back to this post (N05 §2 «비로그인 열람, 로그인 작성»); an account with onboarding steps left
 * is taken to its step and back by the onboarding gate (#57-8) — except one facing a re-consent
 * alone, for which this page is exempt (`ONBOARDING_EXEMPT_PAGES`, ADR-0073): its boxes still open
 * until they send it to that step (`useOnboardingEntry`, ADR-0074 결과 5), and the server refuses
 * its writes (ONBOARDING_REQUIRED). A hidden or deleted post takes no comment (#45-5): its box is
 * a sentence saying so. Nothing personal is in the HTML: the first page is public and seeded by the
 * server, whose own and whose 답글 are decided here once `GET /me` has answered.
 */
export function CommentsSection({ post }: { post: Post }) {
  const comments = useComments(post.id);
  const writer = usePostWriter();
  const viewer: Viewer | undefined =
    writer.accountId !== undefined && writer.publicId !== undefined
      ? { accountId: writer.accountId, publicId: writer.publicId }
      : undefined;
  const open = post.state === 'published';
  const threads = commentThreadsOf(comments.data);

  return (
    <Stack as="section" aria-labelledby="comments-heading" gap="4" data-testid="post-comments">
      {/* A peer of the post's title (`h2`), not one of its body's headings (`h3`–`h5`). */}
      <Heading as="h2" id="comments-heading" textStyle="titleLg" data-testid="comments-heading">
        {commentCountText(post.commentCount)}
      </Heading>
      {comments.isRefetchError && (
        <Alert.Root status="warning" role="status" data-testid="comments-refresh-failed">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {comments.isPending ? (
        SKELETON_ROWS.map((row) => <Skeleton key={row} height="72px" borderRadius="card" />)
      ) : comments.isLoadingError ? (
        <Stack gap="3" align="flex-start" data-testid="comments-error">
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{postReadErrorMessage(comments.error)}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void comments.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : threads.length === 0 ? (
        <Text textStyle="bodySm" color="fg.muted" data-testid="comments-empty">
          {copy.commentsEmpty}
        </Text>
      ) : (
        <Stack as="ul" gap="5" listStyleType="none" data-testid="comments-list">
          {threads.map((thread) => (
            <Thread
              key={thread.comment.id}
              postId={post.id}
              thread={thread}
              viewer={viewer}
              open={open}
            />
          ))}
        </Stack>
      )}
      {comments.hasNextPage && (
        <Button
          alignSelf="center"
          variant="outline"
          borderRadius="pill"
          borderColor="border.emphasized"
          h="40px"
          px="4"
          textStyle="emphasisSm"
          loading={comments.isFetchingNextPage}
          onClick={() => void comments.fetchNextPage()}
          data-testid="comments-more"
        >
          {copy.loadMore}
        </Button>
      )}
      {post.state !== 'published' ? (
        <Text textStyle="bodySm" color="fg.muted" data-testid="comments-closed">
          {commentsClosedMessage(post.state)}
        </Text>
      ) : writer.pending ? (
        <Skeleton height="96px" borderRadius="card" data-testid="comment-composer-pending" />
      ) : writer.failed ? (
        <Text textStyle="bodySm" color="fg.muted" data-testid="comment-composer-failed">
          {copy.errProfileLoad}
        </Text>
      ) : viewer === undefined ? (
        <EmptyState
          message={copy.commentSignedOut}
          action={
            <Button asChild size="sm" variant="outline">
              <NextLink
                href={loginPathBackTo(postPath(post.id)) as Route}
                data-testid="comment-login"
              >
                {copy.login}
              </NextLink>
            </Button>
          }
          data-testid="comment-signed-out"
        />
      ) : (
        <CommentComposer postId={post.id} parentId={null} accountId={viewer.accountId} />
      )}
    </Stack>
  );
}

/**
 * One 댓글 and its 대댓글 (#45-2). 답글 — on the 댓글 and on each of its 대댓글 alike — opens one box
 * at the end of the thread: a reply to a 대댓글 is another 대댓글 of the same 댓글, so every reply of
 * the thread is written there and sent under the 댓글. Offered to a signed-in reader while the post
 * and the 댓글 are open: a hidden 댓글 or 대댓글 takes none (#45-5), nor does a deleted 댓글 kept as
 * its placeholder (ADR-0074 7-4, a question for the owner). When the box closes — 취소, or sent —
 * the focus goes back to the 답글 that opened it, rather than to the page's start with the box that
 * held it (WCAG 2.4.3).
 */
function Thread({
  postId,
  thread,
  viewer,
  open,
}: {
  postId: string;
  thread: CommentThread;
  viewer: Viewer | undefined;
  open: boolean;
}) {
  const [replying, setReplying] = useState(false);
  // Bumped by every 답글, so a box already open takes the focus again.
  const [focusSignal, setFocusSignal] = useState(0);
  // The 답글 last pressed: where the focus returns when the box closes.
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const replyable = open && viewer !== undefined && thread.comment.state === 'published';
  const startReply = (button: HTMLElement) => {
    setOpener(button);
    setReplying(true);
    setFocusSignal((signal) => signal + 1);
  };
  const endReply = () => {
    setReplying(false);
    // Still on the page (a sent reply keeps the thread, and its 답글 with it).
    if (opener?.isConnected) opener.focus();
  };
  const replyTo = (comment: PostComment) =>
    replyable && comment.state === 'published' ? startReply : undefined;

  return (
    <Stack as="li" gap="3" data-testid={`comment-thread-${thread.comment.id}`}>
      <CommentItem
        postId={postId}
        comment={thread.comment}
        viewer={viewer}
        onReply={replyTo(thread.comment)}
      />
      {(thread.replies.length > 0 || (replying && replyable)) && (
        <Stack
          gap="3"
          ps={{ base: '3', md: '5' }}
          ms={{ base: '1', md: '2' }}
          borderStartWidth="2px"
          borderColor="border.subtle"
        >
          {thread.replies.length > 0 && (
            <Stack
              as="ul"
              gap="3"
              listStyleType="none"
              aria-label={copy.commentsRepliesLabel}
              data-testid="comment-replies"
            >
              {thread.replies.map((reply) => (
                <li key={reply.id}>
                  <CommentItem
                    postId={postId}
                    comment={reply}
                    viewer={viewer}
                    onReply={replyTo(reply)}
                  />
                </li>
              ))}
            </Stack>
          )}
          {replying && replyable && viewer !== undefined && (
            <CommentComposer
              postId={postId}
              parentId={thread.comment.id}
              accountId={viewer.accountId}
              focusSignal={focusSignal}
              onDone={endReply}
            />
          )}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * A comment as the thread shows it: a placeholder of a deleted 댓글 (with 대댓글 under it) or of a
 * hidden comment — neither names the author nor keeps a word (#45-5) — or the comment itself.
 */
function CommentItem({
  postId,
  comment,
  viewer,
  onReply,
}: {
  postId: string;
  comment: PostComment;
  viewer: Viewer | undefined;
  onReply: ((button: HTMLElement) => void) | undefined;
}) {
  if (comment.state !== 'published') {
    return (
      <Box as="article" py="1" data-testid={`comment-${comment.id}`} data-state={comment.state}>
        <Text textStyle="bodySm" color="fg.muted" data-testid="comment-placeholder">
          {commentPlaceholderMessage(comment.state)}
        </Text>
      </Box>
    );
  }
  return (
    <PublishedCommentItem postId={postId} comment={comment} viewer={viewer} onReply={onReply} />
  );
}

/**
 * A published comment: the byline (author, time, 수정됨 — the post's, ADR-0073), the text with its
 * links, and its actions — 답글 where the thread takes one, and for its author 수정 (in place) and
 * 삭제 (asked first). The author is told by the public id of `GET /me` (`isOwnPost`), never in the
 * HTML; the server checks the author on every write. When the edit closes — 취소, or saved — the
 * focus goes back to 수정, as a reply's goes back to 답글.
 */
function PublishedCommentItem({
  postId,
  comment,
  viewer,
  onReply,
}: {
  postId: string;
  comment: PublishedComment;
  viewer: Viewer | undefined;
  onReply: ((button: HTMLElement) => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const own = viewer !== undefined && isOwnPost(comment.author, viewer.publicId);
  // 수정 comes back as a new button when the form closes: focused once it is there.
  const editButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    editButton.current?.focus();
  }, [editing]);

  return (
    <Stack as="article" gap="1.5" data-testid={`comment-${comment.id}`} data-state={comment.state}>
      <PostByline
        author={comment.author}
        createdAt={comment.createdAt}
        editedAt={comment.editedAt}
      />
      {editing && viewer !== undefined ? (
        <CommentEditForm
          postId={postId}
          comment={comment}
          accountId={viewer.accountId}
          onDone={() => {
            refocus.current = true;
            setEditing(false);
          }}
        />
      ) : (
        <>
          <CommentText body={comment.body} />
          {(onReply !== undefined || own) && (
            <HStack gap="1" ms="-2" data-testid="comment-actions">
              {onReply !== undefined && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={(event) => onReply(event.currentTarget)}
                  data-testid="comment-reply"
                >
                  {copy.commentReply}
                </Button>
              )}
              {own && viewer !== undefined && (
                <>
                  <Button
                    ref={editButton}
                    size="xs"
                    variant="ghost"
                    onClick={() => setEditing(true)}
                    data-testid="comment-edit"
                  >
                    {copy.commentEdit}
                  </Button>
                  <DeleteComment postId={postId} comment={comment} accountId={viewer.accountId} />
                </>
              )}
            </HStack>
          )}
        </>
      )}
    </Stack>
  );
}

/**
 * A new 댓글 (`parentId` null) or a 대댓글 of the 댓글 `parentId`: the box, emptied once the server
 * took it. The answer goes into the thread on screen (use-comments.ts); a reply's box then closes.
 * A refusal is said under the button or as a toast (`inlineRefusal`).
 */
function CommentComposer({
  postId,
  parentId,
  accountId,
  focusSignal,
  onDone,
}: {
  postId: string;
  parentId: string | null;
  accountId: string;
  /** A reply's box: focused when it opens and on every 답글 after. */
  focusSignal?: number;
  /** A reply's box: closes it, after a send or on 취소. */
  onDone?: () => void;
}) {
  const [text, setText] = useState('');
  const { refetch: refetchSession } = useSession();
  const create = useCreateComment(postId, () => void refetchSession());
  const reply = parentId !== null;

  return (
    <CommentBox
      text={text}
      onTextChange={setText}
      label={reply ? copy.commentReplyLabel : copy.commentWriteLabel}
      placeholder={reply ? copy.commentReplyPlaceholder : copy.commentWritePlaceholder}
      submitLabel={copy.commentSubmit}
      pending={create.isPending}
      errorMessage={inlineRefusal(create.error, 'create')}
      focusSignal={focusSignal}
      onCancel={onDone}
      onSubmit={(draft) => {
        void create
          .mutateAsync({ parentId, body: draft, expectedAccountId: accountId })
          .then(() => {
            setText('');
            onDone?.();
          }, toastStaleRefusal('create'));
      }}
      testId={reply ? 'reply-composer' : 'comment-composer'}
    />
  );
}

/**
 * The author's edit, in place of the text (#45-4: any time, the text only): the same box with the
 * comment as it stands. Saving what it already says closes the box without a request — the server
 * would change nothing and mark nothing edited either.
 */
function CommentEditForm({
  postId,
  comment,
  accountId,
  onDone,
}: {
  postId: string;
  comment: PublishedComment;
  accountId: string;
  onDone: () => void;
}) {
  const [text, setText] = useState(comment.body);
  const { refetch: refetchSession } = useSession();
  const update = useUpdateComment(postId, () => void refetchSession());

  return (
    <CommentBox
      text={text}
      onTextChange={setText}
      label={copy.commentEditLabel}
      placeholder={copy.commentWritePlaceholder}
      submitLabel={copy.commentEditSave}
      pending={update.isPending}
      errorMessage={inlineRefusal(update.error, 'edit')}
      focusSignal={0}
      onCancel={onDone}
      onSubmit={(draft) => {
        if (draft === comment.body) {
          onDone();
          return;
        }
        void update
          .mutateAsync({ commentId: comment.id, body: draft, expectedAccountId: accountId })
          .then(onDone, toastStaleRefusal('edit'));
      }}
      testId="comment-edit-form"
    />
  );
}

/**
 * Where a refused write is said. A refusal that says the thread is out of date (the post or the
 * 댓글 was hidden or deleted meanwhile, the comment is gone — `isStaleThreadRefusal`) reads the
 * thread again before the mutation settles (use-comments.ts), and the thread it reads no longer
 * holds the box: a reply's 댓글 is a placeholder or gone, an edited comment hidden or gone, the
 * post closed. So that refusal is a toast, raised from the write's promise — which settles whether
 * or not the box is still there — and never under the button; every other refusal is under the
 * button (`inlineRefusal`), where the box and its text still are. The text a removed box held goes
 * with it (ADR-0074 결과 4).
 */
function inlineRefusal(error: Error | null, write: CommentWrite): string | undefined {
  return error === null || isStaleThreadRefusal(error)
    ? undefined
    : commentWriteErrorMessage(error, write);
}

function toastStaleRefusal(write: CommentWrite) {
  return (error: unknown) => {
    if (isStaleThreadRefusal(error)) {
      toaster.create({ type: 'error', title: commentWriteErrorMessage(error, write) });
    }
  };
}

/**
 * The text box every comment write uses: plain text (no formatting, no images, #45-3), the count
 * under it as the server counts (`commentDraft`: '12 / 1,000자'), and the server's refusal under
 * the buttons. It sends nothing empty or over the limit. Like the post form (ADR-0073), the box is
 * `aria-invalid` past the limit and described by the count and the limit's message, which a polite
 * live region, mounted before it holds anything, announces when it appears. No field asks for a
 * probability, a position or an order (N05 §2).
 */
function CommentBox({
  text,
  onTextChange,
  label,
  placeholder,
  submitLabel,
  pending,
  errorMessage,
  focusSignal,
  onCancel,
  onSubmit,
  testId,
}: {
  text: string;
  onTextChange: (text: string) => void;
  label: string;
  placeholder: string;
  submitLabel: string;
  pending: boolean;
  errorMessage: string | undefined;
  /** Focus the box on mount and whenever this changes; undefined: never. */
  focusSignal: number | undefined;
  onCancel: (() => void) | undefined;
  /** The text as the server will keep it (`commentDraft`). */
  onSubmit: (body: string) => void;
  testId: string;
}) {
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const draft = commentDraft(text);
  const blocked = pending || draft.empty || draft.tooLong;

  useEffect(() => {
    if (focusSignal !== undefined) box.current?.focus();
  }, [focusSignal]);

  return (
    <Stack
      as="form"
      gap="2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) onSubmit(draft.body);
      }}
      data-testid={testId}
    >
      <Textarea
        ref={box}
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        aria-label={label}
        placeholder={placeholder}
        rows={3}
        // UTF-16 units: twice the code points, so a box of emoji is never cut short; the count
        // below is the rule, and it keeps counting past it ('1,012 / 1,000자').
        maxLength={COMMENT_BODY_MAX_LENGTH * 2}
        disabled={pending}
        aria-invalid={draft.tooLong}
        aria-describedby={`${id}-length ${id}-limit`}
        data-testid="comment-input"
      />
      <HStack justify="space-between" gap="3" flexWrap="wrap">
        <Text
          as="span"
          id={`${id}-length`}
          textStyle="bodyXs"
          color={draft.tooLong ? 'fg.error' : 'fg.muted'}
          data-testid="comment-length"
        >
          {commentLengthText(draft.length)}
        </Text>
        <HStack gap="2">
          {onCancel !== undefined && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={onCancel}
              data-testid="comment-cancel"
            >
              {copy.cancel}
            </Button>
          )}
          <Button
            type="submit"
            size="sm"
            colorPalette="brand"
            loading={pending}
            disabled={blocked}
            data-testid="comment-submit"
          >
            {submitLabel}
          </Button>
        </HStack>
      </HStack>
      {/* Mounted before anything is in it, so the message is announced when it appears. */}
      <Box id={`${id}-limit`} role="status" aria-live="polite" data-testid="comment-limit">
        {draft.tooLong && (
          <Text textStyle="bodyXs" color="fg.error">
            {copy.errCommentBodyTooLong}
          </Text>
        )}
      </Box>
      {errorMessage !== undefined && (
        <Alert.Root status="error" role="alert" data-testid="comment-error">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{errorMessage}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
    </Stack>
  );
}

/**
 * 삭제 for the author: asked first (never undone, #45-5), then the comment becomes '삭제된
 * 글입니다' while 대댓글 hang under it, or leaves the thread. Deleting one's own needs a session only
 * (owner decision 2026-10-19, as a post's): no onboarding refusal reaches here.
 *
 * The outcome is said from the write's promise, not from per-call callbacks: the answer takes the
 * comment out of the thread (or makes it its placeholder) before the mutation settles, which
 * unmounts this component and the observer such callbacks ride on. The toaster is the page's.
 */
function DeleteComment({
  postId,
  comment,
  accountId,
}: {
  postId: string;
  comment: PublishedComment;
  accountId: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const { refetch: refetchSession } = useSession();
  const remove = useDeleteComment(postId, () => void refetchSession());

  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        colorPalette="no"
        onClick={() => setConfirming(true)}
        data-testid="comment-delete"
      >
        {copy.commentDelete}
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
            <Dialog.Content data-testid="comment-delete-dialog">
              <Dialog.Header>
                <Dialog.Title>{copy.commentDeleteTitle}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text>{copy.commentDeleteBody}</Text>
              </Dialog.Body>
              <Dialog.Footer>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => setConfirming(false)}
                  data-testid="comment-delete-cancel"
                >
                  {copy.cancel}
                </Button>
                <Button
                  size="sm"
                  colorPalette="no"
                  loading={remove.isPending}
                  onClick={() => {
                    void remove
                      .mutateAsync({ commentId: comment.id, expectedAccountId: accountId })
                      .then(
                        () => {
                          setConfirming(false);
                          toaster.create({ type: 'success', title: copy.commentDeletedToast });
                        },
                        (error: unknown) => {
                          setConfirming(false);
                          toaster.create({
                            type: 'error',
                            title: commentWriteErrorMessage(error, 'delete'),
                          });
                        },
                      );
                  }}
                  data-testid="comment-delete-confirm"
                >
                  {copy.commentDeleteConfirm}
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
