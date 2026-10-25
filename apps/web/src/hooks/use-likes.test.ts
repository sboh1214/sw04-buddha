import { readFileSync } from 'node:fs';
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
import {
  type LikeTarget,
  commentLikeCount,
  likeButtonView,
  likePressAction,
  likePressId,
  likedIn,
  myPostLikesKey,
  postLikeCount,
} from '@/lib/likes';
import { communityPostsKey, postKey } from '@/lib/posts';
import { getQueryClient } from '@/lib/query-client';
import {
  commentsInfiniteQueryOptions,
  createCommentOptions,
  readMoreReplies,
  updateCommentOptions,
} from './use-comments';
import {
  type LikeVariables,
  likePressOptions,
  likePressesOnTheWire,
  myPostLikesQueryOptions,
  updateLikeOptions,
} from './use-likes';
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
/** The account the page shows, which every press here names unless it says otherwise. */
const ACCOUNT = 'user-1';

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
  queryClient.setQueryData(myPostLikesKey(post, ACCOUNT), likes);
  queryClient.setQueryData(communityPostsKey({}), { pages: [], pageParams: [] });
  return queryClient;
}

const likesOf = (queryClient: QueryClient) =>
  queryClient.getQueryData<MyPostLikes>(myPostLikesKey(post, ACCOUNT));
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

/**
 * The reader's edit of COMMENT, answered as edited at the count from when it was saved — 2, the
 * count the pages held before any press: an edit's answer carries the comment's count.
 */
function editComment(queryClient: QueryClient) {
  vi.spyOn(api, 'PUT').mockResolvedValue(
    answer({ ...published(commentId, 2), body: '고친 댓글', editedAt: '2026-10-24T00:00:00.000Z' }),
  );
  return new MutationObserver(
    queryClient,
    updateCommentOptions(queryClient, POST, () => undefined),
  ).mutate({ commentId, body: '고친 댓글', expectedAccountId: 'user-1' });
}

