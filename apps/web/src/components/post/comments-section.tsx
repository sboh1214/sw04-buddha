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
import { useQueryClient } from '@tanstack/react-query';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  type CommentBoxDialogRef,
  type CommentBoxRootRef,
  CommentBoxGoingContext,
  keepSectionTextsForStep,
  useCommentBoxDraft,
  useCommentDraftsTakenBack,
} from '@/hooks/use-comment-draft';
import {
  useComments,
  useCreateComment,
  useDeleteComment,
  useUpdateComment,
} from '@/hooks/use-comments';
import { useLeaveGuard } from '@/hooks/use-leave-guard';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { useOnboardingEntry } from '@/hooks/use-onboarding-entry';
import { usePostWriter } from '@/hooks/use-posts';
import {
  type CommentThread,
  type Me,
  type Post,
  type PostComment,
  type PublishedComment,
} from '@/lib/api';
import {
  type CommentDraftKey,
  commentDraftStorageKey,
  hasCommentDrafts,
} from '@/lib/comment-drafts';
import {
  type CommentsPostState,
  type HeldText,
  type HeldTextPlace,
  type ResolvedCommentDrafts,
  commentCountText,
  commentDraft,
  commentLengthText,
  commentPlaceholderMessage,
  commentTextChanged,
  commentThreadsOf,
  commentWriteErrorMessage,
  commentsClosedMessage,
  placeHeldTexts,
  postCommentsKey,
  resolveCommentDrafts,
} from '@/lib/comments';
import { loginPathBackTo } from '@/lib/next-path';
import { isOwnPost, postKey, postPath, postReadErrorMessage } from '@/lib/posts';
import { useSession } from '@/lib/use-session';
import { CommentText } from './comment-text';
import { HeldCommentText, useHeldCommentTexts } from './held-comment-text';
import { PostByline } from './post-author';

/** Who reads the page, once `GET /me` has said: the account the writes name and its public id. */
interface Viewer {
  accountId: string;
  publicId: string;
}

/** Placeholders at a comment's height while the first page loads. */
const SKELETON_ROWS = [0, 1];

const NOTHING_TAKEN_BACK: ResolvedCommentDrafts = {
  comment: undefined,
  replies: new Map(),
  edits: new Map(),
  unplaced: [],
  waiting: false,
};

/** What every thread is handed alike. */
interface ThreadContext {
  postId: string;
  viewer: Viewer | undefined;
  /** The post takes new comments. */
  open: boolean;
  /**
   * The account's onboarding step left, coming back to this post (`useOnboardingEntry`): set, every
   * comment write goes there first — 답글, 수정, and a box's 올리기·저장 (오너 결정 2026-10-20 답 3).
   */
  stepPath: string | undefined;
  /** Drafts taken back after a step, for the boxes to open with (`resolveCommentDrafts`). */
  takenBack: ResolvedCommentDrafts;
  /** A box took its draft. */
  onTaken: (key: CommentDraftKey) => void;
  onCloseHeld: (id: string) => void;
  /** The focus to the comments' heading: where it goes when nothing nearer is left. */
  focusHeading: () => void;
}

