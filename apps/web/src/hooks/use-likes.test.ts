import {
  InfiniteQueryObserver,
  MutationObserver,
  QueryObserver,
  type QueryClient,
} from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type LikeState,
  type Me,
  type MyPostLikes,
  type Post,
  type PublishedComment,
  api,
} from '@/lib/api';
import {
  type CommentPage,
  type CommentPages,
  commentThreadsOf,
  postCommentsKey,
} from '@/lib/comments';
import { commentLikeCount, myPostLikesKey, postLikeCount } from '@/lib/likes';
import { communityPostsKey, postKey } from '@/lib/posts';
import { getQueryClient } from '@/lib/query-client';
import {
  commentsInfiniteQueryOptions,
  createCommentOptions,
  readMoreReplies,
} from './use-comments';
import { type LikeVariables, myPostLikesQueryOptions, updateLikeOptions } from './use-likes';
import { ME_QUERY_KEY } from './use-me';

/**
 * The like toggles' wiring (#49, ADR-0076), through a real QueryClient (`getQueryClient()`
 * answers a fresh one per call under node) with the write injected or the API client stubbed:
 * the request each read and press sends, what a press shows before the answer, what the answer
 * and a failure do to the reader's likes, the counts held, the post and the community list — and
 * that a read on its way when a press is sent or answered cannot undo it, while a 더 보기 on its
 * way still brings its page.
 */

const POST = 'B7C9A1D2-6F34-4E58-9B0A-2D1E5F8C7A46';
const post = POST.toLowerCase();
const COMMENT = '6F9619FF-8B86-D011-B42D-00C04FC964FF';
const commentId = COMMENT.toLowerCase();
const REPLY = 'd3b07384-d9a0-4c9b-8e2f-2d1c0f8a4b11';

const published = (
  id: string,
  likeCount: number,
  parentId: string | null = null,
): PublishedComment => ({
  state: 'published',
  id,
  parentId,
  body: '댓글',
  author: {
    kind: 'member',
    publicId: 'k7m2p9qx4z',
    nickname: '근거왕',
    imageUrl: null,
    isAdmin: false,
  },
  createdAt: '2026-10-19T00:00:00.000Z',
  editedAt: null,
  likeCount,
});

/** The first page of comments: COMMENT ('좋아요 `count`') and its 대댓글, and what follows it. */
const firstPage = (count = 2, nextCursor: string | null = null): CommentPage => ({
  items: [
    {
      comment: published(commentId, count),
      replies: [published(REPLY, 0, commentId)],
      repliesNextCursor: null,
    },
  ],
  nextCursor,
});

/** The pages as a read of them answers: the first page only. */
const pagesWith = (count: number): CommentPages => ({
  pages: [firstPage(count)],
  pageParams: [undefined],
});

/**
 * A client holding the post ('좋아요 4'), its comments (COMMENT at '좋아요 2', `nextCursor` when
 * 더 보기 has more), the reader's likes and a list page.
 */
function seeded(
  likes: MyPostLikes = { postLiked: false, likedCommentIds: [] },
  nextCursor: string | null = null,
) {
  const queryClient = getQueryClient();
  queryClient.setQueryData(postKey(post), {
    state: 'published',
    id: post,
    likeCount: 4,
    commentCount: 2,
  });
  const pages: CommentPages = { pages: [firstPage(2, nextCursor)], pageParams: [undefined] };
  queryClient.setQueryData(postCommentsKey(post), pages);
  queryClient.setQueryData(myPostLikesKey(post), likes);
  queryClient.setQueryData(communityPostsKey({}), { pages: [], pageParams: [] });
  return queryClient;
}

const likesOf = (queryClient: QueryClient) =>
  queryClient.getQueryData<MyPostLikes>(myPostLikesKey(post));
const postCountOf = (queryClient: QueryClient) =>
  postLikeCount(queryClient.getQueryData<Post>(postKey(post)));
const commentCountOf = (queryClient: QueryClient, id: string) =>
  commentLikeCount(queryClient.getQueryData<CommentPages>(postCommentsKey(post)), id);
const invalidated = (queryClient: QueryClient, key: readonly unknown[]) =>
  queryClient.getQueryState(key)?.isInvalidated;

