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
  COMMENT_READ_ON_PAGES,
  REPLIES_KEPT_ON_READ,
  REPLY_READ_ON_PAGES,
  REPLY_READ_ON_PAGES_IN_ALL,
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
  goneBoxReason,
  heldEditsBrought,
  postCommentsKey,
  repliesOnScreenOf,
  resolveCommentDrafts,
} from '@/lib/comments';
import { withCommentLikeCount } from '@/lib/likes';
import { MY_ACTIONS_KEY, MY_RESTRICTION_KEY } from '@/lib/moderation';
import { communityPostsKey, marketPostsKey, postKey, postReadErrorMessage } from '@/lib/posts';
import { getQueryClient } from '@/lib/query-client';
import { deleteMyItemOptions } from './use-authored';
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
  likeCount: 0,
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

/** The market the post is on, whose detail's 토론 (#47) holds the post's card too. */
const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

/**
 * A client holding the post's comments, the post ('댓글 1'), a community list page and the
 * market's 토론 page.
 */
function seeded(nextCursor: string | null = null) {
  const queryClient = getQueryClient();
  queryClient.setQueryData(postCommentsKey(post), held(nextCursor));
  queryClient.setQueryData(postKey(post), { state: 'published', id: post, commentCount: 1 });
  queryClient.setQueryData(communityPostsKey({}), { pages: [], pageParams: [] });
  queryClient.setQueryData(marketPostsKey(MARKET), { pages: [], pageParams: [] });
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
  pageOf: (request: CommentsRequest) => CommentPage | Promise<CommentPage>,
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
    const page = await pageOf(request);
    return answer(page.items, { nextCursor: page.nextCursor });
  });
  return asked;
}

/**
 * `GET /me` in the client naming `accountId` (`user-1` by default, the account the tests' writes
 * send): the account on screen, whom a new comment put at the end of what is held is placed for
 * (오너 결정 2026-10-24, `writerOnScreen`).
 */
const onScreen = (queryClient: QueryClient, accountId = 'user-1') => {
  queryClient.setQueryData(ME_QUERY_KEY, { id: accountId });
  return queryClient;
};

