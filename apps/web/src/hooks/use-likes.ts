'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { meBelongsTo } from '@/hooks/use-me';
import {
  type LikeState,
  type MyPostLikes,
  type Post,
  type UpdateLikeBody,
  api,
  unwrap,
} from '@/lib/api';
import { type CommentPages, postCommentsKey } from '@/lib/comments';
import {
  type LikeTarget,
  commentLikeCount,
  isStaleLikeRefusal,
  likedIn,
  movedLikeCount,
  myLikesUnreadable,
  myPostLikesKey,
  postLikeCount,
  withCommentLikeCount,
  withLiked,
  withPostLikeCount,
} from '@/lib/likes';
import { POST_LIST_KEY, postKey } from '@/lib/posts';
import { useSession } from '@/lib/use-session';
import { afterRefusal } from './use-posts';

/**
 * 좋아요 (#49, ADR-0076): what the reader liked on a post page, and the toggles of the post and of
 * each comment under it.
 *
 * Two halves, as the API keeps them. The counts are public: they ride on the post
 * (`['posts', 'post', id]`), its comment pages (`['posts', 'comments', id]`) and the community
 * list's cards, the same for every reader and drawn by the server. Whether the reader liked any of
 * it is theirs alone: one owner-only read per post page (`GET /me/likes/posts/:postId`, under the
 * private `likes` root), which waits for the session like the watch button's (use-watchlist.ts) —
 * the route needs the cookie, and a signed-out request would take a 401 the retry rule refuses to
 * retry.
 *
 * The option factories are exported apart from the hooks so the node test runner reaches them
 * (use-likes.test.ts), as use-watchlist.ts does.
 */

/** Just enough of better-auth's session to say whether anybody is signed in (use-watchlist.ts). */
type SessionLike = { user: unknown } | null;

/** `GET /me/likes/posts/:postId`: whether the reader likes the post, and which comments under it. */
export function myPostLikesQueryOptions(postId: string, session?: SessionLike) {
  const id = postId.toLowerCase();
  return {
    queryKey: myPostLikesKey(id),
    queryFn: async (): Promise<MyPostLikes> =>
      unwrap(await api.GET('/api/v1/me/likes/posts/{postId}', { params: { path: { postId: id } } }))
        .data,
    enabled: session != null,
  };
}

/** What a press sends: the post or the comment, the state to set, and the account on screen. */
export interface LikeVariables extends UpdateLikeBody {
  target: LikeTarget;
}

async function putLike({ target, ...body }: LikeVariables): Promise<LikeState> {
  const id = target.id.toLowerCase();
  return target.kind === 'post'
    ? unwrap(
        await api.PUT('/api/v1/posts/{postId}/like', { params: { path: { postId: id } }, body }),
      ).data
    : unwrap(
        await api.PUT('/api/v1/comments/{commentId}/like', {
          params: { path: { commentId: id } },
          body,
        }),
      ).data;
}

/** Where the count of `target` is held: the post's own entry, or the post's comment pages. */
function countKey(postId: string, target: LikeTarget) {
  return target.kind === 'post' ? postKey(postId) : postCommentsKey(postId);
}

function readCount(queryClient: QueryClient, postId: string, target: LikeTarget) {
  return target.kind === 'post'
    ? postLikeCount(queryClient.getQueryData<Post>(postKey(postId)))
    : commentLikeCount(queryClient.getQueryData<CommentPages>(postCommentsKey(postId)), target.id);
}

function writeCount(queryClient: QueryClient, postId: string, target: LikeTarget, count: number) {
  if (target.kind === 'post') {
    queryClient.setQueryData<Post>(postKey(postId), (post) => withPostLikeCount(post, count));
  } else {
    queryClient.setQueryData<CommentPages>(postCommentsKey(postId), (pages) =>
      withCommentLikeCount(pages, target.id, count),
    );
  }
}

/** Whether a read of `key` is on its way (fetching, or paused until the browser is back online). */
function isOnItsWay(queryClient: QueryClient, key: QueryKey): boolean {
  const state = queryClient.getQueryState(key);
  return state !== undefined && state.fetchStatus !== 'idle';
}

/**
 * A 더 보기 of the comment pages still on its way (`fetchNextPage`: the fetch carries the
 * `fetchMore` meta), as the promise of its read; undefined for any other read, or none.
 */
function loadingMore(queryClient: QueryClient, key: QueryKey): Promise<unknown> | undefined {
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
  if (query === undefined || query.state.fetchStatus === 'idle') return undefined;
  if (query.state.fetchMeta?.fetchMore === undefined) return undefined;
  return query.promise?.catch(() => undefined);
}

