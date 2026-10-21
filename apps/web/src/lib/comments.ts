import {
  COMMENT_BODY_MAX_LENGTH,
  COMMENT_NOT_ALLOWED_REASONS,
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
 * The thread `fresh`, read again, with the reply pages after it still to read so it holds as many
 * 대댓글 as the screen did (`held`, the same thread before the read) — so a read of the comment
 * pages (the window's focus, 30 seconds, a reconnection, a write's read) never takes away what
 * '답글 더 보기' brought, nor a box open on it. Whether one more page is to be read.
 */
export function threadReadsOn(fresh: CommentThread, held: CommentThread | undefined): boolean {
  return (
    held !== undefined &&
    fresh.repliesNextCursor !== null &&
    fresh.replies.length < held.replies.length
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
 * instead (`readOnReplies`, use-comments.ts) and come here only once they are all read or that
 * read fails — before 대댓글 still unread, then, until their page brings it to its place. A 댓글
 * goes last of the pages read: the hooks read its page instead (`readOnToTheEnd`) and come here
 * only when that read fails — before 댓글 still unread, and out of the pages at the next read of as
 * many pages, until 더 보기 brings it. Nothing is added twice.
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
 * 댓글's — under the threads, in the order they were held.
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
 * on screen went with that thread's pages read, so one not among them is gone. What a held text
 * says for a box with no write that went because its place changed (오너 결정 2026-10-21 답 2), and
 * when the refusal its box heard was about something else — a network failure, say — and the box
 * went later because its thread changed (`heldTextsOf`).
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
      return found === undefined ? copy.errCommentGone : editRefusalOf(found.state);
    }
  }
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
 * 보기') and is gone once they are all read. A post out of every view (`gone`) takes none: each is
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
    return { comment, replies, edits, unplaced, waiting, waitingThreads };
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
    const place: HeldTextPlace = { kind: 'comment', commentId, threadId };
    const found =
      thread === undefined
        ? undefined
        : [thread.comment, ...thread.replies].find((held) => held.id === commentId);
    const home = threads.find((held) => held.comment.id === keptIn);
    if (found === undefined && home !== undefined && home.repliesNextCursor !== null) {
      // Among its thread's 대댓글 still unread, perhaps: read on through them.
      waitingThreads.push(keptIn);
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
    } else {
      edits.set(commentId, text);
    }
  }

  return { comment, replies, edits, unplaced, waiting, waitingThreads };
}
