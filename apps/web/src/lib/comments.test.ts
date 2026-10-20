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
  commentTextChanged,
  commentWriteErrorMessage,
  commentsClosedMessage,
  goneBoxReason,
  isStaleThreadRefusal,
  placeHeldTexts,
  postCommentsKey,
  resolveCommentDrafts,
  type HeldText,
  withEditedComment,
  withNewComment,
  withoutComment,
} from './comments';
import { NO_COMMENT_DRAFTS, type CommentDrafts } from './comment-drafts';
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

describe('a box’s text', () => {
  it('is something to lose only where it differs from what the box started with, as the server keeps it', () => {
    expect(commentTextChanged('', '')).toBe(false);
    expect(commentTextChanged('  \n ', '')).toBe(false);
    expect(commentTextChanged('댓글', '')).toBe(true);
    expect(commentTextChanged('그대로 ', '그대로')).toBe(false);
    expect(commentTextChanged('고친 것', '그대로')).toBe(true);
    // An edit emptied is a change (its save is refused, leaving still loses it).
    expect(commentTextChanged('', '그대로')).toBe(true);
  });
});

describe('text held apart from a box', () => {
  const held = (id: string, place: HeldText['place']): HeldText => ({
    id,
    place,
    reason: '까닭',
    text: id,
    focus: false,
  });
  const threads = [thread(comment('t1'), comment('r1', 't1')), thread(comment('t2'))];

  it('stands where its box stood while the thread still has that place, else under the threads', () => {
    const texts = [
      held('edit-of-reply', { kind: 'comment', commentId: 'r1', threadId: 't1' }),
      held('edit-gone', { kind: 'comment', commentId: 'r9', threadId: 't2' }),
      held('reply', { kind: 'thread', threadId: 't2' }),
      held('reply-gone', { kind: 'thread', threadId: 't9' }),
      held('edit-thread-gone', { kind: 'comment', commentId: 'x', threadId: 'x' }),
      held('new', { kind: 'post' }),
    ];
    const placed = placeHeldTexts(threads, texts);
    expect([...placed.byComment].map(([id, list]) => [id, list.map((one) => one.id)])).toEqual([
      ['r1', ['edit-of-reply']],
    ]);
    expect([...placed.byThread].map(([id, list]) => [id, list.map((one) => one.id)])).toEqual([
      ['t2', ['edit-gone', 'reply']],
    ]);
    expect(placed.rest.map((one) => one.id)).toEqual(['reply-gone', 'edit-thread-gone', 'new']);
  });
});

