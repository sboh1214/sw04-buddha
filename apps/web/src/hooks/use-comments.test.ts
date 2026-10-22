import {
  InfiniteQueryObserver,
  MutationObserver,
  type QueryClient,
  QueryObserver,
} from '@tanstack/react-query';
import { COMMENT_REPLIES_PAGE_SIZE } from '@buddha/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type CommentThread, type Post, type PublishedComment, api } from '@/lib/api';
import {
  NO_COMMENT_DRAFTS,
  type CommentDrafts,
  commentDraftLandedSince,
  commentDraftMoment,
  withoutCommentDrafts,
} from '@/lib/comment-drafts';
import {
  REPLIES_KEPT_ON_READ,
  REPLY_READ_ON_PAGES,
  type CommentPage,
  type CommentPages,
  type HeldEditsBrought,
  type HeldText,
  type ReplyPage,
  type UnplacedCommentDraft,
  commentThreadsOf,
  draftsHeldOnReadFailure,
  editDraftReadOnMark,
  editDraftsReadOn,
  heldEditsBrought,
  postCommentsKey,
  repliesOnScreenOf,
  resolveCommentDrafts,
} from '@/lib/comments';
import { communityPostsKey, postKey, postReadErrorMessage } from '@/lib/posts';
import { getQueryClient } from '@/lib/query-client';
import {
  commentsInfiniteQueryOptions,
  createCommentOptions,
  deleteCommentOptions,
  readMoreComments,
  readMoreReplies,
  updateCommentOptions,
} from './use-comments';
import { ME_QUERY_KEY } from './use-me';

/**
 * The comment hooks' wiring (#48, ADR-0074), through a real QueryClient with the API client's
 * methods stubbed: the request each read and write sends, and what each answer does to the pages
 * held, the post (its count) and the community list — and that a read of the pages already on its
 * way when an answer lands cannot undo it.
 */

const POST = 'B7C9A1D2-6F34-4E58-9B0A-2D1E5F8C7A46';
const post = POST.toLowerCase();
const COMMENT = '6F9619FF-8B86-D011-B42D-00C04FC964FF';
const commentId = COMMENT.toLowerCase();
/** Another post, whose pages no write of the post above touches. */
const OTHER_POST = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
/** A 댓글 older than the one written below, on a page the reader had not opened. */
const OLDER = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d';
/** A 댓글 the reader writes. */
const MINE = 'f0e1d2c3-b4a5-4968-8776-655443322110';
/** 대댓글 others wrote after MINE, while its thread was being read. */
const LATER = [
  'f1e1d2c3-b4a5-4968-8776-655443322111',
  'f2e1d2c3-b4a5-4968-8776-655443322112',
  'f3e1d2c3-b4a5-4968-8776-655443322113',
];

const published = (
  id: string,
  parentId: string | null = null,
  body = '댓글',
): PublishedComment => ({
  state: 'published',
  id,
  parentId,
  body,
  author: {
    kind: 'member',
    publicId: 'k7m2p9qx4z',
    nickname: '근거왕',
    imageUrl: null,
    isAdmin: false,
  },
  createdAt: '2026-10-19T00:00:00.000Z',
  editedAt: null,
});

const thread = (comment: PublishedComment): CommentThread => ({
  comment,
  replies: [],
  repliesNextCursor: null,
});

/** The first page read: one 댓글, and `nextCursor` when 더 보기 has more. */
const held = (nextCursor: string | null = null): CommentPages => ({
  pages: [{ items: [thread(published(commentId))], nextCursor }],
  pageParams: [undefined],
});

/** openapi-fetch's `{ data, response }`, the shape `unwrap` reads. */
const answer = (data: unknown, meta?: unknown) =>
  ({
    data: meta === undefined ? { data } : { data, meta },
    response: new Response(null, { status: 200 }),
  }) as never;

/** A client holding the post's comments, the post ('댓글 1') and a community list page. */
function seeded(nextCursor: string | null = null) {
  const queryClient = getQueryClient();
  queryClient.setQueryData(postCommentsKey(post), held(nextCursor));
  queryClient.setQueryData(postKey(post), { state: 'published', id: post, commentCount: 1 });
  queryClient.setQueryData(communityPostsKey({}), { pages: [], pageParams: [] });
  return queryClient;
}

const commentCountOf = (queryClient: QueryClient) =>
  queryClient.getQueryData<Post>(postKey(post))?.commentCount;

/** The 댓글 ids the pages of `postId` hold, in the order the thread draws them. */
const threadIds = (queryClient: QueryClient, postId = post) =>
  commentThreadsOf(queryClient.getQueryData(postCommentsKey(postId))).map(
    ({ comment }) => comment.id,
  );

/** What a `GET /posts/:postId/comments` was asked: the post and the query (its cursor). */
type CommentsRequest = { params: { path: { postId: string }; query: { cursor?: string } } };

/** `api.GET` answering each comments request with `pageOf(request)`; the queries it was asked. */
function getComments(pageOf: (request: CommentsRequest) => CommentPage | Promise<CommentPage>) {
  const asked: CommentsRequest['params']['query'][] = [];
  vi.spyOn(api, 'GET').mockImplementation(async (_path: string, request: CommentsRequest) => {
    asked.push(request.params.query);
    const page = await pageOf(request);
    return answer(page.items, { nextCursor: page.nextCursor });
  });
  return asked;
}

/** What a `GET /comments/:commentId/replies` was asked: the 댓글 and its cursor. */
type RepliesRequest = { params: { path: { commentId: string }; query: { cursor: string } } };

/**
 * `api.GET` answering the comment pages with `pageOf` and the reply pages with `repliesOf`; the
 * requests each was asked, as `comments:<cursor>` and `replies:<commentId>:<cursor>` — and, into
 * `signals` when given, the signal each request was sent with.
 */
function getThreads(
  pageOf: (request: CommentsRequest) => CommentPage,
  repliesOf: (request: RepliesRequest) => ReplyPage | Promise<ReplyPage>,
  signals?: (AbortSignal | undefined)[],
) {
  const asked: string[] = [];
  vi.spyOn(api, 'GET').mockImplementation(async (path: string, request: never) => {
    signals?.push((request as { signal?: AbortSignal }).signal);
    if (path === '/api/v1/comments/{commentId}/replies') {
      const { params } = request as RepliesRequest;
      asked.push(`replies:${params.path.commentId}:${params.query.cursor}`);
      const page = await repliesOf(request);
      return answer(page.items, { nextCursor: page.nextCursor });
    }
    const { params } = request as CommentsRequest;
    asked.push(`comments:${params.query.cursor ?? ''}`);
    const page = pageOf(request);
    return answer(page.items, { nextCursor: page.nextCursor });
  });
  return asked;
}

/** The thread of `commentId` as the pages hold it. */
const threadHeld = (queryClient: QueryClient) =>
  commentThreadsOf(queryClient.getQueryData(postCommentsKey(post)))[0];

/** The 대댓글 ids the thread of `commentId` holds, and its cursor. */
const repliesHeld = (queryClient: QueryClient) => {
  const first = threadHeld(queryClient);
  return [first?.replies.map((reply) => reply.id), first?.repliesNextCursor];
};

/** 대댓글 ids r<from>…r<to-1>, as UUIDs a test reads back. */
const replyIds = (from: number, to: number) =>
  Array.from(
    { length: to - from },
    (_, index) => `00000000-0000-4000-8000-${String(from + index).padStart(12, '0')}`,
  );

/**
 * A fake reply route over `total` 대댓글 of the 댓글 above, two a page — the cursor `r<n>` reading
 * from the n-th — and `last`, when given, after them (a 대댓글 just written), and `after` after it
 * (others' answers written meanwhile).
 */
const fakeReplies =
  (total: number, last?: string, after: readonly string[] = []) =>
  ({ params }: RepliesRequest): ReplyPage => {
    const all = [...replyIds(0, total), ...(last === undefined ? [] : [last]), ...after];
    const from = Number(params.query.cursor.slice(1));
    const to = Math.min(from + 2, all.length);
    return replyPage(all.slice(from, to), to < all.length ? `r${String(to)}` : null);
  };

