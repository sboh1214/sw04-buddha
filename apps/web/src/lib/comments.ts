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
import {
  type CommentDeletion,
  type CommentThread,
  type PostComment,
  type PublishedComment,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';
import { POSTS_KEY } from './posts';

/**
 * 댓글·대댓글 (#48, ADR-0074) as the post page reads them: the cache key and request of a post's
 * comment threads, what the author's own writes do to the pages held, how a draft is counted and
 * what a refusal says. Pure functions of the API's answers, apart from the components and the hooks
 * so the node test runner reaches them, and free of `'use client'`, so the server page seeds the
 * key the browser's hook reads.
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
 * A post's comment threads, under the posts' root: public like the post (N05 §2), so the post page
 * reads the first page on the server and dehydrates it (`posts` is not a private root). Apart from
 * `postKey` (`['posts', 'post', id]`) so neither invalidates the other by prefix.
 */
export const postCommentsKey = (postId: string) =>
  [...POSTS_KEY, 'comments', postId.toLowerCase()] as const;

/** One page of `GET /posts/:postId/comments`: up to 20 댓글, each with every 대댓글 under it. */
export interface CommentPage {
  items: CommentThread[];
  nextCursor: string | null;
}

/** The pages as `useInfiniteQuery` holds them (the page params are its own business). */
export type CommentPages = InfiniteData<CommentPage>;

/**
 * The query of one page, as the server page and the browser's `queryFn` both send it: the cursor
 * when there is one, nothing else (the page size is the API's default), so the two produce
 * interchangeable pages under one key.
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
  const threads = pages?.pages.flatMap((page) => page.items) ?? [];
  const last = new Map<string, number>();
  threads.forEach((thread, index) => last.set(thread.comment.id, index));
  return threads.filter((thread, index) => last.get(thread.comment.id) === index);
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
 * sees it at once: a 대댓글 last of its 댓글's replies — `parentId` in the answer is always that
 * 댓글, even when the reply was aimed at a 대댓글 — and a 대댓글 whose 댓글 is not among the pages
 * read changes nothing (its page brings it). A 댓글 goes last of the pages read (the newest, #45-2
 * oldest first): the hooks read its page instead (`readOnToTheEnd`, use-comments.ts) and come here
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
    return {
      ...pages,
      pages: pages.pages.map((page, index) =>
        index === lastIndex ? { ...page, items: [...page.items, { comment, replies: [] }] } : page,
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
    comment: swap(thread.comment),
    replies: thread.replies.map(swap),
  }));
}

/**
 * A deletion's answer (`POST /comments/:commentId/delete`) applied as the next read would show it
 * (#45-5): a 댓글 that keeps its placeholder becomes '삭제된 글입니다' with its 대댓글 under it;
 * any other comment leaves the view. A 대댓글 that was the last under a deleted 댓글 takes that
 * placeholder with it — a deleted 댓글 with nothing under it is in no answer.
 */
export function withoutComment(
  pages: CommentPages | undefined,
  deletion: CommentDeletion,
): CommentPages | undefined {
  return mapThreads(pages, (thread) => {
    if (thread.comment.id === deletion.id) {
      return deletion.placeholder
        ? { comment: { state: 'deleted', id: deletion.id }, replies: thread.replies }
        : undefined;
    }
    if (!thread.replies.some((reply) => reply.id === deletion.id)) return thread;
    const replies = thread.replies.filter((reply) => reply.id !== deletion.id);
    return thread.comment.state === 'deleted' && replies.length === 0
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
 * every view its 404 (post-screen.tsx). The box that was refused is often not in what they show,
 * so the refusal is said as a toast (comments-section.tsx).
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