/**
 * Before a write into `key`: a read of it on its way left before the like committed and would
 * land after the write with what was there before (A-M5-18, the disputes' seed), so it is
 * cancelled — `cancelled` says one was, and the caller makes it again once the server has
 * answered, since it was asked for (a refocus, another press's failure). A 더 보기 of the comment
 * pages is let be instead: cancelling it would drop the page the reader asked for — likes are
 * pressed far more often than comments are written (use-comments.ts cancels it for a write) — so
 * `more` is its read, after which the count is written again (`showCount`).
 */
async function holdReads(
  queryClient: QueryClient,
  key: QueryKey,
): Promise<{ cancelled: boolean; more: Promise<unknown> | undefined }> {
  const more = loadingMore(queryClient, key);
  if (more !== undefined) return { cancelled: false, more };
  const cancelled = isOnItsWay(queryClient, key);
  if (cancelled) await queryClient.cancelQueries({ queryKey: key, exact: true });
  return { cancelled, more: undefined };
}

/**
 * Reads `key` again so the screen ends on the server's word — after a 더 보기 still on its way,
 * which a read of every page held would otherwise cancel.
 */
async function readAgain(queryClient: QueryClient, key: QueryKey): Promise<void> {
  await loadingMore(queryClient, key);
  await queryClient.invalidateQueries({ queryKey: key, exact: true });
}

/**
 * What `onMutate` hands to the answer and the rollback: the reader's state of the target and its
 * count as they were before the press (`undefined` where the cache held none), the reads it
 * cancelled, and the count the press wrote last (`shown`, see `showCount`).
 */
interface LikeSnapshot {
  liked: boolean | undefined;
  count: number | undefined;
  cancelled: { likes: boolean; count: boolean };
  shown: number | undefined;
}

/**
 * Writes `count` as the target's, and again once `more` — a 더 보기 on its way — has landed: its
 * pages were taken when it left and carry the counts from then. What is written again is the
 * count this press wrote last, so whichever of the press's writes registered first, the 더 보기
 * ends on the latest (the answer's, or the rollback's).
 */
function showCount(
  queryClient: QueryClient,
  postId: string,
  target: LikeTarget,
  press: LikeSnapshot,
  count: number,
  more: Promise<unknown> | undefined,
) {
  press.shown = count;
  writeCount(queryClient, postId, target, count);
  if (more === undefined) return;
  void more.then(() => {
    if (press.shown !== undefined) writeCount(queryClient, postId, target, press.shown);
  });
}

/**
 * `PUT /posts/:postId/like` and `PUT /comments/:commentId/like` as mutation options for the post
 * page of `postId`, optimistic like the watch button's:
 *
 * - `onMutate` cancels the reads still on their way of the reader's likes and of where the
 *   target's count is held (`holdReads`: they may have left before this write and would land
 *   after it with the old state; a 더 보기 of the comment pages is let be and the count written
 *   again after it), keeps what the cache held, and writes the state being asked for and the
 *   count moved by one (`movedLikeCount`), so the button moves on the press.
 * - success writes the server's answer — the state, and the count after the write, which counts
 *   everybody's likes — after holding the reads of the count again. Then a read that the press
 *   cancelled, or that started while it was on the wire (another press's failure reads the
 *   reader's likes and the pages again; a refocus), is made again: it may have been served before
 *   the write committed and would otherwise land last, leaving the toggle or the count as they
 *   were. Nothing else is read for a comment's like (the comment pages would be a read of every
 *   page held for one number); a post's like also reads the post and the community list's cards
 *   again, which only confirms the count.
 * - failure puts back what was held — this target's state and count only, so another comment's
 *   press still on the wire keeps its own — and reads the reader's likes and where the count is
 *   held again, so the screen ends on the server's word (a press whose answer was lost after it
 *   committed is there). A refusal as another account asks for the session again and one for the
 *   onboarding reads `['me']` (`afterRefusal`); one that says the page is out of date — the post
 *   or the comment was deleted or hidden, or is gone (`isStaleLikeRefusal`) — reads the post and
 *   its comments again, so the page shows the placeholder with no count and no button, or the
 *   post's 404 (post-screen.tsx).
 *
 * The reader's state is written only for the account the press was sent for (`meBelongsTo`, as
 * the watch button does): a press whose answer lands after the tab switched accounts
 * (SessionCacheGuard reset the cache) writes nothing into the other account's likes. The count is
 * public and is written either way.
 */