/** The client holding one 댓글 with `first` 대댓글 and the cursor `cursor` of the rest. */
function seededThread(first: string[], cursor: string | null) {
  const queryClient = seeded();
  queryClient.setQueryData<CommentPages>(postCommentsKey(post), {
    pages: [
      {
        items: [
          {
            comment: published(commentId),
            replies: first.map((id) => published(id, commentId)),
            repliesNextCursor: cursor,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  });
  return queryClient;
}

/** A page of `GET /comments/:commentId/replies` under the 댓글 above. */
const replyPage = (ids: string[], nextCursor: string | null): ReplyPage => ({
  items: ids.map((id) => published(id, commentId)),
  nextCursor,
});

/** The 댓글 above as a page answers it: its first 대댓글 `first`, and the cursor of the rest. */
const threadAnswered = (first: string[], cursor: string | null): CommentThread => ({
  comment: published(commentId),
  replies: first.map((id) => published(id, commentId)),
  repliesNextCursor: cursor,
});

/** The refusal of a cursor sealed under a key changed since (ADR-0074 7-29). */
const cursorRefused = () =>
  Promise.reject(
    new ApiError(400, {
      code: 'VALIDATION_ERROR',
      message: 'Not a cursor of this list',
      details: [{ path: ['cursor'], message: 'Not a cursor of this list' }],
    } as never),
  );

/** A read the test lets answer when it says: a 더 보기 still on its way. */
function onItsWay() {
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  return { arrived, arrive };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a post’s comments', () => {
  it('are keyed and asked for by the lower-cased post id, a page per cursor', async () => {
    const thread = { comment: published(commentId), replies: [], repliesNextCursor: null };
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer([thread], { nextCursor: 'c2' }));
    const options = commentsInfiniteQueryOptions(POST);
    expect(options.queryKey).toEqual(postCommentsKey(post));
    expect(options.initialPageParam).toBeUndefined();
    await expect(options.queryFn({ pageParam: undefined })).resolves.toEqual({
      items: [thread],
      nextCursor: 'c2',
    });
    await options.queryFn({ pageParam: 'c2' });
    expect(get.mock.calls).toEqual([
      ['/api/v1/posts/{postId}/comments', { params: { path: { postId: post }, query: {} } }],
      [
        '/api/v1/posts/{postId}/comments',
        { params: { path: { postId: post }, query: { cursor: 'c2' } } },
      ],
    ]);
    expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: 'c3' })).toBe('c3');
  });

  it('read again from the first when 더 보기’s cursor no longer opens (ADR-0074 7-29), and the next page then', async () => {
    // The page held its cursor from before the server's key changed: refused on every press, the
    // pages read again carry fresh ones, and 더 보기 reads on from there — once.
    const queryClient = seeded('c2');
    const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
    const unsubscribe = comments.subscribe(() => undefined);
    const asked = getComments(({ params }) => {
      switch (params.query.cursor) {
        case undefined:
          return { items: [thread(published(commentId))], nextCursor: 'fresh2' };
        case 'fresh2':
          return { items: [thread(published(OLDER))], nextCursor: null };
        default:
          return cursorRefused();
      }
    });
    await readMoreComments(comments);
    expect(asked).toEqual([{ cursor: 'c2' }, {}, { cursor: 'fresh2' }]);
    expect(threadIds(queryClient)).toEqual([commentId, OLDER]);
    expect(comments.getCurrentResult().hasNextPage).toBe(false);
    // Any other failure is the query's to show: nothing read again.
    const failing = seeded('c2');
    const other = new InfiniteQueryObserver(failing, commentsInfiniteQueryOptions(POST));
    const stop = other.subscribe(() => undefined);
    const tried = getComments(() =>
      Promise.reject(new ApiError(404, { code: 'NOT_FOUND', message: 'x' } as never)),
    );
    await readMoreComments(other);
    expect(tried).toEqual([{ cursor: 'c2' }]);
    expect(other.getCurrentResult().isFetchNextPageError).toBe(true);
    stop();
    unsubscribe();
  });
});

