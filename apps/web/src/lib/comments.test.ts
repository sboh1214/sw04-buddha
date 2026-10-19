import {
  COMMENT_BODY_EMPTY_MESSAGE,
  COMMENT_BODY_MAX_LENGTH,
  commentBodyTooLongMessage,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type CommentThread, type PostAuthor, type PublishedComment } from './api';
import {
  type CommentPages,
  commentCountText,
  commentDraft,
  commentLengthText,
  commentPageQuery,
  commentPlaceholderMessage,
  commentThreadsOf,
  commentWriteErrorMessage,
  commentsClosedMessage,
  isStaleThreadRefusal,
  postCommentsKey,
  withEditedComment,
  withNewComment,
  withoutComment,
} from './comments';
import { isPrivateQueryKey } from './market-keys';
import { POSTS_KEY, postKey } from './posts';

/**
 * 댓글·대댓글 on the web (#48, ADR-0074): the key, what the author's writes do to the pages held,
 * the draft's count and the refusals — pure functions, so they run here under node.
 */

const POST = 'B7C9A1D2-6F34-4E58-9B0A-2D1E5F8C7A46';
const post = POST.toLowerCase();

const author: PostAuthor = {
  kind: 'member',
  publicId: 'k7m2p9qx4z',
  nickname: '근거왕',
  imageUrl: null,
  isAdmin: false,
};

/** A published comment `id`, under `parentId` when it is a 대댓글. */
const comment = (id: string, parentId: string | null = null, body = id): PublishedComment => ({
  state: 'published',
  id,
  parentId,
  body,
  author,
  createdAt: '2026-10-19T00:00:00.000Z',
  editedAt: null,
});

const thread = (top: CommentThread['comment'], ...replies: CommentThread['replies']) => ({
  comment: top,
  replies,
});

/** Pages of threads as `useInfiniteQuery` holds them, the last with `nextCursor`. */
const pagesOf = (pages: CommentThread[][], nextCursor: string | null = null): CommentPages => ({
  pages: pages.map((items, index) => ({
    items,
    nextCursor: index === pages.length - 1 ? nextCursor : `after-${String(index)}`,
  })),
  pageParams: pages.map((_, index) => (index === 0 ? undefined : `after-${String(index - 1)}`)),
});

/** The threads as ids: a 댓글's id (or its state) with its replies'. */
const shape = (pages: CommentPages | undefined) =>
  commentThreadsOf(pages).map(({ comment: top, replies }) => [
    top.state === 'published' ? top.id : `${top.state}:${top.id}`,
    replies.map((reply) => (reply.state === 'published' ? reply.id : `${reply.state}:${reply.id}`)),
  ]);

const refusal = (status: number, code: string, details?: unknown) =>
  new ApiError(status, { code, message: 'x', details } as never);

describe('the comments key', () => {
  it('is the post’s lower-cased id under the public posts root, apart from the post’s own key', () => {
    expect(postCommentsKey(POST)).toEqual(['posts', 'comments', post]);
    expect(postCommentsKey(POST).slice(0, 1)).toEqual([...POSTS_KEY]);
    expect(isPrivateQueryKey(postCommentsKey(POST))).toBe(false);
    // Neither is a prefix of the other, so invalidating one never reaches the other.
    expect(postCommentsKey(POST).slice(0, 3)).not.toEqual(postKey(POST));
  });

  it('asks for a page by its cursor only', () => {
    expect(commentPageQuery()).toEqual({});
    expect(commentPageQuery('c2')).toEqual({ cursor: 'c2' });
  });
});

describe('the threads held', () => {
  it('are the pages in order, each 댓글 once — where it last appears', () => {
    expect(shape(undefined)).toEqual([]);
    const pages = pagesOf([
      [thread(comment('a'), comment('a1', 'a')), thread(comment('n'))],
      [thread(comment('b')), thread(comment('n'))],
    ]);
    // 'n' was written by the reader and put after page one; page two brought it in its place.
    expect(shape(pages)).toEqual([
      ['a', ['a1']],
      ['b', []],
      ['n', []],
    ]);
  });
});

