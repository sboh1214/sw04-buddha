import {
  COMMENT_BODY_EMPTY_MESSAGE,
  COMMENT_BODY_MAX_LENGTH,
  COMMENT_REPLIES_PAGE_SIZE,
  commentBodyTooLongMessage,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  ApiError,
  type CommentThread,
  type PostAuthor,
  type PostComment,
  type PublishedComment,
} from './api';
import {
  PLACED_COMMENTS_KEPT,
  PLACED_REPLIES_KEPT,
  REPLIES_KEPT_ON_READ,
  REPLY_READ_ON_PAGES,
  type CommentPage,
  type CommentPages,
  type RepliesOnScreen,
  type ReplyPage,
  commentCountText,
  commentDraft,
  commentLengthText,
  commentPageQuery,
  commentPageRead,
  commentPlaceholderMessage,
  commentThreadsOf,
  commentTextChanged,
  commentWriteErrorMessage,
  commentsClosedMessage,
  draftsHeldOnReadFailure,
  editDraftReadOnMark,
  editDraftsReadOn,
  goneBoxReason,
  heldEditsBrought,
  heldEditsReadToTheirEnd,
  isCursorRefusal,
  isStaleThreadRefusal,
  keepPlacedComments,
  placeHeldTexts,
  placedReplyIds,
  postCommentsKey,
  repliesOnScreenOf,
  resolveCommentDrafts,
  threadKeepsAnotherPage,
  threadOf,
  threadReadsOn,
  threadWithReplies,
  type HeldText,
  withEditedComment,
  withMoreReplies,
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
  likeCount: 0,
});

const thread = (
  top: CommentThread['comment'],
  ...replies: CommentThread['replies']
): CommentThread => ({ comment: top, replies, repliesNextCursor: null });

/** A thread with 대댓글 still unread after `replies`, from `cursor` ('답글 더 보기'). */
const threadWithMore = (
  cursor: string,
  top: CommentThread['comment'],
  ...replies: CommentThread['replies']
): CommentThread => ({ comment: top, replies, repliesNextCursor: cursor });

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