describe('why a box’s place takes its text no more', () => {
  const threads = [
    thread(comment('t1'), comment('r1', 't1'), { state: 'hidden', id: 'rh' }),
    thread({ state: 'deleted', id: 'td' }, comment('r2', 'td')),
    thread({ state: 'hidden', id: 'th' }),
  ];
  const view = (postState: 'published' | 'hidden' | 'deleted' = 'published') => ({
    postState,
    threads,
  });

  it('is nothing while the place still takes it', () => {
    expect(goneBoxReason({ kind: 'post' }, view())).toBeUndefined();
    expect(goneBoxReason({ kind: 'thread', threadId: 't1' }, view())).toBeUndefined();
    expect(
      goneBoxReason({ kind: 'comment', commentId: 'r1', threadId: 't1' }, view()),
    ).toBeUndefined();
  });

  it('is the server’s words for a 댓글 a placeholder or gone, and a comment hidden or gone', () => {
    expect(goneBoxReason({ kind: 'thread', threadId: 'td' }, view())).toBe(
      copy.errCommentParentDeleted,
    );
    expect(goneBoxReason({ kind: 'thread', threadId: 'th' }, view())).toBe(
      copy.errCommentParentHidden,
    );
    expect(goneBoxReason({ kind: 'thread', threadId: 'gone' }, view())).toBe(
      copy.errCommentParentGone,
    );
    expect(goneBoxReason({ kind: 'comment', commentId: 'rh', threadId: 't1' }, view())).toBe(
      copy.errCommentNotEditable,
    );
    expect(goneBoxReason({ kind: 'comment', commentId: 'td', threadId: 'td' }, view())).toBe(
      copy.errCommentGone,
    );
    expect(goneBoxReason({ kind: 'comment', commentId: 'x', threadId: 'x' }, view())).toBe(
      copy.errCommentGone,
    );
  });

  it('is the closed post’s sentence for a new 댓글 or a 대댓글 — an edit is still its author’s (7-6)', () => {
    for (const postState of ['hidden', 'deleted'] as const) {
      expect(goneBoxReason({ kind: 'post' }, view(postState))).toBe(
        commentsClosedMessage(postState),
      );
      expect(goneBoxReason({ kind: 'thread', threadId: 't1' }, view(postState))).toBe(
        commentsClosedMessage(postState),
      );
      expect(
        goneBoxReason({ kind: 'comment', commentId: 'r1', threadId: 't1' }, view(postState)),
      ).toBeUndefined();
    }
  });

  it('is the post gone for every box once the post is out of every view (오너 결정 2026-10-21 답 1)', () => {
    const gone = { postState: 'gone' as const, threads };
    expect(goneBoxReason({ kind: 'post' }, gone)).toBe(copy.errPostGone);
    expect(goneBoxReason({ kind: 'thread', threadId: 't1' }, gone)).toBe(copy.errPostGone);
    expect(goneBoxReason({ kind: 'comment', commentId: 'r1', threadId: 't1' }, gone)).toBe(
      copy.errPostGone,
    );
    expect(copy.errPostGone).toBe(copy.postNotFound);
  });
});