describe('the writes', () => {
  it('a new 대댓글 goes under its 댓글; the post and the lists are marked stale', async () => {
    const queryClient = seeded();
    const reply = published('d3b07384-d9a0-4c9b-8e2f-2d1c0f8a4b11', commentId, '답글');
    const send = vi.spyOn(api, 'POST').mockResolvedValue(answer(reply));
    const write = new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, () => undefined),
    );
    const body = { parentId: commentId, body: '답글', expectedAccountId: 'user-1' };
    await write.mutate(body);
    expect(send).toHaveBeenCalledWith('/api/v1/posts/{postId}/comments', {
      params: { path: { postId: post } },
      body,
    });
    const [first] = commentThreadsOf(queryClient.getQueryData(postCommentsKey(post)));
    expect(first?.replies).toEqual([reply]);
    // The count moves at once, and the post is read again to confirm it.
    expect(commentCountOf(queryClient)).toBe(2);
    expect(queryClient.getQueryState(postKey(post))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(communityPostsKey({}))?.isInvalidated).toBe(true);
    // The pages themselves are not read again: the answer is in them.
    expect(queryClient.getQueryState(postCommentsKey(post))?.isInvalidated).toBe(false);
  });

  it('an edit replaces the comment held, and a refusal that says the thread is stale reads it again', async () => {
    const queryClient = seeded();
    const edited = { ...published(commentId, null, '고친 댓글'), editedAt: '2026-10-19T01:00:00Z' };
    const put = vi.spyOn(api, 'PUT').mockResolvedValueOnce(answer(edited));
    const edit = new MutationObserver(
      queryClient,
      updateCommentOptions(queryClient, POST, () => undefined),
    );
    await edit.mutate({ commentId: COMMENT, body: '고친 댓글', expectedAccountId: 'user-1' });
    expect(put).toHaveBeenCalledWith('/api/v1/comments/{commentId}', {
      params: { path: { commentId } },
      body: { body: '고친 댓글', expectedAccountId: 'user-1' },
    });
    expect(commentThreadsOf(queryClient.getQueryData(postCommentsKey(post)))[0]?.comment).toEqual(
      edited,
    );
    // An edit changes no count.
    expect(commentCountOf(queryClient)).toBe(1);
    expect(queryClient.getQueryState(postKey(post))?.isInvalidated).toBe(false);

    put.mockRejectedValueOnce(
      new ApiError(409, {
        code: 'COMMENT_NOT_EDITABLE',
        message: 'x',
        details: { reason: 'hidden' },
      } as never),
    );
    await expect(
      edit.mutate({ commentId: COMMENT, body: '또', expectedAccountId: 'user-1' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryState(postCommentsKey(post))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(postKey(post))?.isInvalidated).toBe(true);
  });

  it('a write that lands records it for its box, so a draft kept for a step goes (오너 결정 2026-10-20 답 2); a refusal does not', async () => {
    const queryClient = seeded();
    const before = commentDraftMoment();
    const replyBox = { kind: 'reply', postId: post, parentId: commentId } as const;
    const newBox = { kind: 'comment', postId: post } as const;
    const editBox = { kind: 'edit', postId: post, commentId } as const;
    const send = vi.spyOn(api, 'POST');
    const write = new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, () => undefined),
    );
    send.mockRejectedValueOnce(
      new ApiError(409, {
        code: 'COMMENT_NOT_ALLOWED',
        message: 'x',
        details: { reason: 'parent_deleted' },
      } as never),
    );
    await expect(
      write.mutate({ parentId: COMMENT, body: '답글', expectedAccountId: 'user-1' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(commentDraftLandedSince(replyBox, before)).toBe(false);

    send.mockResolvedValueOnce(
      answer(published('d3b07384-d9a0-4c9b-8e2f-2d1c0f8a4b11', commentId)),
    );
    await write.mutate({ parentId: COMMENT, body: '답글', expectedAccountId: 'user-1' });
    expect(commentDraftLandedSince(replyBox, before)).toBe(true);
    expect(commentDraftLandedSince(newBox, before)).toBe(false);

    vi.spyOn(api, 'PUT').mockResolvedValueOnce(answer(published(commentId, null, '고친 댓글')));
    const edit = new MutationObserver(
      queryClient,
      updateCommentOptions(queryClient, POST, () => undefined),
    );
    await edit.mutate({ commentId: COMMENT, body: '고친 댓글', expectedAccountId: 'user-1' });
    expect(commentDraftLandedSince(editBox, before)).toBe(true);
  });

  it('a deletion applies its answer to the pages held, and the count is read again', async () => {
    const queryClient = seeded();
    const send = vi
      .spyOn(api, 'POST')
      .mockResolvedValue(answer({ id: commentId, placeholder: false }));
    const remove = new MutationObserver(
      queryClient,
      deleteCommentOptions(queryClient, POST, () => undefined),
    );
    await remove.mutate({ commentId: COMMENT, expectedAccountId: 'user-1' });
    expect(send).toHaveBeenCalledWith('/api/v1/comments/{commentId}/delete', {
      params: { path: { commentId } },
      body: { expectedAccountId: 'user-1' },
    });
    expect(commentThreadsOf(queryClient.getQueryData(postCommentsKey(post)))).toEqual([]);
    expect(commentCountOf(queryClient)).toBe(0);
    expect(queryClient.getQueryState(postKey(post))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(communityPostsKey({}))?.isInvalidated).toBe(true);
  });

  it('a refusal as another account asks for the session; one for the onboarding reads /me again', async () => {
    const queryClient = seeded();
    const me = new QueryObserver(queryClient, {
      queryKey: ME_QUERY_KEY,
      queryFn: () => Promise.resolve({}),
      enabled: false,
    });
    queryClient.setQueryData(ME_QUERY_KEY, {});
    const unsubscribe = me.subscribe(() => undefined);
    const sessionChanged = vi.fn();
    const send = vi.spyOn(api, 'POST');
    const write = new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, sessionChanged),
    );
    const body = { parentId: null, body: '댓글', expectedAccountId: 'user-1' };

    send.mockRejectedValueOnce(
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'x',
        details: [{ path: ['expectedAccountId'], message: 'other account' }],
      }),
    );
    await expect(write.mutate(body)).rejects.toBeInstanceOf(ApiError);
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    // Not a stale thread: the pages held stay as they are.
    expect(queryClient.getQueryState(postCommentsKey(post))?.isInvalidated).toBe(false);

    send.mockRejectedValueOnce(
      new ApiError(403, { code: 'ONBOARDING_REQUIRED', message: 'x' } as never),
    );
    await expect(write.mutate(body)).rejects.toBeInstanceOf(ApiError);
    expect(queryClient.getQueryState(ME_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe('the 대댓글 after the first 50 (오너 결정 2026-10-21: 답글 더 보기)', () => {
  it('are read 50 at a time from the thread’s cursor, after the ones held', async () => {
    const queryClient = seededThread(replyIds(0, 2), 'r2');
    const asked = getThreads(
      () => ({ items: [], nextCursor: null }),
      ({ params }) =>
        params.query.cursor === 'r2'
          ? replyPage(replyIds(2, 4), 'r4')
          : replyPage(replyIds(4, 5), null),
    );
    await readMoreReplies(queryClient, POST, commentId);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 4), 'r4']);
    await readMoreReplies(queryClient, POST, commentId);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 5), null]);
    // Nothing more to read: nothing asked.
    await readMoreReplies(queryClient, POST, commentId);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 5), null]);
    expect(asked).toEqual([`replies:${commentId}:r2`, `replies:${commentId}:r4`]);
  });

  it('stay when the pages are read again (a focus, 30 seconds): the thread is read on as far', async () => {
    const queryClient = seededThread(replyIds(0, 2), 'r2');
    const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
    const unsubscribe = comments.subscribe(() => undefined);
    const asked = getThreads(
      () => ({
        items: [
          {
            comment: published(commentId),
            replies: replyIds(0, 2).map((id) => published(id, commentId)),
            repliesNextCursor: 'r2',
          },
        ],
        nextCursor: null,
      }),
      ({ params }) =>
        params.query.cursor === 'r2'
          ? replyPage(replyIds(2, 4), 'r4')
          : replyPage(replyIds(4, 6), null),
    );
    await readMoreReplies(queryClient, POST, commentId);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 4), 'r4']);
    asked.length = 0;
    await comments.refetch();
    // The page, then its thread's next reply page — as many 대댓글 as were held, no more.
    expect(asked).toEqual(['comments:', `replies:${commentId}:r2`]);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 4), 'r4']);
    unsubscribe();
  });

  it('keep the screen as it was when the read again of a reply page fails', async () => {
    const queryClient = seededThread(replyIds(0, 4), 'r4');
    const comments = new InfiniteQueryObserver(queryClient, {
      ...commentsInfiniteQueryOptions(POST),
      retry: false,
    });
    const unsubscribe = comments.subscribe(() => undefined);
    getThreads(
      () => ({
        items: [
          {
            comment: published(commentId),
            replies: replyIds(0, 2).map((id) => published(id, commentId)),
            repliesNextCursor: 'r2',
          },
        ],
        nextCursor: null,
      }),
      () => Promise.reject(new TypeError('Failed to fetch')),
    );
    await comments.refetch();
    expect(comments.getCurrentResult().isRefetchError).toBe(true);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 4), 'r4']);
    unsubscribe();
  });

  it('stop where they are when the read is cancelled: the query’s signal reaches each request, and no reply page is asked for after', async () => {
    const queryClient = seededThread(replyIds(0, 6), 'r6');
    const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
    const unsubscribe = comments.subscribe(() => undefined);
    const signals: (AbortSignal | undefined)[] = [];
    const read = onItsWay();
    const asked = getThreads(
      () => ({ items: [threadAnswered(replyIds(0, 2), 'r2')], nextCursor: null }),
      async ({ params }) => {
        if (params.query.cursor !== 'r2') return replyPage(replyIds(4, 6), 'r6');
        await read.arrived;
        return replyPage(replyIds(2, 4), 'r4');
      },
      signals,
    );
    const refetch = comments.refetch();
    await vi.waitFor(() => expect(asked).toEqual(['comments:', `replies:${commentId}:r2`]));
    // A write's answer cancels it (`writePages`); so does the page going (its last observer).
    await queryClient.cancelQueries({ queryKey: postCommentsKey(post), exact: true });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
    // The reply page on its way lands after; the read on stops there — each request would count in
    // the reader's address limit (ADR-0074 7-28).
    read.arrive();
    await refetch;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toEqual(['comments:', `replies:${commentId}:r2`]);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 6), 'r6']);
    unsubscribe();
  });

  it('read the post and its comments again when the 댓글 left every view (NOT_FOUND), rather than fail; any other failure throws', async () => {
    const queryClient = seededThread(replyIds(0, 2), 'r2');
    getThreads(
      () => ({ items: [], nextCursor: null }),
      () => Promise.reject(new TypeError('Failed to fetch')),
    );
    // The button says so and is pressed again; nothing is read again.
    await expect(readMoreReplies(queryClient, POST, commentId)).rejects.toBeInstanceOf(TypeError);
    expect(queryClient.getQueryState(postCommentsKey(post))?.isInvalidated).toBe(false);
    getThreads(
      () => ({ items: [], nextCursor: null }),
      () => Promise.reject(new ApiError(404, { code: 'NOT_FOUND', message: 'x' } as never)),
    );
    // The thread on screen is old: a button that can only be answered the same is no use — the
    // pages and the post are read again, and the thread goes with them.
    await expect(readMoreReplies(queryClient, POST, commentId)).resolves.toBeUndefined();
    expect(queryClient.getQueryState(postCommentsKey(post))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(postKey(post))?.isInvalidated).toBe(true);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 2), 'r2']);
  });

  it('a new 대댓글 reads its thread’s unread 대댓글 to the end first and stands last of them', async () => {
    const queryClient = seededThread(replyIds(0, 2), 'r2');
    vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, commentId, '답글')));
    const asked = getThreads(
      () => ({ items: [], nextCursor: null }),
      ({ params }) =>
        params.query.cursor === 'r2'
          ? replyPage(replyIds(2, 4), 'r4')
          : replyPage([...replyIds(4, 5), MINE], null),
    );
    await new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, () => undefined),
    ).mutate({ parentId: commentId, body: '답글', expectedAccountId: 'user-1' });
    expect(asked).toEqual([`replies:${commentId}:r2`, `replies:${commentId}:r4`]);
    expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 5), MINE], null]);
    expect(commentCountOf(queryClient)).toBe(2);
  });

  it('are read on five reply pages at most when the pages are read again: a thread opened further comes back to that (오너 결정 2026-10-21 (2차) 답 1)', async () => {
    // A fake server of 40 대댓글 two a page (the page's size is the server's; the cap counts
    // requests). The screen had opened 14 — the first two and six pages more.
    const queryClient = seededThread(replyIds(0, 14), 'r14');
    const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
    const unsubscribe = comments.subscribe(() => undefined);
    const asked = getThreads(
      () => ({ items: [threadAnswered(replyIds(0, 2), 'r2')], nextCursor: null }),
      fakeReplies(40),
    );
    await comments.refetch();
    const replyRequests = asked.filter((one) => one.startsWith('replies:'));
    expect(replyRequests).toHaveLength(REPLY_READ_ON_PAGES);
    expect(replyRequests).toEqual(
      [2, 4, 6, 8, 10].map((from) => `replies:${commentId}:r${String(from)}`),
    );
    // The first two and five pages: the two pages past the cap go back behind '답글 더 보기'.
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 12), 'r12']);
    // Read again, the same five: the bound holds on every read.
    asked.length = 0;
    await comments.refetch();
    expect(asked.filter((one) => one.startsWith('replies:'))).toHaveLength(REPLY_READ_ON_PAGES);
    unsubscribe();
  });

  it('are read on five reply pages for each thread, not five for the read: two threads opened further each come back to their first and five pages (오너 결정 2026-10-21 (2차) 답 1)', async () => {
    // Two threads on one page of 댓글, each opened to 14 of its 40 대댓글 (two a page): every one
    // gets its own five pages — the owner's cap is per thread.
    const replies: Record<string, string[]> = {
      [commentId]: replyIds(0, 40),
      [OLDER]: replyIds(100, 140),
    };
    const threadOf = (id: string, count: number, cursor: string): CommentThread => ({
      comment: published(id),
      replies: replies[id]!.slice(0, count).map((reply) => published(reply, id)),
      repliesNextCursor: cursor,
    });
    const queryClient = seeded();
    queryClient.setQueryData<CommentPages>(postCommentsKey(post), {
      pages: [
        { items: [threadOf(commentId, 14, 'r14'), threadOf(OLDER, 14, 'r14')], nextCursor: null },
      ],
      pageParams: [undefined],
    });
    const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
    const unsubscribe = comments.subscribe(() => undefined);
    const asked = getThreads(
      () => ({ items: [threadOf(commentId, 2, 'r2'), threadOf(OLDER, 2, 'r2')], nextCursor: null }),
      ({ params }) => {
        const all = replies[params.path.commentId]!;
        const from = Number(params.query.cursor.slice(1));
        const to = Math.min(from + 2, all.length);
        return {
          items: all.slice(from, to).map((reply) => published(reply, params.path.commentId)),
          nextCursor: to < all.length ? `r${String(to)}` : null,
        };
      },
    );
    await comments.refetch();
    const pagesOf = (id: string) =>
      [2, 4, 6, 8, 10].map((from) => `replies:${id}:r${String(from)}`);
    expect(asked.filter((one) => one.startsWith('replies:'))).toEqual([
      ...pagesOf(commentId),
      ...pagesOf(OLDER),
    ]);
    expect(
      commentThreadsOf(queryClient.getQueryData(postCommentsKey(post))).map((thread) => [
        thread.comment.id,
        thread.replies.map((reply) => reply.id),
        thread.repliesNextCursor,
      ]),
    ).toEqual([
      [commentId, replies[commentId]!.slice(0, 12), 'r12'],
      [OLDER, replies[OLDER]!.slice(0, 12), 'r12'],
    ]);
    unsubscribe();
  });

  it('read the pages again when the thread’s cursor no longer opens (ADR-0074 7-29), and the next page from the fresh cursor', async () => {
    const queryClient = seededThread(replyIds(0, 2), 'r2');
    const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
    const unsubscribe = comments.subscribe(() => undefined);
    const asked = getThreads(
      () => ({ items: [threadAnswered(replyIds(0, 2), 'fresh2')], nextCursor: null }),
      ({ params }) =>
        params.query.cursor === 'fresh2' ? replyPage(replyIds(2, 4), 'fresh4') : cursorRefused(),
    );
    // Pressed once, it reads its page: not a button refused on every press until a reload.
    await readMoreReplies(queryClient, POST, commentId);
    expect(asked).toEqual([`replies:${commentId}:r2`, 'comments:', `replies:${commentId}:fresh2`]);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 4), 'fresh4']);
    unsubscribe();
  });

  it('throw a cursor’s refusal when the read again brings no fresh cursor, once: the next press reads again', async () => {
    // No one on the page reads the pages (no observer): the read again is only marked.
    const queryClient = seededThread(replyIds(0, 2), 'r2');
    const asked = getThreads(() => ({ items: [], nextCursor: null }), cursorRefused);
    await expect(readMoreReplies(queryClient, POST, commentId)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(asked).toEqual([`replies:${commentId}:r2`]);
    expect(queryClient.getQueryState(postCommentsKey(post))?.isInvalidated).toBe(true);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 2), 'r2']);
  });

  it('a new 대댓글 past five unread reply pages goes last of those held, and ‘답글 더 보기’ brings it into place (오너 결정 2026-10-21 (2차) 답 1)', async () => {
    const queryClient = seededThread(replyIds(0, 2), 'r2');
    vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, commentId, '답글')));
    const asked = getThreads(() => ({ items: [], nextCursor: null }), fakeReplies(20, MINE));
    await new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, () => undefined),
    ).mutate({ parentId: commentId, body: '답글', expectedAccountId: 'user-1' });
    // Five pages read, the end not reached: as a read that failed — the pages dropped, the answer
    // last of the 대댓글 held, the thread's cursor where it was.
    expect(asked).toEqual([2, 4, 6, 8, 10].map((from) => `replies:${commentId}:r${String(from)}`));
    expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 2), MINE], 'r2']);
    expect(commentCountOf(queryClient)).toBe(2);
    // '답글 더 보기' to the end puts it after every older one.
    for (let page = 0; page < 10; page += 1) await readMoreReplies(queryClient, POST, commentId);
    expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 20), MINE], null]);
  });

  it('a new 대댓글 whose thread ends within five unread reply pages stands in its place', async () => {
    const queryClient = seededThread(replyIds(0, 2), 'r2');
    vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, commentId, '답글')));
    const asked = getThreads(() => ({ items: [], nextCursor: null }), fakeReplies(11, MINE));
    await new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, () => undefined),
    ).mutate({ parentId: commentId, body: '답글', expectedAccountId: 'user-1' });
    // The fifth page is the last (r10: the eleventh and the new one).
    expect(asked).toHaveLength(REPLY_READ_ON_PAGES);
    expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 11), MINE], null]);
  });

  it('a new 대댓글 on the fifth unread reply page stands in its place though others answered after it (오너 결정 2026-10-21 (2차) 답 1)', async () => {
    // Another answer came after MINE while the pages were read: the fifth page holds MINE and
    // still has a page after it. MINE was within the five pages — not past the cap.
    const queryClient = seededThread(replyIds(0, 2), 'r2');
    vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, commentId, '답글')));
    const asked = getThreads(
      () => ({ items: [], nextCursor: null }),
      fakeReplies(11, MINE, LATER.slice(0, 1)),
    );
    await new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, () => undefined),
    ).mutate({ parentId: commentId, body: '답글', expectedAccountId: 'user-1' });
    expect(asked).toEqual([2, 4, 6, 8, 10].map((from) => `replies:${commentId}:r${String(from)}`));
    // The pages kept, MINE after every older one, the later answer behind the thread's cursor.
    expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 11), MINE], 'r12']);
    await readMoreReplies(queryClient, POST, commentId);
    expect(repliesHeld(queryClient)).toEqual([
      [...replyIds(0, 11), MINE, ...LATER.slice(0, 1)],
      null,
    ]);
  });

  it('a new 대댓글 reached before five unread reply pages stops the reading there: what came after stays behind ‘답글 더 보기’', async () => {
    const queryClient = seededThread(replyIds(0, 2), 'r2');
    vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, commentId, '답글')));
    const asked = getThreads(() => ({ items: [], nextCursor: null }), fakeReplies(7, MINE, LATER));
    await new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, () => undefined),
    ).mutate({ parentId: commentId, body: '답글', expectedAccountId: 'user-1' });
    // The third page (r6: the seventh and MINE) holds it: no fourth page is asked for.
    expect(asked).toEqual([2, 4, 6].map((from) => `replies:${commentId}:r${String(from)}`));
    expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 7), MINE], 'r8']);
    expect(commentCountOf(queryClient)).toBe(2);
    await readMoreReplies(queryClient, POST, commentId);
    await readMoreReplies(queryClient, POST, commentId);
    expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 7), MINE, ...LATER], null]);
  });

  it('a new 대댓글 whose thread’s unread 대댓글 cannot be read goes last of those held: it is written', async () => {
    const queryClient = seededThread(replyIds(0, 2), 'r2');
    vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, commentId, '답글')));
    getThreads(
      () => ({ items: [], nextCursor: null }),
      () => Promise.reject(new TypeError('Failed to fetch')),
    );
    await new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, () => undefined),
    ).mutate({ parentId: commentId, body: '답글', expectedAccountId: 'user-1' });
    expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 2), MINE], 'r2']);
    // Its page, read later by 답글 더 보기, puts it in its place after the older ones.
    getThreads(
      () => ({ items: [], nextCursor: null }),
      () => replyPage([...replyIds(2, 3), MINE], null),
    );
    await readMoreReplies(queryClient, POST, commentId);
    expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 3), MINE], null]);
  });
});