/**
 * A post's comments (#48, ADR-0074), under the post — or under its placeholder: the comments of a
 * hidden post and of a deleted one stay readable (N04 §6: the replies keep their context). The
 * heading counts what the public reads ('댓글 N', the post's `commentCount`). Each 댓글 comes with
 * every 대댓글 under it, both oldest first (#45-2), 20 댓글 a page with 더 보기; then the box for a
 * new 댓글.
 *
 * The box is for an account that `GET /me` names — a visitor reads and is asked to sign in, coming
 * back to this post (N05 §2 «비로그인 열람, 로그인 작성»); a later read of `GET /me` that fails
 * keeps it while the account it named is held, as the 답글 and 수정 boxes stay (only a first read
 * that failed says '내 정보를 불러오지 못했습니다.'); an account with onboarding steps left
 * is taken to its step and back by the onboarding gate (#57-8) — except one facing a re-consent
 * alone, for which this page is exempt (`ONBOARDING_EXEMPT_PAGES`, ADR-0073) so it can delete its
 * own comments with a session alone: its comment writes go to that step first and come back here
 * (`stepPath`, 오너 결정 2026-10-20 답 3). A hidden or deleted post takes no comment (#45-5): its
 * box is a sentence saying so. Nothing personal is in the HTML: the first page is public and
 * seeded by the server, whose own and whose 답글 are decided here once `GET /me` has answered.
 *
 * What a box holds is kept on the ways the owner decided (오너 결정 2026-10-20 답 1·2·4,
 * 2026-10-21 답 1·2·3): leaving the page with text in a box asks first (`useCommentBoxDraft`), and
 * so does a 답글 or 수정 box's 취소 (`CommentBox`); going to an onboarding step keeps each box's
 * text in this tab, and this page takes it back into its box after the step
 * (`useCommentDraftsTakenBack`, reading on through the pages for a thread not read yet) — or, when
 * that box can no longer open, shows it apart with why; and a box the thread read again no longer
 * holds — its write refused or in flight, or no write at all and its place gone under it (the
 * comment or the post deleted or hidden elsewhere, the writer's own 댓글 deleted under an open
 * 답글) — leaves its text and why it cannot be sent where the box stood until the writer closes
 * them (`useHeldCommentTexts`, for the account on screen only). Leaving while any of that is on
 * screen asks too — and going to a step keeps it in the tab as well, as the draft of the box it
 * stood for, to be shown again after the step (`keepSectionTextsForStep`). A post gone from every
 * view (`gone`, post-screen.tsx) keeps the section for those texts alone — every box goes, its
 * text held with '없거나 삭제된 글입니다.' — and the page is told once none is left
 * (`onNothingHeld`), for its 404.
 */
