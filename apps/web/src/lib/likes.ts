import { LIKE_NOT_ALLOWED_REASONS, type LikeNotAllowedReason } from '@buddha/shared';
import { copy } from '@/copy';
import {
  type MyPostLikes,
  type Post,
  type PostComment,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
} from './api';
import { type CommentPages } from './comments';
import { type Onboarding, hasOnboardingStepLeft, needsOnboarding } from './onboarding';
import { postPath } from './posts';

/**
 * 좋아요 (#49, ADR-0076) as the post page and the cards draw them: the cache key of what the
 * reader liked, the toggle's rungs, what a like's answer does to the counts held, and what a
 * refusal says. Pure functions of the API's answers, apart from the components and the hooks so
 * the node test runner reaches them (the rule `lib/watchlist.ts` follows).
 *
 * Owner decisions (ADR-0069 decision 4, the #49 rows; decision 7): a 근거 글, a 댓글 and a 대댓글
 * take likes, one's own too; only the count is shown — beside the post, the comment and on the
 * card — never who liked, and the reader sees whether they liked it themselves. A deleted or
 * hidden one takes none and shows no count (its placeholder has none); a post of an ended market
 * takes them. An account that finished the onboarding likes (#57-8); a visitor reads the counts,
 * and a press takes them to the login page and back to the post (owner decision 2026-10-20,
 * answer 8 — the watch button's way). Display only (D5, N05 §2): a count is never a score or a
 * rank, pays nothing and sorts nothing.
 */

// ---- cache key ---------------------------------------------------------------------------------

/**
 * What the reader liked (`GET /me/likes/posts/:postId`), one entry per post page: the reader's
 * own, read with their cookie, so the root is in `PRIVATE_QUERY_ROOTS` (market-keys.ts) — never
 * fetched on the server, never dehydrated, and reset with every other personal entry when the
 * session changes (SessionCacheGuard). No key under it says whose it is. The counts are public
 * and ride on the post, the comments and the cards (`likeCount`), the same for everyone.
 */
export const LIKES_KEY = ['likes'] as const;

export const myPostLikesKey = (postId: string) =>
  [...LIKES_KEY, 'post', postId.toLowerCase()] as const;

// ---- what is liked -----------------------------------------------------------------------------

/** What a like button is for: the post of the page, or a 댓글 or a 대댓글 under it. */
export type LikeTarget = { kind: 'post'; id: string } | { kind: 'comment'; id: string };

/**
 * Whether the reader likes `target`, by what `GET /me/likes/posts/:postId` answered; undefined
 * while nothing has answered. A comment written after that answer is in none of its ids, and
 * nobody can have liked it from this account without this page writing it in (`withLiked`).
 */
export function likedIn(likes: MyPostLikes | undefined, target: LikeTarget): boolean | undefined {
  if (likes === undefined) return undefined;
  const id = target.id.toLowerCase();
  return target.kind === 'post' ? likes.postLiked : likes.likedCommentIds.includes(id);
}

/** `likes` with the reader's state of `target` set to `liked`, every other target as it was. */
export function withLiked(likes: MyPostLikes, target: LikeTarget, liked: boolean): MyPostLikes {
  if (target.kind === 'post') return { ...likes, postLiked: liked };
  const id = target.id.toLowerCase();
  const others = likes.likedCommentIds.filter((held) => held !== id);
  return { ...likes, likedCommentIds: liked ? [...others, id] : others };
}

// ---- the counts held ---------------------------------------------------------------------------

/**
 * The count a press shows before the server answers: one more for a like, one fewer for an
 * unlike, nothing when the state does not change. Never below zero — a count read before
 * somebody else's unlike may already be one short of what the reader remembers.
 */
export function movedLikeCount(count: number, from: boolean, to: boolean): number {
  if (from === to) return count;
  return Math.max(0, count + (to ? 1 : -1));
}

/** The post's count, while it is published (a placeholder has none). */
export function postLikeCount(post: Post | undefined): number | undefined {
  return post?.state === 'published' ? post.likeCount : undefined;
}

/** `post` with its count set to `count`; a placeholder, or no post, as it was. */
export function withPostLikeCount(post: Post | undefined, count: number): Post | undefined {
  return post?.state === 'published' ? { ...post, likeCount: count } : post;
}