export function updateLikeOptions(
  queryClient: QueryClient,
  postId: string,
  onSessionChanged: () => void,
  put: (variables: LikeVariables) => Promise<LikeState> = putLike,
) {
  const id = postId.toLowerCase();
  const likesKey = myPostLikesKey(id);
  const setLiked = (target: LikeTarget, liked: boolean) =>
    queryClient.setQueryData<MyPostLikes>(
      likesKey,
      (likes) => likes && withLiked(likes, target, liked),
    );
  return {
    mutationFn: put,
    onMutate: async ({ target, liked }: LikeVariables): Promise<LikeSnapshot> => {
      const [likes, counted] = await Promise.all([
        holdReads(queryClient, likesKey),
        holdReads(queryClient, countKey(id, target)),
      ]);
      const before = likedIn(queryClient.getQueryData<MyPostLikes>(likesKey), target);
      const count = readCount(queryClient, id, target);
      const press: LikeSnapshot = {
        liked: before,
        count,
        cancelled: { likes: likes.cancelled, count: counted.cancelled },
        shown: undefined,
      };
      setLiked(target, liked);
      if (before !== undefined && count !== undefined) {
        showCount(
          queryClient,
          id,
          target,
          press,
          movedLikeCount(count, before, liked),
          counted.more,
        );
      }
      return press;
    },
    onSuccess: async (
      state: LikeState,
      { target, expectedAccountId }: LikeVariables,
      snapshot: LikeSnapshot | undefined,
    ) => {
      const press = snapshot ?? {
        liked: undefined,
        count: undefined,
        cancelled: { likes: false, count: false },
        shown: undefined,
      };
      const counted = await holdReads(queryClient, countKey(id, target));
      if (meBelongsTo(queryClient, expectedAccountId)) setLiked(target, state.liked);
      showCount(queryClient, id, target, press, state.likeCount, counted.more);
      const readLikes = press.cancelled.likes || isOnItsWay(queryClient, likesKey);
      const readPages = press.cancelled.count || counted.cancelled;
      await Promise.all([
        readLikes ? readAgain(queryClient, likesKey) : undefined,
        ...(target.kind === 'post'
          ? [
              queryClient.invalidateQueries({ queryKey: postKey(id), exact: true }),
              queryClient.invalidateQueries({ queryKey: POST_LIST_KEY }),
            ]
          : readPages
            ? [readAgain(queryClient, postCommentsKey(id))]
            : []),
      ]);
    },
    onError: async (
      error: Error,
      { target, expectedAccountId }: LikeVariables,
      snapshot: LikeSnapshot | undefined,
    ) => {
      // No snapshot: `onMutate` did not finish, so nothing optimistic was written.
      if (snapshot !== undefined) {
        if (snapshot.liked !== undefined && meBelongsTo(queryClient, expectedAccountId)) {
          setLiked(target, snapshot.liked);
        }
        if (snapshot.count !== undefined) {
          const more = loadingMore(queryClient, countKey(id, target));
          showCount(queryClient, id, target, snapshot, snapshot.count, more);
        }
      }
      await afterRefusal(queryClient, error, onSessionChanged);
      const keys = isStaleLikeRefusal(error)
        ? [likesKey, postKey(id), postCommentsKey(id)]
        : [likesKey, countKey(id, target)];
      await Promise.all(keys.map((key) => readAgain(queryClient, key)));
    },
  };
}

/**
 * One like button: the reader's state of `target` on the post page of `postId` and its toggle,
 * plus the account the screen shows (the session's user id), which a press sends as
 * `expectedAccountId`. Until better-auth has said whose session this is, `sessionPending` is true
 * and `accountId` undefined; the button draws its count, unpressed, until then
 * (`likeButtonView`). Every button of the page shares the one read of the reader's likes.
 */
export function useLike(postId: string, target: LikeTarget) {
  const queryClient = useQueryClient();
  const { data: session, isPending: sessionPending, refetch: refetchSession } = useSession();
  const mine = useQuery(myPostLikesQueryOptions(postId, session));
  const toggle = useMutation(updateLikeOptions(queryClient, postId, () => void refetchSession()));
  return {
    sessionPending,
    signedIn: session != null,
    accountId: session?.user.id,
    mine: { isFetched: mine.isFetched, liked: likedIn(mine.data, target) },
    toggle,
  };
}

/**
 * Whether the post page of `postId` says that the reader's likes could not be read
 * (`myLikesUnreadable`): the same one read every like button of the page shares, so the line
 * shows exactly when the buttons are on the `unavailable` rung.
 */
export function useMyLikesUnreadable(postId: string): boolean {
  const { data: session, isPending: sessionPending } = useSession();
  const mine = useQuery(myPostLikesQueryOptions(postId, session));
  return myLikesUnreadable({
    sessionPending,
    signedIn: session != null,
    isFetched: mine.isFetched,
    likes: mine.data,
  });
}