export function CommentsSection({
  post,
  gone = false,
  onNothingHeld,
  focusGone,
}: {
  post: Post;
  /**
   * The post is out of every view (오너 결정 2026-10-21 답 1): the section shows the texts it holds
   * apart and nothing else, until they are closed.
   */
  gone?: boolean;
  /** Told while `gone` once no text is held apart, nor on its way to be. */
  onNothingHeld?: () => void;
  /** While `gone`: the focus to what the page says instead of the post, from a text closed. */
  focusGone?: () => void;
}) {
  const comments = useComments(post.id);
  const writer = usePostWriter();
  const viewer: Viewer | undefined =
    writer.accountId !== undefined && writer.publicId !== undefined
      ? { accountId: writer.accountId, publicId: writer.publicId }
      : undefined;
  const { stepLeft, entryPath } = useOnboardingEntry();
  const stepPath = stepLeft ? entryPath(postPath(post.id)) : undefined;
  const postState: CommentsPostState = gone ? 'gone' : post.state;
  const open = postState === 'published';
  const threads = useMemo(() => commentThreadsOf(comments.data), [comments.data]);
  const heading = useRef<HTMLHeadingElement>(null);

  const heldTexts = useHeldCommentTexts(viewer?.accountId, { postState, threads });
  const { drafts, take, reads } = useCommentDraftsTakenBack(post.id, viewer?.accountId, stepLeft);
  const viewerPublicId = viewer?.publicId;
  const viewerAccountId = viewer?.accountId;
  // Drafts taken back go where the post and its threads as read after they came back say: what the
  // cache kept from before the step can be older than the step — the server's fresh seed of this
  // page lands in an effect, after the first render — and a box opened by it for a 댓글 deleted
  // meanwhile would go with the next read, and its draft with it, rather than be shown apart.
  const queryClient = useQueryClient();
  const [readAgainFor, setReadAgainFor] = useState(0);
  useEffect(() => {
    if (reads === readAgainFor) return;
    let live = true;
    void Promise.all([
      queryClient.refetchQueries({ queryKey: postKey(post.id), exact: true }),
      queryClient.refetchQueries({ queryKey: postCommentsKey(post.id), exact: true }),
    ]).then(() => {
      if (live) setReadAgainFor(reads);
    });
    return () => {
      live = false;
    };
  }, [reads, readAgainFor, post.id, queryClient]);
  const readAgain = reads === readAgainFor;
  const allRead = comments.isSuccess && !comments.hasNextPage;
  const takenBack = useMemo(
    () =>
      viewerPublicId === undefined || !hasCommentDrafts(drafts)
        ? NOTHING_TAKEN_BACK
        : // A post gone from every view takes none of them: each is held apart, with why.
          postState === 'gone'
          ? resolveCommentDrafts(drafts, {
              postId: post.id.toLowerCase(),
              postState,
              threads: [],
              allRead: true,
              viewerPublicId,
            })
          : !comments.isSuccess || !readAgain
            ? NOTHING_TAKEN_BACK
            : resolveCommentDrafts(drafts, {
                postId: post.id.toLowerCase(),
                postState,
                threads,
                allRead,
                viewerPublicId,
              }),
    [drafts, threads, post.id, postState, allRead, viewerPublicId, comments.isSuccess, readAgain],
  );
  // A draft no box can take any more is shown apart, with why; one whose thread is not read yet
  // reads on (as a new 댓글 does, ADR-0074 7-14).
  const { unplaced, waiting } = takenBack;
  const { hold } = heldTexts;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = comments;
  useEffect(() => {
    if (unplaced.length === 0 || viewerAccountId === undefined) return;
    hold(
      viewerAccountId,
      unplaced.map(({ key, text, reason, place }) => ({
        id: `taken-back:${commentDraftStorageKey(key)}`,
        text,
        reason,
        place,
      })),
    );
    take(unplaced.map(({ key }) => key));
  }, [unplaced, viewerAccountId, hold, take]);
  useEffect(() => {
    if (waiting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [waiting, hasNextPage, isFetchingNextPage, fetchNextPage]);
  useLeaveGuard(heldTexts.held.length > 0 || hasCommentDrafts(drafts), copy.postLeaveConfirm);
  // The same texts, as this render has them, go to a step left as the boxes' texts do (오너 결정
  // 2026-10-20 답 2·4): kept in this tab when the page goes and `['me']` names a step left of this
  // account — a write's entry here going to it, or the gate — and shown again after it.
  const onScreen = useRef({ accountId: viewerAccountId, held: heldTexts.held, drafts });
  useEffect(() => {
    onScreen.current = { accountId: viewerAccountId, held: heldTexts.held, drafts };
  });
  useEffect(
    () => () => {
      keepSectionTextsForStep(
        { postId: post.id, ...onScreen.current },
        queryClient.getQueryData<Me>(ME_QUERY_KEY),
      );
    },
    [post.id, queryClient],
  );

  // A post gone from every view (오너 결정 2026-10-21 답 1): its 404 waits while a text is held
  // apart, or on its way to be — a box that went with its write in flight hears its refusal a
  // moment later (`pageMayGo`). The drafts are a guard: drafts taken back are held in the effects of
  // the render the post goes in, before `pageMayGo` can say yes (its `post-gone` comes from an
  // effect of that render too) — this only covers drafts read in the very render the last held
  // text is closed.
  const nothingHeld = heldTexts.pageMayGo && !hasCommentDrafts(drafts);
  useEffect(() => {
    if (gone && nothingHeld) onNothingHeld?.();
  }, [gone, nothingHeld, onNothingHeld]);

  const placed = placeHeldTexts(gone ? [] : threads, heldTexts.held);
  const onTaken = useCallback((key: CommentDraftKey) => take([key]), [take]);
  const focusHeading = () => {
    if (gone) focusGone?.();
    else heading.current?.focus({ preventScroll: true });
  };
  const onCloseHeld = (id: string) => {
    heldTexts.dismiss(id);
    // The text and its 닫기 are gone: the focus goes to the comments' heading rather than the
    // page's start.
    focusHeading();
  };
  const context: ThreadContext = {
    postId: post.id,
    viewer,
    open,
    stepPath,
    takenBack,
    onTaken,
    onCloseHeld,
    focusHeading,
  };

  // A post gone from every view shows the texts held apart and nothing else — its comments are
  // gone with it — in the same section, each text at the same place in it (`placed.rest`).
  return (
    <CommentBoxGoingContext.Provider value={heldTexts.going}>
      <Stack
        as="section"
        aria-labelledby={gone ? undefined : 'comments-heading'}
        aria-label={gone ? copy.commentsHeading : undefined}
        gap="4"
        data-testid="post-comments"
        data-gone={gone ? '' : undefined}
      >
        {/* A peer of the post's title (`h2`), not one of its body's headings (`h3`–`h5`). */}
        {!gone && (
          <Heading
            ref={heading}
            as="h2"
            id="comments-heading"
            tabIndex={-1}
            textStyle="titleLg"
            data-testid="comments-heading"
          >
            {commentCountText(post.commentCount)}
          </Heading>
        )}
        {!gone && comments.isRefetchError && (
          <Alert.Root status="warning" role="status" data-testid="comments-refresh-failed">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}
        {gone ? null : comments.isPending ? (
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
                context={context}
                thread={thread}
                heldAtEnd={placed.byThread.get(thread.comment.id) ?? []}
                heldByComment={placed.byComment}
              />
            ))}
          </Stack>
        )}
        {!gone && comments.hasNextPage && (
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
        <HeldTexts held={placed.rest} onClose={onCloseHeld} />
        {gone ? null : post.state !== 'published' ? (
          <Text textStyle="bodySm" color="fg.muted" data-testid="comments-closed">
            {commentsClosedMessage(post.state)}
          </Text>
        ) : writer.pending ? (
          <Skeleton height="96px" borderRadius="card" data-testid="comment-composer-pending" />
        ) : writer.failed && viewer === undefined ? (
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
          <CommentComposer
            postId={post.id}
            parentId={null}
            accountId={viewer.accountId}
            stepPath={stepPath}
            takenBack={takenBack.comment}
            onTaken={context.onTaken}
          />
        )}
      </Stack>
    </CommentBoxGoingContext.Provider>
  );
}

/** The held texts of one place, in the order they were held. */
function HeldTexts({
  held,
  onClose,
}: {
  held: readonly HeldText[];
  onClose: (id: string) => void;
}) {
  if (held.length === 0) return null;
  return (
    <Stack gap="3">
      {held.map((text) => (
        <HeldCommentText key={text.id} held={text} onClose={() => onClose(text.id)} />
      ))}
    </Stack>
  );
}

/**
 * A draft handed to a box after an onboarding step (`takenBack`), as the box takes it: once per
 * draft, while rendering, so the box is drawn with it — and then the section is told, so it holds
 * the draft no longer (a box closed and opened again starts afresh).
 */
function useTakenBack(
  takenBack: string | undefined,
  key: CommentDraftKey,
  onTaken: (key: CommentDraftKey) => void,
  apply: (text: string) => void,
): void {
  const [seen, setSeen] = useState<string | undefined>(undefined);
  if (takenBack !== undefined && takenBack !== seen) {
    setSeen(takenBack);
    apply(takenBack);
  }
  const { kind } = key;
  const id = key.kind === 'reply' ? key.parentId : key.kind === 'edit' ? key.commentId : '';
  const postId = key.postId;
  useEffect(() => {
    if (takenBack === undefined) return;
    onTaken(
      kind === 'comment'
        ? { kind, postId }
        : kind === 'reply'
          ? { kind, postId, parentId: id }
          : { kind, postId, commentId: id },
    );
  }, [takenBack, kind, postId, id, onTaken]);
}

/**
 * One 댓글 and its 대댓글 (#45-2). 답글 — on the 댓글 and on each of its 대댓글 alike — opens one box
 * at the end of the thread: a reply to a 대댓글 is another 대댓글 of the same 댓글, so every reply of
 * the thread is written there and sent under the 댓글. Offered to a signed-in reader while the post
 * and the 댓글 are open: a hidden 댓글 or 대댓글 takes none (#45-5), nor does a deleted 댓글 kept as
 * its placeholder (오너 결정 2026-10-20, ADR-0074 7-4). With a step left, 답글 goes to it first
 * (`stepPath`). When the box closes — 취소, or sent — the focus goes back to the 답글 that opened
 * it, rather than to the page's start with the box that held it (WCAG 2.4.3). A reply draft taken
 * back after a step opens the box with it — no 답글 opened it, so closing it puts the focus on the
 * 댓글's own 답글 (or, were that gone, the comments' heading: ADR-0074 7-24).
 */
function Thread({
  context,
  thread,
  heldAtEnd,
  heldByComment,
}: {
  context: ThreadContext;
  thread: CommentThread;
  heldAtEnd: readonly HeldText[];
  heldByComment: ReadonlyMap<string, readonly HeldText[]>;
}) {
  const { postId, viewer, open, stepPath, takenBack, onTaken, onCloseHeld, focusHeading } = context;
  const router = useRouter();
  const [replying, setReplying] = useState(false);
  // The 댓글's own 답글: where the focus goes when no 답글 pressed opened the box.
  const threadReply = useRef<HTMLButtonElement>(null);
  // Bumped by every 답글, so a box already open takes the focus again.
  const [focusSignal, setFocusSignal] = useState(0);
  // The 답글 last pressed: where the focus returns when the box closes.
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  // The text a box opened by a draft taken back starts with.
  const [replyStart, setReplyStart] = useState<string | undefined>(undefined);
  const threadId = thread.comment.id;
  useTakenBack(
    takenBack.replies.get(threadId),
    { kind: 'reply', postId, parentId: threadId },
    onTaken,
    (text) => {
      setReplyStart(text);
      setOpener(null);
      setReplying(true);
    },
  );
  const replyable = open && viewer !== undefined && thread.comment.state === 'published';
  const startReply = (button: HTMLElement) => {
    if (stepPath !== undefined) {
      router.push(stepPath as Route);
      return;
    }
    setOpener(button);
    setReplying(true);
    setFocusSignal((signal) => signal + 1);
  };
  const endReply = () => {
    setReplying(false);
    setReplyStart(undefined);
    // Still on the page (a sent reply keeps the thread, and its 답글 with it).
    if (opener?.isConnected) opener.focus();
    else if (threadReply.current?.isConnected) threadReply.current.focus();
    else focusHeading();
  };
  const replyTo = (comment: PostComment) =>
    replyable && comment.state === 'published' ? startReply : undefined;

  return (
    <Stack as="li" gap="3" data-testid={`comment-thread-${threadId}`}>
      <CommentItem
        context={context}
        comment={thread.comment}
        threadId={threadId}
        onReply={replyTo(thread.comment)}
        replyButton={threadReply}
        held={heldByComment.get(thread.comment.id) ?? []}
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
                    context={context}
                    comment={reply}
                    threadId={threadId}
                    onReply={replyTo(reply)}
                    held={heldByComment.get(reply.id) ?? []}
                  />
                </li>
              ))}
            </Stack>
          )}
          {replying && replyable && viewer !== undefined && (
            <CommentComposer
              postId={postId}
              parentId={threadId}
              accountId={viewer.accountId}
              stepPath={stepPath}
              startText={replyStart}
              focusSignal={focusSignal}
              onDone={endReply}
            />
          )}
        </Stack>
      )}
      <HeldTexts held={heldAtEnd} onClose={onCloseHeld} />
    </Stack>
  );
}

