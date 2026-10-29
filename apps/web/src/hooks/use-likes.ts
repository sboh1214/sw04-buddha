'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
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
  likePressId,
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
import { landWrite } from './use-comments';
import { afterRefusal } from './use-posts';

/**
 * 좋아요 (#49, ADR-0076): what the reader liked on a post page, and the toggles of the post and of
 * each comment under it.
 *
 * Two halves, as the API keeps them. The counts are public: they ride on the post
 * (`['posts', 'post', id]`), its comment pages (`['posts', 'comments', id]`) and the community
 * list's cards, the same for every reader and drawn by the server. Whether the reader liked any of
 * it is theirs alone: one owner-only read per post page (`GET /me/likes/posts/:postId`, under the
 * private `likes` root), kept under the account the page shows and read only once that account is
 * known, like the watch button's (use-watchlist.ts) — never for a visitor: the route needs the
 * cookie, and a signed-out request would take a 401 the retry rule refuses to retry.
 *
 * The option factories are exported apart from the hooks so the node test runner reaches them
 * (use-likes.test.ts), as use-watchlist.ts does.
 */

/**
 * `GET /me/likes/posts/:postId`: whether the reader likes the post, and which comments under it —
 * under the account the page shows (`accountId`, `myPostLikesKey`), and read only once it is known.
 */