describe('an edit draft taken back on a thread’s unread 대댓글 (오너 결정 2026-10-22 답 5, (2차) 답 1·2, (3차) 답 1·3)', () => {
  /** The account on screen: the author of every 대댓글 the fakes answer with. */
  const VIEWER = 'k7m2p9qx4z';

  /** The threads the pages hold now. */
  const threadsNow = (queryClient: QueryClient) =>
    commentThreadsOf(queryClient.getQueryData(postCommentsKey(post)));

  /**
   * What `read` does to the texts `held` apart, as the comment section tells it
   * (comments-section.tsx): where the 대댓글 on screen stood before it against the threads it leaves
   * (`heldEditsBrought`, 오너 결정 2026-10-22 (3차) 답 1 — any read).
   */
  async function broughtBy(
    queryClient: QueryClient,
    held: readonly HeldText[],
    read: () => Promise<unknown>,
    viewer: string = VIEWER,
  ): Promise<HeldEditsBrought> {
    const before = repliesOnScreenOf(threadsNow(queryClient));
    await read();
    return heldEditsBrought(held, threadsNow(queryClient), before, viewer);
  }

  /**
   * The post page's read on for edit drafts taken back after an onboarding step, as its effect
   * takes it (comments-section.tsx): the drafts placed against the threads held
   * (`resolveCommentDrafts`), the next step asked of `editDraftsReadOn` — what it says is past shown
   * apart and dropped, one reply page read ('답글 더 보기') of the thread it names — until it names
   * none. A read that fails is kept by where it read from, and the drafts then waiting on that thread
   * are shown apart with its failure — unless `unlistedAtFailure`: the page listed none as it failed
   * (the comment pages being read again), so they are left for the next step. The edits whose boxes
   * open, what is shown apart and what is gone.
   */
  async function readOnForEdits(
    queryClient: QueryClient,
    edits: readonly string[],
    {
      unlistedAtFailure = false,
      held = [],
    }: { unlistedAtFailure?: boolean; held?: readonly HeldText[] } = {},
  ) {
    // What each page read opens of the texts `held` apart, as the section tells it (`broughtBy`).
    const readIn: HeldEditsBrought = { open: [], reasons: [] };
    let drafts: CommentDrafts = {
      ...NO_COMMENT_DRAFTS,
      edits: new Map(edits.map((id) => [id, `고친 ${id}`])),
      editThreads: new Map(edits.map((id) => [id, commentId])),
    };
    const pagesRead = new Map<string, number>();
    const failures = new Map<string, string>();
    const apart: UnplacedCommentDraft[] = [];
    const placed = () =>
      resolveCommentDrafts(drafts, {
        postId: post,
        postState: 'published',
        threads: commentThreadsOf(queryClient.getQueryData(postCommentsKey(post))),
        allRead: true,
        viewerPublicId: VIEWER,
      });
    const showApart = (shown: readonly UnplacedCommentDraft[]) => {
      apart.push(...shown);
      drafts = withoutCommentDrafts(
        drafts,
        shown.map(({ key }) => key),
      );
    };
    for (let steps = 0; steps < 50; steps += 1) {
      const threads = commentThreadsOf(queryClient.getQueryData(postCommentsKey(post)));
      const { read, past } = editDraftsReadOn(threads, placed(), {
        pagesRead: (threadId) => pagesRead.get(threadId) ?? 0,
        failed: (mark) => failures.get(mark),
      });
      showApart(past);
      if (read === undefined) {
        const { edits: opened, unplaced: gone } = placed();
        return { opened: [...opened.keys()], apart, gone, readIn };
      }
      const threadId = read.comment.id;
      const readFrom = editDraftReadOnMark(read);
      pagesRead.set(threadId, (pagesRead.get(threadId) ?? 0) + 1);
      try {
        const { open, reasons } = await broughtBy(queryClient, held, () =>
          readMoreReplies(queryClient, POST, threadId),
        );
        readIn.open.push(...open);
        readIn.reasons.push(...reasons);
      } catch (error) {
        const reason = postReadErrorMessage(error);
        failures.set(readFrom, reason);
        if (!unlistedAtFailure) {
          showApart(draftsHeldOnReadFailure(placed().waitingEdits, threadId, reason));
        }
      }
    }
    throw new Error('the read on did not end');
  }

  /** The reply pages the fake server was asked for, from the n-th 대댓글 each. */
  const pagesFrom = (...froms: number[]) =>
    froms.map((from) => `replies:${commentId}:r${String(from)}`);

  /** The id of the n-th 대댓글 of `replyIds`. */
  const replyId = (index: number) => replyIds(index, index + 1).join('');

  /**
   * A fake reply route over `total` 대댓글 of the 댓글 above, a full page each time as the server
   * reads them (COMMENT_REPLIES_PAGE_SIZE) — the cursor `r<n>` reading from the n-th: the bound
   * is the 300 대댓글 a read of the pages keeps, counted in 대댓글.
   */
  const fullPages =
    (total: number) =>
    ({ params }: RepliesRequest): ReplyPage => {
      const from = Number(params.query.cursor.slice(1));
      const to = Math.min(from + COMMENT_REPLIES_PAGE_SIZE, total);
      return replyPage(replyIds(from, to), to < total ? `r${String(to)}` : null);
    };

  /** The client holding the 댓글 above with its first `count` 대댓글 of a longer thread. */
  const holding = (count: number) => seededThread(replyIds(0, count), `r${String(count)}`);

  it('reads the thread on until the 대댓글 is read: on the first unread page, or the one that brings it to 300, its box opens', async () => {
    for (const [index, pages] of [
      [60, pagesFrom(50)],
      [REPLIES_KEPT_ON_READ - 1, pagesFrom(50, 100, 150, 200, 250)],
    ] as const) {
      const queryClient = holding(50);
      const asked = getThreads(() => ({ items: [], nextCursor: null }), fullPages(400));
      const draft = replyId(index);
      expect(await readOnForEdits(queryClient, [draft])).toMatchObject({
        opened: [draft],
        apart: [],
        gone: [],
      });
      expect(asked).toEqual(pages);
    }
  });

  it('stops at the 300 a read of the pages keeps: a 대댓글 past them is shown apart with the owner’s words, and no page past them is asked for (오너 결정 2026-10-22 (2차) 답 1)', async () => {
    for (const index of [REPLIES_KEPT_ON_READ, 390]) {
      const queryClient = holding(50);
      const asked = getThreads(() => ({ items: [], nextCursor: null }), fullPages(400));
      const draft = replyId(index);
      const { opened, apart, gone } = await readOnForEdits(queryClient, [draft]);
      expect(asked).toEqual(pagesFrom(50, 100, 150, 200, 250));
      expect(asked).toHaveLength(REPLY_READ_ON_PAGES);
      expect([opened, gone]).toEqual([[], []]);
      expect(apart).toEqual([
        {
          key: { kind: 'edit', postId: post, commentId: draft, threadId: commentId },
          text: `고친 ${draft}`,
          reason: copy.errCommentEditNotRead,
          place: { kind: 'comment', commentId: draft, threadId: commentId },
        },
      ]);
      // The pages read stay, as '답글 더 보기' leaves them: the next press reads on from there.
      expect(repliesHeld(queryClient)).toEqual([replyIds(0, REPLIES_KEPT_ON_READ), 'r300']);
    }
  });

  it('reads nothing for a thread that holds its 300 already — the comments kept in this tab across the step, read again on the way back — and shows the draft apart at once (오너 결정 2026-10-22 (2차) 답 1)', async () => {
    const queryClient = holding(REPLIES_KEPT_ON_READ);
    const asked = getThreads(() => ({ items: [], nextCursor: null }), fullPages(400));
    const draft = replyId(315);
    const { opened, apart, gone } = await readOnForEdits(queryClient, [draft]);
    expect(asked).toEqual([]);
    expect([opened, gone]).toEqual([[], []]);
    expect(apart.map(({ text, reason }) => [text, reason])).toEqual([
      [`고친 ${draft}`, copy.errCommentEditNotRead],
    ]);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, REPLIES_KEPT_ON_READ), 'r300']);
  });

  it('opens no box past the 300 when the thread holds more — the read again on the way back did not land (cancelled, failed, offline): the draft is shown apart at once under its 대댓글, with the owner’s words, nothing read (오너 결정 2026-10-22 (2차) 답 1, (3차) 답 3)', async () => {
    // As '답글 더 보기' left it before the step: 361 of 400, or all 361 of them.
    for (const cursor of ['r361', null]) {
      const queryClient = seededThread(replyIds(0, 361), cursor);
      const asked = getThreads(() => ({ items: [], nextCursor: null }), fullPages(400));
      const [onScreenPast, within] = [replyId(329), replyId(299)];
      const { opened, apart, gone } = await readOnForEdits(queryClient, [onScreenPast, within]);
      expect(asked).toEqual([]);
      // The 300th opens; the 330th, on screen in pages the next read that lands takes back to 300,
      // does not — shown apart, under it: '고치던 답글을 다시 열지 못했습니다. 쓰던 내용을 여기 남겨
      // 둡니다.'
      expect(opened).toEqual([within]);
      expect(apart).toEqual([]);
      expect(gone).toEqual([
        {
          key: { kind: 'edit', postId: post, commentId: onScreenPast, threadId: commentId },
          text: `고친 ${onScreenPast}`,
          reason: copy.errCommentEditNotReopened,
          place: { kind: 'comment', commentId: onScreenPast, threadId: commentId },
        },
      ]);
    }
  });

  it('counts to the 300 from wherever the thread stands: one held at 150 reads three pages, not five, and no box opens past 300 for the next read of the pages to take away (ADR-0074 7-28·7-30)', async () => {
    const queryClient = holding(150);
    const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
    const unsubscribe = comments.subscribe(() => undefined);
    const asked = getThreads(
      () => ({ items: [threadAnswered(replyIds(0, 50), 'r50')], nextCursor: null }),
      fullPages(400),
    );
    for (const [index, opened] of [
      [REPLIES_KEPT_ON_READ - 1, true],
      [REPLIES_KEPT_ON_READ + 5, false],
    ] as const) {
      queryClient.setQueryData<CommentPages>(postCommentsKey(post), {
        pages: [{ items: [threadAnswered(replyIds(0, 150), 'r150')], nextCursor: null }],
        pageParams: [undefined],
      });
      asked.length = 0;
      const draft = replyId(index);
      const result = await readOnForEdits(queryClient, [draft]);
      expect(asked).toEqual(pagesFrom(150, 200, 250));
      expect([result.opened.length, result.apart.length]).toEqual(opened ? [1, 0] : [0, 1]);
    }
    // A read of the pages (a focus after 30 seconds) keeps what the read on brought: the 300.
    asked.length = 0;
    await comments.refetch();
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, REPLIES_KEPT_ON_READ), 'r300']);
    unsubscribe();
  });

  it('a thread that ends within them without the 대댓글: gone, in the words it was before', async () => {
    const queryClient = holding(50);
    const asked = getThreads(() => ({ items: [], nextCursor: null }), fullPages(170));
    const { opened, apart, gone } = await readOnForEdits(queryClient, [MINE]);
    expect(asked).toEqual(pagesFrom(50, 100, 150));
    expect([opened, apart]).toEqual([[], []]);
    expect(gone.map(({ text, reason }) => [text, reason])).toEqual([
      [`고친 ${MINE}`, copy.errCommentGone],
    ]);
  });

  /** The fake reply route over 400 대댓글, its read from `failing` refused as a network failure. */
  const failingFrom =
    (failing: string) =>
    (request: RepliesRequest): ReplyPage | Promise<ReplyPage> =>
      request.params.query.cursor === failing
        ? Promise.reject(new TypeError('Failed to fetch'))
        : fullPages(400)(request);

  it('a read that fails shows the drafts waiting on its thread apart with its failure, and asks no more (오너 결정 2026-10-21 (2차) 답 2)', async () => {
    const queryClient = holding(50);
    const asked = getThreads(() => ({ items: [], nextCursor: null }), failingFrom('r150'));
    const draft = replyId(220);
    const { opened, apart, gone } = await readOnForEdits(queryClient, [draft]);
    expect(asked).toEqual(pagesFrom(50, 100, 150));
    expect([opened, gone]).toEqual([[], []]);
    expect(apart.map(({ text, reason }) => [text, reason])).toEqual([
      [`고친 ${draft}`, copy.errNetwork],
    ]);
  });

  it('a read that fails while the page lists no draft — the comment pages read again — shows them apart with its failure once listed, its cursor not read again', async () => {
    // As the page has it: the drafts were not on screen as the read failed, so nothing was shown
    // then; the thread stands where it failed when they are listed again.
    const queryClient = holding(50);
    const asked = getThreads(() => ({ items: [], nextCursor: null }), failingFrom('r150'));
    const draft = replyId(220);
    const { opened, apart, gone } = await readOnForEdits(queryClient, [draft], {
      unlistedAtFailure: true,
    });
    expect(asked).toEqual(pagesFrom(50, 100, 150));
    expect([opened, gone]).toEqual([[], []]);
    expect(apart.map(({ text, reason }) => [text, reason])).toEqual([
      [`고친 ${draft}`, copy.errNetwork],
    ]);
  });

  /** The drafts `readOnForEdits` showed apart, as the section holds them: drawn already. */
  const heldOf = (apart: readonly UnplacedCommentDraft[]): HeldText[] =>
    apart.map(({ key, text, reason, place }) => ({
      id: `taken-back:${key.kind}:${place.kind === 'comment' ? place.commentId : ''}`,
      text,
      reason,
      place,
      focus: false,
      shown: true,
    }));

  it('a draft shown apart opens in its edit once 답글 더 보기 brings its 대댓글 within the 300 — after a read that failed; one brought past them stays apart, under it, with the owner’s words (오너 결정 2026-10-22 (2차) 답 2, (3차) 답 1·3)', async () => {
    // After a read that failed: the 221st, the thread at 50 — the second press brings it.
    const failed = holding(50);
    getThreads(() => ({ items: [], nextCursor: null }), failingFrom('r150'));
    const draft = replyId(220);
    const held = heldOf((await readOnForEdits(failed, [draft])).apart);
    expect(held.map(({ reason }) => reason)).toEqual([copy.errNetwork]);
    getThreads(() => ({ items: [], nextCursor: null }), fullPages(400));
    const press = () => readMoreReplies(failed, POST, commentId);
    expect(await broughtBy(failed, held, press)).toEqual({ open: [], reasons: [] });
    expect(await broughtBy(failed, held, press)).toEqual({
      open: [{ id: held[0]!.id, commentId: draft, text: `고친 ${draft}` }],
      reasons: [],
    });

    // Past the 300: the 316th, the thread holding its 300 — shown apart at once, then brought by
    // 답글 더 보기 past them: no box for the next read of the pages to take away; the text stays,
    // under its 대댓글 now, with '고치던 답글을 다시 열지 못했습니다. 쓰던 내용을 여기 남겨 둡니다.'
    // — said once: the next press, past it, says nothing more.
    const past = holding(REPLIES_KEPT_ON_READ);
    const far = replyId(315);
    const apart = heldOf((await readOnForEdits(past, [far])).apart);
    expect(apart.map(({ reason }) => reason)).toEqual([copy.errCommentEditNotRead]);
    const pastPress = () => readMoreReplies(past, POST, commentId);
    expect(await broughtBy(past, apart, pastPress)).toEqual({
      open: [],
      reasons: [{ id: apart[0]!.id, reason: copy.errCommentEditNotReopened }],
    });
    expect(await broughtBy(past, apart, pastPress)).toEqual({ open: [], reasons: [] });
  });

  /** A text held apart for the edit of the 대댓글 `id`, drawn already, saying `reason`. */
  const heldFor = (id: string, reason: string = copy.errCommentEditNotRead): HeldText => ({
    id: `taken-back:edit:${id}`,
    text: `따로 둔 ${id}`,
    reason,
    place: { kind: 'comment', commentId: id, threadId: commentId },
    focus: false,
    shown: true,
  });

  /** The fake reply route over `total` 대댓글, the reader's new 대댓글 MINE after them. */
  const fullPagesThenMine = (total: number) => {
    const server = fullPages(total);
    return (request: RepliesRequest): ReplyPage => {
      const page = server(request);
      return page.nextCursor === null
        ? { ...page, items: [...page.items, published(MINE, commentId)] }
        : page;
    };
  };

  /** The reader's new 대댓글 under the 댓글 above, through the hook's options. */
  const writeReply = (queryClient: QueryClient) => {
    vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, commentId, '답글')));
    return () =>
      new MutationObserver(
        queryClient,
        createCommentOptions(queryClient, POST, () => undefined),
      ).mutate({ parentId: commentId, body: '답글', expectedAccountId: 'user-1' });
  };

  it('a text held apart opens in its edit when a new 대댓글’s read on brings its 대댓글 within the 300; past them it stays apart with the owner’s words (오너 결정 2026-10-22 (3차) 답 1·3)', async () => {
    // The thread at 50; the read on reads to the new 대댓글, three pages, the 121st on the way.
    const within = holding(50);
    const asked = getThreads(() => ({ items: [], nextCursor: null }), fullPagesThenMine(200));
    const target = replyId(120);
    // On screen before the read: nothing to it.
    const held = [heldFor(target, copy.errNetwork), heldFor(replyId(10))];
    expect(await broughtBy(within, held, writeReply(within))).toEqual({
      open: [{ id: held[0]!.id, commentId: target, text: held[0]!.text }],
      reasons: [],
    });
    expect(asked).toEqual(pagesFrom(50, 100, 150));
    expect(repliesHeld(within)).toEqual([[...replyIds(0, 200), MINE], null]);

    // The thread at its 300 ('답글 더 보기' opened it so far): the read on reads past them, the 321st
    // on the way — no box there; the text says it cannot be opened.
    vi.restoreAllMocks();
    const past = holding(REPLIES_KEPT_ON_READ);
    getThreads(() => ({ items: [], nextCursor: null }), fullPagesThenMine(400));
    const far = heldFor(replyId(320));
    expect(await broughtBy(past, [far], writeReply(past))).toEqual({
      open: [],
      reasons: [{ id: far.id, reason: copy.errCommentEditNotReopened }],
    });
    expect(repliesHeld(past)).toEqual([[...replyIds(0, 400), MINE], null]);
  });

  it('a text held apart opens in its edit when a read of the pages brings its 대댓글 within the 300 — an earlier 대댓글 deleted meanwhile — whether it was not on screen or on screen past them (오너 결정 2026-10-22 (3차) 답 1)', async () => {
    // The 301st: held apart while the thread held 300 (not among those read), or under it while the
    // thread held 301 (a read again on the way back that did not land, the owner's words of 3차 답 3).
    // The 11th deleted meanwhile: the read of the pages — its first 50 and five pages, 300 — now
    // ends with it.
    const all = replyIds(0, 400).filter((id) => id !== replyId(10));
    const target = replyId(REPLIES_KEPT_ON_READ);
    for (const [count, reason] of [
      [REPLIES_KEPT_ON_READ, copy.errCommentEditNotRead],
      [REPLIES_KEPT_ON_READ + 1, copy.errCommentEditNotReopened],
    ] as const) {
      const queryClient = seededThread(replyIds(0, count), `r${String(count)}`);
      const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
      const unsubscribe = comments.subscribe(() => undefined);
      const asked = getThreads(
        () => ({ items: [threadAnswered(all.slice(0, 50), 'c50')], nextCursor: null }),
        ({ params }) => {
          const from = Number(params.query.cursor.slice(1));
          const to = Math.min(from + COMMENT_REPLIES_PAGE_SIZE, all.length);
          return replyPage(all.slice(from, to), to < all.length ? `c${String(to)}` : null);
        },
      );
      const held = [heldFor(target, reason)];
      expect(await broughtBy(queryClient, held, () => comments.refetch())).toEqual({
        open: [{ id: held[0]!.id, commentId: target, text: held[0]!.text }],
        reasons: [],
      });
      expect(asked.filter((one) => one.startsWith('replies:'))).toHaveLength(REPLY_READ_ON_PAGES);
      expect(repliesHeld(queryClient)).toEqual([all.slice(0, REPLIES_KEPT_ON_READ), 'c300']);
      unsubscribe();
      vi.restoreAllMocks();
    }
  });

  it('a 대댓글 on screen past the 300 is brought within them with no read at all when the reader deletes an earlier 대댓글 of its thread — counted as a read’s (ADR-0074 7-30 (b), 오너 확인 2026-10-22 (오후) 답 1)', async () => {
    // The thread holding 301: the 301st on screen past the 300, its text held apart under it with
    // the owner's words (3차 답 3). The reader deletes their own 11th: the answer takes it out of the
    // pages (`withoutComment`), nothing is read, and the 301st is the 300th. The section opens its
    // edit with the text — unless the reader has that edit open already: the box keeps what it has,
    // the text stays, and no toast says it was restored (`useReopened`, the e2e's big thread).
    const count = REPLIES_KEPT_ON_READ + 1;
    const queryClient = seededThread(replyIds(0, count), `r${String(count)}`);
    const read = vi.spyOn(api, 'GET').mockRejectedValue(new Error('nothing is read'));
    const earlier = replyId(10);
    vi.spyOn(api, 'POST').mockResolvedValue(answer({ id: earlier, placeholder: false }));
    const target = replyId(REPLIES_KEPT_ON_READ);
    const held = [heldFor(target, copy.errCommentEditNotReopened)];
    const deleteEarlier = () =>
      new MutationObserver(
        queryClient,
        deleteCommentOptions(queryClient, POST, () => undefined),
      ).mutate({ commentId: earlier, expectedAccountId: 'user-1' });
    expect(await broughtBy(queryClient, held, deleteEarlier)).toEqual({
      open: [{ id: held[0]!.id, commentId: target, text: held[0]!.text }],
      reasons: [],
    });
    expect(read).not.toHaveBeenCalled();
    expect(repliesHeld(queryClient)).toEqual([
      replyIds(0, count).filter((id) => id !== earlier),
      `r${String(count)}`,
    ]);
  });

  it('a 대댓글 brought that takes no edit — hidden, or another account’s — keeps its text apart, with why in the server’s words (오너 결정 2026-10-22 (2차) 답 2, (3차) 답 1)', async () => {
    const queryClient = holding(50);
    const [hidden, theirs, mine, hiddenSaid] = [replyId(60), replyId(70), replyId(80), replyId(90)];
    getThreads(
      () => ({ items: [], nextCursor: null }),
      (request) => {
        const page = fullPages(400)(request);
        return {
          ...page,
          items: page.items.map((reply) =>
            reply.id === hidden || reply.id === hiddenSaid
              ? { state: 'hidden' as const, id: reply.id }
              : reply.id === theirs && reply.state === 'published'
                ? { ...reply, author: { ...reply.author, publicId: 'other00000' } }
                : reply,
          ),
        };
      },
    );
    const held = [
      heldFor(hidden),
      heldFor(theirs, copy.errNetwork),
      heldFor(mine),
      // Says it already: nothing new.
      heldFor(hiddenSaid, copy.errCommentNotEditable),
    ];
    const before = repliesOnScreenOf(threadsNow(queryClient));
    await readMoreReplies(queryClient, POST, commentId);
    expect(heldEditsBrought(held, threadsNow(queryClient), before, VIEWER)).toEqual({
      open: [{ id: held[2]!.id, commentId: mine, text: `따로 둔 ${mine}` }],
      reasons: [
        { id: held[0]!.id, reason: copy.errCommentNotEditable },
        { id: held[1]!.id, reason: copy.errCommentNotYours },
      ],
    });
    // Another account on screen: none of them opens.
    expect(heldEditsBrought(held, threadsNow(queryClient), before, 'nobody0000').open).toEqual([]);
  });

  it('each 대댓글 is brought once, by the read that put it on screen: a press whose page lands after another read moved its thread on brings nothing, and the edit that read opened keeps what it has (ADR-0074 7-30)', async () => {
    // The thread at 100, a text held apart for its 141st (a read that failed). The reader presses
    // 답글 더 보기 and its page is slow; meanwhile the reader's new 대댓글 reads the thread on to the
    // end (`readOnReplies`), the 141st on screen with it — its edit opens with the held text there
    // (3차 답 1), and the reader may type in it.
    const queryClient = seededThread(replyIds(0, 100), 'r100');
    const slow = onItsWay();
    let first = true;
    const server = fullPagesThenMine(200);
    getThreads(
      () => ({ items: [], nextCursor: null }),
      async (request) => {
        if (request.params.query.cursor === 'r100' && first) {
          first = false;
          await slow.arrived;
        }
        return server(request);
      },
    );
    const target = replyId(140);
    const held = [heldFor(target, copy.errNetwork)];
    const pressedWith = repliesOnScreenOf(threadsNow(queryClient));
    const press = readMoreReplies(queryClient, POST, commentId);
    expect(await broughtBy(queryClient, held, writeReply(queryClient))).toEqual({
      open: [{ id: held[0]!.id, commentId: target, text: held[0]!.text }],
      reasons: [],
    });
    expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 200), MINE], null]);
    // Its page goes nowhere — the thread had moved on — and brings nothing: the 141st was the read
    // on's, and its edit keeps what the reader typed since.
    slow.arrive();
    expect(await broughtBy(queryClient, held, () => press)).toEqual({ open: [], reasons: [] });
    expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 200), MINE], null]);
    // Judged against the thread as it was pressed, the 141st would count again — and the held text
    // would go into an edit open with other words, and be lost.
    expect(heldEditsBrought(held, threadsNow(queryClient), pressedWith, VIEWER).open).toHaveLength(
      1,
    );
  });

  it('a text held apart opens in its edit when the read on for drafts taken back brings its 대댓글 within the 300 — any read does (오너 결정 2026-10-22 (3차) 답 1)', async () => {
    // Held apart for the 121st after an earlier set's read failed; a later set brings a draft for the
    // 221st of the same thread, and its read on passes the 121st on the way.
    const queryClient = holding(50);
    const asked = getThreads(() => ({ items: [], nextCursor: null }), fullPages(400));
    const earlier = heldFor(replyId(120), copy.errNetwork);
    const draft = replyId(220);
    const { opened, apart, gone, readIn } = await readOnForEdits(queryClient, [draft], {
      held: [earlier],
    });
    expect(asked).toEqual(pagesFrom(50, 100, 150, 200));
    expect([opened, apart, gone]).toEqual([[draft], [], []]);
    expect(readIn).toEqual({
      open: [{ id: earlier.id, commentId: replyId(120), text: earlier.text }],
      reasons: [],
    });
  });
});