/** The count of the published comment `commentId` among the pages held, if they hold it. */
export function commentLikeCount(
  pages: CommentPages | undefined,
  commentId: string,
): number | undefined {
  const id = commentId.toLowerCase();
  for (const page of pages?.pages ?? []) {
    for (const thread of page.items) {
      for (const comment of [thread.comment, ...thread.replies]) {
        if (comment.id === id && comment.state === 'published') return comment.likeCount;
      }
    }
  }
  return undefined;
}

/**
 * The pages with the count of the published comment `commentId` — a 댓글 or a 대댓글, on any page
 * and among the 대댓글 '답글 더 보기' read into its thread (#48) — set to `count`. Every other
 * comment, a placeholder of the same id, and each thread's cursor of the rest, as they were.
 */
export function withCommentLikeCount(
  pages: CommentPages | undefined,
  commentId: string,
  count: number,
): CommentPages | undefined {
  if (pages === undefined) return undefined;
  const id = commentId.toLowerCase();
  const set = (comment: PostComment): PostComment =>
    comment.id === id && comment.state === 'published' ? { ...comment, likeCount: count } : comment;
  return {
    ...pages,
    pages: pages.pages.map((page) => ({
      ...page,
      items: page.items.map((thread) => ({
        ...thread,
        comment: set(thread.comment),
        replies: thread.replies.map(set),
      })),
    })),
  };
}

/**
 * '좋아요 N': the count beside a post, a comment and on a card. A 0 is written as 0. Written with
 * `String`, as '댓글 N' is (`commentCountText`): the card is drawn on the server and in the browser,
 * whose number data never have to agree.
 */
export function likeCountText(count: number): string {
  return `${copy.likeToggle} ${String(count)}`;
}

// ---- the toggle ------------------------------------------------------------------------------

/** What a press of the toggle does once the reader's state is known. */
export type LikePress = 'like' | 'unlike' | 'wait';

/**
 * What a like button draws. The count is drawn on every rung — it is public, the post's in the
 * server's HTML and a comment's in the comments the browser reads — and only the reader's own
 * state waits for the browser:
 * - `pending`: the session, or the reader's likes, not known yet — the count, unpressed, and a
 *   press sends nothing;
 * - `unavailable`: signed in, and the read of the reader's likes failed before any succeeded —
 *   the count, and a button that cannot be pressed (`aria-disabled`), since drawing it unpressed
 *   would tell a reader who came to take a like back that there is none; the page says why in a
 *   line of text (`myLikesUnreadable`, owner decision 2026-10-20, answer 10);
 * - `signed-out`: a press goes to the login page, told to come back to the post (#49: a visitor
 *   does not like; owner decision 2026-10-20, answer 8);
 * - `toggle`: pressed or not, and what a press sends.
 */
export type LikeButtonView =
  | { kind: 'pending' }
  | { kind: 'unavailable' }
  | { kind: 'signed-out' }
  | { kind: 'toggle'; pressed: boolean; press: LikePress };

export interface LikeButtonInput {
  /**
   * better-auth has not said who is signed in yet. Always true on the server and through
   * hydration (`useSession`), which is what keeps the post page's HTML the same for every reader.
   */
  sessionPending: boolean;
  signedIn: boolean;
  /**
   * The reader's likes (`GET /me/likes/posts/:postId`) as `useQuery` reports them. `isFetched`: a
   * read has answered — with the likes or with a failure — since the entry was made (a session
   * change makes a new one); it stays true through later reads, so a toggle on screen is never
   * swapped back for the pending rung while it holds the keyboard focus (the watch button's
   * reason, lib/watchlist.ts). `liked` is undefined before the likes are known and after their
   * first read failed; a later failed read keeps what the last good one said.
   */
  mine: { isFetched: boolean; liked: boolean | undefined };
  /** A press of this button is on the wire. */
  saving: boolean;
}

/**
 * The button's rung. While a press is on the wire the toggle shows where it is going (the
 * optimistic state) and a second press waits: two writes in flight could land in either order and
 * leave the screen and the server disagreeing.
 */
