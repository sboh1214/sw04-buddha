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
import {
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  readMoreComments,
  readMoreReplies,
  useComments,
  useCreateComment,
  useDeleteComment,
  useMoreReplies,
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
  type RepliesOnScreen,
  type ResolvedCommentDrafts,
  commentCountText,
  commentDraft,
  commentLengthText,
  commentPlaceholderMessage,
  commentTextChanged,
  commentThreadsOf,
  commentWriteErrorMessage,
  commentsClosedMessage,
  draftsHeldOnReadFailure,
  editDraftReadOnMark,
  editDraftsReadOn,
  heldEditsBrought,
  heldEditsReadToTheirEnd,
  placeHeldTexts,
  postCommentsKey,
  repliesOnScreenOf,
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
  waitingThreads: [],
  waitingEdits: [],
};

/**
 * A held text on its way into its edit's box: the held text's id and its text, and the render that
 * brought its 대댓글 (counted, `heldEditsBrought`) — the toast is raised once for each such render
 * whose texts a box took, and none for one whose boxes all kept their own (`useReopened`).
 */
interface Reopened {
  id: string;
  text: string;
  brought: number;
}

/**
 * The held edit texts on their way into their edits' boxes (`heldEditsBrought`), by the comment, for
 * the account they were opened for.
 */
interface Reopening {
  accountId: string | undefined;
  edits: ReadonlyMap<string, Reopened>;
}

const NOTHING_REOPENED: ReadonlyMap<string, Reopened> = new Map();

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
  /**
   * The held edit texts whose 대댓글 a read just brought within the 300 a read of the pages keeps,
   * for their edits to open with, by the comment (오너 결정 2026-10-22 (2차) 답 2·(3차) 답 1) — and
   * the edit's box took the held text, or left it apart (its edit open already, or opened by a
   * draft taken back: `useReopened`).
   */
  reopened: ReadonlyMap<string, Reopened>;
  onReopened: (commentId: string, one: Reopened) => void;
  onReopenSkipped: (commentId: string, one: Reopened) => void;
  onCloseHeld: (id: string) => void;
  /** The focus to the comments' heading: where it goes when nothing nearer is left. */
  focusHeading: () => void;
}