describe('a new comment', () => {
  it('goes last of the pages read when it is a 댓글, once', () => {
    const held = pagesOf([[thread(comment('a'))], [thread(comment('b'))]], 'more');
    const next = withNewComment(held, comment('n'));
    expect(shape(next)).toEqual([
      ['a', []],
      ['b', []],
      ['n', []],
    ]);
    // The cursor of the next page is the server's: the new 댓글 changes nothing about it.
    expect(next?.pages.at(-1)?.nextCursor).toBe('more');
    expect(withNewComment(next, comment('n'))).toBe(next);
    expect(withNewComment(undefined, comment('n'))).toBeUndefined();
  });

  it('goes last of its 댓글’s replies when it is a 대댓글, and waits for a 댓글 not read yet', () => {
    const held = pagesOf([[thread(comment('a'), comment('a1', 'a')), thread(comment('b'))]]);
    const next = withNewComment(held, comment('a2', 'a'));
    expect(shape(next)).toEqual([
      ['a', ['a1', 'a2']],
      ['b', []],
    ]);
    expect(shape(withNewComment(next, comment('a2', 'a')))).toEqual(shape(next));
    expect(shape(withNewComment(held, comment('z1', 'z')))).toEqual(shape(held));
  });
});

describe('an edit', () => {
  it('replaces the comment it answered for, a 댓글 or a 대댓글', () => {
    const held = pagesOf([[thread(comment('a'), comment('a1', 'a'))]]);
    const edited = { ...comment('a1', 'a', '고친 답글'), editedAt: '2026-10-19T01:00:00.000Z' };
    const next = withEditedComment(withEditedComment(held, edited), {
      ...comment('a', null, '고친 댓글'),
      editedAt: '2026-10-19T01:00:00.000Z',
    });
    const [only] = commentThreadsOf(next);
    expect(only?.comment).toMatchObject({
      body: '고친 댓글',
      editedAt: '2026-10-19T01:00:00.000Z',
    });
    expect(only?.replies[0]).toMatchObject({ id: 'a1', body: '고친 답글' });
  });
});

describe('a deletion', () => {
  const held = pagesOf([
    [
      thread(comment('a'), comment('a1', 'a'), comment('a2', 'a')),
      thread(comment('b')),
      thread({ state: 'deleted', id: 'd' }, comment('d1', 'd')),
      thread({ state: 'hidden', id: 'h' }, comment('h1', 'h')),
    ],
  ]);

  it('leaves a 댓글 with 대댓글 under it as its placeholder, with them', () => {
    expect(shape(withoutComment(held, { id: 'a', placeholder: true }))[0]).toEqual([
      'deleted:a',
      ['a1', 'a2'],
    ]);
  });

  it('takes any other comment out of the thread', () => {
    expect(shape(withoutComment(held, { id: 'b', placeholder: false }))).toEqual([
      ['a', ['a1', 'a2']],
      ['deleted:d', ['d1']],
      ['hidden:h', ['h1']],
    ]);
    expect(shape(withoutComment(held, { id: 'a1', placeholder: false }))[0]).toEqual(['a', ['a2']]);
  });

  it('takes a deleted 댓글’s placeholder with its last 대댓글, never a hidden one’s', () => {
    expect(shape(withoutComment(held, { id: 'd1', placeholder: false }))).toEqual([
      ['a', ['a1', 'a2']],
      ['b', []],
      ['hidden:h', ['h1']],
    ]);
    expect(shape(withoutComment(held, { id: 'h1', placeholder: false })).at(-1)).toEqual([
      'hidden:h',
      [],
    ]);
  });
});

describe('a draft', () => {
  it('is counted as the server keeps it: normalised, in code points', () => {
    expect(commentDraft('  한 줄\r\n두 줄 😀  ')).toEqual({
      body: '한 줄\n두 줄 😀',
      length: 9,
      empty: false,
      tooLong: false,
    });
    expect(commentDraft(' \n\t ')).toMatchObject({ body: '', length: 0, empty: true });
  });

  it('is too long past COMMENT_BODY_MAX_LENGTH characters, and keeps counting', () => {
    expect(commentDraft('가'.repeat(COMMENT_BODY_MAX_LENGTH)).tooLong).toBe(false);
    expect(commentDraft(`${'😀'.repeat(COMMENT_BODY_MAX_LENGTH)}a`)).toMatchObject({
      length: COMMENT_BODY_MAX_LENGTH + 1,
      tooLong: true,
    });
  });

  it('shows its count against the limit, and the copy says the same limit', () => {
    expect(commentLengthText(12)).toBe('12 / 1,000자');
    expect(commentLengthText(1012)).toBe('1,012 / 1,000자');
    expect(copy.errCommentBodyTooLong).toContain(COMMENT_BODY_MAX_LENGTH.toLocaleString('ko-KR'));
  });
});

describe('the count', () => {
  it('is written as it is, 0 included', () => {
    expect(commentCountText(0)).toBe('댓글 0');
    expect(commentCountText(1234)).toBe('댓글 1234');
  });
});