/** A promise the test settles itself, so "what the screen shows while it is out" is explicit. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets the mutation's `onMutate` (two cancellations) run before the test looks. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function toggle(
  queryClient: QueryClient,
  put: (variables: LikeVariables) => Promise<LikeState>,
  onSessionChanged: () => void = () => undefined,
) {
  return new MutationObserver(
    queryClient,
    updateLikeOptions(queryClient, POST, onSessionChanged, put),
  );
}

const onComment = (liked: boolean, id = COMMENT, account = 'user-1'): LikeVariables => ({
  target: { kind: 'comment', id },
  liked,
  expectedAccountId: account,
});
const onPost = (liked: boolean, account = 'user-1'): LikeVariables => ({
  target: { kind: 'post', id: POST },
  liked,
  expectedAccountId: account,
});

const refusal = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);

/** openapi-fetch's `{ data, response }`, the shape `unwrap` reads. */
const answer = (data: unknown) =>
  ({ data: { data }, response: new Response(null, { status: 200 }) }) as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the reader’s likes', () => {
  it('are one private read per post, by the lower-cased id, once a session exists', async () => {
    const options = myPostLikesQueryOptions(POST, { user: {} });
    expect(options.queryKey).toEqual(['likes', 'post', post]);
    expect(options.enabled).toBe(true);
    // Signed out or not known yet: never asked (the route needs the cookie).
    expect(myPostLikesQueryOptions(POST, null).enabled).toBe(false);
    expect(myPostLikesQueryOptions(POST).enabled).toBe(false);
    const likes = { postLiked: true, likedCommentIds: [commentId] };
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answer(likes));
    await expect(options.queryFn()).resolves.toEqual(likes);
    expect(get).toHaveBeenCalledWith('/api/v1/me/likes/posts/{postId}', {
      params: { path: { postId: post } },
    });
  });

  it('are pressed through one route per target, the state and the account in the body', async () => {
    const queryClient = seeded();
    const put = vi.spyOn(api, 'PUT').mockResolvedValue(answer({ liked: true, likeCount: 5 }));
    const press = new MutationObserver(
      queryClient,
      updateLikeOptions(queryClient, POST, () => undefined),
    );
    await press.mutate(onPost(true));
    await press.mutate(onComment(false, REPLY));
    expect(put.mock.calls).toEqual([
      [
        '/api/v1/posts/{postId}/like',
        { params: { path: { postId: post } }, body: { liked: true, expectedAccountId: 'user-1' } },
      ],
      [
        '/api/v1/comments/{commentId}/like',
        {
          params: { path: { commentId: REPLY } },
          body: { liked: false, expectedAccountId: 'user-1' },
        },
      ],
    ]);
  });
});