describe('a new 댓글', () => {
  /** Writes MINE as a 댓글 through the hook's options. */
  const write = (queryClient: QueryClient) => {
    vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE)));
    return new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, () => undefined),
    ).mutate({ parentId: null, body: '댓글', expectedAccountId: 'user-1' });
  };

  it('arrives with its page after every older 댓글, unread ones too, and a later read keeps it', async () => {
    // Page 1 read, page 2 (an older 댓글) not: put at the end of page 1, MINE would stand before it.
    const queryClient = seeded('c2');
    const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
    const unsubscribe = comments.subscribe(() => undefined);
    const asked = getComments(({ params }) =>
      params.query.cursor === undefined
        ? { items: [thread(published(commentId))], nextCursor: 'c2' }
        : { items: [thread(published(OLDER)), thread(published(MINE))], nextCursor: null },
    );
    await write(queryClient);
    // The last page held is read again, and every page after it.
    expect(asked).toEqual([{}, { cursor: 'c2' }]);
    expect(threadIds(queryClient)).toEqual([commentId, OLDER, MINE]);
    expect(comments.getCurrentResult().hasNextPage).toBe(false);
    expect(commentCountOf(queryClient)).toBe(2);
    // A read of as many pages as are held (a focus, 30 seconds on) keeps it.
    await comments.refetch();
    expect(threadIds(queryClient)).toEqual([commentId, OLDER, MINE]);
    unsubscribe();
  });

  it('opens the next page when the last page held was the end but full', async () => {
    // The server's page ends where the held one did, now with a next page holding MINE.
    const queryClient = seeded(null);
    const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
    const unsubscribe = comments.subscribe(() => undefined);
    getComments(({ params }) =>
      params.query.cursor === undefined
        ? { items: [thread(published(commentId))], nextCursor: 'c2' }
        : { items: [thread(published(MINE))], nextCursor: null },
    );
    await write(queryClient);
    expect(threadIds(queryClient)).toEqual([commentId, MINE]);
    await comments.refetch();
    expect(threadIds(queryClient)).toEqual([commentId, MINE]);
    unsubscribe();
  });

  it('keeps a thread ‘답글 더 보기’ opened: its page read again reads the thread on as far', async () => {
    // One page of 댓글, the usual case: the page read again replaces it, each thread back to its
    // first 대댓글 unless read on — and an edit open on a 대댓글 past them would go with them.
    const queryClient = seededThread(replyIds(0, 4), 'r4');
    const asked = getThreads(
      () => ({
        items: [threadAnswered(replyIds(0, 2), 'r2'), thread(published(MINE))],
        nextCursor: null,
      }),
      ({ params }) =>
        params.query.cursor === 'r2'
          ? replyPage(replyIds(2, 4), 'r4')
          : replyPage(replyIds(4, 6), null),
    );
    await write(queryClient);
    expect(asked).toEqual(['comments:', `replies:${commentId}:r2`]);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 4), 'r4']);
    expect(threadIds(queryClient)).toEqual([commentId, MINE]);
  });

  it('goes at the end of the pages held when its page cannot be read: it is written', async () => {
    const queryClient = seeded('c2');
    vi.spyOn(api, 'GET').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(write(queryClient)).resolves.toEqual(published(MINE));
    expect(threadIds(queryClient)).toEqual([commentId, MINE]);
    expect(commentCountOf(queryClient)).toBe(2);
  });
});