describe('drafts taken back after an onboarding step', () => {
  const drafts = (partial: Partial<CommentDrafts>): CommentDrafts => ({
    ...NO_COMMENT_DRAFTS,
    ...partial,
  });
  const mine = (id: string, parentId: string | null = null) => comment(id, parentId);
  const theirs = (id: string): PublishedComment => ({
    ...comment(id),
    author: { ...author, publicId: 'other00000' },
  });
  const view = (
    threads: CommentThread[],
    more: Partial<{ postState: 'published' | 'hidden' | 'deleted'; allRead: boolean }> = {},
  ) => ({
    postId: post,
    postState: more.postState ?? 'published',
    threads,
    allRead: more.allRead ?? true,
    viewerPublicId: author.kind === 'member' ? author.publicId : '',
  });

  it('go into their boxes while those can open', () => {
    const resolved = resolveCommentDrafts(
      drafts({
        comment: '새 댓글',
        replies: new Map([['t1', '답글']]),
        edits: new Map([
          ['t1', '고친 댓글'],
          ['r1', '고친 답글'],
        ]),
      }),
      view([thread(mine('t1'), mine('r1', 't1'))]),
    );
    expect(resolved.comment).toBe('새 댓글');
    expect([...resolved.replies]).toEqual([['t1', '답글']]);
    expect([...resolved.edits]).toEqual([
      ['t1', '고친 댓글'],
      ['r1', '고친 답글'],
    ]);
    expect(resolved.unplaced).toEqual([]);
    expect(resolved.waiting).toBe(false);
  });

  it('are shown apart, in the server’s words, where their box can no longer open', () => {
    const resolved = resolveCommentDrafts(
      drafts({
        replies: new Map([
          ['deleted', '지운 댓글에'],
          ['hidden', '숨긴 댓글에'],
          ['gone', '없는 댓글에'],
        ]),
        edits: new Map([
          ['hidden-own', '숨긴 내 댓글'],
          ['gone-own', '없는 내 댓글'],
          ['their', '남의 댓글'],
        ]),
      }),
      view([
        thread({ state: 'deleted', id: 'deleted' }, comment('under', 'deleted')),
        thread({ state: 'hidden', id: 'hidden' }),
        thread(mine('t1'), { state: 'hidden', id: 'hidden-own' }),
        thread(theirs('their')),
      ]),
    );
    expect(resolved.replies.size).toBe(0);
    expect(resolved.edits.size).toBe(0);
    expect(resolved.unplaced.map(({ text, reason, place }) => [text, reason, place])).toEqual([
      ['지운 댓글에', copy.errCommentParentDeleted, { kind: 'thread', threadId: 'deleted' }],
      ['숨긴 댓글에', copy.errCommentParentHidden, { kind: 'thread', threadId: 'hidden' }],
      ['없는 댓글에', copy.errCommentParentGone, { kind: 'thread', threadId: 'gone' }],
      [
        '숨긴 내 댓글',
        copy.errCommentNotEditable,
        { kind: 'comment', commentId: 'hidden-own', threadId: 't1' },
      ],
      [
        '없는 내 댓글',
        copy.errCommentGone,
        { kind: 'comment', commentId: 'gone-own', threadId: 'gone-own' },
      ],
      [
        '남의 댓글',
        copy.errCommentNotYours,
        { kind: 'comment', commentId: 'their', threadId: 'their' },
      ],
    ]);
    expect(resolved.unplaced.map(({ key }) => key)).toEqual([
      { kind: 'reply', postId: post, parentId: 'deleted' },
      { kind: 'reply', postId: post, parentId: 'hidden' },
      { kind: 'reply', postId: post, parentId: 'gone' },
      { kind: 'edit', postId: post, commentId: 'hidden-own' },
      { kind: 'edit', postId: post, commentId: 'gone-own' },
      { kind: 'edit', postId: post, commentId: 'their' },
    ]);
  });

  it('under a post hidden or deleted meanwhile: a new 댓글 or a 대댓글 is shown apart, an edit still opens', () => {
    for (const postState of ['hidden', 'deleted'] as const) {
      const resolved = resolveCommentDrafts(
        drafts({
          comment: '새 댓글',
          replies: new Map([['t1', '답글']]),
          edits: new Map([['t1', '고친 댓글']]),
        }),
        view([thread(mine('t1'))], { postState }),
      );
      expect(resolved.comment).toBeUndefined();
      expect(resolved.replies.size).toBe(0);
      expect([...resolved.edits]).toEqual([['t1', '고친 댓글']]);
      expect(resolved.unplaced.map(({ text, reason }) => [text, reason])).toEqual([
        ['새 댓글', commentsClosedMessage(postState)],
        ['답글', commentsClosedMessage(postState)],
      ]);
    }
  });

  it('are all shown apart with the post gone once it is out of every view (오너 결정 2026-10-21 답 1)', () => {
    const resolved = resolveCommentDrafts(
      drafts({
        comment: '새 댓글',
        replies: new Map([['t1', '답글']]),
        edits: new Map([['t1', '고친 댓글']]),
      }),
      { ...view([thread(mine('t1'))]), postState: 'gone' },
    );
    expect(resolved.comment).toBeUndefined();
    expect(resolved.replies.size + resolved.edits.size).toBe(0);
    expect(resolved.waiting).toBe(false);
    expect(resolved.unplaced).toEqual([
      {
        key: { kind: 'comment', postId: post },
        text: '새 댓글',
        reason: copy.errPostGone,
        place: { kind: 'post' },
      },
      {
        key: { kind: 'reply', postId: post, parentId: 't1' },
        text: '답글',
        reason: copy.errPostGone,
        place: { kind: 'thread', threadId: 't1' },
      },
      {
        key: { kind: 'edit', postId: post, commentId: 't1' },
        text: '고친 댓글',
        reason: copy.errPostGone,
        place: { kind: 'comment', commentId: 't1', threadId: 't1' },
      },
    ]);
  });

  it('wait for the pages still to read when their comment is not among those read', () => {
    const resolved = resolveCommentDrafts(
      drafts({ replies: new Map([['later', '답글']]), edits: new Map([['later', '고친 댓글']]) }),
      view([thread(mine('t1'))], { allRead: false }),
    );
    expect(resolved.waiting).toBe(true);
    expect(resolved.unplaced).toEqual([]);
    expect(resolved.replies.size + resolved.edits.size).toBe(0);
  });
});