describe('a press', () => {
  it('moves a comment’s toggle and count at once, then takes the server’s count', async () => {
    const queryClient = seeded();
    const sent = deferred<LikeState>();
    const press = toggle(queryClient, () => sent.promise);
    const done = press.mutate(onComment(true));
    await settle();
    // Before the answer: liked, and one more than the two held.
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    expect(commentCountOf(queryClient, REPLY)).toBe(0);
    // The server counts everybody's likes: others liked it meanwhile.
    sent.resolve({ liked: true, likeCount: 6 });
    await done;
    expect(commentCountOf(queryClient, commentId)).toBe(6);
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
    // A comment's like reads nothing again: the answer is in the pages, and the post's own count
    // and the cards are not a comment's.
    expect(invalidated(queryClient, postCommentsKey(post))).toBe(false);
    expect(invalidated(queryClient, myPostLikesKey(post))).toBe(false);
    expect(invalidated(queryClient, postKey(post))).toBe(false);
    expect(invalidated(queryClient, communityPostsKey({}))).toBe(false);
  });

  it('takes a like back the same way, and a post’s like reads the post and the cards again', async () => {
    const queryClient = seeded({ postLiked: true, likedCommentIds: [] });
    const sent = deferred<LikeState>();
    const press = toggle(queryClient, () => sent.promise);
    const done = press.mutate(onPost(false));
    await settle();
    expect(likesOf(queryClient)?.postLiked).toBe(false);
    expect(postCountOf(queryClient)).toBe(3);
    sent.resolve({ liked: false, likeCount: 3 });
    await done;
    expect(postCountOf(queryClient)).toBe(3);
    expect(invalidated(queryClient, postKey(post))).toBe(true);
    expect(invalidated(queryClient, communityPostsKey({}))).toBe(true);
    expect(invalidated(queryClient, postCommentsKey(post))).toBe(false);
  });

  it('that fails puts back its own target only, and reads the likes and the count again', async () => {
    const queryClient = seeded();
    const first = deferred<LikeState>();
    const second = deferred<LikeState>();
    const failing = toggle(queryClient, () => first.promise);
    const pending = toggle(queryClient, () => second.promise);
    const failed = failing.mutate(onComment(true)).catch((error: unknown) => error);
    await settle();
    const done = pending.mutate(onComment(true, REPLY));
    await settle();
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId, REPLY]);

    first.reject(refusal(503, 'INTERNAL'));
    expect(await failed).toBeInstanceOf(ApiError);
    // The failed press is undone; the other one, still on the wire, keeps what it showed.
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([REPLY.toLowerCase()]);
    expect(commentCountOf(queryClient, commentId)).toBe(2);
    expect(commentCountOf(queryClient, REPLY)).toBe(1);
    // Read again, so the screen ends on the server's word (a write that committed before its
    // answer was lost shows up there).
    expect(invalidated(queryClient, myPostLikesKey(post))).toBe(true);
    expect(invalidated(queryClient, postCommentsKey(post))).toBe(true);
    // Not a refusal that says the page is stale: the post is not read again.
    expect(invalidated(queryClient, postKey(post))).toBe(false);

    second.resolve({ liked: true, likeCount: 1 });
    await done;
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([REPLY.toLowerCase()]);
    expect(commentCountOf(queryClient, REPLY)).toBe(1);
  });

  it('refused because the post or comment was deleted or hidden reads the post and its comments again', async () => {
    const queryClient = seeded();
    const press = toggle(queryClient, () =>
      Promise.reject(refusal(409, 'LIKE_NOT_ALLOWED', { reason: 'hidden' })),
    );
    await expect(press.mutate(onComment(true))).rejects.toBeInstanceOf(ApiError);
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([]);
    expect(commentCountOf(queryClient, commentId)).toBe(2);
    expect(invalidated(queryClient, postKey(post))).toBe(true);
    expect(invalidated(queryClient, postCommentsKey(post))).toBe(true);

    const gone = seeded();
    const onGone = toggle(gone, () => Promise.reject(refusal(404, 'NOT_FOUND')));
    await expect(onGone.mutate(onPost(true))).rejects.toBeInstanceOf(ApiError);
    expect(postCountOf(gone)).toBe(4);
    expect(likesOf(gone)?.postLiked).toBe(false);
    expect(invalidated(gone, postKey(post))).toBe(true);
    expect(invalidated(gone, postCommentsKey(post))).toBe(true);
  });

  it('refused as another account asks for the session; one for the onboarding reads /me again', async () => {
    const queryClient = seeded();
    const sessionChanged = vi.fn();
    const other = refusal(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'x' }]);
    const press = toggle(queryClient, () => Promise.reject(other), sessionChanged);
    await expect(press.mutate(onComment(true))).rejects.toBeInstanceOf(ApiError);
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([]);

    queryClient.setQueryData(ME_QUERY_KEY, {});
    const onboarding = toggle(queryClient, () =>
      Promise.reject(refusal(403, 'ONBOARDING_REQUIRED')),
    );
    await expect(onboarding.mutate(onPost(true))).rejects.toBeInstanceOf(ApiError);
    expect(invalidated(queryClient, ME_QUERY_KEY)).toBe(true);
    expect(postCountOf(queryClient)).toBe(4);
  });

  it('refused for the onboarding, rejects only once `/me` has been read again', async () => {
    // The button sends a refused press on by `['me']` as that read left it (`likeRefusalMove`,
    // ADR-0076 7-25): the read is over before the press's promise rejects.
    const queryClient = seeded();
    let reads = 0;
    // Each read takes a moment, as a request does: longer than the rest of the refusal's work.
    const me = new QueryObserver<Me>(queryClient, {
      queryKey: ME_QUERY_KEY,
      queryFn: async () => {
        const id = `read-${String(++reads)}`;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { id } as Me;
      },
      retry: false,
    });
    const unsubscribe = me.subscribe(() => undefined);
    try {
      await vi.waitFor(() => expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.id).toBe('read-1'));
      const press = toggle(queryClient, () => Promise.reject(refusal(409, 'ONBOARDING_REQUIRED')));
      const seen = await press.mutate(onPost(true)).then(
        () => 'sent',
        () => queryClient.getQueryData<Me>(ME_QUERY_KEY)?.id,
      );
      expect(seen).toBe('read-2');
    } finally {
      unsubscribe();
    }
  });

  it('answered after the tab changed accounts writes the count but not the other account’s likes', async () => {
    const queryClient = seeded();
    const sent = deferred<LikeState>();
    const press = toggle(queryClient, () => sent.promise);
    const done = press.mutate(onComment(true, COMMENT, 'user-1'));
    await settle();
    // SessionCacheGuard reset the cache for user-2, whose likes were read afresh.
    queryClient.setQueryData<Partial<Me>>(ME_QUERY_KEY, { id: 'user-2' });
    queryClient.setQueryData<MyPostLikes>(myPostLikesKey(post), {
      postLiked: false,
      likedCommentIds: [],
    });
    sent.resolve({ liked: true, likeCount: 3 });
    await done;
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([]);
    // The count is public: the same for whoever reads it.
    expect(commentCountOf(queryClient, commentId)).toBe(3);
  });

  it('is not undone by a read of the reader’s likes that left before it, which is made again after the answer', async () => {
    const queryClient = seeded();
    const stale = deferred<MyPostLikes>();
    // A refetch on its way (a refocus), carrying the state from before the press; made again, it
    // is served after the write committed.
    const read = vi
      .fn<() => Promise<MyPostLikes>>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue({ postLiked: false, likedCommentIds: [commentId] });
    const observer = new QueryObserver<MyPostLikes>(queryClient, {
      queryKey: myPostLikesKey(post),
      queryFn: read,
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    void observer.refetch();
    const sent = deferred<LikeState>();
    const done = toggle(queryClient, () => sent.promise).mutate(onComment(true));
    await settle();
    // Landing before the answer, the cancelled read changes nothing: the toggle stays pressed.
    stale.resolve({ postLiked: false, likedCommentIds: [] });
    await settle();
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
    sent.resolve({ liked: true, likeCount: 3 });
    await done;
    expect(read).toHaveBeenCalledTimes(2);
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    unsubscribe();
  });

  it('is not undone by a read of the reader’s likes that started while it was on the wire', async () => {
    // Another press failed meanwhile and read the likes again (or the window got the focus back):
    // that read is served before this write commits, and its answer arrives after this one.
    const queryClient = seeded();
    const stale = deferred<MyPostLikes>();
    const read = vi
      .fn<() => Promise<MyPostLikes>>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue({ postLiked: false, likedCommentIds: [commentId] });
    const observer = new QueryObserver<MyPostLikes>(queryClient, {
      queryKey: myPostLikesKey(post),
      queryFn: read,
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    const sent = deferred<LikeState>();
    const done = toggle(queryClient, () => sent.promise).mutate(onComment(true));
    await settle();
    void observer.refetch();
    sent.resolve({ liked: true, likeCount: 3 });
    await done;
    stale.resolve({ postLiked: false, likedCommentIds: [] });
    await settle();
    // Read again after the answer: the screen ends on the server's word, the toggle pressed.
    expect(read).toHaveBeenCalledTimes(2);
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
    unsubscribe();
  });

  /** An active read of the comment pages: `stale` first, then what the server holds now. */
  function pagesRead(queryClient: QueryClient, stale: Promise<CommentPages>, now: CommentPages) {
    const read = vi
      .fn<() => Promise<CommentPages>>()
      .mockReturnValueOnce(stale)
      .mockResolvedValue(now);
    const observer = new QueryObserver<CommentPages>(queryClient, {
      queryKey: postCommentsKey(post),
      queryFn: read,
      retry: false,
    });
    return { read, observer, unsubscribe: observer.subscribe(() => undefined) };
  }

  it('is not undone by a read of the comment pages that left before it', async () => {
    const queryClient = seeded();
    const stale = deferred<CommentPages>();
    const pages = pagesRead(queryClient, stale.promise, pagesWith(5));
    void pages.observer.refetch();
    const sent = deferred<LikeState>();
    const done = toggle(queryClient, () => sent.promise).mutate(onComment(true));
    await settle();
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    // The pages from before the press land before its answer: cancelled, the count stays moved.
    stale.resolve(pagesWith(2));
    await settle();
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    sent.resolve({ liked: true, likeCount: 5 });
    await done;
    // The cancelled read is made again after the answer.
    expect(pages.read).toHaveBeenCalledTimes(2);
    expect(commentCountOf(queryClient, commentId)).toBe(5);
    pages.unsubscribe();
  });

  it('is not undone by a read of the post that left before it', async () => {
    const queryClient = seeded();
    const stale = deferred<Post>();
    const read = vi
      .fn<() => Promise<Post>>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue({ state: 'published', id: post, likeCount: 5, commentCount: 2 } as Post);
    const observer = new QueryObserver<Post>(queryClient, {
      queryKey: postKey(post),
      queryFn: read,
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    void observer.refetch();
    const sent = deferred<LikeState>();
    const done = toggle(queryClient, () => sent.promise).mutate(onPost(true));
    await settle();
    stale.resolve({ state: 'published', id: post, likeCount: 4, commentCount: 2 } as Post);
    await settle();
    expect(postCountOf(queryClient)).toBe(5);
    sent.resolve({ liked: true, likeCount: 5 });
    await done;
    // A post's like reads the post again anyway: it confirms the count.
    expect(read).toHaveBeenCalledTimes(2);
    expect(postCountOf(queryClient)).toBe(5);
    unsubscribe();
  });

  it('is not undone by a read of the comment pages that started while it was on the wire', async () => {
    // As another comment's refused press reads the pages again (`isStaleLikeRefusal`): that read
    // is cancelled by this answer and made again after it, so it still lands — with this count.
    const queryClient = seeded();
    const stale = deferred<CommentPages>();
    const pages = pagesRead(queryClient, stale.promise, pagesWith(3));
    const sent = deferred<LikeState>();
    const done = toggle(queryClient, () => sent.promise).mutate(onComment(true));
    await settle();
    void pages.observer.refetch();
    sent.resolve({ liked: true, likeCount: 3 });
    await done;
    stale.resolve(pagesWith(2));
    await settle();
    expect(pages.read).toHaveBeenCalledTimes(2);
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    pages.unsubscribe();
  });
});

describe('a comment’s press while 더 보기 is on its way', () => {
  const OLDER = '0c4e9a7b-3f21-4d6a-8b5e-9a1f2c3d4e5f';

  /** The comment pages as the thread reads them, page `c2` answered when the test says. */
  function moreOnItsWay(queryClient: QueryClient) {
    const next = deferred<CommentPage>();
    const comments = new InfiniteQueryObserver(queryClient, {
      queryKey: postCommentsKey(post),
      queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
        pageParam === 'c2' ? next.promise : Promise.resolve(firstPage(2, 'c2')),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last: CommentPage) => last.nextCursor ?? undefined,
      retry: false,
    });
    const unsubscribe = comments.subscribe(() => undefined);
    const more = comments.fetchNextPage();
    const page = {
      items: [{ comment: published(OLDER, 0), replies: [], repliesNextCursor: null }],
      nextCursor: null,
    };
    return { comments, unsubscribe, more, arrive: () => next.resolve(page) };
  }

  it('keeps the 더 보기, whose page lands with the answer’s count', async () => {
    const queryClient = seeded(undefined, 'c2');
    const thread = moreOnItsWay(queryClient);
    const sent = deferred<LikeState>();
    const done = toggle(queryClient, () => sent.promise).mutate(onComment(true));
    await settle();
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    expect(thread.comments.getCurrentResult().isFetchingNextPage).toBe(true);
    sent.resolve({ liked: true, likeCount: 6 });
    await done;
    expect(commentCountOf(queryClient, commentId)).toBe(6);
    // The page the reader asked for arrives, and its pages (taken before the press) do not bring
    // the old count back.
    thread.arrive();
    await thread.more;
    await settle();
    expect(queryClient.getQueryData<CommentPages>(postCommentsKey(post))?.pages).toHaveLength(2);
    expect(commentCountOf(queryClient, OLDER)).toBe(0);
    expect(commentCountOf(queryClient, commentId)).toBe(6);
    expect(thread.comments.getCurrentResult().hasNextPage).toBe(false);
    thread.unsubscribe();
  });

  it('keeps the 더 보기 when it lands before the answer, and when the press fails', async () => {
    const queryClient = seeded(undefined, 'c2');
    const thread = moreOnItsWay(queryClient);
    const sent = deferred<LikeState>();
    const done = toggle(queryClient, () => sent.promise).mutate(onComment(true));
    await settle();
    thread.arrive();
    await thread.more;
    await settle();
    // Landed first: two pages, and the press's count still moved.
    expect(queryClient.getQueryData<CommentPages>(postCommentsKey(post))?.pages).toHaveLength(2);
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    sent.resolve({ liked: true, likeCount: 4 });
    await done;
    expect(commentCountOf(queryClient, commentId)).toBe(4);

    // A failed press during another 더 보기 puts its count back and reads the pages after it.
    const again = seeded(undefined, 'c2');
    const other = moreOnItsWay(again);
    const failing = deferred<LikeState>();
    const failed = toggle(again, () => failing.promise)
      .mutate(onComment(true))
      .catch((error: unknown) => error);
    await settle();
    failing.reject(refusal(503, 'INTERNAL'));
    await settle();
    expect(commentCountOf(again, commentId)).toBe(2);
    expect(other.comments.getCurrentResult().isFetchingNextPage).toBe(true);
    other.arrive();
    expect(await failed).toBeInstanceOf(ApiError);
    expect(again.getQueryData<CommentPages>(postCommentsKey(post))?.pages).toHaveLength(2);
    expect(commentCountOf(again, commentId)).toBe(2);
    other.unsubscribe();
    thread.unsubscribe();
  });
});

describe('a 대댓글’s press while 답글 더 보기 is on its way', () => {
  const EARLIER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  const BETWEEN = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';

  /**
   * The thread as `withNewComment` leaves it when the reader's own 대댓글 (REPLY) could not be read
   * into its place: last of the 대댓글 held, before the ones still unread behind 'r50'. Its '답글
   * 더 보기' is sent, and its page — BETWEEN, then REPLY in its place at the count it had when the
   * page was read — answers when the test says.
   */
  function repliesOnTheirWay(queryClient: QueryClient) {
    queryClient.setQueryData<CommentPages>(postCommentsKey(post), {
      pages: [
        {
          items: [
            {
              comment: published(commentId, 2),
              replies: [published(EARLIER, 0, commentId), published(REPLY, 0, commentId)],
              repliesNextCursor: 'r50',
            },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    });
    const page = deferred<unknown>();
    vi.spyOn(api, 'GET').mockReturnValue(page.promise as never);
    const more = readMoreReplies(queryClient, POST, commentId);
    const arrive = () =>
      page.resolve({
        data: {
          data: [published(BETWEEN, 0, commentId), published(REPLY, 0, commentId)],
          meta: { nextCursor: null },
        },
        response: new Response(null, { status: 200 }),
      });
    return { more, arrive };
  }

  /** The 대댓글 ids the thread holds, and its cursor. */
  const repliesHeld = (queryClient: QueryClient) => {
    const [thread] = commentThreadsOf(
      queryClient.getQueryData<CommentPages>(postCommentsKey(post)),
    );
    return [thread?.replies.map((reply) => reply.id), thread?.repliesNextCursor];
  };

  it('keeps the count the answer wrote when the page lands after it', async () => {
    const queryClient = seeded();
    const replies = repliesOnTheirWay(queryClient);
    const sent = deferred<LikeState>();
    const done = toggle(queryClient, () => sent.promise).mutate(onComment(true, REPLY));
    await settle();
    expect(commentCountOf(queryClient, REPLY)).toBe(1);
    sent.resolve({ liked: true, likeCount: 1 });
    await done;
    expect(commentCountOf(queryClient, REPLY)).toBe(1);
    // The page brings BETWEEN and REPLY into its place — REPLY at the count from when the page was
    // read, which must not take the like back off the screen.
    replies.arrive();
    await replies.more;
    expect(repliesHeld(queryClient)).toEqual([[EARLIER, BETWEEN, REPLY], null]);
    expect(commentCountOf(queryClient, REPLY)).toBe(1);
    expect(commentCountOf(queryClient, BETWEEN)).toBe(0);
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([REPLY]);
  });

  it('keeps the press’s count when the page lands before the answer, and when the press fails', async () => {
    const queryClient = seeded();
    const replies = repliesOnTheirWay(queryClient);
    const sent = deferred<LikeState>();
    const done = toggle(queryClient, () => sent.promise).mutate(onComment(true, REPLY));
    await settle();
    replies.arrive();
    await replies.more;
    // Landed first: REPLY in its place, still at the count the press moved.
    expect(repliesHeld(queryClient)).toEqual([[EARLIER, BETWEEN, REPLY], null]);
    expect(commentCountOf(queryClient, REPLY)).toBe(1);
    sent.resolve({ liked: true, likeCount: 3 });
    await done;
    expect(commentCountOf(queryClient, REPLY)).toBe(3);

    // A press that fails after the page landed puts back the count from before it.
    const again = seeded();
    const other = repliesOnTheirWay(again);
    const failing = deferred<LikeState>();
    const failed = toggle(again, () => failing.promise)
      .mutate(onComment(true, REPLY))
      .catch((error: unknown) => error);
    await settle();
    other.arrive();
    await other.more;
    expect(commentCountOf(again, REPLY)).toBe(1);
    failing.reject(refusal(503, 'INTERNAL'));
    expect(await failed).toBeInstanceOf(ApiError);
    expect(commentCountOf(again, REPLY)).toBe(0);
    expect(repliesHeld(again)).toEqual([[EARLIER, BETWEEN, REPLY], null]);
  });
});

describe('a comment’s press while a new 댓글’s read to the end is on its way', () => {
  const MINE = 'f0e1d2c3-b4a5-4968-8776-655443322110';
  const OLDER = '0c4e9a7b-3f21-4d6a-8b5e-9a1f2c3d4e5f';

  /**
   * The reader's new 댓글 MINE written through the comment section's options: its answer lands at
   * once, and its read of the last page held and every page after it (`readOnToTheEnd`) — the
   * query's function called by the write itself, no read of the query the press could see —
   * answers when the test says: COMMENT and its 대댓글 REPLY at the counts from when the page was
   * read (2 and 0), OLDER (another reader's 댓글, new to the screen, '좋아요 7') and MINE.
   */
  async function newCommentOnItsWay(queryClient: QueryClient) {
    vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, 0)));
    const page = deferred<unknown>();
    const get = vi.spyOn(api, 'GET').mockReturnValue(page.promise as never);
    const written = new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, () => undefined),
    ).mutate({ parentId: null, body: '댓글', expectedAccountId: 'user-1' });
    await vi.waitFor(() => {
      expect(get).toHaveBeenCalledTimes(1);
    });
    const arrive = () =>
      page.resolve({
        data: {
          data: [
            ...firstPage(2).items,
            { comment: published(OLDER, 7), replies: [], repliesNextCursor: null },
            { comment: published(MINE, 0), replies: [], repliesNextCursor: null },
          ],
          meta: { nextCursor: null },
        },
        response: new Response(null, { status: 200 }),
      });
    return { written, arrive, get };
  }

  const threadIds = (queryClient: QueryClient) =>
    commentThreadsOf(queryClient.getQueryData<CommentPages>(postCommentsKey(post))).map(
      (thread) => thread.comment.id,
    );

  it('keeps the counts the answers wrote when the pages land after them (ADR-0076 7-27)', async () => {
    const queryClient = seeded();
    const write = await newCommentOnItsWay(queryClient);
    // The read is the write's own: the query is not fetching, so the press cancels nothing and
    // reads nothing after its answer.
    expect(queryClient.getQueryState(postCommentsKey(post))?.fetchStatus).toBe('idle');
    const onTop = deferred<LikeState>();
    const onReply = deferred<LikeState>();
    const top = toggle(queryClient, () => onTop.promise).mutate(onComment(true));
    const reply = toggle(queryClient, () => onReply.promise).mutate(onComment(true, REPLY));
    await settle();
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    expect(commentCountOf(queryClient, REPLY)).toBe(1);
    onTop.resolve({ liked: true, likeCount: 3 });
    onReply.resolve({ liked: true, likeCount: 1 });
    await Promise.all([top, reply]);
    // The pages arrive with MINE in its place — COMMENT and REPLY at the counts from before the
    // presses, which must not take them back off the screen beside the pressed toggles.
    write.arrive();
    await write.written;
    expect(threadIds(queryClient)).toEqual([commentId, OLDER, MINE]);
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    expect(commentCountOf(queryClient, REPLY)).toBe(1);
    // A 댓글 the screen did not hold comes at the page's count.
    expect(commentCountOf(queryClient, OLDER)).toBe(7);
    expect(commentCountOf(queryClient, MINE)).toBe(0);
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId, REPLY]);
    // Nothing more was read for it: the one page read of the write.
    expect(write.get).toHaveBeenCalledTimes(1);
  });

  it('keeps the press’s count when the pages land before the answer, and when the press fails', async () => {
    const queryClient = seeded();
    const write = await newCommentOnItsWay(queryClient);
    const sent = deferred<LikeState>();
    const done = toggle(queryClient, () => sent.promise).mutate(onComment(true));
    await settle();
    write.arrive();
    await write.written;
    // Landed first: MINE in its place, COMMENT still at the count the press moved.
    expect(threadIds(queryClient)).toEqual([commentId, OLDER, MINE]);
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    sent.resolve({ liked: true, likeCount: 5 });
    await done;
    expect(commentCountOf(queryClient, commentId)).toBe(5);

    // A press that fails after the pages landed puts back the count from before it.
    const again = seeded();
    const other = await newCommentOnItsWay(again);
    const failing = deferred<LikeState>();
    const failed = toggle(again, () => failing.promise)
      .mutate(onComment(true))
      .catch((error: unknown) => error);
    await settle();
    other.arrive();
    await other.written;
    expect(commentCountOf(again, commentId)).toBe(3);
    failing.reject(refusal(503, 'INTERNAL'));
    expect(await failed).toBeInstanceOf(ApiError);
    expect(commentCountOf(again, commentId)).toBe(2);
    expect(threadIds(again)).toEqual([commentId, OLDER, MINE]);
  });

  it('ends on the server’s count when a press whose answer was lost fails while they are on their way: its read again of the pages, cancelled to put them in, is made again (ADR-0076 7-28)', async () => {
    const queryClient = seeded();
    // The post page, watching the pages and the reader's likes: a read of them asked for is made.
    const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
    const mine = new QueryObserver(queryClient, myPostLikesQueryOptions(POST, { user: {} }));
    const unsubscribe = [comments.subscribe(() => undefined), mine.subscribe(() => undefined)];
    vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, 0)));
    // The pages as the server holds them once the like committed: COMMENT at '좋아요 3'.
    const committed = {
      data: {
        data: [
          ...firstPage(3).items,
          { comment: published(OLDER, 7), replies: [], repliesNextCursor: null },
          { comment: published(MINE, 0), replies: [], repliesNextCursor: null },
        ],
        meta: { nextCursor: null },
      },
      response: new Response(null, { status: 200 }),
    };
    const likes = deferred<unknown>();
    const reads = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()];
    const signals: (AbortSignal | undefined)[] = [];
    vi.spyOn(api, 'GET').mockImplementation(((path: string, request: { signal?: AbortSignal }) => {
      if (path === '/api/v1/me/likes/posts/{postId}') return likes.promise;
      signals.push(request.signal);
      return reads[signals.length - 1]?.promise;
    }) as never);
    const written = new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, () => undefined),
    ).mutate({ parentId: null, body: '댓글', expectedAccountId: 'user-1' });
    await vi.waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    const failing = deferred<LikeState>();
    const failed = toggle(queryClient, () => failing.promise)
      .mutate(onComment(true))
      .catch((error: unknown) => error);
    await settle();
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    // The like committed, but its answer was lost: the press fails, puts back the count from
    // before it, and reads the reader's likes and the pages again for the server's word.
    failing.reject(refusal(503, 'INTERNAL'));
    await vi.waitFor(() => {
      expect(signals).toHaveLength(2);
    });
    expect(commentCountOf(queryClient, commentId)).toBe(2);
    // The new 댓글's pages land first, read after the commit: they keep the count held (7-27),
    // and the read again on its way is cancelled to put them in — and made again.
    reads[0]?.resolve(committed);
    await written;
    expect(threadIds(queryClient)).toEqual([commentId, OLDER, MINE]);
    expect(commentCountOf(queryClient, commentId)).toBe(2);
    expect(signals[1]?.aborted).toBe(true);
    expect(signals).toHaveLength(3);
    reads[2]?.resolve(committed);
    likes.resolve(answer({ postLiked: false, likedCommentIds: [commentId] }));
    expect(await failed).toBeInstanceOf(ApiError);
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(postCommentsKey(post))?.fetchStatus).toBe('idle');
    });
    // The screen ends on the server's word: the toggle pressed, beside the count with the press.
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    expect(threadIds(queryClient)).toEqual([commentId, OLDER, MINE]);
    for (const stop of unsubscribe) stop();
  });
});
