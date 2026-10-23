import {
  COMMENT_BODY_MAX_LENGTH,
  COMMENT_NOT_ALLOWED_REASONS,
  COMMENT_REPLIES_PAGE_SIZE,
  codePointLength,
  commentBodyRefusalOf,
  normaliseCommentBody,
  type CommentNotAllowedReason,
} from '@buddha/shared';
import { type InfiniteData } from '@tanstack/react-query';
import { copy } from '@/copy';
import { type CommentDraftKey, type CommentDrafts } from './comment-drafts';
import {
  type CommentDeletion,
  type CommentThread,
  type Post,
  type PostComment,
  type PublishedComment,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';
import { POSTS_KEY, isOwnPost } from './posts';

/**
 * 댓글·대댓글 (#48, ADR-0074) as the post page reads them: the cache key and request of a post's
 * comment threads, what the author's own writes do to the pages held, how a draft is counted and
 * what a refusal says. Pure functions of the API's answers, apart from the components and the hooks
 * so the node test runner reaches them.
 *
 * Owner decisions (ADR-0069 decision 2, #45): under a post hang 댓글 and under a 댓글 hang 대댓글 —
 * no third layer, a reply to a 대댓글 is another 대댓글 of the same 댓글 (#45-2) — both oldest first
 * (작성 순). A comment is plain text whose http(s) addresses show as links, at most 1,000
 * characters, its line breaks kept (#45-3); its author edits it at any time ('수정됨', #45-4) and
 * deletes it, a 댓글 with 대댓글 under it staying as '삭제된 글입니다' (#45-5). A hidden comment is
 * its placeholder and takes no 대댓글; a hidden or deleted post takes no comment. Anyone reads, an
 * account that finished the onboarding writes (#57-8), deleting one's own needs a session only
 * (owner decision 2026-10-19, as a post's).
 */

// ---- cache key and request ------------------------------------------------------------------

/**
 * A post's comment threads, under the posts' root: public like the post (N05 §2), but read in the
 * browser only — the post page does not read them on the server (오너 결정 2026-10-21, ADR-0074:
 * the web's own requests are not held to the per-address limit, so a page drawn for anyone must
 * not read what a thread holds). Apart from `postKey` (`['posts', 'post', id]`) so neither
 * invalidates the other by prefix.
 */
export const postCommentsKey = (postId: string) =>
  [...POSTS_KEY, 'comments', postId.toLowerCase()] as const;

/**
 * One page of `GET /posts/:postId/comments`: up to 20 댓글, each with its first 50 대댓글 and the
 * cursor of the rest (`repliesNextCursor`). A thread the page holds may carry more 대댓글 than its
 * answer did: those '답글 더 보기' read (`withMoreReplies`), kept by every later read of the page
 * (`threadsReadOn`, hooks/use-comments.ts).
 */
export interface CommentPage {
  items: CommentThread[];
  nextCursor: string | null;
}

/** One page of `GET /comments/:commentId/replies`: up to 50 대댓글 of one 댓글, oldest first. */
export interface ReplyPage {
  items: PostComment[];
  nextCursor: string | null;
}

/** The pages as `useInfiniteQuery` holds them (the page params are its own business). */
export type CommentPages = InfiniteData<CommentPage>;

/**
 * The query of one page, as the browser's `queryFn` sends it (and through it `readOnToTheEnd`):
 * the cursor when there is one, nothing else — the page size is the API's default and bound,
 * COMMENT_PAGE_LIMIT (20).
 */
export function commentPageQuery(cursor?: string): { cursor?: string } {
  return cursor === undefined ? {} : { cursor };
}

/**
 * The threads the pages hold, in order. A thread is drawn once, where it last appears: a 댓글 the
 * author just wrote is put at the end of the pages already read when its own page could not be
 * read (`withNewComment`, the hooks' fallback), and if older pages were still to come, the page
 * that holds it in the server's order arrives later — there it stays, after the 댓글 written
 * before it.
 */
export function commentThreadsOf(pages: CommentPages | undefined): CommentThread[] {
  return lastOfEach(
    pages?.pages.flatMap((page) => page.items) ?? [],
    (thread) => thread.comment.id,
  );
}

/** `items` with each id where it last appears, in order. */
function lastOfEach<T>(items: readonly T[], idOf: (item: T) => string): T[] {
  const last = new Map<string, number>();
  items.forEach((item, index) => last.set(idOf(item), index));
  return items.filter((item, index) => last.get(idOf(item)) === index);
}

/**
 * The 대댓글 of a thread with a page read after them, each where it last appears: the page goes
 * after what is held, and a 대댓글 the writer just wrote — put at the end of the replies held when
 * the pages before it could not be read (`withNewComment`) — stays where its page puts it, after
 * the 대댓글 written before it, as `commentThreadsOf` keeps a 댓글.
 */
function repliesWith(held: readonly PostComment[], more: readonly PostComment[]): PostComment[] {
  return lastOfEach([...held, ...more], (reply) => reply.id);
}

/**
 * The 대댓글 page read from the cursor `from` put in the thread `threadId` (오너 결정 2026-10-21:
 * '답글 더 보기'로 50개씩): after the replies held, the thread's cursor moved on to the page's —
 * as long as the thread is still where the page was read from (its `repliesNextCursor` is `from`).
 * A thread read again meanwhile, or gone, takes nothing: the page could overlap or skip what it now
 * holds, and its own cursor is there to read on from.
 */
export function withMoreReplies(
  pages: CommentPages | undefined,
  threadId: string,
  from: string,
  page: ReplyPage,
): CommentPages | undefined {
  return mapThreads(pages, (thread) =>
    thread.comment.id !== threadId || thread.repliesNextCursor !== from
      ? thread
      : {
          ...thread,
          replies: repliesWith(thread.replies, page.items),
          repliesNextCursor: page.nextCursor,
        },
  );
}

/**
 * The reply pages one read on reads at most for one thread (오너 결정 2026-10-21 (2차) 답 1: 5 pages,
 * 250 대댓글): a new 대댓글's read of its thread's unread 대댓글 (`readOnReplies`) and a read of the
 * comment pages reading a thread on as far as the screen had it (`threadsReadOn`), both in
 * hooks/use-comments.ts — and the post page's read on through a thread for an edit draft taken back
 * after an onboarding step (`editDraftsReadOn`, 오너 결정 2026-10-22 답 5), which reads no further
 * than a read of the pages keeps (REPLIES_KEPT_ON_READ, 오너 결정 2026-10-22 (2차) 답 1). Each page
 * is one request in the reader's address limit (100 a minute with every other request of the page),
 * and none of these reads had a bound before: a thread of thousands could spend the limit — and the
 * address's other requests with it — on one reply, one focus of the window or one draft (ADR-0074
 * 7-28). Past it: a new 대댓글 not reached within it stands at the end of the 대댓글 held, and a
 * thread read again holds its first 50 and the 250 after them — '답글 더 보기' brings the rest, and
 * the new 대댓글 into its place, as after a read that failed; an edit draft not found within them is
 * shown apart, with why (`copy.errCommentEditNotRead`).
 */
export const REPLY_READ_ON_PAGES = 5;

/**
 * The comment pages a new 댓글's read toward its place reads at most (오너 결정 2026-10-23 (2차): 5
 * pages, 100 댓글): `readOnToTheEnd` in hooks/use-comments.ts reads the last page held again and the
 * pages after it until the one that holds the new 댓글 — the last page held counts as one. Each is
 * one request in the reader's address limit (100 a minute with every other request of the page),
 * and the read had no bound before: on a post whose older 댓글 the reader had not opened, some
 * 2,000 of them, it asked for every page between and reached the limit's 429 — spending the
 * address's other requests with it — before falling back (Codex review on PR #220, ADR-0074
 * 7-14). Past it, as after a read that failed: the new 댓글 stands at the end of the pages held,
 * and 더 보기 brings it into its place with the page that holds it. Apart from the reply pages the
 * threads of those pages read on (REPLY_READ_ON_PAGES_IN_ALL below, one budget for the read).
 */
export const COMMENT_READ_ON_PAGES = 5;

/**
 * The reply pages one read of the comment pages reads on in all, its threads together (오너 결정
 * 2026-10-23: 스레드마다 다섯 페이지는 그대로, 다시 읽기 한 번은 모두 합쳐 30페이지까지): a
 * refetch — the window's focus after 30 seconds, a reconnection, a write's read, a refusal that
 * says the thread is old — and a new 댓글's read of the pages from the last held on. Spent in the
 * order the threads are on screen, the top first (`threadsReadOn` in hooks/use-comments.ts): each
 * thread reads on up to its REPLY_READ_ON_PAGES while any is left; the thread the budget runs out
 * in keeps the pages read so far, and every thread after it comes back to its first 50, the rest
 * behind '답글 더 보기' again. Before it, a page of 20 threads each opened past 300 spent 100 reply
 * requests on one refetch — with the page's own, more than the reader's address limit (100 a
 * minute), so its last was refused and the whole refetch with it (Codex review on PR #220). 30
 * and the comment page leave the limit room for the page's other requests (ADR-0074 7-28).
 */
export const REPLY_READ_ON_PAGES_IN_ALL = 30;

/** What is left of REPLY_READ_ON_PAGES_IN_ALL for one read of the comment pages. */
export interface ReplyReadOnBudget {
  left: number;
}

/** A read of the comment pages' whole REPLY_READ_ON_PAGES_IN_ALL, none spent yet. */
export function replyReadOnBudget(): ReplyReadOnBudget {
  return { left: REPLY_READ_ON_PAGES_IN_ALL };
}

/**
 * The 대댓글 a read of the comment pages keeps of a thread at most (`threadReadsOn`): the first page's
 * (COMMENT_REPLIES_PAGE_SIZE, 50) and REPLY_READ_ON_PAGES pages after them (250) — 300. The read on
 * for an edit draft taken back after an onboarding step never reads past them (오너 결정 2026-10-22
 * (2차) 답 1, `editDraftsReadOn`), and an edit's text held apart opens in its edit only for a 대댓글
 * a read brought within them (2026-10-22 (3차) 답 1, `heldEditsBrought`): a box opened past them
 * would go with the next read of the pages (ADR-0074 7-30). At most: a thread below those the
 * read's REPLY_READ_ON_PAGES_IN_ALL was spent on keeps less (오너 결정 2026-10-23) — its first 50
 * and what the budget had left — and a box on a 대댓글 past that goes with the read as one past 300
 * does, its text held apart until a read brings it back (ADR-0074 7-28).
 */
export const REPLIES_KEPT_ON_READ = COMMENT_REPLIES_PAGE_SIZE * (1 + REPLY_READ_ON_PAGES);

/**
 * Whether one more reply page read into `thread` stays within what a read of the comment pages
 * keeps of it (REPLIES_KEPT_ON_READ): the 대댓글 it holds and a full page after them, 300 at most.
 * Pages are full but the last (COMMENT_REPLIES_PAGE_SIZE), so a thread read from its first page
 * holds 50, 100, … 300: it reads up to its 300th 대댓글, and nothing once it holds 300 — or more
 * ('답글 더 보기' opened further, the reader's own new 대댓글 put at the end). Held short of a page's
 * end — the reader's own 대댓글 deleted, or new ones put at the end, meanwhile — it reads nothing
 * that could end past 300 either (ADR-0074 7-28).
 */
export function threadKeepsAnotherPage(thread: CommentThread): boolean {
  return thread.replies.length + COMMENT_REPLIES_PAGE_SIZE <= REPLIES_KEPT_ON_READ;
}

/**
 * Whether the 대댓글 `commentId` stands past what a read of the comment pages keeps of `thread`
 * (REPLIES_KEPT_ON_READ, its 301st or later as held): '답글 더 보기' opened the thread further, and
 * the next read of the pages takes it back to 300 — and a box open on that 대댓글 with it.
 */
function keptPast(thread: CommentThread, commentId: string): boolean {
  return thread.replies.findIndex((reply) => reply.id === commentId) >= REPLIES_KEPT_ON_READ;
}

/**
 * The thread `fresh`, read again, with the reply pages after it still to read so it holds as many
 * 대댓글 as the screen did (`held`, the same thread before the read) — so a read of the comment
 * pages (the window's focus, 30 seconds, a reconnection, a write's read) does not take away what
 * '답글 더 보기' brought, nor a box open on it — up to REPLY_READ_ON_PAGES pages read on
 * (`pagesRead`, 오너 결정 2026-10-21 (2차) 답 1): past them, what the screen held beyond goes back
 * behind '답글 더 보기'. Whether one more page is to be read.
 */
export function threadReadsOn(
  fresh: CommentThread,
  held: CommentThread | undefined,
  pagesRead: number,
): boolean {
  return (
    held !== undefined &&
    fresh.repliesNextCursor !== null &&
    fresh.replies.length < held.replies.length &&
    pagesRead < REPLY_READ_ON_PAGES
  );
}

/** `thread` with the reply page after it (`threadReadsOn`, read from its `repliesNextCursor`). */
export function threadWithReplies(thread: CommentThread, page: ReplyPage): CommentThread {
  return {
    ...thread,
    replies: repliesWith(thread.replies, page.items),
    repliesNextCursor: page.nextCursor,
  };
}

// ---- what the author's own writes do to the pages held -------------------------------------

function mapThreads(
  pages: CommentPages | undefined,
  map: (thread: CommentThread) => CommentThread | undefined,
): CommentPages | undefined {
  if (pages === undefined) return undefined;
  return {
    ...pages,
    pages: pages.pages.map((page) => ({
      ...page,
      items: page.items.flatMap((thread) => {
        const next = map(thread);
        return next === undefined ? [] : [next];
      }),
    })),
  };
}

/**
 * A comment `POST /posts/:postId/comments` answered, put where the thread shows it, so the writer
 * sees it at once: a 대댓글 last of its 댓글's replies held — `parentId` in the answer is always
 * that 댓글, even when the reply was aimed at a 대댓글 — and a 대댓글 whose 댓글 is not among the
 * pages read changes nothing (its page brings it). A 대댓글 is the newest of its thread (#45-2
 * oldest first): while 대댓글 of the thread are still unread ('답글 더 보기'), the hooks read them
 * instead (`readOnReplies`, use-comments.ts) and come here only once they are read up to it (then
 * held: nothing to add) or that read fails or stops short of it — before 대댓글 still unread, then,
 * until their page brings it to its place; a read that ends the thread without it (deleted
 * meanwhile) does not come here. A 댓글 goes last of the pages read: the hooks read its
 * page instead (`readOnToTheEnd`) and come here only when that read fails or stops short of it,
 * COMMENT_READ_ON_PAGES read — before 댓글 still unread, and out of the pages at the next read of
 * as many pages, until 더 보기 brings it. Nothing is added twice, and a comment its page brings
 * later is drawn once, where that page puts it (`commentThreadsOf`, `repliesWith`).
 */
export function withNewComment(
  pages: CommentPages | undefined,
  comment: PublishedComment,
): CommentPages | undefined {
  if (pages === undefined) return undefined;
  const parentId = comment.parentId;
  if (parentId === null) {
    if (commentThreadsOf(pages).some((thread) => thread.comment.id === comment.id)) return pages;
    const lastIndex = pages.pages.length - 1;
    if (lastIndex < 0) return pages;
    const thread: CommentThread = { comment, replies: [], repliesNextCursor: null };
    return {
      ...pages,
      pages: pages.pages.map((page, index) =>
        index === lastIndex ? { ...page, items: [...page.items, thread] } : page,
      ),
    };
  }
  return mapThreads(pages, (thread) =>
    thread.comment.id !== parentId || thread.replies.some((reply) => reply.id === comment.id)
      ? thread
      : { ...thread, replies: [...thread.replies, comment] },
  );
}

/** An edit's answer (`PUT /comments/:commentId`) in place of the comment it replaces. */
export function withEditedComment(
  pages: CommentPages | undefined,
  comment: PublishedComment,
): CommentPages | undefined {
  const swap = (held: PostComment): PostComment => (held.id === comment.id ? comment : held);
  return mapThreads(pages, (thread) => ({
    ...thread,
    comment: swap(thread.comment),
    replies: thread.replies.map(swap),
  }));
}

/**
 * A deletion's answer (`POST /comments/:commentId/delete`) applied as the next read would show it
 * (#45-5): a 댓글 that keeps its placeholder becomes '삭제된 글입니다' with its 대댓글 under it;
 * any other comment leaves the view. A 대댓글 that was the last under a deleted 댓글 takes that
 * placeholder with it — a deleted 댓글 with nothing under it is in no answer — the last, that is,
 * with none still unread after it ('답글 더 보기').
 */
export function withoutComment(
  pages: CommentPages | undefined,
  deletion: CommentDeletion,
): CommentPages | undefined {
  return mapThreads(pages, (thread) => {
    if (thread.comment.id === deletion.id) {
      return deletion.placeholder
        ? { ...thread, comment: { state: 'deleted', id: deletion.id } }
        : undefined;
    }
    if (!thread.replies.some((reply) => reply.id === deletion.id)) return thread;
    const replies = thread.replies.filter((reply) => reply.id !== deletion.id);
    return thread.comment.state === 'deleted' &&
      replies.length === 0 &&
      thread.repliesNextCursor === null
      ? undefined
      : { ...thread, replies };
  });
}

// ---- drafts -------------------------------------------------------------------------------------

/** A draft as the server will measure it (#45-3): the text it keeps, counted in code points. */
export interface CommentDraft {
  /** What the server stores: line breaks as `\n`, control characters dropped, trimmed. */
  body: string;
  length: number;
  /** Nothing but white space: the server refuses it. */
  empty: boolean;
  tooLong: boolean;
}

/**
 * Counts a draft the way `commentBodyInputSchema` does — normalised (`normaliseCommentBody`), then
 * code points (`codePointLength`: '가', 'a' and '😀' are one each, a line break one) — so the count
 * under the box is the server's and a writer sees the limit before sending, not after.
 */
export function commentDraft(text: string): CommentDraft {
  const body = normaliseCommentBody(text);
  const length = codePointLength(body);
  return { body, length, empty: body === '', tooLong: length > COMMENT_BODY_MAX_LENGTH };
}

/**
 * Whether a box's text differs from what it started with (`initial`: '' for a new 댓글 or 대댓글,
 * the comment's text for an edit), as the server would keep each (`normaliseCommentBody`) — so
 * spaces alone, or the comment as it stands, are nothing to lose. What leaving asks about (오너 결정
 * 2026-10-20 답 1) and what going to an onboarding step keeps (답 2).
 */
export function commentTextChanged(text: string, initial: string): boolean {
  return normaliseCommentBody(text) !== normaliseCommentBody(initial);
}

/** The count under a box: '12 / 1,000자'. */
export function commentLengthText(length: number): string {
  return `${length.toLocaleString('ko-KR')} / ${COMMENT_BODY_MAX_LENGTH.toLocaleString('ko-KR')}${copy.commentLengthUnit}`;
}

/**
 * '댓글 N': a post's comment count as its card and its page show it (#45-7) — 댓글 and 대댓글 the
 * public reads, never a deleted or hidden one (ADR-0074). A 0 is written as 0. Written with
 * `String`, not `toLocaleString`, as the market card's '참여자 N' is: the card is drawn on the
 * server and in the browser, whose number data never have to agree.
 */
export function commentCountText(count: number): string {
  return `${copy.commentsHeading} ${String(count)}`;
}

// ---- refusals ----------------------------------------------------------------------------------

/** Which write a refusal answered: the same NOT_FOUND means another thing for each. */
export type CommentWrite = 'create' | 'edit' | 'delete';

const NOT_ALLOWED_MESSAGES: Record<CommentNotAllowedReason, string> = {
  post_hidden: copy.commentClosedPostHidden,
  post_deleted: copy.commentClosedPostDeleted,
  parent_hidden: copy.errCommentParentHidden,
  parent_deleted: copy.errCommentParentDeleted,
};

/** The reason of a COMMENT_NOT_ALLOWED answer (`{ reason }`), when it carries one. */
function notAllowedReason(details: unknown): CommentNotAllowedReason | undefined {
  if (typeof details !== 'object' || details === null || !('reason' in details)) return undefined;
  const { reason } = details;
  return COMMENT_NOT_ALLOWED_REASONS.find((known) => known === reason);
}

/**
 * What a refused comment write tells the writer. The server judges every rule — the box counts the
 * same way beforehand — but a stale screen or another tab reaches these:
 * - the cookie is another account than the screen's (`expectedAccountId`): the screen is stale;
 * - COMMENT_NOT_ALLOWED: the post or the 댓글 was hidden or deleted meanwhile (#45-5), by reason;
 * - COMMENT_NOT_EDITABLE: an operator hid the comment;
 * - NOT_FOUND naming `parentId`: the 댓글 to answer left the view; any other NOT_FOUND: the post
 *   (a new 댓글) or the comment (an edit, a deletion) is gone;
 * - FORBIDDEN: another account's comment;
 * - ONBOARDING_REQUIRED: a write or an edit before the onboarding is done (a consent a revision
 *   asked for again, #57-5) — the gate follows `['me']`; deleting one's own never meets it;
 * - VALIDATION_ERROR on `body`, told apart by `commentBodyRefusalOf`: no text, or too long;
 * - a request that never reached the API, and anything else.
 */
export function commentWriteErrorMessage(error: unknown, write: CommentWrite): string {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  if (isApiError(error, 'COMMENT_NOT_ALLOWED')) {
    const reason = notAllowedReason(error.details);
    return reason === undefined ? copy.errCommentNotAllowed : NOT_ALLOWED_MESSAGES[reason];
  }
  if (isApiError(error, 'COMMENT_NOT_EDITABLE')) return copy.errCommentNotEditable;
  if (isApiError(error, 'NOT_FOUND')) {
    if (validationField(error) === 'parentId') return copy.errCommentParentGone;
    return write === 'create' ? copy.errPostGone : copy.errCommentGone;
  }
  if (isApiError(error, 'FORBIDDEN')) return copy.errCommentNotYours;
  if (isApiError(error, 'ONBOARDING_REQUIRED')) return copy.errPostOnboarding;
  if (isApiError(error, 'VALIDATION_ERROR')) {
    if (validationField(error) === 'body') {
      switch (commentBodyRefusalOf(validationMessage(error) ?? '')?.kind) {
        case 'empty':
          return copy.errCommentBodyEmpty;
        case 'too_long':
          return copy.errCommentBodyTooLong;
        case undefined:
          break;
      }
    }
    return copy.errPostInvalid;
  }
  return isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown;
}

/**
 * Whether a refusal means the thread on screen is out of date — the post or a 댓글 was hidden or
 * deleted, or a comment or the post is gone — so the hooks read the post and its comments again
 * and the page shows what they are now: the placeholders, the box closed, or for a post gone from
 * every view its 404 — once no text is held apart (post-screen.tsx, 오너 결정 2026-10-21 답 1). A
 * refused write's words stay under its button; should the
 * thread read again no longer hold the box, they stay with its text where the box stood until the
 * writer closes them (`useCommentBoxDraft`, components/post/held-comment-text.tsx) — and, being
 * about the thread, they are what that text says rather than the box's place as read again
 * (`heldTextsOf`). A refused deletion has no box: it is a toast, as every deletion's refusal is.
 */
export function isStaleThreadRefusal(error: unknown): boolean {
  return (
    isApiError(error, 'COMMENT_NOT_ALLOWED') ||
    isApiError(error, 'COMMENT_NOT_EDITABLE') ||
    isApiError(error, 'NOT_FOUND')
  );
}

/**
 * A page cursor the server no longer opens (ADR-0074 7-29): the 400 VALIDATION_ERROR naming
 * `cursor`. The screen sends only cursors the server gave it, so this one was sealed under a key
 * changed since (`BETTER_AUTH_SECRET` rotated while the page was open): sent again it is refused
 * again, and only the pages read again from the first carry cursors that open
 * (hooks/use-comments.ts, `readMoreReplies`·`readMoreComments`).
 */
export function isCursorRefusal(error: unknown): boolean {
  return isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'cursor';
}

/**
 * What a post page shows in place of the comment box when the post takes no new comment (#45-5):
 * a hidden post and a deleted one whose comments are still in view.
 */
export function commentsClosedMessage(postState: 'deleted' | 'hidden'): string {
  return postState === 'hidden' ? copy.commentClosedPostHidden : copy.commentClosedPostDeleted;
}

/** A comment's placeholder (#45-5): never its author or a word of it. */
export function commentPlaceholderMessage(state: 'deleted' | 'hidden'): string {
  return state === 'deleted' ? copy.commentDeletedPlaceholder : copy.commentHiddenPlaceholder;
}

// ---- text the page holds for a box that is gone ------------------------------------------------

/**
 * Where a box stood: the new 댓글's (`post`, under the threads), a thread's reply box (at its end),
 * or an edit (in place of the comment's text, in its thread).
 */
export type HeldTextPlace =
  | { kind: 'post' }
  | { kind: 'thread'; threadId: string }
  | { kind: 'comment'; commentId: string; threadId: string };

/**
 * Text the page shows apart from any box, with why it cannot be sent, until the writer closes it
 * (오너 결정 2026-10-20 답 4): the text of a box whose write was refused and which went — the post
 * or the 댓글 hidden or deleted, the comment gone, so the thread read again no longer holds it —
 * the text of a box with no write that went because its place took it no more (a read in the
 * background, the writer's own 댓글 deleted under an open 답글: 오너 결정 2026-10-21 답 2), and a
 * draft taken back after an onboarding step whose box can no longer open
 * (`resolveCommentDrafts`). Only the account on screen's (lib/held-comment-texts.ts).
 */
export interface HeldText {
  id: string;
  place: HeldTextPlace;
  /** Why it cannot be sent: the refusal's words, or why its place takes it no more (`goneBoxReason`). */
  reason: string;
  text: string;
  /**
   * The focus was in the box as it went: it comes here (ADR-0074 7-25). Never for a draft taken back
   * after a step — no box held it on this page.
   */
  focus: boolean;
  /**
   * Drawn already (lib/held-comment-texts.ts): a later mount — its place moved — neither reads its
   * reason out as an alert again nor takes the focus (ADR-0074 7-25).
   */
  shown: boolean;
}

/**
 * The box a held text stood for, as the drafts kept in the tab name it (lib/comment-drafts.ts): the
 * new 댓글's, a thread's reply box, an edit. A held text goes to an onboarding step as its box's
 * text would (오너 결정 2026-10-20 답 2·4, `keepSectionTextsForStep`).
 */
export function commentDraftKeyOfPlace(postId: string, place: HeldTextPlace): CommentDraftKey {
  switch (place.kind) {
    case 'post':
      return { kind: 'comment', postId };
    case 'thread':
      return { kind: 'reply', postId, parentId: place.threadId };
    case 'comment':
      return { kind: 'edit', postId, commentId: place.commentId, threadId: place.threadId };
  }
}

/** Where each held text is drawn: under its comment, at the end of its thread, or under them all. */
export interface PlacedHeldTexts {
  byComment: ReadonlyMap<string, readonly HeldText[]>;
  byThread: ReadonlyMap<string, readonly HeldText[]>;
  rest: readonly HeldText[];
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * Each held text where its box stood, as far as the threads on screen still have that place: an
 * edit under its comment (a placeholder now, perhaps), else at the end of its thread; a reply at
 * the end of its thread; and anything whose place is gone — a thread that left the view, the new
 * 댓글's — under the threads, in the order they were held. (An edit's text whose 대댓글 a read just
 * brought within the 300 a read of the pages keeps opens that edit instead, when it can —
 * `heldEditsBrought`: the section leaves it out of what it hands here until the box has it.)
 */
export function placeHeldTexts(
  threads: readonly CommentThread[],
  held: readonly HeldText[],
): PlacedHeldTexts {
  const commentIds = new Set<string>();
  const threadIds = new Set<string>();
  for (const thread of threads) {
    threadIds.add(thread.comment.id);
    commentIds.add(thread.comment.id);
    for (const reply of thread.replies) commentIds.add(reply.id);
  }
  const byComment = new Map<string, HeldText[]>();
  const byThread = new Map<string, HeldText[]>();
  const rest: HeldText[] = [];
  for (const text of held) {
    const { place } = text;
    if (place.kind === 'comment' && commentIds.has(place.commentId)) {
      push(byComment, place.commentId, text);
    } else if (place.kind !== 'post' && threadIds.has(place.threadId)) {
      push(byThread, place.threadId, text);
    } else {
      rest.push(text);
    }
  }
  return { byComment, byThread, rest };
}

/** Why a 대댓글 cannot go under a 댓글 in `state` (#45-5, 7-4), or nothing for a published one. */
function replyRefusalOf(state: PostComment['state']): string | undefined {
  switch (state) {
    case 'published':
      return undefined;
    case 'hidden':
      return copy.errCommentParentHidden;
    case 'deleted':
      return copy.errCommentParentDeleted;
  }
}

/** Why a comment in `state` cannot be edited (#45-5), or nothing for a published one. */
function editRefusalOf(state: PostComment['state']): string | undefined {
  switch (state) {
    case 'published':
      return undefined;
    case 'hidden':
      return copy.errCommentNotEditable;
    case 'deleted':
      return copy.errCommentGone;
  }
}

/**
 * The post as its page shows it: published, hidden or deleted (its placeholder, ADR-0073) — or
 * `gone`, out of every view while the page is open (a deleted post's last comment deleted, the
 * read after a write NOT_FOUND): the page holds off its 404 while texts are held apart and shows
 * only them under '없거나 삭제된 글입니다.' (오너 결정 2026-10-21 답 1, post-screen.tsx).
 */
export type CommentsPostState = Post['state'] | 'gone';

/**
 * Why the place a box stood in takes its text no more, as the post and its threads now read — in
 * the words the server would refuse it in — or nothing while it still would: the post out of every
 * view ('없거나 삭제된 글입니다.', for every box — its comments are gone with it), the post hidden
 * or deleted (a new 댓글, a 대댓글; an edit is still its author's, 7-6), the 댓글 to answer a
 * placeholder or out of the view, the comment edited hidden or out of it. A box gone from a thread
 * on screen went with that thread's pages read, so one not among them is gone — save an edit of a
 * 대댓글 whose thread now holds fewer than the screen did, 대댓글 still unread after them: a read of
 * the pages reads a thread on five reply pages at most (REPLY_READ_ON_PAGES, 오너 결정 2026-10-21
 * (2차) 답 1), so the 대댓글 may be past them as well as deleted, and the words — the owner's
 * (오너 결정 2026-10-22 답 3) — say it may be either (ADR-0074 7-30). What a held text says for a
 * box with no write that went because its place changed (오너 결정 2026-10-21 답 2), and when the
 * refusal its box heard was about something else — a network failure, say — and the box went later
 * because its thread changed (`heldTextsOf`).
 */
export function goneBoxReason(
  place: HeldTextPlace,
  view: { postState: CommentsPostState; threads: readonly CommentThread[] },
): string | undefined {
  const { postState, threads } = view;
  if (postState === 'gone') return copy.errPostGone;
  if (place.kind !== 'comment' && postState !== 'published') {
    return commentsClosedMessage(postState);
  }
  switch (place.kind) {
    case 'post':
      return undefined;
    case 'thread': {
      const thread = threads.find((held) => held.comment.id === place.threadId);
      return thread === undefined
        ? copy.errCommentParentGone
        : replyRefusalOf(thread.comment.state);
    }
    case 'comment': {
      const found = threads
        .flatMap((thread) => [thread.comment, ...thread.replies])
        .find((held) => held.id === place.commentId);
      if (found !== undefined) return editRefusalOf(found.state);
      const home = threads.find((held) => held.comment.id === place.threadId);
      return place.commentId !== place.threadId &&
        home !== undefined &&
        home.repliesNextCursor !== null
        ? copy.errCommentEditNotRead
        : copy.errCommentGone;
    }
  }
}

/**
 * The 대댓글 the threads on screen hold, by id, each with whether it stands within what a read of the
 * comment pages keeps of its thread (REPLIES_KEPT_ON_READ: its first 300 as held) — what the
 * comment section compares from one render to the next to tell what a read brought
 * (`heldEditsBrought`).
 */
export type RepliesOnScreen = ReadonlyMap<string, boolean>;

/** Where each 대댓글 of `threads` stands (`RepliesOnScreen`). */
export function repliesOnScreenOf(threads: readonly CommentThread[]): RepliesOnScreen {
  const onScreen = new Map<string, boolean>();
  for (const thread of threads) {
    thread.replies.forEach((reply, index) => onScreen.set(reply.id, index < REPLIES_KEPT_ON_READ));
  }
  return onScreen;
}

/** What a read that brought 대댓글 onto the screen does to the edit texts held apart for them. */
export interface HeldEditsBrought {
  /** Held texts whose 대댓글's edit opens with them (the held text then goes), by held text. */
  open: { id: string; commentId: string; text: string }[];
  /** Held texts that stay apart, with why their 대댓글, on screen now, takes no edit from them. */
  reasons: { id: string; reason: string }[];
}

/**
 * The held texts of edits of a 대댓글 (`place.kind` 'comment') that a read just brought onto the
 * screen — the threads as they stand now (`threads`) against where they stood before the read
 * (`before`, `repliesOnScreenOf`): on screen now and not before, or within the 300 a read of the
 * pages keeps now and past them before (earlier 대댓글 deleted meanwhile). Any read: '답글 더 보기'
 * pressed by the reader, a new 대댓글's read on through its thread (`readOnReplies`), a read of the
 * comment pages (`threadsReadOn`), the read on for drafts taken back (`editDraftsReadOn`) — 오너 결정
 * 2026-10-22 (3차) 답 1, which made every read do what (2차) 답 2 had '답글 더 보기' do — and no read
 * at all for one moved within the 300: the reader's own 삭제 of an earlier 대댓글 (`withoutComment`,
 * as the owner confirmed, ADR-0074 오너 확인 2026-10-22 (오후) 답 1).
 *
 * A text held apart — its 대댓글 not among those read (`copy.errCommentEditNotRead`), a read that
 * failed, a refusal whose box went with its 대댓글 — opens that 대댓글's edit with it when the edit
 * can open there: the 대댓글 within the 300 (a box past them would go with the next read of the
 * pages, ADR-0074 7-30), published, and the viewer's own (`viewerPublicId`, the account on screen —
 * the held texts are only ever its, lib/held-comment-texts.ts). Its box is shown and said as a
 * draft taken back is (the section's `copy.commentDraftRestored`), the held text gone once the box
 * has it — and said only then: an edit open already keeps its own text, the held text stays, and
 * nothing is said (the section's `useReopened`, ADR-0074 7-30 (f)). Otherwise it stays apart, under
 * that 대댓글 now, with why, when that is not what it says
 * already: hidden or another account's, in the words the server would refuse it in; the viewer's
 * own past the 300, '고치던 답글을 다시 열지 못했습니다. 쓰던 내용을 여기 남겨 둡니다.'
 * (`copy.errCommentEditNotReopened`, 3차 답 3's words for a 대댓글 on screen past them) — '아직
 * 불러오지 않은 답글' no longer holds once it is read. A text whose 대댓글 was where it is before
 * the read, or is not on screen now, or whose place is a 댓글's edit or no edit, is nothing to it.
 */
export function heldEditsBrought(
  held: readonly HeldText[],
  threads: readonly CommentThread[],
  before: RepliesOnScreen,
  viewerPublicId: string | undefined,
): HeldEditsBrought {
  const open: HeldEditsBrought['open'] = [];
  const reasons: HeldEditsBrought['reasons'] = [];
  // No account on screen holds no text.
  if (viewerPublicId === undefined) return { open, reasons };
  const onScreen = new Map<string, { reply: PostComment; kept: boolean }>();
  for (const thread of threads) {
    thread.replies.forEach((reply, index) =>
      onScreen.set(reply.id, { reply, kept: index < REPLIES_KEPT_ON_READ }),
    );
  }
  for (const text of held) {
    const { place } = text;
    if (place.kind !== 'comment') continue;
    const now = onScreen.get(place.commentId);
    if (now === undefined) continue;
    const was = before.get(place.commentId);
    // Where it was: within the 300 then, or on screen at all for one past them now.
    if (now.kept ? was === true : was !== undefined) continue;
    const { reply } = now;
    const editable = reply.state === 'published' && isOwnPost(reply.author, viewerPublicId);
    if (editable && now.kept) {
      open.push({ id: text.id, commentId: reply.id, text: text.text });
      continue;
    }
    const reason = editable
      ? copy.errCommentEditNotReopened
      : (editRefusalOf(reply.state) ?? copy.errCommentNotYours);
    if (reason !== text.reason) reasons.push({ id: text.id, reason });
  }
  return { open, reasons };
}

/** The thread of the 댓글 `threadId` among the pages, if they hold it. */
export function threadOf(
  pages: CommentPages | undefined,
  threadId: string,
): CommentThread | undefined {
  return commentThreadsOf(pages).find((thread) => thread.comment.id === threadId);
}

/**
 * The held texts of edits of a 대댓글 (`place.kind` 'comment', not its 댓글) whose thread is on
 * screen and read to its end without it — no cursor left, the 대댓글 not among its 대댓글 — and that
 * do not say so yet, each with what it says now: '없거나 삭제된 댓글입니다.' (`copy.errCommentGone`).
 * A deleted 대댓글 is in no page (the API leaves it out), so no read ever brings it for
 * `heldEditsBrought` to say why: without this, a text held apart with '…지워졌거나 아직 불러오지 않은
 * 답글입니다.' or a read's failure kept saying it once nothing was left to read — and the right reason
 * is the one a box gone from such a thread says (`goneBoxReason`) and a draft taken back for it is
 * shown with (`resolveCommentDrafts`, ADR-0074 7-30; 오너 결정 2026-10-22 (2차) 답 2: «맞는 까닭»).
 * A thread not on screen (its page not read yet, or gone) or with 대댓글 still unread says nothing
 * new; nor does an edit of a 댓글 — its thread on screen holds it.
 */
export function heldEditsReadToTheirEnd(
  threads: readonly CommentThread[],
  held: readonly HeldText[],
): { id: string; reason: string }[] {
  const byId = new Map(threads.map((thread) => [thread.comment.id, thread]));
  return held.flatMap((text) => {
    const { place } = text;
    if (place.kind !== 'comment' || place.commentId === place.threadId) return [];
    const home = byId.get(place.threadId);
    if (home === undefined || home.repliesNextCursor !== null) return [];
    if (home.replies.some((reply) => reply.id === place.commentId)) return [];
    return text.reason === copy.errCommentGone
      ? []
      : [{ id: text.id, reason: copy.errCommentGone }];
  });
}

// ---- drafts taken back after an onboarding step ------------------------------------------------

/** A draft taken back that no box can take: shown apart, with why (`HeldText`). */
export interface UnplacedCommentDraft {
  key: CommentDraftKey;
  text: string;
  reason: string;
  place: HeldTextPlace;
}

/** Where the drafts taken back go (`resolveCommentDrafts`). */
export interface ResolvedCommentDrafts {
  /** The new 댓글's box opens with it. */
  comment: string | undefined;
  /** The reply box of each thread opens with its draft, by the thread's 댓글. */
  replies: ReadonlyMap<string, string>;
  /** The edit of each comment opens with its draft, by the comment. */
  edits: ReadonlyMap<string, string>;
  /** Drafts whose box can no longer open, and why. */
  unplaced: readonly UnplacedCommentDraft[];
  /** A draft's comment is not among the pages read, and pages are left to read. */
  waiting: boolean;
  /**
   * The threads, by their 댓글's id, whose 대댓글 still unread ('답글 더 보기') may hold the
   * comment of an edit draft: read on through them.
   */
  waitingThreads: readonly string[];
  /**
   * The edit drafts waiting on those threads, each with its place in its thread: shown apart, with
   * why, should the read on through its thread fail (오너 결정 2026-10-21 (2차) 답 2,
   * `draftsHeldOnReadFailure`) or not find its comment within the 300 대댓글 a read of the pages
   * keeps (오너 결정 2026-10-22 답 5 and (2차) 답 1, `editDraftsReadOn`).
   */
  waitingEdits: readonly WaitingEditDraft[];
}

/** An edit draft waiting on its thread's 대댓글 still unread (`ResolvedCommentDrafts`). */
export interface WaitingEditDraft {
  key: CommentDraftKey;
  text: string;
  place: Extract<HeldTextPlace, { kind: 'comment' }>;
}

/**
 * The edit drafts that waited on the thread `threadId`'s 대댓글 still unread, once the read on
 * through them failed (오너 결정 2026-10-21 (2차) 답 2): shown apart like a held text — the text,
 * why (`reason`, the read's failure in the words '답글 더 보기' says it in — 오너 결정 2026-10-22
 * 답 4) — until the writer closes it, rather than waiting unseen behind a button; and, alike, once
 * the read stops short of them (`editDraftsReadOn`, 오너 결정 2026-10-22 답 5 and (2차) 답 1).
 * Nothing for a draft no longer waiting: one its box took meanwhile, or one shown apart already.
 */
export function draftsHeldOnReadFailure(
  waiting: readonly WaitingEditDraft[],
  threadId: string,
  reason: string,
): UnplacedCommentDraft[] {
  return waiting
    .filter(({ place }) => place.threadId === threadId)
    .map(({ key, text, place }) => ({ key, text, reason, place }));
}

/**
 * Where a thread stands for the read on below: the 댓글 and the cursor it would read from — what a
 * read that failed is kept by (`editDraftsReadOn`'s `failed`).
 */
export function editDraftReadOnMark(thread: CommentThread): string {
  return `${thread.comment.id}:${String(thread.repliesNextCursor)}`;
}

/** The next step of the read on for edit drafts taken back (`editDraftsReadOn`). */
export interface EditDraftsReadOn {
  /** The thread to read one more reply page of ('답글 더 보기' pressed for the writer), if any. */
  read: CommentThread | undefined;
  /**
   * The drafts shown apart, with why: those of a thread whose read from where it stands failed
   * (the read's failure), and those its thread did not show within the 300 대댓글 a read of the
   * pages keeps.
   */
  past: UnplacedCommentDraft[];
}

/**
 * The post page's read on through a thread for the edit drafts taken back after an onboarding step
 * that wait on its 대댓글 still unread (`waitingThreads`, `waitingEdits` — 오너 결정 2026-10-21
 * '답글 더 보기'), one step: the next thread to read a reply page of — one with a cursor whose next
 * page stays within the 300 대댓글 a read of the pages keeps (`threadKeepsAnotherPage`) — and the
 * drafts to show apart until the writer closes them. Those of a thread whose read failed from the
 * cursor it still holds (`failed`, by `editDraftReadOnMark`) go with that failure as why (오너 결정
 * 2026-10-21 (2차) 답 2 and 2026-10-22 답 4 — the caller shows them as the read fails; this is for
 * the drafts it could not see then, the comment pages being read again, say), and that cursor is
 * not read again. Those of a thread that holds its 300 — read to them, or holding them already as
 * the drafts came back (the comments kept in this tab across the step, a step done in another tab)
 * — and still has 대댓글 unread go with
 * '고치던 답글을 목록에서 찾지 못했습니다. 지워졌거나 아직 불러오지 않은 답글입니다.' (오너 결정
 * 2026-10-22 (2차) 답 1 with 2026-10-22 답 3·5): the read never goes past what a read of the pages
 * keeps, so no box it opens goes again with the next one (ADR-0074 7-30) — read from the first 50,
 * five reply pages at most, as a new 대댓글's read; from 300, none. So do those of a thread that read
 * REPLY_READ_ON_PAGES pages for these drafts (`pagesRead`) without reaching them — pages it did not
 * take, read again meanwhile: the requests stay bound as every read on's (ADR-0074 7-28). Any other
 * thread waiting is read on, from a cursor read before too (a read whose page the thread did not
 * take, or one of an earlier set of drafts taken back): nothing waits unseen. A draft whose thread
 * is read to its end is no longer waiting (`resolveCommentDrafts` says it is gone), nor is one its
 * box took. The caller reads one thread at a time and asks again after each: a draft found on the
 * page just read waits no more by then, so the comment of the page that brings the thread to 300
 * opens its box rather than being shown apart.
 */
export function editDraftsReadOn(
  threads: readonly CommentThread[],
  waiting: Pick<ResolvedCommentDrafts, 'waitingThreads' | 'waitingEdits'>,
  done: {
    pagesRead: (threadId: string) => number;
    failed: (mark: string) => string | undefined;
  },
): EditDraftsReadOn {
  let read: CommentThread | undefined;
  const past: UnplacedCommentDraft[] = [];
  for (const thread of threads) {
    const threadId = thread.comment.id;
    if (!waiting.waitingThreads.includes(threadId) || thread.repliesNextCursor === null) continue;
    const failure = done.failed(editDraftReadOnMark(thread));
    if (failure !== undefined) {
      past.push(...draftsHeldOnReadFailure(waiting.waitingEdits, threadId, failure));
    } else if (!threadKeepsAnotherPage(thread) || done.pagesRead(threadId) >= REPLY_READ_ON_PAGES) {
      past.push(
        ...draftsHeldOnReadFailure(waiting.waitingEdits, threadId, copy.errCommentEditNotRead),
      );
    } else if (read === undefined) {
      read = thread;
    }
  }
  return { read, past };
}

/**
 * Where each draft the post page took back after an onboarding step goes (오너 결정 2026-10-20 답 2):
 * into its box — the new 댓글's while the post takes comments, a thread's reply box while its 댓글
 * takes 대댓글, an edit while the comment is the viewer's and published — or, where that box can no
 * longer open, apart, with the words the server would refuse it in (`unplaced`): the post hidden
 * or deleted meanwhile, the 댓글 a placeholder or gone, the comment hidden or gone. A comment not
 * among the pages read waits for them (`waiting`: the page reads on) and is gone once every page
 * is read (`allRead`); an edit of a 대댓글 whose thread is read but not all its 대댓글 waits for
 * them (`waitingThreads`: the page reads on through that thread, 오너 결정 2026-10-21 '답글 더
 * 보기') and is gone once they are all read — or shown apart with the read's failure, should that
 * read fail (`waitingEdits`, `draftsHeldOnReadFailure`, 오너 결정 2026-10-21 (2차) 답 2), or with
 * `copy.errCommentEditNotRead` once the thread holds the 300 대댓글 a read of the pages keeps
 * without it (`editDraftsReadOn`, 오너 결정 2026-10-22 답 5 and (2차) 답 1). An edit of the
 * viewer's own published 대댓글 held past those 300 opens no box either (2차 답 1: no edit box opens
 * past 300 from this): it is shown apart, under that 대댓글, with
 * '고치던 답글을 다시 열지 못했습니다. 쓰던 내용을 여기 남겨 둡니다.' (오너 결정 2026-10-22 (3차)
 * 답 3, `copy.errCommentEditNotReopened`) — a hidden one or another account's with why, as anywhere.
 * The page places the drafts once the read again on the way back is over, which takes such a
 * thread back to 300 — but that read can end without landing (cancelled by a write or another
 * '답글 더 보기', failed, offline), the pages as the step left them, and a box opened there would go
 * with the next read that lands (ADR-0074 7-28·7-30); a read that later brings it within the 300
 * opens it (3차 답 1, `heldEditsBrought`). A post out of every view (`gone`) takes none: each is
 * shown apart with '없거나 삭제된 글입니다.' (오너 결정 2026-10-21 답 1).
 */
export function resolveCommentDrafts(
  drafts: CommentDrafts,
  view: {
    postId: string;
    postState: CommentsPostState;
    threads: readonly CommentThread[];
    allRead: boolean;
    viewerPublicId: string;
  },
): ResolvedCommentDrafts {
  const { postId, postState, threads, allRead, viewerPublicId } = view;
  const replies = new Map<string, string>();
  const edits = new Map<string, string>();
  const unplaced: UnplacedCommentDraft[] = [];
  const waitingThreads: string[] = [];
  const waitingEdits: WaitingEditDraft[] = [];
  let comment: string | undefined;
  let waiting = false;

  if (postState === 'gone') {
    const reason = copy.errPostGone;
    if (drafts.comment !== undefined) {
      unplaced.push({
        key: { kind: 'comment', postId },
        text: drafts.comment,
        reason,
        place: { kind: 'post' },
      });
    }
    for (const [parentId, text] of drafts.replies) {
      unplaced.push({
        key: { kind: 'reply', postId, parentId },
        text,
        reason,
        place: { kind: 'thread', threadId: parentId },
      });
    }
    for (const [commentId, text] of drafts.edits) {
      const threadId = drafts.editThreads.get(commentId) ?? commentId;
      unplaced.push({
        key: { kind: 'edit', postId, commentId, threadId },
        text,
        reason,
        place: { kind: 'comment', commentId, threadId },
      });
    }
    return { comment, replies, edits, unplaced, waiting, waitingThreads, waitingEdits };
  }

  if (drafts.comment !== undefined) {
    if (postState === 'published') comment = drafts.comment;
    else {
      unplaced.push({
        key: { kind: 'comment', postId },
        text: drafts.comment,
        reason: commentsClosedMessage(postState),
        place: { kind: 'post' },
      });
    }
  }

  for (const [parentId, text] of drafts.replies) {
    const key: CommentDraftKey = { kind: 'reply', postId, parentId };
    const place: HeldTextPlace = { kind: 'thread', threadId: parentId };
    const thread = threads.find((held) => held.comment.id === parentId);
    if (postState !== 'published') {
      unplaced.push({ key, text, reason: commentsClosedMessage(postState), place });
    } else if (thread === undefined) {
      if (allRead) unplaced.push({ key, text, reason: copy.errCommentParentGone, place });
      else waiting = true;
    } else {
      const reason = replyRefusalOf(thread.comment.state);
      if (reason === undefined) replies.set(parentId, text);
      else unplaced.push({ key, text, reason, place });
    }
  }

  for (const [commentId, text] of drafts.edits) {
    // The thread it was kept with — itself for a 댓글, and for a draft kept without one.
    const keptIn = drafts.editThreads.get(commentId) ?? commentId;
    const thread = threads.find(
      (held) =>
        held.comment.id === commentId || held.replies.some((reply) => reply.id === commentId),
    );
    const threadId = thread?.comment.id ?? keptIn;
    const key: CommentDraftKey = { kind: 'edit', postId, commentId, threadId };
    const place = { kind: 'comment', commentId, threadId } as const;
    const found =
      thread === undefined
        ? undefined
        : [thread.comment, ...thread.replies].find((held) => held.id === commentId);
    const home = threads.find((held) => held.comment.id === keptIn);
    if (found === undefined && home !== undefined && home.repliesNextCursor !== null) {
      // Among its thread's 대댓글 still unread, perhaps: read on through them.
      waitingThreads.push(keptIn);
      waitingEdits.push({ key, text, place });
    } else if (found === undefined) {
      if (allRead || home !== undefined) {
        unplaced.push({ key, text, reason: copy.errCommentGone, place });
      } else waiting = true;
    } else if (found.state !== 'published') {
      unplaced.push({
        key,
        text,
        reason: editRefusalOf(found.state) ?? copy.errCommentGone,
        place,
      });
    } else if (!isOwnPost(found.author, viewerPublicId)) {
      unplaced.push({ key, text, reason: copy.errCommentNotYours, place });
    } else if (thread !== undefined && keptPast(thread, commentId)) {
      // On screen past the 300 a read of the pages keeps — a read again on the way back that did
      // not land: no box opens there, and the text stays under it with the owner's words for that
      // (오너 결정 2026-10-22 (3차) 답 3) until a read brings it within them (3차 답 1).
      unplaced.push({ key, text, reason: copy.errCommentEditNotReopened, place });
    } else {
      edits.set(commentId, text);
    }
  }

  return { comment, replies, edits, unplaced, waiting, waitingThreads, waitingEdits };
}
