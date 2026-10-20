import {
  InfiniteQueryObserver,
  MutationObserver,
  type QueryClient,
  QueryObserver,
} from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type CommentThread, type Post, type PublishedComment, api } from '@/lib/api';
import { commentDraftLandedSince, commentDraftMoment } from '@/lib/comment-drafts';
import {
  type CommentPage,
  type CommentPages,
  commentThreadsOf,
  postCommentsKey,
} from '@/lib/comments';
import { communityPostsKey, postKey } from '@/lib/posts';
import { getQueryClient } from '@/lib/query-client';
import {
  commentsInfiniteQueryOptions,
  createCommentOptions,
  deleteCommentOptions,
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

const thread = (comment: PublishedComment): CommentThread => ({ comment, replies: [] });

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
    const thread = { comment: published(commentId), replies: [] };
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