/**
 * A comment as the thread shows it: a placeholder of a deleted 댓글 (with 대댓글 under it) or of a
 * hidden comment — neither names the author nor keeps a word (#45-5) — or the comment itself; and
 * under either, the text an edit of it left when its write was refused (`held`).
 */
function CommentItem({
  context,
  comment,
  threadId,
  onReply,
  replyButton,
  held,
}: {
  context: ThreadContext;
  comment: PostComment;
  threadId: string;
  onReply: ((button: HTMLElement) => void) | undefined;
  /** Its 답글, for the thread's 댓글 (`Thread`). */
  replyButton?: RefObject<HTMLButtonElement | null>;
  held: readonly HeldText[];
}) {
  return (
    <Stack gap="2">
      {comment.state !== 'published' ? (
        <Box as="article" py="1" data-testid={`comment-${comment.id}`} data-state={comment.state}>
          <Text textStyle="bodySm" color="fg.muted" data-testid="comment-placeholder">
            {commentPlaceholderMessage(comment.state)}
          </Text>
        </Box>
      ) : (
        <PublishedCommentItem
          context={context}
          comment={comment}
          threadId={threadId}
          onReply={onReply}
          replyButton={replyButton}
        />
      )}
      <HeldTexts held={held} onClose={context.onCloseHeld} />
    </Stack>
  );
}