/** COMMENT's text as the pages hold it. */
const commentBodyOf = (queryClient: QueryClient) => {
  const thread = commentThreadsOf(
    queryClient.getQueryData<CommentPages>(postCommentsKey(post)),
  ).find((held) => held.comment.id === commentId);
  return thread?.comment.state === 'published' ? thread.comment.body : thread?.comment.state;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the reader’s likes', () => {
  it('are one private read per post and account on screen, by the lower-cased id, once that account is known (ADR-0091)', async () => {
    const options = myPostLikesQueryOptions(POST, ACCOUNT);
    expect(options.queryKey).toEqual(['likes', 'post', post, ACCOUNT]);
    expect(options.enabled).toBe(true);
    // Signed out, or `GET /me` not answered yet: never asked (the route needs the cookie, and
    // whose likes they would be is unknown).
    expect(myPostLikesQueryOptions(POST, undefined).enabled).toBe(false);
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

describe('the account the toggles draw and name (ADR-0091)', () => {
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

  it('is the one of the `Me` the post page was drawn from, never the session’s', () => {
    // In the render between the session naming B and SessionCacheGuard's reset the toggles still
    // show A's likes, and a press naming the session's account would be taken with B's cookie: B's
    // like set to the opposite of A's. No component renders under node, so the wiring is pinned
    // in the sources: the hooks offer no account (no session id), the button and the page's line
    // hand them the page's writer — the `Me` the post and comment writes name — which keys the
    // likes (above), and a press sends that. e2e likes.spec.ts ('탭의 계정이 …', '탭의 세션이 …')
    // drives both orders.
    expect(source('./use-likes.ts')).not.toMatch(/user\.id|\bmeBelongsTo\b/);
    const button = source('../components/post/like-button.tsx');
    expect(button).toContain('const { accountId } = writer;');
    expect(button).toContain('useLike(postId, target, accountId, writer.failed)');
    expect(button).toContain('expectedAccountId: accountId');
    expect(button).toContain('useMyLikesUnreadable(postId, writer.accountId, writer.failed)');
    expect(button.match(/const writer = usePostWriter\(\);/g)).toHaveLength(2);
    expect(button).not.toMatch(/\blike\.accountId\b/);
  });

  it('counts a `GET /me` that failed without ever answering as likes that could not be read', () => {
    // Whose likes they would be is unknown, so none is read: without this the toggles stood on
    // the pending rung for good, a press doing nothing and nothing said. They take the unreadable
    // likes' rung instead — the count, a button that cannot be pressed, and the page's line saying
    // why (owner decision 2026-10-20, answer 10). e2e likes.spec.ts ('좋아요는 GET /me의 답을 …').
    const hooks = source('./use-likes.ts');
    expect(hooks).toContain(
      'mine: { isFetched: mine.isFetched || accountFailed, liked: likedIn(mine.data, target) },',
    );
    expect(hooks).toContain('isFetched: mine.isFetched || accountFailed,');
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
    expect(invalidated(queryClient, myPostLikesKey(post, ACCOUNT))).toBe(false);
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
    expect(invalidated(queryClient, myPostLikesKey(post, ACCOUNT))).toBe(true);
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

  it('writes only the likes of the account it named, never another account’s, and the count either way (ADR-0091)', async () => {
    // The press names the account whose likes the toggles drew, and every write of the reader's
    // state — the optimistic one, the answer, the rollback — goes into that account's entry: B's,
    // read after `['me']` turned to B (in place, or after SessionCacheGuard's reset), is left
    // alone. One entry for both — the key before ADR-0091 — would carry A's press into B's toggle.
    const queryClient = seeded();
    const others = () => queryClient.getQueryData<MyPostLikes>(myPostLikesKey(post, 'user-2'));
    queryClient.setQueryData<MyPostLikes>(myPostLikesKey(post, 'user-2'), {
      postLiked: false,
      likedCommentIds: [],
    });
    const sent = deferred<LikeState>();
    const press = toggle(queryClient, () => sent.promise);
    const done = press.mutate(onComment(true, COMMENT, 'user-1'));
    await settle();
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
    expect(others()?.likedCommentIds).toEqual([]);
    // The tab switched to user-2 while the press was out.
    queryClient.setQueryData<Partial<Me>>(ME_QUERY_KEY, { id: 'user-2' });
    sent.resolve({ liked: true, likeCount: 3 });
    await done;
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
    expect(others()?.likedCommentIds).toEqual([]);
    // The count is public: the same for whoever reads it.
    expect(commentCountOf(queryClient, commentId)).toBe(3);

    // A failure landing then puts user-1's state back, and leaves user-2's alone.
    queryClient.setQueryData<MyPostLikes>(myPostLikesKey(post, 'user-2'), {
      postLiked: true,
      likedCommentIds: [],
    });
    await expect(
      toggle(queryClient, () => Promise.reject(refusal(503, 'INTERNAL'))).mutate(
        onPost(true, 'user-1'),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(likesOf(queryClient)?.postLiked).toBe(false);
    expect(others()?.postLiked).toBe(true);
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
      queryKey: myPostLikesKey(post, ACCOUNT),
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
      queryKey: myPostLikesKey(post, ACCOUNT),
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

describe('the presses of one target (ADR-0076 7-30)', () => {
  const target: LikeTarget = { kind: 'comment', id: COMMENT };

  /** A like button's presses of COMMENT, as `useLike` makes them: an observer of its own. */
  const button = (
    queryClient: QueryClient,
    put: (variables: LikeVariables) => Promise<LikeState>,
  ) =>
    new MutationObserver(
      queryClient,
      likePressOptions(queryClient, POST, target, () => undefined, put),
    );

  /** What a button of `of` reads to wait, whichever button pressed (`useLike`'s `saving`). */
  const presses = (queryClient: QueryClient, of: LikeTarget = target) =>
    likePressesOnTheWire(queryClient, likePressId(POST, of));

  /** The rung a button of COMMENT draws now (`useLike`). */
  const drawn = (queryClient: QueryClient) =>
    likeButtonView({
      sessionPending: false,
      signedIn: true,
      mine: { isFetched: true, liked: likedIn(likesOf(queryClient), target) },
      saving: presses(queryClient).onTheWire(),
    });

  it('keeps a button drawn anew while its press is on the wire waiting, and sends a press made anyway only once the first has settled, the first’s late answer not written over it', async () => {
    const queryClient = seeded();
    const like = deferred<LikeState>();
    const unlike = deferred<LikeState>();
    const put = vi.fn((variables: LikeVariables) =>
      variables.liked ? like.promise : unlike.promise,
    );
    // The buttons drawn: COMMENT's, and the post's and the 대댓글's, told only of their own.
    const told = { comment: 0, post: 0, reply: 0 };
    const stop = [
      presses(queryClient).subscribe(() => (told.comment += 1)),
      presses(queryClient, { kind: 'post', id: POST }).subscribe(() => (told.post += 1)),
      presses(queryClient, { kind: 'comment', id: REPLY }).subscribe(() => (told.reply += 1)),
    ];
    // The reader likes their own comment: on the wire, pressed and one more — its button told
    // as the press is made.
    const liking = button(queryClient, put).mutate(onComment(true));
    expect(told.comment).toBe(1);
    await settle();
    expect(drawn(queryClient)).toEqual({ kind: 'toggle', pressed: true, press: 'wait' });

    // 수정 opened and closed: the comment's button is drawn anew, with a new observer — idle,
    // though the like is still on the wire. The press is still on the wire for the target, and
    // the button still waits: a press sends nothing.
    const again = button(queryClient, put);
    expect(again.getCurrentResult().isPending).toBe(false);
    expect(drawn(queryClient)).toEqual({ kind: 'toggle', pressed: true, press: 'wait' });
    expect(likePressAction(drawn(queryClient), false)).toBeNull();
    // Only COMMENT's: the post's button and the 대댓글's are not waiting on it.
    expect(presses(queryClient, { kind: 'post', id: POST }).onTheWire()).toBe(false);
    expect(presses(queryClient, { kind: 'comment', id: REPLY }).onTheWire()).toBe(false);

    // An unlike made anyway (a press that beat the button's drawing) moves at once, and waits to
    // be sent until the like has settled.
    const unliking = again.mutate(onComment(false));
    await settle();
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([]);
    expect(commentCountOf(queryClient, commentId)).toBe(2);
    expect(put).toHaveBeenCalledTimes(1);
    // The like committed; its answer lands behind the unlike and is not written over it.
    like.resolve({ liked: true, likeCount: 3 });
    await liking;
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([]);
    expect(commentCountOf(queryClient, commentId)).toBe(2);
    expect(drawn(queryClient)).toEqual({ kind: 'toggle', pressed: false, press: 'wait' });
    // Now the unlike is sent, after the like: the server takes them in the order pressed.
    await settle();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls.map(([variables]) => variables.liked)).toEqual([true, false]);
    unlike.resolve({ liked: false, likeCount: 2 });
    await unliking;
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([]);
    expect(commentCountOf(queryClient, commentId)).toBe(2);
    expect(drawn(queryClient)).toEqual({ kind: 'toggle', pressed: false, press: 'like' });
    // Told of each press made and settled; the other targets' buttons never.
    expect(told).toEqual({ comment: 4, post: 0, reply: 0 });
    for (const unsubscribe of stop) unsubscribe();
  });

  it('sends the next press of the target once the first has failed, and ends on its answer', async () => {
    const queryClient = seeded();
    const like = deferred<LikeState>();
    const unlike = deferred<LikeState>();
    const put = vi.fn((variables: LikeVariables) =>
      variables.liked ? like.promise : unlike.promise,
    );
    const liking = button(queryClient, put)
      .mutate(onComment(true))
      .catch((error: unknown) => error);
    await settle();
    const unliking = button(queryClient, put).mutate(onComment(false));
    await settle();
    expect(put).toHaveBeenCalledTimes(1);
    // The like's answer was lost (it may have committed): the likes and the pages are read again
    // for the server's word, and the unlike goes out after it.
    like.reject(refusal(503, 'INTERNAL'));
    expect(await liking).toBeInstanceOf(ApiError);
    expect(invalidated(queryClient, myPostLikesKey(post, ACCOUNT))).toBe(true);
    expect(invalidated(queryClient, postCommentsKey(post))).toBe(true);
    await settle();
    expect(put).toHaveBeenCalledTimes(2);
    unlike.resolve({ liked: false, likeCount: 2 });
    await unliking;
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([]);
    expect(commentCountOf(queryClient, commentId)).toBe(2);
    expect(presses(queryClient).onTheWire()).toBe(false);
  });

  it('leaves what a newer press showed when an older one fails or answers, and ends on the newest’s answer', async () => {
    // Three presses of COMMENT made before any settled: a like, an unlike, a like again.
    const queryClient = seeded();
    const first = deferred<LikeState>();
    const second = deferred<LikeState>();
    const third = deferred<LikeState>();
    const answers = [first.promise, second.promise, third.promise];
    let sent = 0;
    const put = vi.fn((_variables: LikeVariables) => answers[sent++]!);
    const liking = button(queryClient, put)
      .mutate(onComment(true))
      .catch((error: unknown) => error);
    await settle();
    const unliking = button(queryClient, put).mutate(onComment(false));
    await settle();
    const likingAgain = button(queryClient, put).mutate(onComment(true));
    await settle();
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    // The first fails: what it held (unliked, 2) is not put back over the newest's like.
    first.reject(refusal(503, 'INTERNAL'));
    expect(await liking).toBeInstanceOf(ApiError);
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    // The second answers, sent after the first: not written either.
    await settle();
    second.resolve({ liked: false, likeCount: 2 });
    await unliking;
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    // The newest, sent last, has the last word.
    await settle();
    third.resolve({ liked: true, likeCount: 3 });
    await likingAgain;
    expect(put.mock.calls.map(([variables]) => variables.liked)).toEqual([true, false, true]);
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    expect(presses(queryClient).onTheWire()).toBe(false);
  });

  it('keeps the newest press’s answer when the answers of two presses cross, the older one landing last', async () => {
    // The guard on its own (`updateLikeOptions`, without the scope that keeps a target's presses
    // from crossing): the like committed first and the unlike after it, but the like's answer
    // arrives after the unlike's. Written, it would put back the like and its count — with
    // nothing read again to correct them.
    const queryClient = seeded();
    const like = deferred<LikeState>();
    const unlike = deferred<LikeState>();
    const liking = toggle(queryClient, () => like.promise).mutate(onComment(true));
    await settle();
    const unliking = toggle(queryClient, () => unlike.promise).mutate(onComment(false));
    await settle();
    unlike.resolve({ liked: false, likeCount: 2 });
    await unliking;
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([]);
    expect(commentCountOf(queryClient, commentId)).toBe(2);
    like.resolve({ liked: true, likeCount: 3 });
    await liking;
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([]);
    expect(commentCountOf(queryClient, commentId)).toBe(2);
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
  it('keeps the count of a press on a 댓글 edited while the page is read: the press is done again over it after the edit (ADR-0074 7-34, ADR-0076 7-29)', async () => {
    const queryClient = seeded();
    const replies = repliesOnTheirWay(queryClient);
    // While the page is on its way the reader edits the 댓글 and then likes it: the edit, which
    // the page's read does again over what it puts in, carries the count from before the press.
    await editComment(queryClient);
    const sent = deferred<LikeState>();
    const done = toggle(queryClient, () => sent.promise).mutate(onComment(true));
    await settle();
    sent.resolve({ liked: true, likeCount: 3 });
    await done;
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    replies.arrive();
    await replies.more;
    expect(repliesHeld(queryClient)).toEqual([[EARLIER, BETWEEN, REPLY], null]);
    expect(commentBodyOf(queryClient)).toBe('고친 댓글');
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
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

  it('keeps the count of a press on a 댓글 edited while the pages are read: the press is done again over them after the edit (ADR-0074 7-34, ADR-0076 7-29)', async () => {
    const queryClient = seeded();
    const write = await newCommentOnItsWay(queryClient);
    // The edit lands while the pages are on their way and goes into their read's log; the press
    // after it must too, or the edit done again over the pages takes the press back to 2.
    await editComment(queryClient);
    const sent = deferred<LikeState>();
    const done = toggle(queryClient, () => sent.promise).mutate(onComment(true));
    await settle();
    sent.resolve({ liked: true, likeCount: 3 });
    await done;
    write.arrive();
    await write.written;
    expect(threadIds(queryClient)).toEqual([commentId, OLDER, MINE]);
    expect(commentBodyOf(queryClient)).toBe('고친 댓글');
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
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

  it('keeps the count the answer wrote when the read stops short of the new 댓글: the last page held, read again, goes in at the counts held with the 댓글 at its end (ADR-0074 7-14, ADR-0076 7-27)', async () => {
    const queryClient = seeded();
    vi.spyOn(api, 'POST').mockResolvedValue(answer(published(MINE, 0)));
    const page = deferred<unknown>();
    const get = vi
      .spyOn(api, 'GET')
      .mockReturnValueOnce(page.promise as never)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const written = new MutationObserver(
      queryClient,
      createCommentOptions(queryClient, POST, () => undefined),
    ).mutate({ parentId: null, body: '댓글', expectedAccountId: 'user-1' });
    await vi.waitFor(() => {
      expect(get).toHaveBeenCalledTimes(1);
    });
    const sent = deferred<LikeState>();
    const done = toggle(queryClient, () => sent.promise).mutate(onComment(true));
    await settle();
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    sent.resolve({ liked: true, likeCount: 3 });
    await done;
    // The last page held, read again at COMMENT's count from before the press, with another
    // reader's 댓글 after it and more to read; the next page fails — as a read that failed, MINE
    // goes at the end of that page, whose cursor leaves 더 보기 to bring it into place (#48).
    page.resolve({
      data: {
        data: [
          ...firstPage(2).items,
          { comment: published(OLDER, 7), replies: [], repliesNextCursor: null },
        ],
        meta: { nextCursor: 'after-older' },
      },
      response: new Response(null, { status: 200 }),
    });
    await written;
    expect(get).toHaveBeenCalledTimes(2);
    expect(threadIds(queryClient)).toEqual([commentId, OLDER, MINE]);
    expect(
      queryClient.getQueryData<CommentPages>(postCommentsKey(post))?.pages.at(-1)?.nextCursor,
    ).toBe('after-older');
    expect(commentCountOf(queryClient, commentId)).toBe(3);
    expect(commentCountOf(queryClient, REPLY)).toBe(0);
    // A 댓글 the screen did not hold comes at the page's count.
    expect(commentCountOf(queryClient, OLDER)).toBe(7);
    expect(likesOf(queryClient)?.likedCommentIds).toEqual([commentId]);
  });

  it('ends on the server’s count when a press whose answer was lost fails while they are on their way: its read again of the pages, cancelled to put them in, is made again (ADR-0076 7-28)', async () => {
    const queryClient = seeded();
    // The post page, watching the pages and the reader's likes: a read of them asked for is made.
    const comments = new InfiniteQueryObserver(queryClient, commentsInfiniteQueryOptions(POST));
    const mine = new QueryObserver(queryClient, myPostLikesQueryOptions(POST, ACCOUNT));
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