/** What the pages of the post keep placed at the end of what is held, as `<threadId|->:<id>`. */
const placedHeld = (queryClient: QueryClient) =>
  (queryClient.getQueryData<CommentPages>(postCommentsKey(post))?.placed ?? []).map(
    (entry) => `${entry.threadId ?? '-'}:${entry.id}`,
  );

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
    // …and the market detail's 토론, whose card carries the same '댓글 N' (#47, ADR-0075).
    expect(queryClient.getQueryState(marketPostsKey(MARKET))?.isInvalidated).toBe(true);
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
    expect(commentDraftLandedSince(replyBox, 'user-1', before)).toBe(false);

    send.mockResolvedValueOnce(
      answer(published('d3b07384-d9a0-4c9b-8e2f-2d1c0f8a4b11', commentId)),
    );
    await write.mutate({ parentId: COMMENT, body: '답글', expectedAccountId: 'user-1' });
    expect(commentDraftLandedSince(replyBox, 'user-1', before)).toBe(true);
    expect(commentDraftLandedSince(newBox, 'user-1', before)).toBe(false);
    // The account that sent it, not another the tab may show by now (Codex review on PR #220).
    expect(commentDraftLandedSince(replyBox, 'user-2', before)).toBe(false);

    vi.spyOn(api, 'PUT').mockResolvedValueOnce(answer(published(commentId, null, '고친 댓글')));
    const edit = new MutationObserver(
      queryClient,
      updateCommentOptions(queryClient, POST, () => undefined),
    );
    await edit.mutate({ commentId: COMMENT, body: '고친 댓글', expectedAccountId: 'user-1' });
    expect(commentDraftLandedSince(editBox, 'user-1', before)).toBe(true);
    expect(commentDraftLandedSince(editBox, 'user-2', before)).toBe(false);
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

  describe('30 reply pages in all for one read of the pages, the threads at the top first (오너 결정 2026-10-23)', () => {
    // A fake server of 40 대댓글 under each 댓글, two a page (the page's size is the server's; the
    // budget counts requests). Each 댓글 the screen opened to `held` of them.
    const threadIdOf = (index: number) =>
      `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const repliesOf = (index: number) => replyIds(index * 100, index * 100 + 40);
    const threadHolding = (index: number, count: number): CommentThread => ({
      comment: published(threadIdOf(index)),
      replies: repliesOf(index)
        .slice(0, count)
        .map((reply) => published(reply, threadIdOf(index))),
      repliesNextCursor: `r${String(count)}`,
    });
    /** The pages of 댓글 as `layout` says: per page, how many 대댓글 each thread held. */
    const pagesHolding = (layout: number[][]): CommentPages => {
      let index = 0;
      return {
        pages: layout.map((page, at) => ({
          items: page.map((count) => threadHolding((index += 1), count)),
          nextCursor: at < layout.length - 1 ? `c${String(at + 1)}` : null,
        })),
        pageParams: layout.map((_, at) => (at === 0 ? undefined : `c${String(at)}`)),
      };
    };
    /** A reply page of the fake server: two of the 40 대댓글 of the thread asked, from its cursor. */
    const replyPageOf = ({ params }: RepliesRequest): ReplyPage => {
      const all = repliesOf(Number(params.path.commentId.slice(-12)));
      const from = Number(params.query.cursor.slice(1));
      const to = Math.min(from + 2, all.length);
      return {
        items: all.slice(from, to).map((reply) => published(reply, params.path.commentId)),
        nextCursor: to < all.length ? `r${String(to)}` : null,
      };
    };
    /** The server: every page of 댓글 as `layout` lays them out, each thread with its first two. */
    const serving = (layout: number[][]) => {
      const fresh = pagesHolding(layout.map((page) => page.map(() => 2)));
      return getThreads(
        ({ params }) =>
          fresh.pages[
            params.query.cursor === undefined ? 0 : Number(params.query.cursor.slice(1))
          ]!,
        replyPageOf,
      );
    };
    /** Each thread held: its index, how many 대댓글 it holds and its cursor. */
    const threadsHeld = (queryClient: QueryClient) =>
      commentThreadsOf(queryClient.getQueryData(postCommentsKey(post))).map((one) => [
        Number(one.comment.id.slice(-12)),
        one.replies.length,
        one.repliesNextCursor,
      ]);
    /** The reply pages asked, as `<thread index>:<cursor>`, in the order asked. */
    const replyReads = (asked: string[]) =>
      asked
        .filter((one) => one.startsWith('replies:'))
        .map((one) => {
          const [, id, cursor] = one.split(':');
          return `${String(Number(id!.slice(-12)))}:${cursor!}`;
        });
    /** The first `count` reply pages a thread asks for, read on from its first two: `r2`, `r4`, …. */
    const readOn = (index: number, count: number) =>
      Array.from({ length: count }, (_, page) => `${String(index)}:r${String(2 + page * 2)}`);

    it('spends them top first: five a thread while any is left, the thread they run out in keeps what it read, those after it come back to their first page — and every read has its own 30', async () => {
      // Seven 댓글 on one page, the first opened to 8 (three pages to read on), the other six past
      // the five pages a thread reads: 3 + 5 × 5 = 28, so the sixth thread reads two pages, the
      // seventh none.
      const layout = [[8, 14, 14, 14, 14, 14, 14]];
      const queryClient = seeded();
      queryClient.setQueryData<CommentPages>(postCommentsKey(post), pagesHolding(layout));
      const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
      const unsubscribe = comments.subscribe(() => undefined);
      const asked = serving(layout);
      await comments.refetch();
      expect(replyReads(asked)).toEqual([
        ...readOn(1, 3),
        ...readOn(2, 5),
        ...readOn(3, 5),
        ...readOn(4, 5),
        ...readOn(5, 5),
        ...readOn(6, 5),
        ...readOn(7, 2),
      ]);
      expect(replyReads(asked)).toHaveLength(REPLY_READ_ON_PAGES_IN_ALL);
      expect(threadsHeld(queryClient)).toEqual([
        [1, 8, 'r8'],
        [2, 12, 'r12'],
        [3, 12, 'r12'],
        [4, 12, 'r12'],
        [5, 12, 'r12'],
        [6, 12, 'r12'],
        [7, 6, 'r6'],
      ]);
      // The next read has its own 30: the seventh thread, held at 6 now, reads on to it.
      asked.length = 0;
      await comments.refetch();
      expect(replyReads(asked)).toEqual([
        ...readOn(1, 3),
        ...readOn(2, 5),
        ...readOn(3, 5),
        ...readOn(4, 5),
        ...readOn(5, 5),
        ...readOn(6, 5),
        ...readOn(7, 2),
      ]);
      expect(threadsHeld(queryClient).at(-1)).toEqual([7, 6, 'r6']);
      unsubscribe();
    });

    it('spends one budget over every page of 댓글 the read reads again, in their order: the threads of a later page get what those above left', async () => {
      // Two pages of 댓글: four threads past five pages on the first (20), three on the second —
      // two get their five (30), the last comes back to its first page.
      const layout = [
        [14, 14, 14, 14],
        [14, 14, 14],
      ];
      const queryClient = seeded();
      queryClient.setQueryData<CommentPages>(postCommentsKey(post), pagesHolding(layout));
      const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
      const unsubscribe = comments.subscribe(() => undefined);
      const asked = serving(layout);
      await comments.refetch();
      expect(asked.filter((one) => one.startsWith('comments:'))).toEqual([
        'comments:',
        'comments:c1',
      ]);
      expect(replyReads(asked)).toHaveLength(REPLY_READ_ON_PAGES_IN_ALL);
      expect(threadsHeld(queryClient)).toEqual([
        [1, 12, 'r12'],
        [2, 12, 'r12'],
        [3, 12, 'r12'],
        [4, 12, 'r12'],
        [5, 12, 'r12'],
        [6, 12, 'r12'],
        [7, 2, 'r2'],
      ]);
      unsubscribe();
    });

    it('spends one budget over every page a new 댓글’s read reads too, which reads them with no signal: a thread held on the page after the last held one gets what those above left', async () => {
      // The last page held: five threads opened past five pages, one opened to 8 (three pages to
      // read on) and, at its end, the reader's own earlier 댓글 — put there when its page could not
      // be read (`readOnToTheEnd`'s fallback) and opened past five pages since. The server keeps
      // that 댓글 on the page after, with MINE: read again for MINE, the last page held spends
      // 5 × 5 + 3 = 28 and the page after it the two left — the seventh thread keeps the two pages
      // it read, not five.
      const layout = [[14, 14, 14, 14, 14, 8, 14]];
      const queryClient = seeded();
      queryClient.setQueryData<CommentPages>(postCommentsKey(post), pagesHolding(layout));
      const fresh = pagesHolding([[2, 2, 2, 2, 2, 2], [2]]);
      const asked = getThreads(
        ({ params }) =>
          params.query.cursor === undefined
            ? fresh.pages[0]!
            : { items: [...fresh.pages[1]!.items, thread(published(MINE))], nextCursor: null },
        replyPageOf,
      );
      vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE)));
      await new MutationObserver(
        queryClient,
        createCommentOptions(queryClient, POST, () => undefined),
      ).mutate({ parentId: null, body: '댓글', expectedAccountId: 'user-1' });
      expect(asked.filter((one) => one.startsWith('comments:'))).toEqual([
        'comments:',
        'comments:c1',
      ]);
      expect(replyReads(asked)).toEqual([
        ...readOn(1, 5),
        ...readOn(2, 5),
        ...readOn(3, 5),
        ...readOn(4, 5),
        ...readOn(5, 5),
        ...readOn(6, 3),
        ...readOn(7, 2),
      ]);
      expect(replyReads(asked)).toHaveLength(REPLY_READ_ON_PAGES_IN_ALL);
      expect(threadsHeld(queryClient)).toEqual([
        [1, 12, 'r12'],
        [2, 12, 'r12'],
        [3, 12, 'r12'],
        [4, 12, 'r12'],
        [5, 12, 'r12'],
        [6, 8, 'r8'],
        [7, 6, 'r6'],
        [Number(MINE.slice(-12)), 0, null],
      ]);
    });

    it('put the writer’s own 대댓글 placed at the end of a thread back at the end of its first page when the 30 ran out above it, reading nothing more for it (오너 결정 2026-10-24)', async () => {
      // Eight 댓글: the 30 run out in the seventh (3 + 5 × 5 + 2), the eighth comes back to its
      // first two. MINE, answered in the eighth while it held 14, stopped at five unread pages
      // and stands placed at the end of the 14.
      const layout = [[8, 14, 14, 14, 14, 14, 14, 14]];
      const queryClient = onScreen(seeded());
      queryClient.setQueryData<CommentPages>(postCommentsKey(post), pagesHolding(layout));
      const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
      const unsubscribe = comments.subscribe(() => undefined);
      const asked = serving(layout);
      const eighth = threadIdOf(8);
      vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, eighth, '답글')));
      await new MutationObserver(
        queryClient,
        createCommentOptions(queryClient, POST, () => undefined),
      ).mutate({ parentId: eighth, body: '답글', expectedAccountId: 'user-1' });
      expect(replyReads(asked)).toEqual([14, 16, 18, 20, 22].map((from) => `8:r${String(from)}`));
      expect(threadsHeld(queryClient).at(-1)).toEqual([8, 15, 'r14']);
      expect(placedHeld(queryClient)).toEqual([`${eighth}:${MINE}`]);
      asked.length = 0;
      await comments.refetch();
      // The reads of every thread as they would be without it — none for the eighth.
      expect(replyReads(asked)).toEqual([
        ...readOn(1, 3),
        ...readOn(2, 5),
        ...readOn(3, 5),
        ...readOn(4, 5),
        ...readOn(5, 5),
        ...readOn(6, 5),
        ...readOn(7, 2),
      ]);
      const last = commentThreadsOf(queryClient.getQueryData(postCommentsKey(post))).at(-1);
      expect(last?.replies.map((reply) => reply.id)).toEqual([...repliesOf(8).slice(0, 2), MINE]);
      expect(last?.repliesNextCursor).toBe('r2');
      expect(placedHeld(queryClient)).toEqual([`${eighth}:${MINE}`]);
      unsubscribe();
    });
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

  it('a new 대댓글 the read of its thread does not meet before the thread’s end was deleted meanwhile (in another tab): it is not put back (Codex review on PR #220)', async () => {
    // Its author deleted it in another tab while this tab read the thread: the read reaches the
    // thread's end (no cursor after the second page) without it. That is the server's word, not a
    // read that failed — the pages read are kept, and no 대댓글 shows whose edit and deletion could
    // only be answered NOT_FOUND.
    const queryClient = seededThread(replyIds(0, 2), 'r2');
    vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, commentId, '답글')));
    const asked = getThreads(() => ({ items: [], nextCursor: null }), fakeReplies(5));
    await new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, () => undefined),
    ).mutate({ parentId: commentId, body: '답글', expectedAccountId: 'user-1' });
    expect(asked).toEqual([`replies:${commentId}:r2`, `replies:${commentId}:r4`]);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 5), null]);
    // The post is read again for its count, as after every write.
    expect(queryClient.getQueryState(postKey(post))?.isInvalidated).toBe(true);
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

  describe('a new 대댓글 placed at the end of those held, until ‘답글 더 보기’ brings its page (오너 결정 2026-10-24: «대댓글도 같은 규칙»)', () => {
    /** Answers the 댓글 above with MINE, as the account on screen (`user-1`). */
    const answerIt = (queryClient: QueryClient) => {
      vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, commentId, '답글')));
      return new MutationObserver(
        onScreen(queryClient),
        createCommentOptions(queryClient, POST, () => undefined),
      ).mutate({ parentId: commentId, body: '답글', expectedAccountId: 'user-1' });
    };
    /** The client holding the 댓글 above with its first two 대댓글, and an observer of the pages. */
    const holdingTwo = () => {
      const queryClient = seededThread(replyIds(0, 2), 'r2');
      const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
      return { queryClient, comments, unsubscribe: comments.subscribe(() => undefined) };
    };
    /** The comment page: the 댓글 above as the server answers it, its first two and their cursor. */
    const firstPage = () => ({ items: [threadAnswered(replyIds(0, 2), 'r2')], nextCursor: null });
    /** Whether a 수정 box on MINE keeps its place as the threads now read (undefined: it does). */
    const editOnMine = (queryClient: QueryClient) =>
      goneBoxReason(
        { kind: 'comment', commentId: MINE, threadId: commentId },
        {
          postState: 'published',
          threads: commentThreadsOf(queryClient.getQueryData(postCommentsKey(post))),
        },
      );

    it('every read of the pages puts it back at the end of its thread, reading no reply page for it; each ‘답글 더 보기’ short of it leaves it last; the one that brings it puts it in place, before what was answered after it', async () => {
      const { queryClient, comments, unsubscribe } = holdingTwo();
      const asked = getThreads(firstPage, fakeReplies(20, MINE, LATER));
      await answerIt(queryClient);
      expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 2), MINE], 'r2']);
      expect(placedHeld(queryClient)).toEqual([`${commentId}:${MINE}`]);
      asked.length = 0;
      await comments.refetch();
      expect(asked).toEqual(['comments:']);
      expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 2), MINE], 'r2']);
      expect(editOnMine(queryClient)).toBeUndefined();
      await readMoreReplies(queryClient, POST, commentId);
      expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 4), MINE], 'r4']);
      // Read again, the thread is read on as far as the rest of it: one reply page, not two.
      asked.length = 0;
      await comments.refetch();
      expect(asked).toEqual(['comments:', `replies:${commentId}:r2`]);
      expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 4), MINE], 'r4']);
      expect(editOnMine(queryClient)).toBeUndefined();
      // '답글 더 보기' on: MINE last of what is held until its page — r20, with LATER[0] — brings it.
      for (let to = 6; to <= 20; to += 2) {
        await readMoreReplies(queryClient, POST, commentId);
        expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, to), MINE], `r${String(to)}`]);
      }
      await readMoreReplies(queryClient, POST, commentId);
      expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 20), MINE, LATER[0]], 'r22']);
      expect(placedHeld(queryClient)).toEqual([]);
      await readMoreReplies(queryClient, POST, commentId);
      expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 20), MINE, ...LATER], null]);
      unsubscribe();
    });

    it('deleted meanwhile — in another tab — it stays until a read reaches the end of its thread without it: ‘답글 더 보기’, or a read of the pages', async () => {
      const queryClient = onScreen(seededThread(replyIds(0, 2), 'r2'));
      getThreads(firstPage, fakeReplies(20, MINE));
      await answerIt(queryClient);
      getThreads(firstPage, fakeReplies(20));
      for (let to = 4; to < 20; to += 2) {
        await readMoreReplies(queryClient, POST, commentId);
        expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, to), MINE], `r${String(to)}`]);
        expect(editOnMine(queryClient)).toBeUndefined();
      }
      // The thread's last page, MINE on none: the server's word — it goes, and its box with it.
      await readMoreReplies(queryClient, POST, commentId);
      expect(repliesHeld(queryClient)).toEqual([replyIds(0, 20), null]);
      expect(placedHeld(queryClient)).toEqual([]);
      expect(editOnMine(queryClient)).toBe(copy.errCommentGone);

      // Placed after a read that failed: a read of the pages short of its page keeps it last; one
      // that reads the thread to its end without it drops it.
      const { queryClient: failed, comments, unsubscribe } = holdingTwo();
      getThreads(firstPage, () => Promise.reject(new TypeError('Failed to fetch')));
      await answerIt(failed);
      expect(repliesHeld(failed)).toEqual([[...replyIds(0, 2), MINE], 'r2']);
      getThreads(firstPage, fakeReplies(3, MINE));
      await comments.refetch();
      expect(repliesHeld(failed)).toEqual([[...replyIds(0, 2), MINE], 'r2']);
      expect(placedHeld(failed)).toEqual([`${commentId}:${MINE}`]);
      getThreads(
        () => ({ items: [threadAnswered(replyIds(0, 3), null)], nextCursor: null }),
        fakeReplies(3),
      );
      await comments.refetch();
      expect(repliesHeld(failed)).toEqual([replyIds(0, 3), null]);
      expect(placedHeld(failed)).toEqual([]);
      unsubscribe();
    });

    it('a read of the pages whose thread’s first page holds it puts it in place: placed no more', async () => {
      const { queryClient, comments, unsubscribe } = holdingTwo();
      getThreads(firstPage, () => Promise.reject(new TypeError('Failed to fetch')));
      await answerIt(queryClient);
      getThreads(
        () => ({
          items: [threadAnswered([...replyIds(0, 2), MINE, ...LATER.slice(0, 1)], 'r4')],
          nextCursor: null,
        }),
        fakeReplies(2, MINE, LATER),
      );
      await comments.refetch();
      expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 2), MINE, LATER[0]], 'r4']);
      expect(placedHeld(queryClient)).toEqual([]);
      unsubscribe();
    });

    it('for the account on screen only: written as one account and landing on another’s screen, it stands at the end but is placed for none, and the next read of the pages leaves it out', async () => {
      const { queryClient, comments, unsubscribe } = holdingTwo();
      getThreads(firstPage, () => Promise.reject(new TypeError('Failed to fetch')));
      vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, commentId, '답글')));
      // Sent as user-1; the tab changed hands on its way, `GET /me` naming user-2 now.
      await new MutationObserver(
        onScreen(queryClient, 'user-2'),
        createCommentOptions(queryClient, POST, () => undefined),
      ).mutate({ parentId: commentId, body: '답글', expectedAccountId: 'user-1' });
      expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 2), MINE], 'r2']);
      expect(placedHeld(queryClient)).toEqual([]);
      getThreads(firstPage, fakeReplies(20, MINE));
      await comments.refetch();
      expect(repliesHeld(queryClient)).toEqual([replyIds(0, 4), 'r4']);
      unsubscribe();
    });

    it('for the account on screen as it is put in: the tab changing hands during the read of its thread — the cache reset, `GET /me` naming nobody yet — it is placed for none, and the next read of the pages leaves it out (the review of the commit of 오너 결정 2026-10-24)', async () => {
      const { queryClient, comments, unsubscribe } = holdingTwo();
      const replies = fakeReplies(20, MINE);
      let handedOver = false;
      getThreads(firstPage, async (request) => {
        // Sent as user-1, on screen as it was sent; on the first reply page another account
        // signs in: SessionCacheGuard resets the cache, and `GET /me` has not answered yet.
        if (!handedOver) {
          handedOver = true;
          await queryClient.resetQueries();
        }
        return replies(request);
      });
      await answerIt(queryClient);
      expect(handedOver).toBe(true);
      expect(queryClient.getQueryData(ME_QUERY_KEY)).toBeUndefined();
      expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 2), MINE], 'r2']);
      expect(placedHeld(queryClient)).toEqual([]);
      await comments.refetch();
      expect(repliesHeld(queryClient)).toEqual([replyIds(0, 4), 'r4']);
      unsubscribe();
    });
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
  /** Writes MINE as a 댓글 through the hook's options, as the account on screen (`user-1`). */
  const write = (queryClient: QueryClient) => {
    vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE)));
    return new MutationObserver(
      onScreen(queryClient),
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

  it('is not put back when the read reaches the end without it: deleted meanwhile, in another tab', async () => {
    const queryClient = seeded('c2');
    const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
    const unsubscribe = comments.subscribe(() => undefined);
    const asked = getComments(({ params }) =>
      params.query.cursor === undefined
        ? { items: [thread(published(commentId))], nextCursor: 'c2' }
        : { items: [thread(published(OLDER))], nextCursor: null },
    );
    await write(queryClient);
    expect(asked).toEqual([{}, { cursor: 'c2' }]);
    expect(threadIds(queryClient)).toEqual([commentId, OLDER]);
    unsubscribe();
  });

  describe('five comment pages at most toward its place, the last held among them (오너 결정 2026-10-23 (2차))', () => {
    // A fake server of older 댓글 one a page (the page's size is the server's; the cap counts
    // requests): the cursor `c<n>` reads the n-th. The reader holds the first page only.
    const olderIds = (from: number, to: number) =>
      Array.from(
        { length: to - from },
        (_, index) => `20000000-0000-4000-8000-${String(from + index).padStart(12, '0')}`,
      );
    /** `total` older 댓글, MINE after them, and `after` after it (others' 댓글 written meanwhile). */
    const serving = (total: number, after: readonly string[] = []) => {
      const all = [...olderIds(0, total), MINE, ...after];
      return getComments(({ params }) => {
        const from = params.query.cursor === undefined ? 0 : Number(params.query.cursor.slice(1));
        const to = Math.min(from + 1, all.length);
        return {
          items: all.slice(from, to).map((id) => thread(published(id))),
          nextCursor: to < all.length ? `c${String(to)}` : null,
        };
      });
    };
    /**
     * The client holding the first page of the fake server — with `nextCursor`, as it was read —
     * and an observer of the pages.
     */
    const holdingFirst = (nextCursor: string | null = 'c1') => {
      const queryClient = seeded();
      queryClient.setQueryData<CommentPages>(postCommentsKey(post), {
        pages: [{ items: [thread(published(olderIds(0, 1)[0]!))], nextCursor }],
        pageParams: [undefined],
      });
      const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
      return { queryClient, comments, unsubscribe: comments.subscribe(() => undefined) };
    };
    /** The comment pages asked, as their cursors ('' the first). */
    const cursorsAsked = (asked: { cursor?: string }[]) => asked.map((one) => one.cursor ?? '');
    /** How many times the pages held carry MINE, drawn once or not. */
    const mineHeld = (queryClient: QueryClient) =>
      queryClient
        .getQueryData<CommentPages>(postCommentsKey(post))!
        .pages.flatMap((page) => page.items)
        .filter((one) => one.comment.id === MINE).length;

    it('past them goes at the end of the pages held, and 더 보기 brings it into place, drawn once', async () => {
      const { queryClient, comments, unsubscribe } = holdingFirst();
      const asked = serving(8);
      await write(queryClient);
      // The last page held and four after it, MINE on none: as a read that failed — the pages
      // read dropped, MINE at the end of the page held, 더 보기 where it was.
      expect(cursorsAsked(asked)).toEqual(['', 'c1', 'c2', 'c3', 'c4']);
      expect(cursorsAsked(asked)).toHaveLength(COMMENT_READ_ON_PAGES);
      expect(threadIds(queryClient)).toEqual([...olderIds(0, 1), MINE]);
      expect(comments.getCurrentResult().hasNextPage).toBe(true);
      expect(commentCountOf(queryClient)).toBe(2);
      // 더 보기 to the end: MINE's page puts it after every older 댓글, once — no longer at the end
      // of the first page too (오너 결정 2026-10-24: placed until its page is read).
      asked.length = 0;
      while (comments.getCurrentResult().hasNextPage) await comments.fetchNextPage();
      expect(cursorsAsked(asked)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']);
      expect(mineHeld(queryClient)).toBe(1);
      expect(threadIds(queryClient)).toEqual([...olderIds(0, 8), MINE]);
      expect(placedHeld(queryClient)).toEqual([]);
      unsubscribe();
    });

    it('past them keeps the last page held as read again: held as the end of the list, it leaves 더 보기 there', async () => {
      // The reader had the whole list open (the page held says nothing is after it), and others
      // wrote eight 댓글 meanwhile, MINE after them: past the five pages, MINE goes at the end of
      // that page as read again, whose cursor leaves 더 보기 there to bring it into place.
      const { queryClient, comments, unsubscribe } = holdingFirst(null);
      expect(comments.getCurrentResult().hasNextPage).toBe(false);
      const asked = serving(8);
      await write(queryClient);
      expect(cursorsAsked(asked)).toEqual(['', 'c1', 'c2', 'c3', 'c4']);
      expect(threadIds(queryClient)).toEqual([...olderIds(0, 1), MINE]);
      expect(comments.getCurrentResult().hasNextPage).toBe(true);
      // Until 더 보기 brings it, a read of as many pages as are held puts it back at their end
      // (오너 결정 2026-10-24).
      await comments.refetch();
      expect(threadIds(queryClient)).toEqual([...olderIds(0, 1), MINE]);
      expect(comments.getCurrentResult().hasNextPage).toBe(true);
      while (comments.getCurrentResult().hasNextPage) await comments.fetchNextPage();
      expect(threadIds(queryClient)).toEqual([...olderIds(0, 8), MINE]);
      unsubscribe();

      // So too a read that fails on the way, once the last page held came back read again.
      const failed = holdingFirst(null);
      const all = [...olderIds(0, 8), MINE];
      getComments(({ params }) => {
        if (params.query.cursor === 'c2') throw new TypeError('Failed to fetch');
        const from = params.query.cursor === undefined ? 0 : Number(params.query.cursor.slice(1));
        return { items: [thread(published(all[from]!))], nextCursor: `c${String(from + 1)}` };
      });
      await write(failed.queryClient);
      expect(threadIds(failed.queryClient)).toEqual([...olderIds(0, 1), MINE]);
      expect(failed.comments.getCurrentResult().hasNextPage).toBe(true);
      failed.unsubscribe();
    });

    it('stops at the page that holds it — on the fifth too, though others wrote after it — and keeps the pages read', async () => {
      const LATER_ROOTS = olderIds(100, 102);
      const fifth = holdingFirst();
      const asked = serving(4, LATER_ROOTS);
      await write(fifth.queryClient);
      // MINE is on the fifth page read (the last held and four after it), with a page after it:
      // within the five, so in its place; the 댓글 written after it stay behind 더 보기.
      expect(cursorsAsked(asked)).toEqual(['', 'c1', 'c2', 'c3', 'c4']);
      expect(threadIds(fifth.queryClient)).toEqual([...olderIds(0, 4), MINE]);
      expect(fifth.comments.getCurrentResult().hasNextPage).toBe(true);
      await fifth.comments.fetchNextPage();
      await fifth.comments.fetchNextPage();
      expect(threadIds(fifth.queryClient)).toEqual([...olderIds(0, 4), MINE, ...LATER_ROOTS]);
      expect(fifth.comments.getCurrentResult().hasNextPage).toBe(false);
      fifth.unsubscribe();

      // Reached on the second page: no third is asked for, though others wrote after it.
      const second = holdingFirst();
      const askedAgain = serving(1, LATER_ROOTS);
      await write(second.queryClient);
      expect(cursorsAsked(askedAgain)).toEqual(['', 'c1']);
      expect(threadIds(second.queryClient)).toEqual([...olderIds(0, 1), MINE]);
      expect(second.comments.getCurrentResult().hasNextPage).toBe(true);
      second.unsubscribe();
    });

    it('a read that fails on the way asks for no page after: MINE goes at the end of the pages held', async () => {
      const { queryClient, unsubscribe } = holdingFirst();
      const all = [...olderIds(0, 8), MINE];
      const asked = getComments(({ params }) => {
        if (params.query.cursor === 'c2') throw new TypeError('Failed to fetch');
        const from = params.query.cursor === undefined ? 0 : Number(params.query.cursor.slice(1));
        return {
          items: [thread(published(all[from]!))],
          nextCursor: `c${String(from + 1)}`,
        };
      });
      await write(queryClient);
      expect(cursorsAsked(asked)).toEqual(['', 'c1', 'c2']);
      expect(threadIds(queryClient)).toEqual([...olderIds(0, 1), MINE]);
      expect(commentCountOf(queryClient)).toBe(2);
      unsubscribe();
    });

    describe('placed at the end of the pages held until 더 보기 brings its page (오너 결정 2026-10-24)', () => {
      // «제자리가 읽힐 때까지 끝에 남김: 다시 읽을 때마다 그 댓글을 열린 목록의 끝에 다시 넣고 그 위의
      // 상자도 남김(요청은 늘지 않음). 다른 탭에서 지웠다면 '더 보기'로 끝까지 읽을 때 사라짐»
      const LATER_ROOTS = olderIds(100, 102);
      /**
       * A fake server of the 댓글 `list()` names — asked each time, so a test deletes from it —
       * `size` a page: the cursor `c<n>` reads from the n-th.
       */
      const servingList = (list: () => readonly string[], size = 1) =>
        getComments(({ params }) => {
          const all = list();
          const from = params.query.cursor === undefined ? 0 : Number(params.query.cursor.slice(1));
          const to = Math.min(from + size, all.length);
          return {
            items: all.slice(from, to).map((id) => thread(published(id))),
            nextCursor: to < all.length ? `c${String(to)}` : null,
          };
        });
      /** Where a box on MINE stands as the threads now read: its place, or why it is gone. */
      const boxesOnMine = (queryClient: QueryClient) => {
        const view = {
          postState: 'published' as const,
          threads: commentThreadsOf(queryClient.getQueryData(postCommentsKey(post))),
        };
        return [
          goneBoxReason({ kind: 'thread', threadId: MINE }, view),
          goneBoxReason({ kind: 'comment', commentId: MINE, threadId: MINE }, view),
        ];
      };

      it('every read of the pages puts it back at their end, asking for nothing more, and a 답글 or 수정 box on it stays', async () => {
        const { queryClient, comments, unsubscribe } = holdingFirst();
        const asked = serving(8, LATER_ROOTS);
        await write(queryClient);
        expect(threadIds(queryClient)).toEqual([...olderIds(0, 1), MINE]);
        expect(placedHeld(queryClient)).toEqual([`-:${MINE}`]);
        for (let reads = 0; reads < 3; reads += 1) {
          asked.length = 0;
          await comments.refetch();
          // The one page held, read again: nothing is read for MINE.
          expect(cursorsAsked(asked)).toEqual(['']);
          expect(threadIds(queryClient)).toEqual([...olderIds(0, 1), MINE]);
          expect(mineHeld(queryClient)).toBe(1);
          expect(comments.getCurrentResult().hasNextPage).toBe(true);
        }
        // Its boxes keep their place: neither goes as from a 댓글 deleted.
        expect(boxesOnMine(queryClient)).toEqual([undefined, undefined]);
        // A stale thread's read again (`readThreadsAgain`) is one more read of the pages.
        vi.spyOn(api, 'PUT').mockRejectedValue(
          new ApiError(404, { code: 'NOT_FOUND', message: 'x' } as never),
        );
        await expect(
          new MutationObserver(
            queryClient,
            updateCommentOptions(queryClient, POST, () => undefined),
          ).mutate({ commentId: OLDER, body: '고친 댓글', expectedAccountId: 'user-1' }),
        ).rejects.toBeInstanceOf(ApiError);
        await vi.waitFor(() => expect(comments.getCurrentResult().isFetching).toBe(false));
        expect(threadIds(queryClient)).toEqual([...olderIds(0, 1), MINE]);
        unsubscribe();
      });

      it('stays at the end through each 더 보기 that does not bring it; the one that does puts it in its place, before the 댓글 written after it, drawn and held once and placed no more', async () => {
        const { queryClient, comments, unsubscribe } = holdingFirst();
        const asked = serving(8, LATER_ROOTS);
        await write(queryClient);
        asked.length = 0;
        for (let page = 1; page < 8; page += 1) {
          await comments.fetchNextPage();
          expect(threadIds(queryClient)).toEqual([...olderIds(0, page + 1), MINE]);
          expect(mineHeld(queryClient)).toBe(1);
        }
        // c8 holds MINE: in its place now, the 댓글 written after it behind 더 보기.
        await comments.fetchNextPage();
        expect(threadIds(queryClient)).toEqual([...olderIds(0, 8), MINE]);
        expect(placedHeld(queryClient)).toEqual([]);
        while (comments.getCurrentResult().hasNextPage) await comments.fetchNextPage();
        expect(threadIds(queryClient)).toEqual([...olderIds(0, 8), MINE, ...LATER_ROOTS]);
        expect(mineHeld(queryClient)).toBe(1);
        // One request a page, as 더 보기 always asks.
        expect(cursorsAsked(asked)).toEqual(
          Array.from({ length: 10 }, (_, index) => `c${String(index + 1)}`),
        );
        // Read again, the pages hold it in its place: nothing puts it anywhere else.
        await comments.refetch();
        expect(threadIds(queryClient)).toEqual([...olderIds(0, 8), MINE, ...LATER_ROOTS]);
        expect(mineHeld(queryClient)).toBe(1);
        unsubscribe();
      });

      it('deleted meanwhile — in another tab — it stays until 더 보기 reads to the end of the list without it, then goes', async () => {
        const all = [...olderIds(0, 8), MINE];
        const { queryClient, comments, unsubscribe } = holdingFirst();
        servingList(() => all);
        await write(queryClient);
        all.pop();
        // Not the end of the list: the reads say nothing of MINE yet, and it stays.
        await comments.refetch();
        expect(threadIds(queryClient)).toEqual([...olderIds(0, 1), MINE]);
        for (let page = 1; page < 7; page += 1) {
          await comments.fetchNextPage();
          expect(threadIds(queryClient)).toEqual([...olderIds(0, page + 1), MINE]);
          expect(boxesOnMine(queryClient)).toEqual([undefined, undefined]);
        }
        // The last page, MINE on none: the server's word — it goes, and a box on it with it.
        await comments.fetchNextPage();
        expect(comments.getCurrentResult().hasNextPage).toBe(false);
        expect(threadIds(queryClient)).toEqual(olderIds(0, 8));
        expect(placedHeld(queryClient)).toEqual([]);
        expect(boxesOnMine(queryClient)).toEqual([copy.errCommentParentGone, copy.errCommentGone]);
        unsubscribe();
      });

      it('placed after a read that failed too: a read of the pages that ends the list without it drops it, one that reaches its page puts it in place', async () => {
        // The reader held the whole list, one page; MINE's read failed, so MINE stands at its end.
        const ended = holdingFirst(null);
        vi.spyOn(api, 'GET').mockRejectedValue(new TypeError('Failed to fetch'));
        await write(ended.queryClient);
        expect(threadIds(ended.queryClient)).toEqual([...olderIds(0, 1), MINE]);
        expect(placedHeld(ended.queryClient)).toEqual([`-:${MINE}`]);
        // Read again, the page held does not reach it (it is on the next): back at the end.
        const all = [...olderIds(0, 1), MINE];
        servingList(() => all);
        await ended.comments.refetch();
        expect(threadIds(ended.queryClient)).toEqual([...olderIds(0, 1), MINE]);
        expect(ended.comments.getCurrentResult().hasNextPage).toBe(true);
        // Deleted elsewhere since: the page read again ends the list without it.
        all.pop();
        await ended.comments.refetch();
        expect(threadIds(ended.queryClient)).toEqual(olderIds(0, 1));
        expect(placedHeld(ended.queryClient)).toEqual([]);
        ended.unsubscribe();

        // Not deleted: the page read again holds it — in its place, placed no more.
        const reached = holdingFirst(null);
        vi.spyOn(api, 'GET').mockRejectedValue(new TypeError('Failed to fetch'));
        await write(reached.queryClient);
        servingList(() => [...olderIds(0, 1), MINE, ...LATER_ROOTS], 20);
        await reached.comments.refetch();
        expect(threadIds(reached.queryClient)).toEqual([...olderIds(0, 1), MINE, ...LATER_ROOTS]);
        expect(placedHeld(reached.queryClient)).toEqual([]);
        reached.unsubscribe();
      });

      it('a later 댓글’s read that reaches it puts it in its place, placed no more, at the like count held — the pages that read takes at the counts held are still the read’s (#49, ADR-0076 7-27)', async () => {
        const NEXT = LATER_ROOTS[0]!;
        /** The pages held after NEXT is written, as the account on screen. */
        const writeNext = async (queryClient: QueryClient) => {
          vi.spyOn(api, 'POST').mockResolvedValue(answer(published(NEXT)));
          await new MutationObserver(
            onScreen(queryClient),
            createCommentOptions(queryClient, POST, () => undefined),
          ).mutate({ parentId: null, body: '댓글', expectedAccountId: 'user-1' });
        };
        const likesOf = (queryClient: QueryClient) =>
          commentThreadsOf(queryClient.getQueryData(postCommentsKey(post))).map(({ comment }) =>
            comment.state === 'published' ? comment.likeCount : null,
          );
        // MINE past the five pages: placed at the end; a like on it pressed meanwhile (the
        // toggle's count, held), and five of the older 댓글 deleted in another tab since.
        const all = [...olderIds(0, 8), MINE];
        const reached = holdingFirst();
        servingList(() => all);
        await write(reached.queryClient);
        expect(placedHeld(reached.queryClient)).toEqual([`-:${MINE}`]);
        reached.queryClient.setQueryData<CommentPages>(postCommentsKey(post), (pages) =>
          withCommentLikeCount(pages, MINE, 1),
        );
        all.splice(3, 5);
        all.push(NEXT);
        // NEXT's read reaches MINE's page and then NEXT's, within the five: both in their place,
        // MINE at the count held and no longer placed — not taken off its page to the end again.
        await writeNext(reached.queryClient);
        expect(threadIds(reached.queryClient)).toEqual([...olderIds(0, 3), MINE, NEXT]);
        expect(likesOf(reached.queryClient)).toEqual([0, 0, 0, 1, 0]);
        expect(placedHeld(reached.queryClient)).toEqual([]);
        await reached.comments.refetch();
        expect(threadIds(reached.queryClient)).toEqual([...olderIds(0, 3), MINE, NEXT]);
        reached.unsubscribe();

        // NEXT's read failing after the last page held read again, which holds MINE now: that
        // page in place of the held one, MINE in its place on it — placed no more — and NEXT
        // placed at the end of it.
        const failed = holdingFirst();
        servingList(() => [...olderIds(0, 8), MINE]);
        await write(failed.queryClient);
        getComments(({ params }) => {
          if (params.query.cursor !== undefined) throw new TypeError('Failed to fetch');
          return {
            items: [thread(published(olderIds(0, 1)[0]!)), thread(published(MINE))],
            nextCursor: 'c2',
          };
        });
        await writeNext(failed.queryClient);
        expect(threadIds(failed.queryClient)).toEqual([...olderIds(0, 1), MINE, NEXT]);
        expect(placedHeld(failed.queryClient)).toEqual([`-:${NEXT}`]);
        failed.unsubscribe();
      });

      it('comes back with what was written under it and its edit — as a placeholder once deleted with a 답글 under it — and not once nothing of it is left', async () => {
        const { queryClient, comments, unsubscribe } = holdingFirst();
        serving(8);
        await write(queryClient);
        // A 답글 under it: its thread has nothing unread, so the 답글 is in its place.
        const REPLY = LATER[0]!;
        vi.spyOn(api, 'POST').mockResolvedValue(answer(published(REPLY, MINE, '답글')));
        await new MutationObserver(
          queryClient,
          createCommentOptions(queryClient, POST, () => undefined),
        ).mutate({ parentId: MINE, body: '답글', expectedAccountId: 'user-1' });
        vi.spyOn(api, 'PUT').mockResolvedValue(
          answer({ ...published(MINE, null, '고친 댓글'), editedAt: '2026-10-24T00:00:00.000Z' }),
        );
        await new MutationObserver(
          queryClient,
          updateCommentOptions(queryClient, POST, () => undefined),
        ).mutate({ commentId: MINE, body: '고친 댓글', expectedAccountId: 'user-1' });
        expect(placedHeld(queryClient)).toEqual([`-:${MINE}`]);
        await comments.refetch();
        const mine = () => commentThreadsOf(queryClient.getQueryData(postCommentsKey(post))).at(-1);
        expect(mine()?.comment).toMatchObject({ id: MINE, body: '고친 댓글' });
        expect(mine()?.replies.map((reply) => reply.id)).toEqual([REPLY]);
        // Deleted by its writer, its 답글 under it: '삭제된 글입니다', still at the end.
        const remove = (commentId: string, placeholder: boolean) => {
          vi.spyOn(api, 'POST').mockResolvedValue(answer({ id: commentId, placeholder }));
          return new MutationObserver(
            queryClient,
            deleteCommentOptions(queryClient, POST, () => undefined),
          ).mutate({ commentId, expectedAccountId: 'user-1' });
        };
        await remove(MINE, true);
        await comments.refetch();
        expect(mine()?.comment).toEqual({ state: 'deleted', id: MINE });
        expect(mine()?.replies.map((reply) => reply.id)).toEqual([REPLY]);
        // Its 답글 deleted too, nothing of it is left: no read brings it back.
        await remove(REPLY, false);
        expect(threadIds(queryClient)).toEqual(olderIds(0, 1));
        expect(placedHeld(queryClient)).toEqual([]);
        await comments.refetch();
        expect(threadIds(queryClient)).toEqual(olderIds(0, 1));
        unsubscribe();
      });

      describe('hidden by an operator meanwhile (#50, ADR-0081 7-28·결과 5)', () => {
        /**
         * A fake server of the 댓글 `list()` names, one a page, answering each by `answers` — the
         * thread as an operator's hiding or the writer's deletion left it — or as published.
         */
        const servingAnswers = (
          list: () => readonly string[],
          answers: ReadonlyMap<string, CommentThread>,
        ) =>
          getComments(({ params }) => {
            const all = list();
            const from =
              params.query.cursor === undefined ? 0 : Number(params.query.cursor.slice(1));
            const to = Math.min(from + 1, all.length);
            return {
              items: all.slice(from, to).map((id) => answers.get(id) ?? thread(published(id))),
              nextCursor: to < all.length ? `c${String(to)}` : null,
            };
          });
        const hiddenThread = (replies: PublishedComment[] = []): CommentThread => ({
          comment: { state: 'hidden', id: MINE },
          replies,
          repliesNextCursor: null,
        });
        /** The state of MINE wherever the pages hold it, in the order held. */
        const mineStates = (queryClient: QueryClient) =>
          queryClient
            .getQueryData<CommentPages>(postCommentsKey(post))!
            .pages.flatMap((page) => page.items)
            .filter((one) => one.comment.id === MINE)
            .map((one) => one.comment.state);
        /** MY's 삭제 on MINE (`deleteMyItemOptions`, use-authored.ts), answered `placeholder`. */
        const deleteFromMy = (queryClient: QueryClient, placeholder: boolean) => {
          vi.spyOn(api, 'POST').mockResolvedValue(answer({ id: MINE, placeholder }));
          return new MutationObserver(
            queryClient,
            deleteMyItemOptions(queryClient, () => undefined),
          ).mutate({ tab: 'comments', id: MINE, postId: post, expectedAccountId: 'user-1' });
        };

        it('a read that does not bring its page puts the copy held back, as for any placed; the 더 보기 that brings it shows it hidden in its place, placed no more, and no read after puts the published copy back', async () => {
          const answers = new Map<string, CommentThread>();
          const { queryClient, comments, unsubscribe } = holdingFirst();
          servingAnswers(() => [...olderIds(0, 8), MINE], answers);
          await write(queryClient);
          expect(placedHeld(queryClient)).toEqual([`-:${MINE}`]);
          answers.set(MINE, hiddenThread());
          // The reads say nothing of MINE yet: the copy held stays at the end (오너 결정 2026-10-24
          // — until its page is read), as it was written.
          await comments.refetch();
          expect(threadIds(queryClient)).toEqual([...olderIds(0, 1), MINE]);
          expect(mineStates(queryClient)).toEqual(['published']);
          for (let page = 1; page < 8; page += 1) await comments.fetchNextPage();
          expect(mineStates(queryClient)).toEqual(['published']);
          // c8 holds MINE, hidden: its placeholder in its place, drawn once, placed no more.
          await comments.fetchNextPage();
          expect(comments.getCurrentResult().hasNextPage).toBe(false);
          expect(threadIds(queryClient)).toEqual([...olderIds(0, 8), MINE]);
          expect(mineStates(queryClient)).toEqual(['hidden']);
          expect(placedHeld(queryClient)).toEqual([]);
          // Every read after reads it hidden where it is: nothing puts the copy held back.
          for (let reads = 0; reads < 2; reads += 1) {
            await comments.refetch();
            expect(threadIds(queryClient)).toEqual([...olderIds(0, 8), MINE]);
            expect(mineStates(queryClient)).toEqual(['hidden']);
          }
          unsubscribe();
        });

        it('a read of the pages that reaches its page — the 댓글 before it deleted — shows it hidden in its place, placed no more, and the next read too', async () => {
          const all = [...olderIds(0, 8), MINE];
          const answers = new Map<string, CommentThread>();
          const { queryClient, comments, unsubscribe } = holdingFirst();
          servingAnswers(() => all, answers);
          await write(queryClient);
          answers.set(MINE, hiddenThread());
          all.splice(0, 8);
          await comments.refetch();
          expect(threadIds(queryClient)).toEqual([MINE]);
          expect(mineStates(queryClient)).toEqual(['hidden']);
          expect(placedHeld(queryClient)).toEqual([]);
          await comments.refetch();
          expect(mineStates(queryClient)).toEqual(['hidden']);
          unsubscribe();
        });

        it('deleted from MY in this tab: out of the pages and of what is placed at once, and no read puts the copy held back', async () => {
          const all = [...olderIds(0, 8), MINE];
          const answers = new Map<string, CommentThread>();
          const { queryClient, comments, unsubscribe } = holdingFirst();
          servingAnswers(() => all, answers);
          await write(queryClient);
          answers.set(MINE, hiddenThread());
          // MY's 삭제 (nothing under it: out of every view), then MY's reads of what it touched —
          // the pages on screen read again among them.
          all.pop();
          await deleteFromMy(queryClient, false);
          expect(threadIds(queryClient)).toEqual(olderIds(0, 1));
          expect(placedHeld(queryClient)).toEqual([]);
          for (let reads = 0; reads < 2; reads += 1) {
            await comments.refetch();
            expect(threadIds(queryClient)).toEqual(olderIds(0, 1));
          }
          while (comments.getCurrentResult().hasNextPage) await comments.fetchNextPage();
          expect(threadIds(queryClient)).toEqual(olderIds(0, 8));
          unsubscribe();
        });

        it('deleted from MY with a 답글 under it: its placeholder ‘삭제된 글입니다’ with the 답글, as the post page’s own 삭제 leaves it — never the copy held — until 더 보기 brings it into place', async () => {
          const answers = new Map<string, CommentThread>();
          const { queryClient, comments, unsubscribe } = holdingFirst();
          servingAnswers(() => [...olderIds(0, 8), MINE], answers);
          await write(queryClient);
          // A 답글 under it: its thread has nothing unread, so the 답글 is in its place.
          const REPLY = LATER[0]!;
          vi.spyOn(api, 'POST').mockResolvedValue(answer(published(REPLY, MINE, '답글')));
          await new MutationObserver(
            queryClient,
            createCommentOptions(queryClient, POST, () => undefined),
          ).mutate({ parentId: MINE, body: '답글', expectedAccountId: 'user-1' });
          answers.set(MINE, hiddenThread([published(REPLY, MINE, '답글')]));
          await comments.refetch();
          expect(mineStates(queryClient)).toEqual(['published']);
          // MY's 삭제: '삭제된 글입니다' with the 답글 under it, on the server as in the pages held.
          answers.set(MINE, {
            comment: { state: 'deleted', id: MINE },
            replies: [published(REPLY, MINE, '답글')],
            repliesNextCursor: null,
          });
          await deleteFromMy(queryClient, true);
          const mine = () =>
            commentThreadsOf(queryClient.getQueryData(postCommentsKey(post))).at(-1);
          for (let reads = 0; reads < 2; reads += 1) {
            expect(mineStates(queryClient)).toEqual(['deleted']);
            expect(mine()?.replies.map((reply) => reply.id)).toEqual([REPLY]);
            await comments.refetch();
          }
          while (comments.getCurrentResult().hasNextPage) await comments.fetchNextPage();
          expect(threadIds(queryClient)).toEqual([...olderIds(0, 8), MINE]);
          expect(mineStates(queryClient)).toEqual(['deleted']);
          expect(placedHeld(queryClient)).toEqual([]);
          unsubscribe();
        });
      });

      it('for the account on screen only: written as one account and landing on another’s screen, it is placed for none — and a reset of the cache as the session changes drops what was placed', async () => {
        // Sent as user-1; the tab changed hands on its way, `GET /me` naming user-2 now.
        const other = holdingFirst();
        serving(8);
        vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE)));
        await new MutationObserver(
          onScreen(other.queryClient, 'user-2'),
          createCommentOptions(other.queryClient, POST, () => undefined),
        ).mutate({ parentId: null, body: '댓글', expectedAccountId: 'user-1' });
        expect(threadIds(other.queryClient)).toEqual([...olderIds(0, 1), MINE]);
        expect(placedHeld(other.queryClient)).toEqual([]);
        await other.comments.refetch();
        expect(threadIds(other.queryClient)).toEqual(olderIds(0, 1));
        other.unsubscribe();

        // Placed for user-1, then another account signs in: SessionCacheGuard resets the cache.
        const { queryClient, comments, unsubscribe } = holdingFirst();
        serving(8);
        await write(queryClient);
        expect(placedHeld(queryClient)).toEqual([`-:${MINE}`]);
        await queryClient.resetQueries();
        expect(comments.getCurrentResult().isFetching).toBe(false);
        expect(threadIds(queryClient)).toEqual(olderIds(0, 1));
        expect(placedHeld(queryClient)).toEqual([]);
        await comments.refetch();
        expect(threadIds(queryClient)).toEqual(olderIds(0, 1));
        unsubscribe();
      });

      it('for the account on screen as it is put in: the tab changing hands during the read toward its page — the cache reset, `GET /me` naming another — it is placed for none, and the next read of the pages leaves it out (the review of the commit of 오너 결정 2026-10-24)', async () => {
        const { queryClient, comments, unsubscribe } = holdingFirst();
        const all = [...olderIds(0, 8), MINE];
        let handedOver = false;
        const asked = getComments(async ({ params }) => {
          // Sent as user-1, on screen as it was sent; on the read's first page user-2 signs in:
          // SessionCacheGuard resets the cache (the page on screen read again), `GET /me` names
          // user-2.
          if (!handedOver) {
            handedOver = true;
            await queryClient.resetQueries();
            onScreen(queryClient, 'user-2');
          }
          const from = params.query.cursor === undefined ? 0 : Number(params.query.cursor.slice(1));
          return { items: [thread(published(all[from]!))], nextCursor: `c${String(from + 1)}` };
        });
        await write(queryClient);
        // The read's five, and the page on screen read again by the reset among them.
        expect(cursorsAsked(asked)).toEqual(['', '', 'c1', 'c2', 'c3', 'c4']);
        expect(threadIds(queryClient)).toEqual([...olderIds(0, 1), MINE]);
        expect(placedHeld(queryClient)).toEqual([]);
        await comments.refetch();
        expect(threadIds(queryClient)).toEqual(olderIds(0, 1));
        expect(placedHeld(queryClient)).toEqual([]);
        unsubscribe();
      });

      it('nothing for a write a writing restriction refused (RESTRICTED, #185): a 댓글 and a 대댓글 under the placed one leave the pages, what is placed and the count as they were, read nothing and land no draft; the member’s restriction is read again (ADR-0082)', async () => {
        const { queryClient, comments, unsubscribe } = holdingFirst();
        const asked = serving(8, LATER_ROOTS);
        await write(queryClient);
        expect(placedHeld(queryClient)).toEqual([`-:${MINE}`]);
        const pages = queryClient.getQueryData<CommentPages>(postCommentsKey(post));
        const count = commentCountOf(queryClient);
        queryClient.setQueryData(MY_RESTRICTION_KEY, { restriction: null });
        queryClient.setQueryData(MY_ACTIONS_KEY, { pages: [], pageParams: [] });
        asked.length = 0;
        const before = commentDraftMoment();
        vi.spyOn(api, 'POST').mockRejectedValue(
          new ApiError(403, {
            code: 'RESTRICTED',
            message: 'x',
            details: { kind: 'writing', endsAt: '2026-10-31T00:00:00.000Z' },
          } as never),
        );
        const send = new MutationObserver(
          queryClient,
          createCommentOptions(queryClient, POST, () => undefined),
        );
        for (const parentId of [null, MINE]) {
          await expect(
            send.mutate({ parentId, body: '쓰던 댓글', expectedAccountId: 'user-1' }),
          ).rejects.toMatchObject({ code: 'RESTRICTED' });
        }
        expect(queryClient.getQueryData(postCommentsKey(post))).toBe(pages);
        expect(placedHeld(queryClient)).toEqual([`-:${MINE}`]);
        expect(commentCountOf(queryClient)).toBe(count);
        expect(cursorsAsked(asked)).toEqual([]);
        expect(commentDraftLandedSince({ kind: 'comment', postId: post }, 'user-1', before)).toBe(
          false,
        );
        expect(
          commentDraftLandedSince(
            { kind: 'reply', postId: post, parentId: MINE },
            'user-1',
            before,
          ),
        ).toBe(false);
        expect(queryClient.getQueryState(MY_RESTRICTION_KEY)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(MY_ACTIONS_KEY)?.isInvalidated).toBe(true);
        // The next read of the pages puts back MINE alone, as before the refusals.
        await comments.refetch();
        expect(threadIds(queryClient)).toEqual([...olderIds(0, 1), MINE]);
        expect(placedHeld(queryClient)).toEqual([`-:${MINE}`]);
        expect(mineHeld(queryClient)).toBe(1);
        unsubscribe();
      });
    });
  });
});

describe('a read of the pages on its way when an answer lands', () => {
  /** A 댓글 another reader wrote meanwhile, which only a read of the pages brings. */
  const NEWER = '9d8c7b6a-5f4e-4d3c-8b2a-190807060504';

  /**
   * Each write: what it sends, what its answer leaves in the pages held, and the threads the
   * server holds after it — what a read of the pages that leaves after it answers, with NEWER.
   */
  const writes: [
    string,
    (queryClient: QueryClient) => Promise<unknown>,
    (pages: CommentPages | undefined) => void,
    CommentThread[],
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
      [],
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
      [thread(published(commentId, null, '고친 댓글'))],
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
      [{ ...thread(published(commentId)), replies: [published(MINE, commentId, '답글')] }],
    ],
  ];

  for (const [name, writeOf, written] of writes) {
    it(`as a 더 보기 is cancelled first, so it cannot undo ${name}, and is not made again; another post's read lands`, async () => {
      const queryClient = seeded('c2');
      queryClient.setQueryData(postCommentsKey(OTHER_POST), held('o2'));
      const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
      const others = new InfiniteQueryObserver(
        queryClient,
        commentsInfiniteQueryOptions(OTHER_POST),
      );
      const unsubscribe = [comments.subscribe(() => undefined), others.subscribe(() => undefined)];
      const read = onItsWay();
      const asked = getComments(async () => {
        await read.arrived;
        return { items: [thread(published(OLDER))], nextCursor: null };
      });
      // 더 보기 on both posts, left before the write was answered: each holds the pages as they were.
      const more = [comments.fetchNextPage(), others.fetchNextPage()];
      await writeOf(queryClient);
      read.arrive();
      await Promise.all(more);
      written(queryClient.getQueryData(postCommentsKey(post)));
      // The cancelled 더 보기 is there to press again, and is not made again (ADR-0076 7-28).
      expect(comments.getCurrentResult().hasNextPage).toBe(true);
      expect(asked).toHaveLength(2);
      expect(queryClient.getQueryState(postCommentsKey(post))?.fetchStatus).toBe('idle');
      // Only this post's pages: the other post's read is its own, and lands.
      expect(threadIds(queryClient, OTHER_POST)).toEqual([commentId, OLDER]);
      for (const stop of unsubscribe) stop();
    });
  }

  for (const [name, writeOf, written, afterWrite] of writes) {
    it(`of every page held is cancelled first and made again after ${name}, which it then reads (ADR-0076 7-28)`, async () => {
      const queryClient = seeded();
      const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
      const unsubscribe = comments.subscribe(() => undefined);
      const before = onItsWay();
      const after = onItsWay();
      const signals: (AbortSignal | undefined)[] = [];
      vi.spyOn(api, 'GET').mockImplementation(
        async (_path: string, request: { signal?: AbortSignal }) => {
          signals.push(request.signal);
          // The first read left before the write committed; the one after it reads it, and NEWER.
          if (signals.length === 1) {
            await before.arrived;
            return answer([thread(published(commentId))], { nextCursor: null });
          }
          await after.arrived;
          return answer([...afterWrite, thread(published(NEWER))], { nextCursor: null });
        },
      );
      // A read of every page held (a focus, 30 seconds, a like's failure), left before the answer.
      const focus = comments.refetch();
      await vi.waitFor(() => {
        expect(signals).toHaveLength(1);
      });
      // Done once its answer is in: the write does not wait for the read made again.
      await writeOf(queryClient);
      written(queryClient.getQueryData(postCommentsKey(post)));
      expect(signals).toHaveLength(2);
      expect(signals[0]?.aborted).toBe(true);
      expect(queryClient.getQueryState(postCommentsKey(post))?.fetchStatus).toBe('fetching');
      // The read cancelled answers late: it does not land.
      before.arrive();
      await focus;
      written(queryClient.getQueryData(postCommentsKey(post)));
      // The read made again lands with the write, and with what only a read brings.
      after.arrive();
      await vi.waitFor(() => {
        expect(queryClient.getQueryState(postCommentsKey(post))?.fetchStatus).toBe('idle');
      });
      expect(commentThreadsOf(queryClient.getQueryData(postCommentsKey(post)))).toEqual([
        ...afterWrite,
        thread(published(NEWER)),
      ]);
      unsubscribe();
    });
  }
});