describe('the 대댓글 after the first 50 (오너 결정 2026-10-21: 답글 더 보기)', () => {
  const page = (nextCursor: string | null, ...items: ReplyPage['items']): ReplyPage => ({
    items,
    nextCursor,
  });

  it('go after the replies held, the thread’s cursor moving on to the page’s', () => {
    const held = pagesOf([
      [threadWithMore('a-50', comment('a'), comment('a1', 'a')), thread(comment('b'))],
    ]);
    const next = withMoreReplies(held, 'a', 'a-50', page('a-100', comment('a2', 'a')));
    expect(shape(next)).toEqual([
      ['a', ['a1', 'a2']],
      ['b', []],
    ]);
    expect(commentThreadsOf(next)[0]?.repliesNextCursor).toBe('a-100');
    const last = withMoreReplies(next, 'a', 'a-100', page(null, { state: 'hidden', id: 'a3' }));
    expect(shape(last)[0]).toEqual(['a', ['a1', 'a2', 'hidden:a3']]);
    expect(commentThreadsOf(last)[0]?.repliesNextCursor).toBeNull();
  });

  it('go nowhere once the thread was read again from elsewhere, or is gone', () => {
    const held = pagesOf([[threadWithMore('a-50', comment('a'), comment('a1', 'a'))]]);
    // Read from a cursor the thread no longer holds: it could overlap or skip what it holds now.
    expect(shape(withMoreReplies(held, 'a', 'stale', page(null, comment('a2', 'a'))))).toEqual(
      shape(held),
    );
    expect(shape(withMoreReplies(held, 'z', 'a-50', page(null, comment('z1', 'z'))))).toEqual(
      shape(held),
    );
    expect(withMoreReplies(undefined, 'a', 'a-50', page(null))).toBeUndefined();
  });

  it('put a 대댓글 the writer added at the end where its page brings it, after older ones', () => {
    // Written while a1's later siblings were unread and their read failed: last of what was held.
    const held = withNewComment(
      pagesOf([[threadWithMore('a-50', comment('a'), comment('a1', 'a'))]]),
      comment('mine', 'a'),
    );
    expect(shape(held)[0]).toEqual(['a', ['a1', 'mine']]);
    const next = withMoreReplies(
      held,
      'a',
      'a-50',
      page(null, comment('a2', 'a'), comment('mine', 'a')),
    );
    expect(shape(next)[0]).toEqual(['a', ['a1', 'a2', 'mine']]);
  });

  it('are read on when a page read again holds fewer than the screen did', () => {
    const fresh = threadWithMore('a-50', comment('a'), comment('a1', 'a'));
    const held = thread(comment('a'), comment('a1', 'a'), comment('a2', 'a'));
    expect(threadReadsOn(fresh, held, 0)).toBe(true);
    expect(threadReadsOn(fresh, undefined, 0)).toBe(false);
    expect(threadReadsOn(fresh, thread(comment('a'), comment('a1', 'a')), 0)).toBe(false);
    expect(threadReadsOn(thread(comment('a'), comment('a1', 'a')), held, 0)).toBe(false);
    const read = threadWithReplies(fresh, page(null, comment('a2', 'a')));
    expect(read).toEqual(held);
    expect(threadReadsOn(read, held, 1)).toBe(false);
  });

  it('are read on five reply pages at most (오너 결정 2026-10-21 (2차) 답 1)', () => {
    expect(REPLY_READ_ON_PAGES).toBe(5);
    const fresh = threadWithMore('a-50', comment('a'), comment('a1', 'a'));
    const held = thread(comment('a'), comment('a1', 'a'), comment('a2', 'a'));
    for (let pagesRead = 0; pagesRead < REPLY_READ_ON_PAGES; pagesRead += 1) {
      expect(threadReadsOn(fresh, held, pagesRead)).toBe(true);
    }
    // Past them, what the screen held beyond goes back behind '답글 더 보기'.
    expect(threadReadsOn(fresh, held, REPLY_READ_ON_PAGES)).toBe(false);
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

describe('the writer’s own new comment placed at the end of what is held (오너 결정 2026-10-24)', () => {
  const page = (nextCursor: string | null, ...items: ReplyPage['items']): ReplyPage => ({
    items,
    nextCursor,
  });
  /** What `pages` keeps placed, as `<threadId|->:<id>`. */
  const placedIn = (pages: CommentPages | undefined) =>
    (pages?.placed ?? []).map((entry) => `${entry.threadId ?? '-'}:${entry.id}`);
  /** A page of 댓글 as a read has just brought it (`commentPageRead`). */
  const read = (nextCursor: string | null, ...items: CommentThread[]): CommentPage =>
    commentPageRead({ items, nextCursor });

  it('is placed for its writer by `withNewComment`: a 댓글 always, a 대댓글 while its thread has 대댓글 unread — and nothing without a writer', () => {
    const held = pagesOf(
      [[threadWithMore('a-2', comment('a'), comment('a1', 'a')), thread(comment('b'))]],
      'more',
    );
    expect(placedIn(withNewComment(held, comment('n')))).toEqual([]);
    const one = withNewComment(held, comment('n'), 'user-1');
    expect(placedIn(one)).toEqual(['-:n']);
    const two = withNewComment(one, comment('n1', 'a'), 'user-1');
    expect(placedIn(two)).toEqual(['-:n', 'a:n1']);
    expect(placedReplyIds(two)).toEqual(new Set(['n1']));
    // Under a thread with nothing unread, a 대댓글 is in its place: nothing is placed.
    expect(placedIn(withNewComment(two, comment('b1', 'b'), 'user-1'))).toEqual(['-:n', 'a:n1']);
    // Written again (held already), nothing changes.
    expect(withNewComment(two, comment('n'), 'user-1')).toBe(two);
  });

  it('is its writer’s only, and within its bounds: another account’s go as one is placed, and the oldest past PLACED_COMMENTS_KEPT 댓글 or PLACED_REPLIES_KEPT 대댓글', () => {
    const held = pagesOf([[threadWithMore('a-2', comment('a'), comment('a1', 'a'))]], 'more');
    const theirs = withNewComment(
      withNewComment(held, comment('t'), 'user-2'),
      comment('t1', 'a'),
      'user-2',
    );
    expect(placedIn(withNewComment(theirs, comment('n'), 'user-1'))).toEqual(['-:n']);
    let pages: CommentPages | undefined = held;
    for (let index = 0; index <= PLACED_COMMENTS_KEPT; index += 1) {
      pages = withNewComment(pages, comment(`n${String(index)}`), 'user-1');
    }
    for (let index = 0; index <= PLACED_REPLIES_KEPT; index += 1) {
      pages = withNewComment(pages, comment(`r${String(index)}`, 'a'), 'user-1');
    }
    const placed = placedIn(pages);
    expect(placed.filter((one) => one.startsWith('-:'))).toHaveLength(PLACED_COMMENTS_KEPT);
    expect(placed.filter((one) => one.startsWith('a:'))).toHaveLength(PLACED_REPLIES_KEPT);
    expect(placed).not.toContain('-:n0');
    expect(placed).not.toContain('a:r0');
    expect(placed).toContain(`-:n${String(PLACED_COMMENTS_KEPT)}`);
    // The oldest stays where it stood — drawn still, until the next read leaves it out.
    expect(commentThreadsOf(pages).map((one) => one.comment.id)).toContain('n0');
  });

  it('a read’s pages come without it: it is carried over and put back at the end — a 댓글 at the end of the last page, a 대댓글 at the end of its thread — as held, with what was written under it', () => {
    const held = withNewComment(
      withNewComment(
        pagesOf([[threadWithMore('a-2', comment('a'), comment('a1', 'a'))]], 'more'),
        comment('n'),
        'user-1',
      ),
      comment('a9', 'a'),
      'user-1',
    )!;
    const withReply = withNewComment(held, comment('n1', 'n'))!;
    const fresh: CommentPages = {
      pages: [
        read('more', threadWithMore('a-2', comment('a'), comment('a1', 'a')), thread(comment('b'))),
      ],
      pageParams: [undefined],
    };
    const next = keepPlacedComments(withReply, fresh);
    expect(shape(next)).toEqual([
      ['a', ['a1', 'a9']],
      ['b', []],
      ['n', ['n1']],
    ]);
    expect(placedIn(next)).toEqual(['-:n', 'a:a9']);
    // A write that carries those pages later is no read: what it holds stays as the write left it.
    const again = keepPlacedComments(next, { ...next, pages: [...fresh.pages] });
    expect(shape(again)).toEqual([
      ['a', ['a1']],
      ['b', []],
    ]);
    expect(placedIn(again)).toEqual([]);
  });

  it('a read that brings its page puts it in place, drawn there only; a read that ends the list — or its thread — without it drops it', () => {
    const held = withNewComment(
      withNewComment(
        pagesOf([[threadWithMore('a-2', comment('a'), comment('a1', 'a'))]], 'c1'),
        comment('n'),
        'user-1',
      ),
      comment('a9', 'a'),
      'user-1',
    )!;
    // 더 보기's page holds the 댓글: the held pages keep theirs, the copy at the end goes.
    const brought = keepPlacedComments(held, {
      ...held,
      pages: [...held.pages, read('c2', thread(comment('m')), thread(comment('n')))],
      pageParams: [...held.pageParams, 'c1'],
    });
    expect(shape(brought).map(([id]) => id)).toEqual(['a', 'm', 'n']);
    expect(brought.pages[0]?.items.map((one) => one.comment.id)).toEqual(['a']);
    expect(placedIn(brought)).toEqual(['a:a9']);
    // 더 보기 to the end of the list without it: gone.
    const ended = keepPlacedComments(held, {
      ...held,
      pages: [...held.pages, read(null, thread(comment('m')))],
      pageParams: [...held.pageParams, 'c1'],
    });
    expect(shape(ended).map(([id]) => id)).toEqual(['a', 'm']);
    expect(placedIn(ended)).toEqual(['a:a9']);
    // A read of the pages whose thread is read to its end without the 대댓글: gone too; one whose
    // thread holds it: in place.
    const threadEnded = keepPlacedComments(held, {
      pages: [read('c1', thread(comment('a'), comment('a1', 'a'), comment('a2', 'a')))],
      pageParams: [undefined],
    });
    expect(shape(threadEnded)).toEqual([
      ['a', ['a1', 'a2']],
      ['n', []],
    ]);
    expect(placedIn(threadEnded)).toEqual(['-:n']);
    const threadBrought = keepPlacedComments(held, {
      pages: [
        read('c1', threadWithMore('a-4', comment('a'), comment('a1', 'a'), comment('a9', 'a'))),
      ],
      pageParams: [undefined],
    });
    expect(shape(threadBrought)[0]).toEqual(['a', ['a1', 'a9']]);
    expect(placedIn(threadBrought)).toEqual(['-:n']);
  });

  it('what the write itself placed stands where it put it, on a page just read too (a new 댓글’s read stopped at five pages); what was placed before goes back after it in the order placed', () => {
    const held = withNewComment(pagesOf([[thread(comment('a'))]], 'c1'), comment('p'), 'user-1')!;
    // The last page held as read again, a new 댓글 put at its end: what `readOnToTheEnd` writes.
    const readAgain = read('c1', thread(comment('a')), thread(comment('b')));
    const written = withNewComment({ ...held, pages: [readAgain] }, comment('n'), 'user-1')!;
    const next = keepPlacedComments(held, written);
    expect(shape(next).map(([id]) => id)).toEqual(['a', 'b', 'p', 'n']);
    expect(placedIn(next)).toEqual(['-:p', '-:n']);
  });

  it('is no longer placed once the writer’s own deletion took it off', () => {
    const held = withNewComment(pagesOf([[thread(comment('a'))]], 'c1'), comment('n'), 'user-1')!;
    const next = keepPlacedComments(held, withoutComment(held, { id: 'n', placeholder: false })!);
    expect(shape(next).map(([id]) => id)).toEqual(['a']);
    expect(placedIn(next)).toEqual([]);
  });

  it('‘답글 더 보기’ leaves it last of what is held until its page brings it into place, and drops it once the thread ends without it', () => {
    const held = withNewComment(
      pagesOf([[threadWithMore('a-2', comment('a'), comment('a1', 'a'))]]),
      comment('mine', 'a'),
      'user-1',
    );
    const short = withMoreReplies(held, 'a', 'a-2', page('a-3', comment('a2', 'a')));
    expect(shape(short)[0]).toEqual(['a', ['a1', 'a2', 'mine']]);
    expect(placedIn(short)).toEqual(['a:mine']);
    const brought = withMoreReplies(
      short,
      'a',
      'a-3',
      page('a-5', comment('a3', 'a'), comment('mine', 'a')),
    );
    expect(shape(brought)[0]).toEqual(['a', ['a1', 'a2', 'a3', 'mine']]);
    expect(placedIn(brought)).toEqual([]);
    const ended = withMoreReplies(short, 'a', 'a-3', page(null, comment('a3', 'a')));
    expect(shape(ended)[0]).toEqual(['a', ['a1', 'a2', 'a3']]);
    expect(placedIn(ended)).toEqual([]);
    // From a cursor the thread no longer holds, nothing changes: it stays placed.
    expect(placedIn(withMoreReplies(short, 'a', 'stale', page(null)))).toEqual(['a:mine']);
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
    // The thread's place in its 대댓글 stays.
    const more = pagesOf([[threadWithMore('a-50', comment('a'), comment('a1', 'a'))]]);
    expect(commentThreadsOf(withEditedComment(more, edited))[0]?.repliesNextCursor).toBe('a-50');
  });

  it('goes in only over the comment as published and edited no later: done again over pages read since (ADR-0074 7-34), it keeps a deletion, a hiding or a later edit they know of', () => {
    const answer = { ...comment('a1', 'a', '고친 답글'), editedAt: '2026-10-19T01:00:00.000Z' };
    const later = { ...comment('a1', 'a', '또 고친 답글'), editedAt: '2026-10-19T02:00:00.000Z' };
    const same = { ...comment('a1', 'a', '같은 때'), editedAt: answer.editedAt };
    const replyOf = (pages: CommentPages | undefined) => commentThreadsOf(pages)[0]?.replies[0];
    // Deleted or hidden since: the placeholder stays.
    for (const state of ['deleted', 'hidden'] as const) {
      const held = pagesOf([[thread(comment('a'), { state, id: 'a1' })]]);
      expect(replyOf(withEditedComment(held, answer))).toEqual({ state, id: 'a1' });
    }
    expect(
      commentThreadsOf(
        withEditedComment(pagesOf([[thread({ state: 'deleted', id: 'a' })]]), {
          ...comment('a', null, '고친 댓글'),
          editedAt: answer.editedAt,
        }),
      )[0]?.comment,
    ).toEqual({ state: 'deleted', id: 'a' });
    // Edited again since: the later edit stays; one as old, or older, takes the answer.
    expect(replyOf(withEditedComment(pagesOf([[thread(comment('a'), later)]]), answer))).toBe(
      later,
    );
    expect(replyOf(withEditedComment(pagesOf([[thread(comment('a'), same)]]), answer))).toBe(
      answer,
    );
    expect(
      replyOf(withEditedComment(pagesOf([[thread(comment('a'), comment('a1', 'a'))]]), answer)),
    ).toBe(answer);
    // An answer with no '수정됨' does not go over a comment that has one.
    expect(
      replyOf(
        withEditedComment(pagesOf([[thread(comment('a'), answer)]]), comment('a1', 'a', 'x')),
      ),
    ).toBe(answer);
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

  it('keeps a deleted 댓글’s placeholder while 대댓글 are still unread under it', () => {
    const more = pagesOf([
      [threadWithMore('d-50', { state: 'deleted', id: 'd' }, comment('d1', 'd'))],
    ]);
    expect(shape(withoutComment(more, { id: 'd1', placeholder: false }))).toEqual([
      ['deleted:d', []],
    ]);
    expect(
      commentThreadsOf(withoutComment(more, { id: 'd1', placeholder: false }))[0]
        ?.repliesNextCursor,
    ).toBe('d-50');
    // A 댓글 deleted to its placeholder keeps its cursor too.
    const top = pagesOf([[threadWithMore('a-50', comment('a'), comment('a1', 'a'))]]);
    expect(commentThreadsOf(withoutComment(top, { id: 'a', placeholder: true }))[0]).toEqual({
      comment: { state: 'deleted', id: 'a' },
      replies: [comment('a1', 'a')],
      repliesNextCursor: 'a-50',
    });
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

  it('tells a cursor that no longer opens (ADR-0074 7-29) from every other refusal', () => {
    const cursor = [{ path: ['cursor'], message: 'Not a cursor of this list' }];
    expect(isCursorRefusal(refusal(400, 'VALIDATION_ERROR', cursor))).toBe(true);
    expect(
      isCursorRefusal(refusal(400, 'VALIDATION_ERROR', [{ path: ['limit'], message: 'x' }])),
    ).toBe(false);
    expect(isCursorRefusal(refusal(400, 'VALIDATION_ERROR'))).toBe(false);
    expect(isCursorRefusal(refusal(404, 'NOT_FOUND', cursor))).toBe(false);
    expect(isCursorRefusal(new TypeError('Failed to fetch'))).toBe(false);
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
    shown: false,
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

  it('says a 대댓글 edited is not among those read when its thread has 대댓글 still unread (오너 결정 2026-10-21 (2차) 답 1, 7-30)', () => {
    // A read of the pages reads a thread on five reply pages at most: a 대댓글 opened past them is
    // out of the thread read again — or deleted; the words hold for both.
    const capped = {
      postState: 'published' as const,
      threads: [threadWithMore('t1-300', comment('t1'), comment('r1', 't1'))],
    };
    expect(goneBoxReason({ kind: 'comment', commentId: 'r400', threadId: 't1' }, capped)).toBe(
      copy.errCommentEditNotRead,
    );
    // Every 대댓글 of the thread read, or the 댓글 itself: gone.
    expect(goneBoxReason({ kind: 'comment', commentId: 'r400', threadId: 't1' }, view())).toBe(
      copy.errCommentGone,
    );
    expect(goneBoxReason({ kind: 'comment', commentId: 't9', threadId: 't9' }, capped)).toBe(
      copy.errCommentGone,
    );
    // Its thread out of view: gone with it.
    expect(goneBoxReason({ kind: 'comment', commentId: 'r400', threadId: 't2' }, capped)).toBe(
      copy.errCommentGone,
    );
  });

  it('says the owner’s sentence for an edit whose 대댓글 is not among those read (오너 결정 2026-10-22 답 3)', () => {
    expect(copy.errCommentEditNotRead).toBe(
      '고치던 답글을 목록에서 찾지 못했습니다. 지워졌거나 아직 불러오지 않은 답글입니다.',
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
      { kind: 'edit', postId: post, commentId: 'hidden-own', threadId: 't1' },
      { kind: 'edit', postId: post, commentId: 'gone-own', threadId: 'gone-own' },
      { kind: 'edit', postId: post, commentId: 'their', threadId: 'their' },
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
        key: { kind: 'edit', postId: post, commentId: 't1', threadId: 't1' },
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
    expect(resolved.waitingThreads).toEqual([]);
    expect(resolved.unplaced).toEqual([]);
    expect(resolved.replies.size + resolved.edits.size).toBe(0);
  });

  it('read on through a thread’s unread 대댓글 for the edit of one kept with that thread (답글 더 보기)', () => {
    const edits = new Map([['r9', '고친 답글']]);
    const editThreads = new Map([['r9', 't1']]);
    // The thread is read, its 대댓글 past the first page not yet: read on through them.
    const waiting = resolveCommentDrafts(
      drafts({ edits, editThreads }),
      view([threadWithMore('t1-50', mine('t1'), mine('r1', 't1'))]),
    );
    expect(waiting.waitingThreads).toEqual(['t1']);
    expect(waiting.waitingEdits).toEqual([
      {
        key: { kind: 'edit', postId: post, commentId: 'r9', threadId: 't1' },
        text: '고친 답글',
        place: { kind: 'comment', commentId: 'r9', threadId: 't1' },
      },
    ]);
    expect(waiting.waiting).toBe(false);
    expect(waiting.unplaced).toEqual([]);
    expect(waiting.edits.size).toBe(0);
    // Read on to it: its edit opens.
    const found = resolveCommentDrafts(
      drafts({ edits, editThreads }),
      view([thread(mine('t1'), mine('r1', 't1'), mine('r9', 't1'))]),
    );
    expect([...found.edits]).toEqual([['r9', '고친 답글']]);
    expect(found.waitingThreads).toEqual([]);
    expect(found.waitingEdits).toEqual([]);
    // Every 대댓글 read and it is not among them: gone, shown apart where its thread stands.
    const gone = resolveCommentDrafts(
      drafts({ edits, editThreads }),
      view([thread(mine('t1'), mine('r1', 't1'))], { allRead: false }),
    );
    expect(gone.waiting).toBe(false);
    expect(gone.unplaced).toEqual([
      {
        key: { kind: 'edit', postId: post, commentId: 'r9', threadId: 't1' },
        text: '고친 답글',
        reason: copy.errCommentGone,
        place: { kind: 'comment', commentId: 'r9', threadId: 't1' },
      },
    ]);
    // Its thread not read yet: the 댓글 pages first.
    const later = resolveCommentDrafts(
      drafts({ edits, editThreads }),
      view([thread(mine('t2'))], { allRead: false }),
    );
    expect([later.waiting, later.waitingThreads]).toEqual([true, []]);
    // Kept without a thread (an edit of a 댓글): its own thread, no 대댓글 to read through.
    const own = resolveCommentDrafts(
      drafts({ edits: new Map([['t1', '고친 댓글']]) }),
      view([threadWithMore('t1-50', mine('t1'), mine('r1', 't1'))]),
    );
    expect([...own.edits]).toEqual([['t1', '고친 댓글']]);
    expect(own.waitingThreads).toEqual([]);
  });

  it('show an edit waiting on its thread apart with the read’s failure when that read fails (오너 결정 2026-10-21 (2차) 답 2)', () => {
    const resolved = resolveCommentDrafts(
      drafts({
        edits: new Map([
          ['r9', '고친 답글'],
          ['s9', '다른 스레드의 고친 답글'],
        ]),
        editThreads: new Map([
          ['r9', 't1'],
          ['s9', 't2'],
        ]),
      }),
      view([
        threadWithMore('t1-50', mine('t1'), mine('r1', 't1')),
        threadWithMore('t2-50', mine('t2'), mine('s1', 't2')),
      ]),
    );
    expect(resolved.waitingThreads).toEqual(['t1', 't2']);
    // Only the drafts waiting on the thread whose read failed, with the read's words as why.
    expect(draftsHeldOnReadFailure(resolved.waitingEdits, 't1', copy.errNetwork)).toEqual([
      {
        key: { kind: 'edit', postId: post, commentId: 'r9', threadId: 't1' },
        text: '고친 답글',
        reason: copy.errNetwork,
        place: { kind: 'comment', commentId: 'r9', threadId: 't1' },
      },
    ]);
    // Nothing waits there any more (its box took it, or it is shown apart already): nothing.
    expect(draftsHeldOnReadFailure([], 't1', copy.errNetwork)).toEqual([]);
    expect(draftsHeldOnReadFailure(resolved.waitingEdits, 't3', copy.errNetwork)).toEqual([]);
  });

  /** `count` of the viewer's 대댓글 under the 댓글 `top`, as `<prefix>0`, `<prefix>1`, …. */
  const minesUnder = (top: string, prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => mine(`${prefix}${String(index)}`, top));

  it('never read past the 300 대댓글 a read of the pages keeps (오너 결정 2026-10-22 (2차) 답 1)', () => {
    expect(REPLIES_KEPT_ON_READ).toBe(COMMENT_REPLIES_PAGE_SIZE * (1 + REPLY_READ_ON_PAGES));
    expect(REPLIES_KEPT_ON_READ).toBe(300);
    const holding = (count: number) =>
      threadWithMore('next', mine('t1'), ...minesUnder('t1', 'r', count));
    // Read from its first page: 50, 100, … 250 — one page more ends at 300 at most.
    for (const count of [0, 50, 100, 250])
      expect(threadKeepsAnotherPage(holding(count))).toBe(true);
    // Holding 300 — or more ('답글 더 보기' opened further), or short of a page's end (its own
    // deleted, or a new one put at the end) — a page more could end past 300: none.
    for (const count of [251, 299, 300, 301, 350]) {
      expect(threadKeepsAnotherPage(holding(count))).toBe(false);
    }
  });

  it('never open an edit past the 300 a read of the pages keeps, whatever the pages still hold: the read again on the way back not landed — the text stays under its 대댓글 with the owner’s words (오너 결정 2026-10-22 (2차) 답 1, (3차) 답 3)', () => {
    // The thread as '답글 더 보기' left it before the step — all 361 read, or 361 of more — the read
    // again on the way back over without landing (cancelled by a write or another '답글 더 보기',
    // failed, offline), so the drafts are placed against it as it is.
    for (const cursor of [null, 't1-361']) {
      const replies: PostComment[] = minesUnder('t1', 'r', 361);
      // Past the 300 too: one hidden, one another account's — why, as anywhere.
      replies[340] = { state: 'hidden', id: 'r340' };
      replies[350] = { ...comment('r350', 't1'), author: { ...author, publicId: 'other00000' } };
      const threads: CommentThread[] = [
        { comment: mine('t1'), replies, repliesNextCursor: cursor },
      ];
      const edits = [
        ['r329', '330번째 고친 답글'],
        ['r300', '301번째 고친 답글'],
        ['r299', '300번째 고친 답글'],
        ['r340', '숨긴 341번째 고친 답글'],
        ['r350', '남의 351번째 고친 답글'],
      ] as const;
      const resolved = resolveCommentDrafts(
        drafts({
          edits: new Map(edits),
          editThreads: new Map(edits.map(([id]) => [id, 't1'])),
        }),
        view(threads),
      );
      const apart = (commentId: string, text: string, reason: string) => ({
        key: { kind: 'edit', postId: post, commentId, threadId: 't1' },
        text,
        reason,
        place: { kind: 'comment', commentId, threadId: 't1' },
      });
      // Its 300th opens; its 301st and 330th — on screen, past the 300 — are shown apart under
      // themselves with '고치던 답글을 다시 열지 못했습니다. 쓰던 내용을 여기 남겨 둡니다.': no box past
      // them for the next read that lands to take away (and its text with it, apart).
      expect([...resolved.edits]).toEqual([['r299', '300번째 고친 답글']]);
      expect(resolved.unplaced).toEqual([
        apart('r329', '330번째 고친 답글', copy.errCommentEditNotReopened),
        apart('r300', '301번째 고친 답글', copy.errCommentEditNotReopened),
        apart('r340', '숨긴 341번째 고친 답글', copy.errCommentNotEditable),
        apart('r350', '남의 351번째 고친 답글', copy.errCommentNotYours),
      ]);
      expect([resolved.waitingThreads, resolved.waitingEdits]).toEqual([[], []]);
    }
    expect(copy.errCommentEditNotReopened).toBe(
      '고치던 답글을 다시 열지 못했습니다. 쓰던 내용을 여기 남겨 둡니다.',
    );
  });

  it('read on one thread at a time, up to its 300th 대댓글; at it an edit not found is shown apart, with why (오너 결정 2026-10-22 답 5, (2차) 답 1)', () => {
    const drafted = drafts({
      edits: new Map([
        ['r9', '고친 답글'],
        ['s9', '다른 스레드의 고친 답글'],
      ]),
      editThreads: new Map([
        ['r9', 't1'],
        ['s9', 't2'],
      ]),
    });
    const second = threadWithMore('t2-50', mine('t2'), ...minesUnder('t2', 'y', 50));
    const r9Apart = {
      key: { kind: 'edit', postId: post, commentId: 'r9', threadId: 't1' },
      text: '고친 답글',
      reason: copy.errCommentEditNotRead,
      place: { kind: 'comment', commentId: 'r9', threadId: 't1' },
    };
    /** The next step with the first thread holding `count` 대댓글, nothing read for these drafts. */
    const stepAt = (count: number) => {
      const first = threadWithMore('t1-next', mine('t1'), ...minesUnder('t1', 'x', count));
      const threads = [first, second];
      const resolved = resolveCommentDrafts(drafted, view(threads));
      expect(resolved.waitingThreads).toEqual(['t1', 't2']);
      return {
        first,
        step: editDraftsReadOn(threads, resolved, {
          pagesRead: () => 0,
          failed: () => undefined,
        }),
      };
    };
    // Its first 50, or 250 (one page short of 300): the first thread waiting is read; one at a time.
    for (const count of [50, 250]) {
      const { first, step } = stepAt(count);
      expect(step).toEqual({ read: first, past: [] });
    }
    // Holding its 300 already — the comments kept in this tab across the step and read again on the
    // way back as far as the screen had them, a step done in another tab — and r9 not among them:
    // shown apart at once with the owner's words (답 3), nothing read for it; the other thread
    // reads on. So for a thread holding more, or short of a page's end.
    for (const count of [300, 301, 299]) {
      expect(stepAt(count).step).toEqual({ read: second, past: [r9Apart] });
    }
  });

  it('read on five reply pages at most a thread for a set of drafts: pages the thread did not take count too', () => {
    const first = threadWithMore('t1-100', mine('t1'), ...minesUnder('t1', 'x', 100));
    const threads = [first];
    const resolved = resolveCommentDrafts(
      drafts({ edits: new Map([['r9', '고친 답글']]), editThreads: new Map([['r9', 't1']]) }),
      view(threads),
    );
    const step = (pagesRead: number) =>
      editDraftsReadOn(threads, resolved, { pagesRead: () => pagesRead, failed: () => undefined });
    // Four read and the thread at 100 (pages read again from under it): one more.
    expect(step(REPLY_READ_ON_PAGES - 1)).toEqual({ read: first, past: [] });
    // Five read: no sixth, though the thread is short of 300 — shown apart, with why.
    expect(step(REPLY_READ_ON_PAGES)).toEqual({
      read: undefined,
      past: [
        {
          key: { kind: 'edit', postId: post, commentId: 'r9', threadId: 't1' },
          text: '고친 답글',
          reason: copy.errCommentEditNotRead,
          place: { kind: 'comment', commentId: 'r9', threadId: 't1' },
        },
      ],
    });
  });

  it('show an edit apart with the read’s failure when its thread still stands where that read failed, and read not from there again (오너 결정 2026-10-21 (2차) 답 2)', () => {
    const first = threadWithMore('t1-50', mine('t1'), mine('r1', 't1'));
    const second = threadWithMore('t2-50', mine('t2'), mine('s1', 't2'));
    const threads = [first, second];
    const resolved = resolveCommentDrafts(
      drafts({
        edits: new Map([
          ['r9', '고친 답글'],
          ['s9', '다른 스레드의 고친 답글'],
        ]),
        editThreads: new Map([
          ['r9', 't1'],
          ['s9', 't2'],
        ]),
      }),
      view(threads),
    );
    // Where the read failed, by the thread and the cursor it read from (`editDraftReadOnMark`).
    expect(editDraftReadOnMark(first)).toBe('t1:t1-50');
    const read = (failures: Record<string, string>, t1Pages = 0) =>
      editDraftsReadOn(threads, resolved, {
        pagesRead: (threadId) => (threadId === 't1' ? t1Pages : 0),
        failed: (mark) => failures[mark],
      });
    // The failure the caller could not show as it came (no draft listed then — the comment pages
    // being read again): the draft is shown apart with it now, and the other thread reads on.
    const r9Failed = {
      key: { kind: 'edit', postId: post, commentId: 'r9', threadId: 't1' },
      text: '고친 답글',
      reason: copy.errNetwork,
      place: { kind: 'comment', commentId: 'r9', threadId: 't1' },
    };
    expect(read({ 't1:t1-50': copy.errNetwork })).toEqual({ read: second, past: [r9Failed] });
    // The failure, not the cap, says why — the fifth read failed, so the 대댓글 may be on its page.
    expect(read({ 't1:t1-50': copy.errNetwork }, REPLY_READ_ON_PAGES)).toEqual({
      read: second,
      past: [r9Failed],
    });
    // A failure from another cursor — the thread moved on since ('답글 더 보기' pressed): it reads
    // on from where it stands.
    expect(read({ 't1:t1-0': copy.errNetwork }, 1)).toEqual({ read: first, past: [] });
    // Nothing waits there any more: nothing shown.
    const none = { waitingThreads: [], waitingEdits: [] };
    expect(
      editDraftsReadOn(threads, none, {
        pagesRead: () => 0,
        failed: () => copy.errNetwork,
      }),
    ).toEqual({ read: undefined, past: [] });
  });

  it('show nothing apart at five reply pages for a thread read to its end or a draft its box took', () => {
    const edits = new Map([['r9', '고친 답글']]);
    const editThreads = new Map([['r9', 't1']]);
    const capped = { pagesRead: () => REPLY_READ_ON_PAGES, failed: () => undefined };
    // Read to its end and the 대댓글 not among those read: gone, in the words it was before.
    const ended = [thread(mine('t1'), mine('r1', 't1'))];
    const gone = resolveCommentDrafts(drafts({ edits, editThreads }), view(ended));
    expect(editDraftsReadOn(ended, gone, capped)).toEqual({ read: undefined, past: [] });
    expect(gone.unplaced.map(({ reason }) => reason)).toEqual([copy.errCommentGone]);
    // Found on the fifth page, 대댓글 after it still unread: its box opens with it.
    const reached = [threadWithMore('t1-300', mine('t1'), mine('r1', 't1'), mine('r9', 't1'))];
    const found = resolveCommentDrafts(drafts({ edits, editThreads }), view(reached));
    expect([...found.edits]).toEqual([['r9', '고친 답글']]);
    expect(editDraftsReadOn(reached, found, capped)).toEqual({ read: undefined, past: [] });
    // Not waiting any more (its box took it, or it is shown apart already): nothing.
    const threads = [threadWithMore('t1-300', mine('t1'), mine('r1', 't1'))];
    expect(editDraftsReadOn(threads, { waitingThreads: [], waitingEdits: [] }, capped)).toEqual({
      read: undefined,
      past: [],
    });
  });
});

describe('where the 대댓글 on screen stand', () => {
  it('is each 대댓글 of every thread by id, within the 300 a read of the pages keeps up to its 300th as held', () => {
    const replies = Array.from({ length: 302 }, (_, index) => comment(`r${String(index)}`, 't1'));
    const onScreen = repliesOnScreenOf([
      { comment: comment('t1'), replies, repliesNextCursor: 'more' },
      thread(comment('t2'), comment('s0', 't2'), { state: 'hidden', id: 's1' }),
    ]);
    expect(onScreen.size).toBe(304);
    expect([0, 299, 300, 301].map((index) => onScreen.get(`r${String(index)}`))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect([onScreen.get('s0'), onScreen.get('s1')]).toEqual([true, true]);
    // A 댓글 is no 대댓글; nothing else is on screen.
    expect([onScreen.has('t1'), onScreen.has('elsewhere')]).toEqual([false, false]);
    expect(repliesOnScreenOf([]).size).toBe(0);
  });

  it('finds a thread among the pages', () => {
    const held = pagesOf([[threadWithMore('t1-2', comment('t1'), comment('r1', 't1'))]]);
    expect(threadOf(held, 't1')?.replies.map(({ id }) => id)).toEqual(['r1']);
    expect(threadOf(held, 'nowhere')).toBeUndefined();
    expect(threadOf(undefined, 't1')).toBeUndefined();
  });
});

describe('an edit’s text held apart once a read brings its 대댓글 onto the screen (오너 결정 2026-10-22 (2차) 답 2, (3차) 답 1·3)', () => {
  const viewerPublicId = author.kind === 'member' ? author.publicId : '';
  const theirs = (id: string): PublishedComment => ({
    ...comment(id, 't1'),
    author: { ...author, publicId: 'other00000' },
  });
  const heldEdit = (id: string, commentId: string, reason: string = copy.errCommentEditNotRead) =>
    ({
      id,
      place: { kind: 'comment', commentId, threadId: 't1' },
      reason,
      text: `${id}의 글자`,
      focus: false,
      shown: true,
    }) satisfies HeldText;
  /**
   * The thread t1 as a read left it: 303 대댓글, `r<index>` at each index, the viewer's but for those
   * named — so `r299` is the last within the 300 a read of the pages keeps and `r300` the first past.
   */
  const replies: PostComment[] = Array.from({ length: 303 }, (_, index) =>
    comment(`r${String(index)}`, 't1'),
  );
  replies[70] = { state: 'hidden', id: 'r70' };
  replies[71] = theirs('r71');
  replies[72] = theirs('r72');
  replies[302] = { state: 'hidden', id: 'r302' };
  const now: CommentThread[] = [
    { comment: comment('t1'), replies, repliesNextCursor: 'more' },
    thread(comment('t2')),
  ];
  /** Before the read: the first 50 within, `r298` past them (more of the thread held then), r301 too. */
  const before: RepliesOnScreen = new Map([
    ...replies.slice(0, 50).map(({ id }) => [id, true] as const),
    ['r298', false],
    ['r301', false],
  ]);

  it('opens the edit of a 대댓글 a read brought within the 300 — not on screen before, or past them then — published and the viewer’s own, whatever kept it apart', () => {
    const held = [
      heldEdit('a', 'r60'),
      heldEdit('b', 'r299', copy.errNetwork),
      heldEdit('c', 'r298', copy.errCommentEditNotReopened),
      heldEdit('d', 'r65', copy.errUnknown),
    ] satisfies HeldText[];
    expect(heldEditsBrought(held, now, before, viewerPublicId)).toEqual({
      open: [
        { id: 'a', commentId: 'r60', text: 'a의 글자' },
        { id: 'b', commentId: 'r299', text: 'b의 글자' },
        { id: 'c', commentId: 'r298', text: 'c의 글자' },
        { id: 'd', commentId: 'r65', text: 'd의 글자' },
      ],
      reasons: [],
    });
  });

  it('opens none past the 300: the viewer’s own says it cannot be opened, with the owner’s words — once; a hidden one or another account’s says why', () => {
    const held = [
      heldEdit('past', 'r300'),
      heldEdit('said', 'r300', copy.errCommentEditNotReopened),
      heldEdit('hidden-past', 'r302'),
      // On screen past the 300 before and still: nothing new.
      heldEdit('still-past', 'r301'),
    ] satisfies HeldText[];
    expect(heldEditsBrought(held, now, before, viewerPublicId)).toEqual({
      open: [],
      reasons: [
        { id: 'past', reason: copy.errCommentEditNotReopened },
        { id: 'hidden-past', reason: copy.errCommentNotEditable },
      ],
    });
  });

  it('keeps apart one brought that takes no edit — hidden, another account’s — with why in the server’s words, where they say something new', () => {
    const held = [
      heldEdit('hidden', 'r70'),
      heldEdit('theirs', 'r71', copy.errNetwork),
      heldEdit('theirs-said', 'r72', copy.errCommentNotYours),
    ] satisfies HeldText[];
    expect(heldEditsBrought(held, now, before, viewerPublicId)).toEqual({
      open: [],
      reasons: [
        { id: 'hidden', reason: copy.errCommentNotEditable },
        { id: 'theirs', reason: copy.errCommentNotYours },
      ],
    });
  });

  it('leaves alone a 대댓글 within the 300 before and now, one not on screen, an edit of a 댓글 and a text that is no edit', () => {
    const held = [
      heldEdit('was-there', 'r10'),
      heldEdit('elsewhere', 'gone'),
      { ...heldEdit('top', 't1'), place: { kind: 'comment', commentId: 't1', threadId: 't1' } },
      { ...heldEdit('reply', 'r60'), place: { kind: 'thread', threadId: 't1' } },
      { ...heldEdit('new', 'r60'), place: { kind: 'post' } },
    ] satisfies HeldText[];
    expect(heldEditsBrought(held, now, before, viewerPublicId)).toEqual({ open: [], reasons: [] });
    // Nothing brought — the threads where they were — nothing either; nor for one on screen within
    // the 300 before and past them now (no read moves a 대댓글 back, but it was on screen).
    expect(
      heldEditsBrought([heldEdit('a', 'r60')], now, repliesOnScreenOf(now), viewerPublicId),
    ).toEqual({ open: [], reasons: [] });
    expect(
      heldEditsBrought([heldEdit('b', 'r300')], now, new Map([['r300', true]]), viewerPublicId),
    ).toEqual({ open: [], reasons: [] });
  });

  it('opens nothing with no account on screen; another account than the 대댓글’s author: why', () => {
    const held = [heldEdit('a', 'r60')];
    expect(heldEditsBrought(held, now, before, undefined)).toEqual({ open: [], reasons: [] });
    expect(heldEditsBrought(held, now, before, 'other00000')).toEqual({
      open: [],
      reasons: [{ id: 'a', reason: copy.errCommentNotYours }],
    });
  });
});

describe('an edit’s text held apart whose thread is read to its end without its 대댓글 (오너 결정 2026-10-22 (2차) 답 2: 맞는 까닭)', () => {
  const heldEdit = (
    id: string,
    commentId: string,
    reason: string = copy.errCommentEditNotRead,
    threadId = 't1',
  ) =>
    ({
      id,
      place: { kind: 'comment', commentId, threadId },
      reason,
      text: `${id}의 글자`,
      focus: false,
      shown: true,
    }) satisfies HeldText;

  it('says it is gone — a deleted 대댓글 is in no page — whatever it said while 대댓글 were unread', () => {
    const ended = [thread(comment('t1'), comment('r1', 't1'))];
    expect(
      heldEditsReadToTheirEnd(ended, [
        heldEdit('not-read', 'r9'),
        heldEdit('failed', 'r8', copy.errNetwork),
        heldEdit('refused', 'r7', copy.errUnknown),
      ]),
    ).toEqual([
      { id: 'not-read', reason: copy.errCommentGone },
      { id: 'failed', reason: copy.errCommentGone },
      { id: 'refused', reason: copy.errCommentGone },
    ]);
  });

  it('says nothing new while 대댓글 are unread, for a 대댓글 on screen, an edit of the 댓글, a reply box, a thread not on screen, or a text that says it already', () => {
    const more = [threadWithMore('t1-50', comment('t1'), comment('r1', 't1'))];
    expect(heldEditsReadToTheirEnd(more, [heldEdit('a', 'r9')])).toEqual([]);
    const ended = [thread(comment('t1'), comment('r1', 't1'), { state: 'hidden', id: 'r2' })];
    expect(
      heldEditsReadToTheirEnd(ended, [
        heldEdit('on-screen', 'r1'),
        heldEdit('placeholder', 'r2', copy.errCommentNotEditable),
        heldEdit('top', 't1', copy.errCommentGone),
        heldEdit('elsewhere', 's9', copy.errCommentEditNotRead, 't2'),
        heldEdit('said', 'r9', copy.errCommentGone),
        {
          id: 'reply',
          place: { kind: 'thread', threadId: 't1' },
          reason: copy.errCommentParentGone,
          text: '답글',
          focus: false,
          shown: true,
        },
      ]),
    ).toEqual([]);
  });
});