/**
 * A post's comments (#48, ADR-0074), under the post — or under its placeholder: the comments of a
 * hidden post and of a deleted one stay readable (N04 §6: the replies keep their context). The
 * heading counts what the public reads ('댓글 N', the post's `commentCount`). Each 댓글 comes with
 * its first 50 대댓글 and '답글 더 보기' for 50 more at a time, both oldest first (#45-2, 오너 결정
 * 2026-10-21), 20 댓글 a page with 더 보기; then the box for a new 댓글. The comments are read in
 * the browser only (오너 결정 2026-10-21): the server's HTML holds the heading and, until they
 * come, placeholders at a comment's height with '불러오는 중' for a screen reader (`aria-busy`).
 *
 * The box is for an account that `GET /me` names — a visitor reads and is asked to sign in, coming
 * back to this post (N05 §2 «비로그인 열람, 로그인 작성»); a later read of `GET /me` that fails
 * keeps it while the account it named is held, as the 답글 and 수정 boxes stay (only a first read
 * that failed says '내 정보를 불러오지 못했습니다.'); an account with onboarding steps left
 * is taken to its step and back by the onboarding gate (#57-8) — except one facing a re-consent
 * alone, for which this page is exempt (`ONBOARDING_EXEMPT_PAGES`, ADR-0073) so it can delete its
 * own comments with a session alone: its comment writes go to that step first and come back here
 * (`stepPath`, 오너 결정 2026-10-20 답 3). A hidden or deleted post takes no comment (#45-5): its
 * box is a sentence saying so. Nothing personal is decided on the server: whose own and whose 답글
 * are decided here once `GET /me` has answered.
 *
 * What a box holds is kept on the ways the owner decided (오너 결정 2026-10-20 답 1·2·4,
 * 2026-10-21 답 1·2·3): leaving the page with text in a box asks first (`useCommentBoxDraft`), and
 * so does a 답글 or 수정 box's 취소 (`CommentBox`); going to an onboarding step keeps each box's
 * text in this tab, and this page takes it back into its box after the step
 * (`useCommentDraftsTakenBack`, reading on through the pages for a thread not read yet) — or, when
 * that box can no longer open, shows it apart with why; an edit's text shown apart opens in that
 * edit once any read brings its 대댓글 within the 300 a read of the pages keeps (오너 결정
 * 2026-10-22 (2차) 답 2·(3차) 답 1, `heldEditsBrought`); and a box the thread read again no longer
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
  // cache kept from before the step can be older than the step — the server's fresh seed of the
  // post lands in an effect, after the first render, and the comments held in this tab are as old
  // as the step — and a box opened by it for a 댓글 deleted meanwhile would go with the next read,
  // and its draft with it, rather than be shown apart.
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
  // An edit's text held apart — its 대댓글 not among those read (past the 300 a read of the pages
  // keeps, or not found within them), a read that failed, a refusal whose box went with its 대댓글 —
  // opens in that edit once any read brings that 대댓글 onto the screen within those 300 (오너 결정
  // 2026-10-22 (3차) 답 1, `heldEditsBrought`): '답글 더 보기', a new 대댓글's read on through its
  // thread, a read of the comment pages (the window's focus, a write's read), the read on for drafts
  // taken back — the 대댓글 published and the viewer's own, the held text the account on screen's.
  // Its box opens as a draft taken back does — '쓰던 내용을 되살렸습니다.' under it and once in a
  // toast, the focus left where it is — and the held text goes once the box has it (`onReopened`):
  // until then it is not drawn while its 대댓글 is on screen, and stays drawn where it was should that
  // 대댓글 leave first. Otherwise it stays apart, under that 대댓글, with why that edit cannot open
  // (`heldTexts.reason`): hidden, another account's, or past the 300 —
  // '고치던 답글을 다시 열지 못했습니다. 쓰던 내용을 여기 남겨 둡니다.' (3차 답 3's words) — and opens
  // should a later read bring it within them. For a re-consent account too: its 저장 goes to the step
  // (3차 답 2, as a box opened before the step was, 7-23). What a read brought is told from the
  // threads themselves, render to render — what each 대댓글 on screen stood at (`repliesOnScreenOf`)
  // against where it stands now — so every read counts alike and each 대댓글 once, as the render it
  // came in has it: not what a read asked for, nor what the thread did not hold as it was asked (a
  // 대댓글 another read put on screen meanwhile was that read's to bring, and its edit may be open
  // already with what the writer typed since). A 대댓글 on screen past the 300 that an earlier one's
  // going moves within them counts as brought too, whatever moved it: a read of the pages after a
  // deletion elsewhere, or no read at all — the reader's own 삭제 of an earlier 대댓글 of the thread
  // (`withoutComment`; whether that should open the box is asked of the owner, ADR-0074 결과 4).
  // Before the paint (a layout effect), so the held text is not seen under its 대댓글 for a frame
  // before its box. An edit open, or opened by a draft taken back in the same render, keeps what it
  // has, and the held text stays apart (`useReopened`) — and no toast says it was restored: the toast
  // is raised once a box took a held text (`onReopened`), once for what one render brought. That
  // edit can be open: the reader opened 수정 on such a 대댓글 past the 300, its text under it, before
  // it moved within them. The parts with no React in them are `heldEditsBrought` and
  // `repliesOnScreenOf` (comments.test.ts and use-comments.test.ts run them through each read); the
  // e2e runs the rest, but for two guards no test runs: the account check below
  // (`reopening.accountId`) needs another account signed in between the render a read lands in and
  // the next, and the held text left out while it is on its way (`drawn`) is one commit long — a
  // check that the held text is gone passes after that commit with or without it.
  const [reopening, setReopening] = useState<Reopening>({
    accountId: undefined,
    edits: NOTHING_REOPENED,
  });
  const { reason: heldReason, dismiss: dismissHeld } = heldTexts;
  const heldNow = heldTexts.held;
  // The threads as the last render had them, and where their 대댓글 stood then.
  const threadsSeen = useRef<
    { threads: readonly CommentThread[]; replies: RepliesOnScreen } | undefined
  >(undefined);
  // The renders that brought held texts' 대댓글, counted (`Reopened.brought`), and the last of them
  // the toast told.
  const broughtRenders = useRef(0);
  const broughtTold = useRef(0);
  useLayoutEffect(() => {
    const seen = threadsSeen.current;
    if (seen?.threads === threads) return;
    threadsSeen.current = { threads, replies: repliesOnScreenOf(threads) };
    // The first threads drawn bring nothing: no text is held before them.
    if (seen === undefined || gone || viewerAccountId === undefined) return;
    const { open: opening, reasons } = heldEditsBrought(
      heldNow,
      threads,
      seen.replies,
      viewerPublicId,
    );
    for (const { id, reason } of reasons) heldReason(id, reason);
    if (opening.length === 0) return;
    broughtRenders.current += 1;
    const brought = broughtRenders.current;
    setReopening((current) => {
      const edits = new Map(current.accountId === viewerAccountId ? current.edits : []);
      for (const { id, commentId, text } of opening) edits.set(commentId, { id, text, brought });
      return { accountId: viewerAccountId, edits };
    });
  }, [threads, gone, viewerAccountId, viewerPublicId, heldNow, heldReason]);
  // Only for the account they were opened for, and only while their held text is: one closed
  // meanwhile, or gone with another account, opens nothing.
  const heldIds = useMemo(() => new Set(heldNow.map((text) => text.id)), [heldNow]);
  const reopened = useMemo(() => {
    if (viewerAccountId === undefined || reopening.accountId !== viewerAccountId) {
      return NOTHING_REOPENED;
    }
    const live = [...reopening.edits].filter(([, one]) => heldIds.has(one.id));
    return live.length === reopening.edits.size ? reopening.edits : new Map(live);
  }, [reopening, viewerAccountId, heldIds]);
  // The box took the held text — told from its effect — or left it apart: on its way no more.
  const reopenedOnce = useCallback((commentId: string, { id }: Reopened) => {
    setReopening((current) => {
      if (current.edits.get(commentId)?.id !== id) return current;
      const edits = new Map(current.edits);
      edits.delete(commentId);
      return { ...current, edits };
    });
  }, []);
  // Took it: the held text goes, and the toast says it — once for what one render brought, and
  // only for a box that took one (a box that kept its own says nothing restored, ADR-0074 7-30).
  const onReopened = useCallback(
    (commentId: string, one: Reopened) => {
      dismissHeld(one.id);
      reopenedOnce(commentId, one);
      if (one.brought <= broughtTold.current) return;
      broughtTold.current = one.brought;
      toaster.create({ type: 'info', title: copy.commentDraftRestored });
    },
    [dismissHeld, reopenedOnce],
  );
  // An edit draft of a 대댓글 not read yet reads on through its thread's 대댓글, a page at a time
  // ('답글 더 보기', 오너 결정 2026-10-21) — one thread at a time, and never past the 300 대댓글 a read
  // of the pages keeps (오너 결정 2026-10-22 답 5 and (2차) 답 1, `editDraftsReadOn`): a draft its
  // thread did not show within them is shown apart, with
  // '고치던 답글을 목록에서 찾지 못했습니다. 지워졌거나 아직 불러오지 않은 답글입니다.', until the
  // writer closes it — at once, nothing read, when the thread holds them already (the comments kept
  // in this tab across the step, read again on the way back as far as the screen had them; a step
  // done in another tab). The pages this read reads for a set of drafts (`reads`) are counted too,
  // five at most a thread — they bind only pages the thread did not take (ADR-0074 7-28). A held
  // edit text whose 대댓글 a page of it brings within the 300 opens in its edit, as after any read
  // (`heldEditsBrought` above, 오너 결정 2026-10-22 (3차) 답 1). A read that fails shows each
  // draft waiting on that thread apart, with the read's failure as why, until the writer closes it
  // (오너 결정 2026-10-21 (2차) 답 2, `draftsHeldOnReadFailure`): the toast said the text was
  // restored, and it would otherwise wait unseen behind the thread's button. Both only for what
  // still waits then — a draft its box took meanwhile is not shown twice — and for the account on
  // screen then: the pages read are judged once the read is over, by the render it brought, and a
  // failure by the drafts of the last render. That render may list none — the comment pages being
  // read again, or a read again of a new set of drafts on its way — so the failure is kept, with
  // the cursor it read from, for the drafts of that set (`failedReadsOn`): those that wait on the
  // thread still at that cursor once the page lists them again are shown apart with it, and that
  // cursor is not read again for them. A thread that left every view (NOT_FOUND) is read again by
  // `readMoreReplies`: it goes, and the draft is shown apart with why once the pages are read.
  const readingOn = useRef(false);
  const pagesReadOn = useRef(new Map<string, number>());
  const failedReadsOn = useRef(new Map<string, string>());
  const [readOnRound, setReadOnRound] = useState(0);
  const waitingNow = useRef({ waitingEdits: takenBack.waitingEdits, accountId: viewerAccountId });
  useEffect(() => {
    waitingNow.current = { waitingEdits: takenBack.waitingEdits, accountId: viewerAccountId };
  });
  useEffect(() => {
    if (readingOn.current) return;
    // A thread, or one of its cursors (`editDraftReadOnMark`), within this set of drafts.
    const roundOf = (mark: string) => `${String(reads)}:${mark}`;
    const pagesRead = (threadId: string) => pagesReadOn.current.get(roundOf(threadId)) ?? 0;
    const { read: next, past } = editDraftsReadOn(threads, takenBack, {
      pagesRead,
      failed: (mark) => failedReadsOn.current.get(roundOf(mark)),
    });
    if (past.length > 0 && viewerAccountId !== undefined) {
      hold(
        viewerAccountId,
        past.map(({ key, text, reason, place }) => ({
          id: `taken-back:${commentDraftStorageKey(key)}`,
          text,
          reason,
          place,
        })),
      );
      take(past.map(({ key }) => key));
    }
    if (next === undefined) return;
    readingOn.current = true;
    const threadId = next.comment.id;
    const readFrom = roundOf(editDraftReadOnMark(next));
    pagesReadOn.current.set(roundOf(threadId), pagesRead(threadId) + 1);
    void readMoreReplies(queryClient, post.id, threadId)
      .catch((error: unknown) => {
        const reason = postReadErrorMessage(error);
        failedReadsOn.current.set(readFrom, reason);
        const { waitingEdits, accountId } = waitingNow.current;
        const failed = draftsHeldOnReadFailure(waitingEdits, threadId, reason);
        if (failed.length === 0 || accountId === undefined) return;
        hold(
          accountId,
          failed.map(({ key, text, place }) => ({
            id: `taken-back:${commentDraftStorageKey(key)}`,
            text,
            reason,
            place,
          })),
        );
        take(failed.map(({ key }) => key));
      })
      .finally(() => {
        readingOn.current = false;
        setReadOnRound((round) => round + 1);
      });
  }, [takenBack, threads, reads, viewerAccountId, queryClient, post.id, readOnRound, hold, take]);
  // A held edit text of a 대댓글 whose thread is now read to its end without it says it is gone —
  // '없거나 삭제된 댓글입니다.', read out as new — rather than '…아직 불러오지 않은 답글입니다.' or a
  // read's failure (`heldEditsReadToTheirEnd`): a deleted 대댓글 is in no page, so no read brings it
  // for `heldEditsBrought` to say so. Whatever read ended the thread: the reader's '답글 더 보기', or a
  // read of the pages (a deletion meanwhile brought the thread within what it reads on). Not for a
  // post out of every view — its texts say the post is gone.
  const readToTheirEnd = useMemo(
    () => heldEditsReadToTheirEnd(gone ? [] : threads, heldTexts.held),
    [gone, threads, heldTexts.held],
  );
  useEffect(() => {
    for (const { id, reason } of readToTheirEnd) heldReason(id, reason);
  }, [readToTheirEnd, heldReason]);
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

  // A held text on its way into its edit's box is not drawn while that box can take it.
  const repliesOnScreen = useMemo(
    () => new Set(threads.flatMap((thread) => thread.replies.map((reply) => reply.id))),
    [threads],
  );
  const drawn = heldTexts.held.filter(
    (text) =>
      text.place.kind !== 'comment' ||
      reopened.get(text.place.commentId)?.id !== text.id ||
      !repliesOnScreen.has(text.place.commentId),
  );
  const placed = placeHeldTexts(gone ? [] : threads, drawn);
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
    reopened,
    onReopened,
    onReopenSkipped: reopenedOnce,
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
          // Every visit starts here — the server's HTML too, the comments being the browser's to
          // read — so the wait is named for a screen reader as well as drawn: '불러오는 중' under
          // '댓글 N', busy until the comments come (the 토론 section's way, #47).
          <Stack gap="4" aria-busy="true" data-testid="comments-loading">
            <Text srOnly>{copy.loading}</Text>
            {SKELETON_ROWS.map((row) => (
              <Skeleton key={row} height="72px" borderRadius="card" />
            ))}
          </Stack>
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
            onClick={() => void readMoreComments(comments)}
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
 * A held edit text on its way into this comment's edit (`reopened`, 오너 결정 2026-10-22 (2차) 답 2·
 * (3차) 답 1),
 * as the comment takes it: once, while rendering, so the box is drawn with it — unless the edit is
 * open already or a draft taken back opens it in this very render (`busy`): that box keeps what it
 * has, and the held text stays apart where it is drawn, rather than going with nothing to show for
 * it, and no toast says it was restored (ADR-0074 7-30). Either way the section is told after the
 * commit: the box took it (`onReopened`, the held text closed and the toast raised) or left it
 * (`onSkipped`, drawn again).
 */