export function likeButtonView(input: LikeButtonInput): LikeButtonView {
  if (input.sessionPending) return { kind: 'pending' };
  if (!input.signedIn) return { kind: 'signed-out' };
  if (input.mine.liked === undefined) {
    return input.mine.isFetched ? { kind: 'unavailable' } : { kind: 'pending' };
  }
  const pressed = input.mine.liked;
  if (input.saving) return { kind: 'toggle', pressed, press: 'wait' };
  return { kind: 'toggle', pressed, press: pressed ? 'unlike' : 'like' };
}

/**
 * What a press of a like button asks for: the login page, the reader's onboarding step left, or
 * the state to send (`PUT …/like`).
 */
export type LikePressAction =
  { kind: 'login' } | { kind: 'step' } | { kind: 'put'; liked: boolean };

/**
 * What a press of the button on rung `view` does. A visitor's goes to the login page, which comes
 * back to the post (the watch button's `watchPressAction`); nothing is remembered for after it,
 * so the reader presses again. A toggle's sends its `press` — unless the reader has an onboarding
 * step left (`stepLeft`, `useOnboardingEntry`): an account facing a re-consent alone stays on the
 * post page (the gate's exemption, ADR-0073), reads its likes (a session is enough for that) and
 * sees the toggle, but a like or an unlike needs the onboarding done (#57-8), so the press goes to
 * that step instead, which comes back to the post, and sends nothing (owner decision 2026-10-20,
 * answer 1 — the post page's 글쓰기·수정 and comment boxes' way). Nothing is remembered for after
 * the step either. `null` sends nothing: while the reader's state is unknown or unreadable, and
 * while a press is on the wire — so the second click of a double-click on 좋아요 never sends an
 * unlike behind the like.
 */
export function likePressAction(view: LikeButtonView, stepLeft: boolean): LikePressAction | null {
  switch (view.kind) {
    case 'signed-out':
      return { kind: 'login' };
    case 'pending':
    case 'unavailable':
      return null;
    case 'toggle':
      switch (view.press) {
        case 'wait':
          return null;
        case 'like':
          return stepLeft ? { kind: 'step' } : { kind: 'put', liked: true };
        case 'unlike':
          return stepLeft ? { kind: 'step' } : { kind: 'put', liked: false };
      }
  }
}

// ---- the reader's likes unreadable ------------------------------------------------------------

/**
 * Whether the page says, in a line of text, that the reader's likes could not be read: signed in,
 * and the read of `GET /me/likes/posts/:postId` failed before any succeeded — exactly when every
 * like button of the page is on the `unavailable` rung (`likeButtonView`). Owner decision
 * 2026-10-20, answer 10: the count stays, the buttons cannot be pressed, and the reason is on the
 * screen, not only in a tooltip and a screen reader's description. One line for the page, not one
 * per button: every button is on that rung at once.
 */
export function myLikesUnreadable(input: {
  sessionPending: boolean;
  signedIn: boolean;
  isFetched: boolean;
  likes: MyPostLikes | undefined;
}): boolean {
  return !input.sessionPending && input.signedIn && input.isFetched && input.likes === undefined;
}

/**
 * The id of that line on the post page of `postId`: every like button on the `unavailable` rung
 * names it as its description (`aria-describedby`). One per page, so the post's id makes it
 * unique.
 */
export function likesUnreadableId(postId: string): string {
  return `likes-unreadable-${postId.toLowerCase()}`;
}

// ---- refusals ----------------------------------------------------------------------------------

/** The reason of a LIKE_NOT_ALLOWED answer (`{ reason }`), when it carries one. */
function notAllowedReason(details: unknown): LikeNotAllowedReason | undefined {
  if (typeof details !== 'object' || details === null || !('reason' in details)) return undefined;
  const { reason } = details;
  return LIKE_NOT_ALLOWED_REASONS.find((known) => known === reason);
}

/**
 * A refusal's toast by what the press asked for: a like that cannot be added, or a like that
 * cannot be taken back (the API refuses both on a deleted or hidden target, ADR-0076 7-6) — a
 * reader who came to take theirs back is told so, not that they cannot press it.
 */
const NOT_ALLOWED_MESSAGES: Record<
  'add' | 'remove',
  Record<LikeTarget['kind'], Record<LikeNotAllowedReason, string>>