/**
 * A published comment: the byline (author, time, 수정됨 — the post's, ADR-0073), the text with its
 * links, and its actions — 답글 where the thread takes one, and for its author 수정 (in place, or
 * the step left first) and 삭제 (asked first, with a session alone). The author is told by the
 * public id of `GET /me` (`isOwnPost`), never in the HTML; the server checks the author on every
 * write. When the edit closes — 취소, or saved — the focus goes back to 수정, as a reply's goes back
 * to 답글. An edit draft taken back after a step opens the edit with it.
 */
function PublishedCommentItem({
  context,
  comment,
  threadId,
  onReply,
  replyButton,
}: {
  context: ThreadContext;
  comment: PublishedComment;
  threadId: string;
  onReply: ((button: HTMLElement) => void) | undefined;
  replyButton: RefObject<HTMLButtonElement | null> | undefined;
}) {
  const { postId, viewer, stepPath, takenBack, onTaken } = context;
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [editStart, setEditStart] = useState<string | undefined>(undefined);
  const own = viewer !== undefined && isOwnPost(comment.author, viewer.publicId);
  useTakenBack(
    takenBack.edits.get(comment.id),
    { kind: 'edit', postId, commentId: comment.id },
    onTaken,
    (text) => {
      setEditStart(text);
      setEditing(true);
    },
  );
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
          threadId={threadId}
          accountId={viewer.accountId}
          stepPath={stepPath}
          startText={editStart}
          onDone={() => {
            refocus.current = true;
            setEditStart(undefined);
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
                  ref={replyButton}
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
                    onClick={() => {
                      if (stepPath !== undefined) router.push(stepPath as Route);
                      else setEditing(true);
                    }}
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
 * A refusal is said under the button — and should the thread read again no longer hold the box,
 * where the box stood (`useCommentBoxDraft`). With a step left, 올리기 goes to it first: the box's
 * text is kept in this tab on the way, and comes back after the step (`stepPath`).
 */
function CommentComposer({
  postId,
  parentId,
  accountId,
  stepPath,
  startText,
  takenBack,
  onTaken,
  focusSignal,
  onDone,
}: {
  postId: string;
  parentId: string | null;
  accountId: string;
  stepPath: string | undefined;
  /** A reply's box opened by a draft taken back: its text. */
  startText?: string;
  /** The new 댓글's box: a draft taken back after a step, as it arrives. */
  takenBack?: string;
  onTaken?: (key: CommentDraftKey) => void;
  /**
   * A reply's box: focused when it opens — unless a draft taken back opened it — and on every 답글
   * after.
   */
  focusSignal?: number;
  /** A reply's box: closes it, after a send or on 취소. */
  onDone?: () => void;
}) {
  const router = useRouter();
  const [text, setText] = useState(startText ?? '');
  const [restored, setRestored] = useState(startText !== undefined);
  const { refetch: refetchSession } = useSession();
  const create = useCreateComment(postId, () => void refetchSession());
  const reply = parentId !== null;
  const key: CommentDraftKey =
    parentId === null
      ? { kind: 'comment', postId: postId.toLowerCase() }
      : { kind: 'reply', postId: postId.toLowerCase(), parentId };
  const place: HeldTextPlace =
    parentId === null ? { kind: 'post' } : { kind: 'thread', threadId: parentId };
  useTakenBack(takenBack, key, onTaken ?? ignoreTaken, (taken) => {
    setText(taken);
    setRestored(true);
  });
  const box = useCommentBoxDraft({
    key,
    accountId,
    text,
    initial: '',
    pending: create.isPending,
    refused: create.isError,
    place,
  });

  return (
    <CommentBox
      text={text}
      onTextChange={setText}
      label={reply ? copy.commentReplyLabel : copy.commentWriteLabel}
      placeholder={reply ? copy.commentReplyPlaceholder : copy.commentWritePlaceholder}
      submitLabel={copy.commentSubmit}
      pending={create.isPending}
      restored={restored}
      errorMessage={
        create.error === null ? undefined : commentWriteErrorMessage(create.error, 'create')
      }
      focusSignal={focusSignal}
      focusOnMount={startText === undefined}
      rootRef={box.rootRef}
      dialogRef={box.dialogRef}
      cancel={
        onDone && {
          asks: commentTextChanged(text, ''),
          drop: box.close,
          close: () => {
            create.reset();
            onDone();
          },
        }
      }
      onSubmit={(draft) => {
        if (stepPath !== undefined) {
          router.push(stepPath as Route);
          return;
        }
        void create
          .mutateAsync({ parentId, body: draft, expectedAccountId: accountId })
          .then(() => {
            box.landed();
            setText('');
            setRestored(false);
            if (onDone !== undefined) {
              // A reply's box closes with its text sent: nothing of it to hold as it goes.
              box.close();
              onDone();
            }
          }, box.refused);
      }}
      testId={reply ? 'reply-composer' : 'comment-composer'}
    />
  );
}

function ignoreTaken(): void {
  // A box opened with its draft (a reply's, an edit's): its opener told the section already.
}

/**
 * The author's edit, in place of the text (#45-4: any time, the text only): the same box with the
 * comment as it stands — or with a draft taken back after a step (`startText`). Saving what it
 * already says closes the box without a request — the server would change nothing and mark nothing
 * edited either. With a step left, 저장 goes to it first, keeping the text (`stepPath`).
 */
function CommentEditForm({
  postId,
  comment,
  threadId,
  accountId,
  stepPath,
  startText,
  onDone,
}: {
  postId: string;
  comment: PublishedComment;
  threadId: string;
  accountId: string;
  stepPath: string | undefined;
  startText: string | undefined;
  onDone: () => void;
}) {
  const router = useRouter();
  const [text, setText] = useState(startText ?? comment.body);
  const { refetch: refetchSession } = useSession();
  const update = useUpdateComment(postId, () => void refetchSession());
  const box = useCommentBoxDraft({
    key: { kind: 'edit', postId: postId.toLowerCase(), commentId: comment.id },
    accountId,
    text,
    initial: comment.body,
    pending: update.isPending,
    refused: update.isError,
    place: { kind: 'comment', commentId: comment.id, threadId },
  });

  return (
    <CommentBox
      text={text}
      onTextChange={setText}
      label={copy.commentEditLabel}
      placeholder={copy.commentWritePlaceholder}
      submitLabel={copy.commentEditSave}
      pending={update.isPending}
      restored={startText !== undefined}
      errorMessage={
        update.error === null ? undefined : commentWriteErrorMessage(update.error, 'edit')
      }
      focusSignal={0}
      focusOnMount={startText === undefined}
      rootRef={box.rootRef}
      dialogRef={box.dialogRef}
      cancel={{ asks: commentTextChanged(text, comment.body), drop: box.close, close: onDone }}
      onSubmit={(draft) => {
        if (stepPath !== undefined) {
          router.push(stepPath as Route);
          return;
        }
        if (draft === comment.body) {
          box.close();
          onDone();
          return;
        }
        void update
          .mutateAsync({ commentId: comment.id, body: draft, expectedAccountId: accountId })
          .then(() => {
            box.landed();
            box.close();
            onDone();
          }, box.refused);
      }}
      testId="comment-edit-form"
    />
  );
}

/**
 * The text box every comment write uses: plain text (no formatting, no images, #45-3), the count
 * under it as the server counts (`commentDraft`: '12 / 1,000자'), and the server's refusal under
 * the buttons. It sends nothing empty or over the limit. Like the post form (ADR-0073), the box is
 * `aria-invalid` past the limit and described by the count and the limit's message, which a polite
 * live region, mounted before it holds anything, announces when it appears. A box holding a draft
 * taken back after an onboarding step says so under it (`restored`) — the page's toast said it
 * once — and is described by it. No field asks for a probability, a position or an order (N05 §2).
 */
function CommentBox({
  text,
  onTextChange,
  label,
  placeholder,
  submitLabel,
  pending,
  restored,
  errorMessage,
  focusSignal,
  focusOnMount = true,
  rootRef,
  dialogRef,
  cancel,
  onSubmit,
  testId,
}: {
  text: string;
  onTextChange: (text: string) => void;
  label: string;
  placeholder: string;
  submitLabel: string;
  pending: boolean;
  restored: boolean;
  errorMessage: string | undefined;
  /** Focus the box on mount and whenever this changes; undefined: never. */
  focusSignal: number | undefined;
  /**
   * False for a box a draft taken back opened: the page does not move the focus into it, only a
   * later change of `focusSignal` does.
   */
  focusOnMount?: boolean;
  /** Follows the focus in it, for the text it may leave (`useCommentBoxDraft`). */
  rootRef: CommentBoxRootRef;
  /** Follows the focus in its 취소's dialog, the box's own (`useCommentBoxDraft`). */
  dialogRef: CommentBoxDialogRef;
  /**
   * 취소, for a 답글's box and an edit (none for the new 댓글's): `asks` while the text differs from
   * what the box started with (오너 결정 2026-10-21 답 3) — then 버리기 in `DiscardTextDialog` is
   * what closes it. `drop`: the writer let the text go, so nothing of it is held from then on
   * (`useCommentBoxDraft`'s `close`); `close`: the box closes, the focus to what opened it.
   */
  cancel: { asks: boolean; drop: () => void; close: () => void } | undefined;
  /** The text as the server will keep it (`commentDraft`). */
  onSubmit: (body: string) => void;
  testId: string;
}) {
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const draft = commentDraft(text);
  const blocked = pending || draft.empty || draft.tooLong;
  useFocusOn(box, focusSignal, focusOnMount);
  // 취소 with a changed text asks first; 버리기 lets the text go at once and closes the box once
  // the dialog is out — its focus back on the box's 취소 first, then where the box's closing puts
  // it (the 답글 or 수정 that opened it), so it never falls to the page with the dialog.
  const [asking, setAsking] = useState(false);
  const closeOnExit = useRef(false);

  return (
    <Stack
      as="form"
      ref={rootRef}
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
        aria-describedby={`${id}-length ${id}-limit${restored ? ` ${id}-restored` : ''}`}
        data-testid="comment-input"
      />
      {restored && (
        <Text
          id={`${id}-restored`}
          textStyle="bodyXs"
          color="fg.muted"
          data-testid="comment-draft-restored"
        >
          {copy.commentDraftRestored}
        </Text>
      )}
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
          {cancel !== undefined && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                if (cancel.asks) {
                  setAsking(true);
                  return;
                }
                cancel.drop();
                cancel.close();
              }}
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
      {cancel !== undefined && (
        <DiscardTextDialog
          open={asking}
          contentRef={dialogRef}
          onKeep={() => setAsking(false)}
          onDiscard={() => {
            // Once: a second click on 버리기 while the dialog closes does nothing more.
            if (!asking) return;
            cancel.drop();
            closeOnExit.current = true;
            setAsking(false);
          }}
          onClosed={() => {
            if (!closeOnExit.current) return;
            closeOnExit.current = false;
            cancel.close();
          }}
        />
      )}
    </Stack>
  );
}

/**
 * What 취소 asks of a 답글 or 수정 box holding a changed text — a restored draft too (오너 결정
 * 2026-10-21 답 3): '쓰던 내용 버리기', '쓰던 내용이 사라집니다. 버릴까요?', 취소 and 버리기 — the
 * post's discard (ADR-0073 3차 답 3) in words, the leave's sentence (오너 결정 2026-10-20 답 1)
 * in its first half. 취소, Escape and a click outside keep the box as it is, the focus back on its
 * 취소; 버리기 closes the box once the dialog is out (`onClosed`), as the post's dialog closes onto
 * the field drawn afresh. A read that takes the box away while the dialog is open takes the dialog
 * with it: the focus in it was the box's (`contentRef`), and goes to the text the box left
 * (ADR-0074 7-25) rather than to the page's start.
 */
function DiscardTextDialog({
  open,
  contentRef,
  onKeep,
  onDiscard,
  onClosed,
}: {
  open: boolean;
  /** On its content: the focus in it is the box's (`CommentBoxDialogRef`). */
  contentRef: CommentBoxDialogRef;
  onKeep: () => void;
  onDiscard: () => void;
  /** The dialog is out of the page (its exit done). */
  onClosed: () => void;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        if (!details.open) onKeep();
      }}
      role="alertdialog"
      lazyMount
      unmountOnExit
      closeOnInteractOutside
      onExitComplete={onClosed}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content ref={contentRef} data-testid="comment-discard-dialog">
            <Dialog.Header>
              <Dialog.Title>{copy.commentDiscardTitle}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Dialog.Description>{copy.commentDiscardQuestion}</Dialog.Description>
            </Dialog.Body>
            <Dialog.Footer>
              <Button
                variant="outline"
                size="sm"
                onClick={onKeep}
                data-testid="comment-discard-cancel"
              >
                {copy.cancel}
              </Button>
              <Button
                size="sm"
                colorPalette="no"
                onClick={onDiscard}
                data-testid="comment-discard-confirm"
              >
                {copy.commentDiscardConfirm}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * Focuses `element` when it mounts (`onMount`) and whenever `signal` changes; never while it is
 * undefined.
 */
function useFocusOn(
  element: RefObject<HTMLElement | null>,
  signal: number | undefined,
  onMount: boolean,
) {
  const [first] = useState(signal);
  useEffect(() => {
    if (signal === undefined || (!onMount && signal === first)) return;
    element.current?.focus();
  }, [element, signal, onMount, first]);
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