function useReopened(
  reopen: Reopened | undefined,
  busy: boolean,
  commentId: string,
  open: (text: string) => void,
  onReopened: (commentId: string, one: Reopened) => void,
  onSkipped: (commentId: string, one: Reopened) => void,
): void {
  const [seen, setSeen] = useState<{ one: Reopened; opened: boolean } | undefined>(undefined);
  if (reopen !== undefined && reopen !== seen?.one) {
    setSeen({ one: reopen, opened: !busy });
    if (!busy) open(reopen.text);
  }
  const decided = reopen !== undefined && seen?.one === reopen ? seen : undefined;
  useEffect(() => {
    if (decided === undefined) return;
    (decided.opened ? onReopened : onSkipped)(commentId, decided.one);
  }, [decided, commentId, onReopened, onSkipped]);
}

/**
 * One 댓글 and its 대댓글 (#45-2): the first 50 and '답글 더 보기' for 50 more at a time while more
 * follow (오너 결정 2026-10-21). 답글 — on the 댓글 and on each of its 대댓글 alike — opens one box
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
  const more = useMoreReplies(postId, threadId);
  const moreToRead = thread.repliesNextCursor !== null;

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
      {(thread.replies.length > 0 || moreToRead || (replying && replyable)) && (
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
          {/* The 대댓글 after the first 50, 50 at a time (오너 결정 2026-10-21); a read pressed that
              failed says why above the button that reads again (the owner's answer of 2026-10-20
              for every 더 보기, which #47 brings to the comment list's own; ADR-0074 7-28). The
              section's own read for a draft taken back shows the draft apart instead, when it
              fails (2026-10-21 (2차) 답 2) or the thread holds its 300 without it (2026-10-22 답 5,
              (2차) 답 1). A held edit text whose 대댓글 a press brings within the 300 opens in that
              edit, as after any read (2026-10-22 (2차) 답 2·(3차) 답 1, the section's
              `heldEditsBrought`). */}
          {moreToRead && (
            <Stack gap="2" align="flex-start">
              {more.isError && (
                <Alert.Root status="error" role="alert" data-testid="comment-replies-more-failed">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{postReadErrorMessage(more.error)}</Alert.Description>
                  </Alert.Content>
                </Alert.Root>
              )}
              <Button
                size="xs"
                variant="outline"
                borderRadius="pill"
                borderColor="border.emphasized"
                loading={more.isPending}
                onClick={() => more.mutate()}
                data-testid="comment-replies-more"
              >
                {copy.commentRepliesMore}
              </Button>
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
 * to 답글. An edit draft taken back after a step opens the edit with it, and so does an edit's text
 * held apart until a read brought this 대댓글 within the 300 a read of the pages keeps (`reopened`,
 * 오너 결정 2026-10-22 (2차) 답 2·(3차) 답 1).
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
  const { postId, viewer, stepPath, takenBack, onTaken, reopened, onReopened, onReopenSkipped } =
    context;
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [editStart, setEditStart] = useState<string | undefined>(undefined);
  const own = viewer !== undefined && isOwnPost(comment.author, viewer.publicId);
  const startEdit = (text: string) => {
    setEditStart(text);
    setEditing(true);
  };
  const draftTakenBack = takenBack.edits.get(comment.id);
  useTakenBack(
    draftTakenBack,
    { kind: 'edit', postId, commentId: comment.id, threadId },
    onTaken,
    startEdit,
  );
  useReopened(
    reopened.get(comment.id),
    editing || draftTakenBack !== undefined,
    comment.id,
    startEdit,
    onReopened,
    onReopenSkipped,
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
    key: { kind: 'edit', postId: postId.toLowerCase(), commentId: comment.id, threadId },
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