describe('the placeholders and the closed box', () => {
  it('say the owner’s words (#45-5), the same as a post’s', () => {
    expect(commentPlaceholderMessage('deleted')).toBe('삭제된 글입니다.');
    expect(commentPlaceholderMessage('hidden')).toBe('운영 정책에 따라 숨긴 글입니다.');
    expect(commentPlaceholderMessage('deleted')).toBe(copy.postDeletedPlaceholder);
    expect(commentPlaceholderMessage('hidden')).toBe(copy.postHiddenPlaceholder);
    expect(commentsClosedMessage('hidden')).toBe(copy.commentClosedPostHidden);
    expect(commentsClosedMessage('deleted')).toBe(copy.commentClosedPostDeleted);
  });
});

describe('a refused write', () => {
  it('says why, in the server’s terms', () => {
    const cases: [unknown, Parameters<typeof commentWriteErrorMessage>[1], string][] = [
      [
        refusal(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'x' }]),
        'create',
        copy.sessionChanged,
      ],
      [
        refusal(409, 'COMMENT_NOT_ALLOWED', { reason: 'post_hidden' }),
        'create',
        copy.commentClosedPostHidden,
      ],
      [
        refusal(409, 'COMMENT_NOT_ALLOWED', { reason: 'post_deleted' }),
        'create',
        copy.commentClosedPostDeleted,
      ],
      [
        refusal(409, 'COMMENT_NOT_ALLOWED', { reason: 'parent_hidden' }),
        'create',
        copy.errCommentParentHidden,
      ],
      [
        refusal(409, 'COMMENT_NOT_ALLOWED', { reason: 'parent_deleted' }),
        'create',
        copy.errCommentParentDeleted,
      ],
      // A reason this screen does not know, or none: still said, without guessing which.
      [
        refusal(409, 'COMMENT_NOT_ALLOWED', { reason: 'toString' }),
        'create',
        copy.errCommentNotAllowed,
      ],
      [refusal(409, 'COMMENT_NOT_ALLOWED'), 'create', copy.errCommentNotAllowed],
      [
        refusal(409, 'COMMENT_NOT_EDITABLE', { reason: 'hidden' }),
        'edit',
        copy.errCommentNotEditable,
      ],
      [
        refusal(404, 'NOT_FOUND', [{ path: ['parentId'], message: 'x' }]),
        'create',
        copy.errCommentParentGone,
      ],
      [refusal(404, 'NOT_FOUND'), 'create', copy.errPostGone],
      [refusal(404, 'NOT_FOUND'), 'edit', copy.errCommentGone],
      [refusal(404, 'NOT_FOUND'), 'delete', copy.errCommentGone],
      [refusal(403, 'FORBIDDEN'), 'edit', copy.errCommentNotYours],
      [refusal(403, 'ONBOARDING_REQUIRED'), 'create', copy.errPostOnboarding],
      [
        refusal(400, 'VALIDATION_ERROR', [{ path: ['body'], message: COMMENT_BODY_EMPTY_MESSAGE }]),
        'create',
        copy.errCommentBodyEmpty,
      ],
      [
        refusal(400, 'VALIDATION_ERROR', [
          { path: ['body'], message: commentBodyTooLongMessage(1_001) },
        ]),
        'edit',
        copy.errCommentBodyTooLong,
      ],
      [
        refusal(400, 'VALIDATION_ERROR', [{ path: ['body'], message: 'something else' }]),
        'create',
        copy.errPostInvalid,
      ],
      [new TypeError('Failed to fetch'), 'create', copy.errNetwork],
      [refusal(500, 'INTERNAL', undefined), 'create', copy.errUnknown],
    ];
    for (const [error, write, message] of cases) {
      expect(commentWriteErrorMessage(error, write)).toBe(message);
    }
  });

  it('reads the thread again only when it says the thread on screen is stale', () => {
    expect(
      isStaleThreadRefusal(refusal(409, 'COMMENT_NOT_ALLOWED', { reason: 'post_hidden' })),
    ).toBe(true);
    expect(isStaleThreadRefusal(refusal(409, 'COMMENT_NOT_EDITABLE'))).toBe(true);
    expect(isStaleThreadRefusal(refusal(404, 'NOT_FOUND'))).toBe(true);
    expect(isStaleThreadRefusal(refusal(400, 'VALIDATION_ERROR'))).toBe(false);
    expect(isStaleThreadRefusal(refusal(403, 'ONBOARDING_REQUIRED'))).toBe(false);
    expect(isStaleThreadRefusal(new TypeError('Failed to fetch'))).toBe(false);
  });
});