export function myPostLikesQueryOptions(postId: string, accountId: string | undefined) {
  const id = postId.toLowerCase();
  return {
    queryKey: myPostLikesKey(id, accountId),
    queryFn: async (): Promise<MyPostLikes> =>
      unwrap(await api.GET('/api/v1/me/likes/posts/{postId}', { params: { path: { postId: id } } }))
        .data,
    enabled: accountId !== undefined,
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

/**
 * Writes `count` as the target's. A comment's goes in as the comment section's writes do
 * (`landWrite`, use-comments.ts — ADR-0074 7-34, ADR-0076 7-29): into the log of every read toward
 * a place on its way — a new 댓글's read to the end, a new 대댓글's read on, '답글 더 보기' — which
 * does it again over its pages after the writes that landed before it. Done once, over pages that
 * were already in, it would be undone by an edit of the same comment that landed earlier in that
 * read: done again over what the read brought, the edit's answer carries the count from when it
 * was saved. A function of the pages held — that comment's count, nothing where it is not — so
 * done again it is the same.
 */
function writeCount(queryClient: QueryClient, postId: string, target: LikeTarget, count: number) {
  if (target.kind === 'post') {
    queryClient.setQueryData<Post>(postKey(postId), (post) => withPostLikeCount(post, count));
  } else {
    landWrite(queryClient, postId, (pages) => withCommentLikeCount(pages, target.id, count));
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
 * `more` is its read, after which the count is written again (`showCount`). '답글 더 보기', a new
 * 대댓글's read on and a new 댓글's read to the end (use-comments.ts) are not reads of the query but
 * pages written into it, which nothing here sees: a page of them that brings a comment already
 * held keeps the count held (`repliesWith`, `withHeldLikeCounts`, lib/comments.ts, ADR-0076 7-17
 * and 7-27), and the count a press writes while one of them reads is done again over its pages
 * after the writes that landed before it (`writeCount`, 7-29), so it cannot take a press back
 * either. A read of the pages a press asked for — a failure's, for the server's word — that one of
 * them cancels to write its page is made again after it (`putReadPages`, 7-28), so the count held,
 * put back, does not outlast it.
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
 * cancelled, the count the press wrote last (`shown`, see `showCount`), and where it stands among
 * the presses of its target (`order`, see `isNewestPress`; undefined where `onMutate` did not
 * finish).
 */
interface LikeSnapshot {
  liked: boolean | undefined;
  count: number | undefined;
  cancelled: { likes: boolean; count: boolean };
  shown: number | undefined;
  order: number | undefined;
}

/**
 * The like presses made through each query client (ADR-0076 7-30), by target (`likePressId`): the
 * number of the newest press of each target pressed, how many of its presses are on the wire, and
 * the buttons drawing it, told when that changes (`likePressesOnTheWire`).
 *
 * Kept here rather than read from the mutation cache (`useIsMutating`): there every button would
 * listen to every event of the cache — each write's, and each render of a `useMutation` whose
 * options are made anew, every like button's among them — and a post page draws a button per
 * comment, some 2,000 with its threads opened (ADR-0074 7-28), so one render of the thread had
 * every button look through the cache once for every other button: the comments' e2e of 30 reply
 * pages timed out on it. Here a press tells the buttons of its own target only.
 */
interface LikePresses {
  newest: Map<string, number>;
  onTheWire: Map<string, number>;
  drawn: Map<string, Set<() => void>>;
}

const likePresses = new WeakMap<QueryClient, LikePresses>();

function pressesOf(queryClient: QueryClient): LikePresses {
  let presses = likePresses.get(queryClient);
  if (presses === undefined) {
    presses = { newest: new Map(), onTheWire: new Map(), drawn: new Map() };
    likePresses.set(queryClient, presses);
  }
  return presses;
}

/**
 * A press of the target `id` made (`onMutate`, before anything is awaited — so in the order of the
 * presses): one more on the wire, and its number, one past the newest.
 */
function pressMade(queryClient: QueryClient, id: string): number {
  const presses = pressesOf(queryClient);
  const order = (presses.newest.get(id) ?? 0) + 1;
  presses.newest.set(id, order);
  presses.onTheWire.set(id, (presses.onTheWire.get(id) ?? 0) + 1);
  presses.drawn.get(id)?.forEach((tell) => tell());
  return order;
}

/** A press of the target `id` settled (`onSettled`): one fewer on the wire. */
function pressSettled(queryClient: QueryClient, id: string): void {
  const presses = pressesOf(queryClient);
  const left = (presses.onTheWire.get(id) ?? 1) - 1;
  if (left > 0) presses.onTheWire.set(id, left);
  else presses.onTheWire.delete(id);
  presses.drawn.get(id)?.forEach((tell) => tell());
}

/**
 * Whether a press of the target `id` (`likePressId`) is on the wire, whichever like button made
 * it, as a store for `useSyncExternalStore`: `subscribe` tells a button when that changes — only
 * the buttons of that target — and `onTheWire` says it.
 */
export function likePressesOnTheWire(queryClient: QueryClient, id: string) {
  return {
    subscribe: (tell: () => void) => {
      const drawn = pressesOf(queryClient).drawn;
      const buttons = drawn.get(id) ?? new Set<() => void>();
      drawn.set(id, buttons);
      buttons.add(tell);
      return () => {
        buttons.delete(tell);
        if (buttons.size === 0 && drawn.get(id) === buttons) drawn.delete(id);
      };
    },
    onTheWire: () => likePresses.get(queryClient)?.onTheWire.has(id) ?? false,
  };
}

/**
 * Whether `press` is still the newest press of `target` (ADR-0076 7-30). Only the newest writes
 * the target's state and count — its answer, its rollback, its count again after a 더 보기: a
 * press made after it showed where the reader went next, and its own answer or rollback is the
 * last word (the presses of a target are sent one after another, `likePressOptions`, so it lands
 * after this one's). An answer that lands behind a newer press is not written over it — the
 * remounted button's case: a like still on the wire, and an unlike pressed meanwhile, whose state
 * a late answer of the like would otherwise take back, with nothing read again to correct it.
 */
function isNewestPress(
  queryClient: QueryClient,
  postId: string,
  target: LikeTarget,
  press: LikeSnapshot,
): boolean {
  if (press.order === undefined) return true;
  return likePresses.get(queryClient)?.newest.get(likePressId(postId, target)) === press.order;
}

/**
 * Writes `count` as the target's, and again once `more` — a 더 보기 on its way — has landed: its
 * pages were taken when it left and carry the counts from then. What is written again is the
 * count this press wrote last, so whichever of the press's writes registered first, the 더 보기
 * ends on the latest (the answer's, or the rollback's) — and nothing once a newer press of the
 * target was made, which writes its own again (`isNewestPress`).
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
    if (press.shown === undefined || !isNewestPress(queryClient, postId, target, press)) return;
    writeCount(queryClient, postId, target, press.shown);
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
 * The reader's state is written only into the likes of the account the press was sent for — the
 * `expectedAccountId` the server compared with the cookie, and the account of the entry the toggle
 * drew (`myPostLikesKey`, as the watch button does): a press whose answer lands after the tab
 * switched accounts writes nothing into the likes another account's page draws. The count is
 * public and is written either way.
 *
 * The answer and the rollback are written only by the newest press of the target
 * (`isNewestPress`, ADR-0076 7-30): one that a newer press of the same target followed still makes
 * its reads again, but leaves the state and the count to that newer press, whose answer lands
 * after it. From `onMutate` to `onSettled` a press counts as on the wire for every button of its
 * target (`likePressesOnTheWire`).
 */
export function updateLikeOptions(
  queryClient: QueryClient,
  postId: string,
  onSessionChanged: () => void,
  put: (variables: LikeVariables) => Promise<LikeState> = putLike,
) {
  const id = postId.toLowerCase();
  // The likes of the account a press names: the entry its toggle drew.
  const likesOf = (account: string) => myPostLikesKey(id, account);
  const setLiked = (likesKey: QueryKey, target: LikeTarget, liked: boolean) =>
    queryClient.setQueryData<MyPostLikes>(
      likesKey,
      (likes) => likes && withLiked(likes, target, liked),
    );
  return {
    mutationFn: put,
    onMutate: async ({
      target,
      liked,
      expectedAccountId,
    }: LikeVariables): Promise<LikeSnapshot> => {
      const likesKey = likesOf(expectedAccountId);
      // Numbered before anything is awaited: in the order of the presses.
      const order = pressMade(queryClient, likePressId(id, target));
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
        order,
      };
      setLiked(likesKey, target, liked);
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
      const likesKey = likesOf(expectedAccountId);
      const press = snapshot ?? {
        liked: undefined,
        count: undefined,
        cancelled: { likes: false, count: false },
        shown: undefined,
        order: undefined,
      };
      // Behind a newer press of the target: its answer is the last word, and the reads of the
      // count are left to it.
      const newest = isNewestPress(queryClient, id, target, press);
      const counted = newest
        ? await holdReads(queryClient, countKey(id, target))
        : { cancelled: false, more: undefined };
      if (newest) {
        setLiked(likesKey, target, state.liked);
        showCount(queryClient, id, target, press, state.likeCount, counted.more);
      }
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
      // No snapshot: `onMutate` did not finish, so nothing optimistic was written. Behind a newer
      // press of the target, putting back what this one held would take that press back too:
      // its answer or its rollback lands after this, and the reads below end on the server's
      // word.
      const likesKey = likesOf(expectedAccountId);
      if (snapshot !== undefined && isNewestPress(queryClient, id, target, snapshot)) {
        if (snapshot.liked !== undefined) setLiked(likesKey, target, snapshot.liked);
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
    // After the answer or the failure has done its writes and reads: the target's buttons wait
    // until then, as a button's own observer did (`likePressesOnTheWire`).
    onSettled: (_state: LikeState | undefined, _error: Error | null, { target }: LikeVariables) => {
      pressSettled(queryClient, likePressId(id, target));
    },
  };
}

/**
 * `updateLikeOptions` for the presses of one `target`, as a like button makes them (ADR-0076
 * 7-30), in one scope per target (TanStack Query's mutation `scope`, named `likePressId`): a
 * second press of the target, however it was made — a button waits while one is on the wire
 * (`useLike`'s `saving`), but a press made before the button was drawn again gets through — is
 * sent only once the first has settled. Its optimistic move shows at once and only its request
 * waits, so the server takes the presses of a target in the order they were made and answers them
 * in that order, and the newest's answer is the one that stays (`isNewestPress`).
 */
export function likePressOptions(
  queryClient: QueryClient,
  postId: string,
  target: LikeTarget,
  onSessionChanged: () => void,
  put?: (variables: LikeVariables) => Promise<LikeState>,
) {
  return {
    ...updateLikeOptions(queryClient, postId, onSessionChanged, put),
    scope: { id: likePressId(postId, target) },
  };
}

/**
 * One like button: the reader's state of `target` on the post page of `postId` — the likes of the
 * account the page shows (`accountId`, the `Me` it was drawn from: `usePostWriter`, which a press
 * sends as `expectedAccountId`) — and its toggle. Never the session's account: in the render
 * between the session naming another account and SessionCacheGuard's reset the session already
 * says B while the toggles still show A's likes, and a press naming B would set B's like to the
 * opposite of A's (ADR-0091). So it offers no account of its own; the likes wait for that account
 * to be known, the button drawing its count, unpressed, until they answer (`likeButtonView`), and
 * `sessionPending` and `signedIn` only say whether anybody is signed in. Every button of the page
 * shares the one read of the reader's likes. `accountFailed` (`usePostWriter`'s `failed`: signed
 * in, and `GET /me` failed without ever answering) means they cannot be read at all: they count as
 * a read that failed — the `unavailable` rung, whose line says why (owner decision 2026-10-20,
 * answer 10) — rather than waiting on the pending one for good.
 *
 * `saving` is whether a press of the target is on the wire — this button's, or one drawn before
 * it (`likePressesOnTheWire`, ADR-0076 7-30). Not this button's `useMutation`: a comment's button
 * is drawn anew when its 수정 is opened and closed, and its new `useMutation` starts idle while the
 * press of the button before it is still on the wire. False on the server and through hydration,
 * when nothing has been pressed.
 */
export function useLike(
  postId: string,
  target: LikeTarget,
  accountId: string | undefined,
  accountFailed: boolean,
) {
  const queryClient = useQueryClient();
  const { data: session, isPending: sessionPending, refetch: refetchSession } = useSession();
  const mine = useQuery(myPostLikesQueryOptions(postId, accountId));
  const toggle = useMutation(
    likePressOptions(queryClient, postId, target, () => void refetchSession()),
  );
  const pressId = likePressId(postId, target);
  const presses = useMemo(() => likePressesOnTheWire(queryClient, pressId), [queryClient, pressId]);
  const saving = useSyncExternalStore(presses.subscribe, presses.onTheWire, () => false);
  return {
    sessionPending,
    signedIn: session != null,
    mine: { isFetched: mine.isFetched || accountFailed, liked: likedIn(mine.data, target) },
    saving,
    toggle,
  };
}

/**
 * Whether the post page of `postId` says that the reader's likes could not be read
 * (`myLikesUnreadable`): the same one read every like button of the page shares — the likes of
 * the account the page shows (`accountId`, `useLike`'s), or none when `GET /me` failed without
 * ever answering (`accountFailed`, `useLike`'s) — so the line shows exactly when the buttons are
 * on the `unavailable` rung.
 */
export function useMyLikesUnreadable(
  postId: string,
  accountId: string | undefined,
  accountFailed: boolean,
): boolean {
  const { data: session, isPending: sessionPending } = useSession();
  const mine = useQuery(myPostLikesQueryOptions(postId, accountId));
  return myLikesUnreadable({
    sessionPending,
    signedIn: session != null,
    isFetched: mine.isFetched || accountFailed,
    likes: mine.data,
  });
}