describe('a read of the pages on its way when an answer lands', () => {
  const writes: [
    string,
    (queryClient: QueryClient) => Promise<unknown>,
    (pages: CommentPages | undefined) => void,
  ][] = [
    [
      'a deletion',
      (queryClient) => {
        vi.spyOn(api, 'POST').mockResolvedValue(answer({ id: commentId, placeholder: false }));
        return new MutationObserver(
          queryClient,
          deleteCommentOptions(queryClient, POST, () => undefined),
        ).mutate({ commentId: COMMENT, expectedAccountId: 'user-1' });
      },
      (pages) => expect(commentThreadsOf(pages)).toEqual([]),
    ],
    [
      'an edit',
      (queryClient) => {
        vi.spyOn(api, 'PUT').mockResolvedValue(answer(published(commentId, null, '고친 댓글')));
        return new MutationObserver(
          queryClient,
          updateCommentOptions(queryClient, POST, () => undefined),
        ).mutate({ commentId: COMMENT, body: '고친 댓글', expectedAccountId: 'user-1' });
      },
      (pages) => {
        const [first] = commentThreadsOf(pages);
        expect(first?.comment.state === 'published' && first.comment.body).toBe('고친 댓글');
      },
    ],
    [
      'a new 대댓글',
      (queryClient) => {
        vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, commentId, '답글')));
        return new MutationObserver(
          queryClient,
          createCommentOptions(queryClient, POST, () => undefined),
        ).mutate({ parentId: commentId, body: '답글', expectedAccountId: 'user-1' });
      },
      (pages) =>
        expect(commentThreadsOf(pages)[0]?.replies.map((reply) => reply.id)).toEqual([MINE]),
    ],
  ];

  for (const [name, writeOf, written] of writes) {
    it(`is cancelled first, so it cannot undo ${name}; another post's read lands`, async () => {
      const queryClient = seeded('c2');
      queryClient.setQueryData(postCommentsKey(OTHER_POST), held('o2'));
      const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
      const others = new InfiniteQueryObserver(
        queryClient,
        commentsInfiniteQueryOptions(OTHER_POST),
      );
      const unsubscribe = [comments.subscribe(() => undefined), others.subscribe(() => undefined)];
      const read = onItsWay();
      getComments(async () => {
        await read.arrived;
        return { items: [thread(published(OLDER))], nextCursor: null };
      });
      // 더 보기 on both posts, left before the write was answered: each holds the pages as they were.
      const more = [comments.fetchNextPage(), others.fetchNextPage()];
      await writeOf(queryClient);
      read.arrive();
      await Promise.all(more);
      written(queryClient.getQueryData(postCommentsKey(post)));
      // The cancelled 더 보기 is there to press again.
      expect(comments.getCurrentResult().hasNextPage).toBe(true);
      // Only this post's pages: the other post's read is its own, and lands.
      expect(threadIds(queryClient, OTHER_POST)).toEqual([commentId, OLDER]);
      for (const stop of unsubscribe) stop();
    });
  }
});