describe('writes that land while a read toward a place reads (Codex review on PR #220, round 4 — ADR-0074 7-34)', () => {
  // A new 댓글's read of its page, a new 대댓글's read of its thread and '답글 더 보기' read pages
  // themselves, not through the query, so no write cancels them: what they read can be older than
  // a write that lands meanwhile, and is put in with every such write done again over it.
  /** A second 댓글 on the first page, which the reader deletes. */
  const SECOND = 'e0d1c2b3-a4f5-4e6d-8c7b-6a5f4e3d2c1b';
  /** The writer's own 대댓글 placed at the end of the thread above (오너 결정 2026-10-24). */
  const PLACED = LATER[0]!;
  const EDITED_AT = '2026-10-24T00:00:00.000Z';

  /** The reader's edit of `id` — a 댓글, or a 대댓글 under the one above — answered as edited now. */
  const edit = (queryClient: QueryClient, id: string, body: string, parentId: string | null) => {
    vi.spyOn(api, 'PUT').mockResolvedValue(
      answer({ ...published(id, parentId, body), editedAt: EDITED_AT }),
    );
    return new MutationObserver(
      queryClient,
      updateCommentOptions(queryClient, POST, () => undefined),
    ).mutate({ commentId: id, body, expectedAccountId: 'user-1' });
  };
  /** The reader's deletion of `id`, which nothing hangs under. */
  const remove = (queryClient: QueryClient, id: string) => {
    vi.spyOn(api, 'POST').mockResolvedValue(answer({ id, placeholder: false }));
    return new MutationObserver(
      queryClient,
      deleteCommentOptions(queryClient, POST, () => undefined),
    ).mutate({ commentId: id, expectedAccountId: 'user-1' });
  };
  /** The reader's new `comment`, as the server answers it. */
  const create = (queryClient: QueryClient, comment: PublishedComment) => {
    vi.spyOn(api, 'POST').mockResolvedValue(answer(comment));
    return new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, () => undefined),
    ).mutate({ parentId: comment.parentId, body: comment.body, expectedAccountId: 'user-1' });
  };
  const firstThread = (queryClient: QueryClient) =>
    commentThreadsOf(queryClient.getQueryData(postCommentsKey(post)))[0];
  const bodyOf = (comment: CommentThread['comment'] | undefined) =>
    comment?.state === 'published' ? comment.body : comment?.state;

  it('a new 댓글’s read: an edit, a 대댓글 and a deletion that landed while its page was on its way stay on the page it read', async () => {
    const queryClient = onScreen(seeded());
    const firstPage = () => ({
      items: [thread(published(commentId)), thread(published(SECOND))],
      nextCursor: 'c2',
    });
    queryClient.setQueryData<CommentPages>(postCommentsKey(post), {
      pages: [firstPage()],
      pageParams: [undefined],
    });
    const read = onItsWay();
    const asked = getComments(async ({ params }) => {
      if (params.query.cursor !== undefined) {
        return { items: [thread(published(OLDER)), thread(published(MINE))], nextCursor: null };
      }
      // Read as the server held it when the read left: before the writes below.
      await read.arrived;
      return firstPage();
    });
    const writing = create(queryClient, published(MINE));
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    await edit(queryClient, commentId, '고친 댓글', null);
    await create(queryClient, published(PLACED, commentId, '답글'));
    await remove(queryClient, SECOND);
    expect(threadIds(queryClient)).toEqual([commentId]);
    read.arrive();
    await writing;
    expect(asked).toEqual([{}, { cursor: 'c2' }]);
    // In its place, the page it read put in — and over it what the reader wrote meanwhile.
    expect(threadIds(queryClient)).toEqual([commentId, OLDER, MINE]);
    expect(bodyOf(firstThread(queryClient)?.comment)).toBe('고친 댓글');
    expect(firstThread(queryClient)?.replies.map((reply) => reply.id)).toEqual([PLACED]);
    expect(placedHeld(queryClient)).toEqual([]);
  });

  it('a new 댓글’s read that fails after the first page: the last page held as read again keeps an edit and a deletion that landed meanwhile, the 댓글 placed after it', async () => {
    const queryClient = onScreen(seeded());
    const firstPage = () => ({
      items: [thread(published(commentId)), thread(published(SECOND))],
      nextCursor: 'c2',
    });
    queryClient.setQueryData<CommentPages>(postCommentsKey(post), {
      pages: [firstPage()],
      pageParams: [undefined],
    });
    const read = onItsWay();
    const asked = getComments(async ({ params }) => {
      if (params.query.cursor === undefined) return firstPage();
      await read.arrived;
      throw new TypeError('Failed to fetch');
    });
    const writing = create(queryClient, published(MINE));
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    await edit(queryClient, commentId, '고친 댓글', null);
    await remove(queryClient, SECOND);
    read.arrive();
    await writing;
    expect(threadIds(queryClient)).toEqual([commentId, MINE]);
    expect(bodyOf(firstThread(queryClient)?.comment)).toBe('고친 댓글');
    expect(placedHeld(queryClient)).toEqual([`-:${MINE}`]);
  });

  it('a new 댓글’s read: ‘답글 더 보기’ pressed while it read keeps the 대댓글 it brought on the page the read put in', async () => {
    const queryClient = onScreen(seededThread(replyIds(0, 2), 'r2'));
    queryClient.setQueryData<CommentPages>(postCommentsKey(post), (pages) => ({
      ...pages!,
      pages: [{ ...pages!.pages[0]!, nextCursor: 'c2' }],
    }));
    const read = onItsWay();
    const asked = getThreads(
      async ({ params }) => {
        // The first page as the screen held it: the thread's first two, nothing read on for it.
        if (params.query.cursor === undefined) {
          return { items: [threadAnswered(replyIds(0, 2), 'r2')], nextCursor: 'c2' };
        }
        await read.arrived;
        return { items: [thread(published(OLDER)), thread(published(MINE))], nextCursor: null };
      },
      () => replyPage(replyIds(2, 4), null),
    );
    const writing = create(queryClient, published(MINE));
    await vi.waitFor(() => expect(asked).toEqual(['comments:', 'comments:c2']));
    await readMoreReplies(queryClient, POST, commentId);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 4), null]);
    read.arrive();
    await writing;
    expect(asked).toEqual(['comments:', 'comments:c2', `replies:${commentId}:r2`]);
    expect(threadIds(queryClient)).toEqual([commentId, OLDER, MINE]);
    expect(repliesHeld(queryClient)).toEqual([replyIds(0, 4), null]);
  });

  it('a new 댓글’s read: a new 대댓글 placed at the end of its thread while it read — its own read stopped at REPLY_READ_ON_PAGES — stays placed on the page the read put in, and the next read of the pages puts it back (the two writes of `putReadPages`)', async () => {
    const queryClient = onScreen(seededThread(replyIds(0, 2), 'r2'));
    queryClient.setQueryData<CommentPages>(postCommentsKey(post), (pages) => ({
      ...pages!,
      pages: [{ ...pages!.pages[0]!, nextCursor: 'c2' }],
    }));
    const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
    const unsubscribe = comments.subscribe(() => undefined);
    /** The first page as the screen holds it: the thread's first two, PLACED not among them. */
    const firstPage = () => ({ items: [threadAnswered(replyIds(0, 2), 'r2')], nextCursor: 'c2' });
    const read = onItsWay();
    let holdBack = true;
    // The thread has 20 대댓글 after its first two, then PLACED: five reply pages stop short of it.
    const asked = getThreads(
      async ({ params }) => {
        if (params.query.cursor !== undefined) {
          return { items: [thread(published(OLDER)), thread(published(MINE))], nextCursor: null };
        }
        if (holdBack) await read.arrived;
        return firstPage();
      },
      fakeReplies(22, PLACED),
    );
    const writing = create(queryClient, published(MINE));
    await vi.waitFor(() => expect(asked).toEqual(['comments:']));
    await create(queryClient, published(PLACED, commentId, '답글'));
    const replyPagesRead = Array.from(
      { length: REPLY_READ_ON_PAGES },
      (_, page) => `replies:${commentId}:r${String(2 + 2 * page)}`,
    );
    expect(asked).toEqual(['comments:', ...replyPagesRead]);
    expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 2), PLACED], 'r2']);
    expect(placedHeld(queryClient)).toEqual([`${commentId}:${PLACED}`]);
    read.arrive();
    await writing;
    expect(asked).toEqual(['comments:', ...replyPagesRead, 'comments:c2']);
    expect(threadIds(queryClient)).toEqual([commentId, OLDER, MINE]);
    // The page read holds the thread without it; the new 대댓글 done again over that page puts it
    // back — and it stays placed: in one write, it would read as one the read brought, in place.
    expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 2), PLACED], 'r2']);
    expect(placedHeld(queryClient)).toEqual([`${commentId}:${PLACED}`]);
    // So the next read of the pages, which reads nothing on for it, puts it back at the end.
    holdBack = false;
    asked.length = 0;
    await comments.refetch();
    expect(asked).toEqual(['comments:', 'comments:c2']);
    expect(repliesHeld(queryClient)).toEqual([[...replyIds(0, 2), PLACED], 'r2']);
    expect(placedHeld(queryClient)).toEqual([`${commentId}:${PLACED}`]);
    unsubscribe();
  });

  /**
   * The thread above holding its first `first` 대댓글 and, at their end, the writer's own PLACED —
   * its read had stopped short (오너 결정 2026-10-24) — with the server's 대댓글 r0…r3, PLACED and
   * MINE, two a page; each reply page answers once the test lets it.
   */
  const holdingPlaced = (first = 2) => {
    const cursor = `r${String(first)}`;
    const queryClient = onScreen(seededThread(replyIds(0, first), cursor));
    queryClient.setQueryData<CommentPages>(postCommentsKey(post), (pages) => ({
      ...pages!,
      pages: [
        {
          ...pages!.pages[0]!,
          items: [
            {
              ...threadAnswered(replyIds(0, first), cursor),
              replies: [...replyIds(0, first), PLACED].map((id) => published(id, commentId)),
            },
          ],
        },
      ],
      placed: [{ id: PLACED, threadId: commentId, accountId: 'user-1' }],
    }));
    expect(placedHeld(queryClient)).toEqual([`${commentId}:${PLACED}`]);
    const read = onItsWay();
    const replies = fakeReplies(4, PLACED, [MINE]);
    const asked = getThreads(
      () => ({ items: [], nextCursor: null }),
      async (request) => {
        await read.arrived;
        return replies(request);
      },
    );
    return { queryClient, read, asked };
  };

  const placedWrites: [string, (queryClient: QueryClient) => Promise<unknown>, string[]][] = [
    [
      'an edit',
      (queryClient) => edit(queryClient, PLACED, '고친 답글', commentId),
      [...replyIds(0, 4), PLACED, MINE],
    ],
    ['a deletion', (queryClient) => remove(queryClient, PLACED), [...replyIds(0, 4), MINE]],
  ];

  for (const [name, write, after] of placedWrites) {
    it(`a new 대댓글’s read of its thread: ${name} of the writer’s own 대댓글 placed at its end, landing while the thread was read, stays — the pages read hold it as it was`, async () => {
      const { queryClient, read, asked } = holdingPlaced();
      const writing = create(queryClient, published(MINE, commentId, '답글'));
      await vi.waitFor(() => expect(asked).toEqual([`replies:${commentId}:r2`]));
      await write(queryClient);
      read.arrive();
      await writing;
      expect(asked).toEqual([`replies:${commentId}:r2`, `replies:${commentId}:r4`]);
      expect(repliesHeld(queryClient)).toEqual([after, null]);
      const placed = firstThread(queryClient)?.replies.find((reply) => reply.id === PLACED);
      expect(placed === undefined ? undefined : bodyOf(placed)).toBe(
        name === 'an edit' ? '고친 답글' : undefined,
      );
      expect(placedHeld(queryClient)).toEqual([]);
    });

    it(`‘답글 더 보기’: ${name} of the writer’s own 대댓글 placed at the thread’s end, landing while the page that brings it was read, stays`, async () => {
      // The thread read up to PLACED's page: the next one brings it, and MINE (another's) after it.
      const { queryClient, read, asked } = holdingPlaced(4);
      const more = readMoreReplies(queryClient, POST, commentId);
      await vi.waitFor(() => expect(asked).toEqual([`replies:${commentId}:r4`]));
      await write(queryClient);
      read.arrive();
      await more;
      expect(repliesHeld(queryClient)).toEqual([after, null]);
      const placed = firstThread(queryClient)?.replies.find((reply) => reply.id === PLACED);
      expect(placed === undefined ? undefined : bodyOf(placed)).toBe(
        name === 'an edit' ? '고친 답글' : undefined,
      );
      expect(placedHeld(queryClient)).toEqual([]);
    });

    it(`‘답글 더 보기’ landing while a new 댓글’s read is on its way: ${name} of the writer’s own 대댓글 placed at the thread’s end, done again over the page it brought, stays on the pages the new 댓글’s read puts in after it`, async () => {
      // The thread holds its first page and PLACED placed at its end; the list goes on behind
      // 'c2'. '답글 더 보기' (from 'r2': PLACED, and MINE — another's — after it) and a new 댓글's
      // read (the first page again, then 'c2') leave before the write. The reply page lands
      // first, the write done again over it; what goes into the other read's log is what it put in
      // with that — the page as read, done again over the other read's pages after the write,
      // would bring PLACED back as it was before it.
      const queryClient = onScreen(seededThread(replyIds(0, 2), 'r2'));
      queryClient.setQueryData<CommentPages>(postCommentsKey(post), (pages) => ({
        pages: [
          {
            items: [
              {
                ...threadAnswered(replyIds(0, 2), 'r2'),
                replies: [...replyIds(0, 2), PLACED].map((id) => published(id, commentId)),
              },
            ],
            nextCursor: 'c2',
          },
        ],
        pageParams: pages!.pageParams,
        placed: [{ id: PLACED, threadId: commentId, accountId: 'user-1' }],
      }));
      const replies = onItsWay();
      const lastPage = onItsWay();
      const asked = getThreads(
        async ({ params }) => {
          if (params.query.cursor === undefined) {
            return { items: [threadAnswered(replyIds(0, 2), 'r2')], nextCursor: 'c2' };
          }
          await lastPage.arrived;
          return { items: [thread(published(OLDER))], nextCursor: null };
        },
        async (request) => {
          await replies.arrived;
          return fakeReplies(2, PLACED, [MINE])(request);
        },
      );
      const more = readMoreReplies(queryClient, POST, commentId);
      const writing = create(queryClient, published(OLDER));
      await vi.waitFor(() =>
        expect(asked).toEqual([`replies:${commentId}:r2`, 'comments:', 'comments:c2']),
      );
      await write(queryClient);
      replies.arrive();
      await more;
      const thread0 =
        name === 'an edit' ? [...replyIds(0, 2), PLACED, MINE] : [...replyIds(0, 2), MINE];
      expect(repliesHeld(queryClient)).toEqual([thread0, null]);
      lastPage.arrive();
      await writing;
      expect(asked).toEqual([`replies:${commentId}:r2`, 'comments:', 'comments:c2']);
      expect(threadIds(queryClient)).toEqual([commentId, OLDER]);
      expect(repliesHeld(queryClient)).toEqual([thread0, null]);
      const placed = firstThread(queryClient)?.replies.find((reply) => reply.id === PLACED);
      expect(placed === undefined ? undefined : bodyOf(placed)).toBe(
        name === 'an edit' ? '고친 답글' : undefined,
      );
      expect(placedHeld(queryClient)).toEqual([]);
    });
  }
});