> = {
  add: {
    post: { deleted: copy.errLikePostDeleted, hidden: copy.errLikePostHidden },
    comment: { deleted: copy.errLikeCommentDeleted, hidden: copy.errLikeCommentHidden },
  },
  remove: {
    post: { deleted: copy.errLikePostDeletedRemove, hidden: copy.errLikePostHiddenRemove },
    comment: {
      deleted: copy.errLikeCommentDeletedRemove,
      hidden: copy.errLikeCommentHiddenRemove,
    },
  },
};

/**
 * The toast of a press that failed. The optimistic state has been put back by then
 * (`updateLikeOptions`), so it says which change did not happen, or why it could not:
 * - the cookie is another account than the screen's (`expectedAccountId`, A-PG-24): the screen
 *   is stale, as the watch button says;
 * - LIKE_NOT_ALLOWED: the post or the comment was deleted (its placeholder) or hidden meanwhile —
 *   that the like could not be added, or could not be taken back, as the press asked;
 * - NOT_FOUND: it left every view;
 * - ONBOARDING_REQUIRED: the onboarding is not done (a consent a revision asked for again,
 *   #57-5) — shown only when `likeRefusalMove` has nowhere to go: `['me']` could not be read
 *   again or names no step left;
 * - a request that never reached the API, and anything else: the change that did not happen.
 */
export function likeFailureMessage(
  error: unknown,
  target: LikeTarget['kind'],
  liked: boolean,
): string {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  if (isApiError(error, 'LIKE_NOT_ALLOWED')) {
    const reason = notAllowedReason(error.details);
    if (reason !== undefined) return NOT_ALLOWED_MESSAGES[liked ? 'add' : 'remove'][target][reason];
  }
  if (isApiError(error, 'NOT_FOUND')) {
    return target === 'post' ? copy.errPostGone : copy.errCommentGone;
  }
  if (isApiError(error, 'ONBOARDING_REQUIRED')) return copy.errPostOnboarding;
  if (isApiUnreachable(error)) return copy.errNetwork;
  return liked ? copy.likeAddFailed : copy.likeRemoveFailed;
}

/**
 * Where a press the server refused for the onboarding (ONBOARDING_REQUIRED) goes, once `['me']`
 * has been read again (`afterRefusal` runs before the press's promise rejects): `onboarding` is
 * what it says now, and `pathname` the page shown now.
 *
 * Such a press was sent because `GET /me` had not said yet that a step is left (`likePressAction`
 * takes it to the step once it has): on a hard load the onboarding gate's `GET /me` and the
 * reader's likes are read side by side, and the toggle can stand first — for seconds while
 * `GET /me` is retried. Owner decision 2026-10-20, answer 1: a re-consent account's press goes to
 * its step, coming back to the post; and a refusal for a re-consent moves to the step without a
 * toast, which is said only when the account could not be read again (owner decision 2026-10-21,
 * for #46's refusals). So:
 * - `gate`: the onboarding gate takes the account from this page (`needsOnboarding`: a step left
 *   that the page is not exempt for — an account that never finished its onboarding): nothing to
 *   say, the gate goes to the step;
 * - `step`: the reader is still on this post's page, which the gate lets an account facing a
 *   re-consent alone stay on, and a step is left: the press goes to it now, no toast;
 * - undefined: anything else — another refusal, `['me']` not read again (a failure keeps what it
 *   held, if anything) or naming no step, or the reader gone from the post meanwhile — and the
 *   toast says why (`likeFailureMessage`).
 */
export function likeRefusalMove(
  error: unknown,
  at: { postId: string; pathname: string; onboarding: Onboarding | undefined },
): 'gate' | 'step' | undefined {
  if (!isApiError(error, 'ONBOARDING_REQUIRED')) return undefined;
  if (needsOnboarding(at.pathname, at.onboarding)) return 'gate';
  const onThePost = at.pathname.toLowerCase() === postPath(at.postId).toLowerCase();
  return onThePost && hasOnboardingStepLeft(at.onboarding) ? 'step' : undefined;
}

/**
 * Whether a refusal means the page is out of date — the post or the comment was deleted or
 * hidden, or is gone — so the hooks read the post and its comments again and the page shows
 * what they are now (the placeholder, with no count and no button, or the post's 404).
 */
export function isStaleLikeRefusal(error: unknown): boolean {
  return isApiError(error, 'LIKE_NOT_ALLOWED') || isApiError(error, 'NOT_FOUND');
}
