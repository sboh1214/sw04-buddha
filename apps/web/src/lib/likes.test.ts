import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  ApiError,
  type MyPostLikes,
  type Post,
  type PostAuthor,
  type PublishedComment,
} from './api';
import { type CommentPages, postCommentsKey } from './comments';
import {
  LIKES_KEY,
  type LikeButtonInput,
  type LikePress,
  type LikePressAction,
  commentLikeCount,
  isStaleLikeRefusal,
  likeButtonView,
  likeCountText,
  likeFailureMessage,
  likePressAction,
  likePressId,
  likeRefusalMove,
  likedIn,
  likesUnreadableId,
  movedLikeCount,
  myLikesUnreadable,
  myPostLikesKey,
  postLikeCount,
  withCommentLikeCount,
  withLiked,
  withPostLikeCount,
} from './likes';
import { isPrivateQueryKey } from './market-keys';
import { type Onboarding } from './onboarding';
import { POSTS_KEY, postKey } from './posts';

/**
 * 좋아요 on the web (#49, ADR-0076): the key of what the reader liked, the toggle's rungs, what an
 * answer does to the counts held and what a refusal says — pure functions, so they run here under
 * node.
 */

const POST = 'B7C9A1D2-6F34-4E58-9B0A-2D1E5F8C7A46';
const post = POST.toLowerCase();
const COMMENT = '6F9619FF-8B86-D011-B42D-00C04FC964FF';
const commentId = COMMENT.toLowerCase();
const REPLY = 'd3b07384-d9a0-4c9b-8e2f-2d1c0f8a4b11';
const OTHER = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d';
/** A 대댓글 '답글 더 보기' read into its thread (#48), after the first page's. */
const READ_ON = 'c4ca4238-a0b9-4382-8dcc-509a6f75849b';
/** A deleted 댓글 kept as its placeholder, and the 대댓글 under it. */
const DELETED = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const UNDER_DELETED = 'f0e1d2c3-b4a5-4968-8776-655443322110';

const author: PostAuthor = {
  kind: 'member',
  publicId: 'k7m2p9qx4z',
  nickname: '근거왕',
  imageUrl: null,
  isAdmin: false,
};

const comment = (
  id: string,
  likeCount: number,
  parentId: string | null = null,
): PublishedComment => ({
  state: 'published',
  id,
  parentId,
  body: '댓글',
  author,
  createdAt: '2026-10-19T00:00:00.000Z',
  editedAt: null,
  likeCount,
});

/**
 * Two pages: a 댓글 with a 대댓글 of its first page and one '답글 더 보기' read after it (#48), more
 * still behind its cursor; then another 댓글 and a deleted one's placeholder.
 */
const pages = (): CommentPages => ({
  pages: [
    {
      items: [
        {
          comment: comment(commentId, 2),
          replies: [comment(REPLY, 1, commentId), comment(READ_ON, 4, commentId)],
          repliesNextCursor: 'r2',
        },
      ],
      nextCursor: 'c2',
    },
    {
      items: [
        { comment: comment(OTHER, 0), replies: [], repliesNextCursor: null },
        {
          comment: { state: 'deleted', id: DELETED },
          replies: [comment(UNDER_DELETED, 3, DELETED)],
          repliesNextCursor: null,
        },
      ],
      nextCursor: null,
    },
  ],
  pageParams: [undefined, 'c2'],
});

const published = (likeCount: number): Post =>
  ({ state: 'published', id: post, likeCount, commentCount: 0 }) as unknown as Post;

const mine = (postLiked: boolean, likedCommentIds: string[] = []): MyPostLikes => ({
  postLiked,
  likedCommentIds,
});

const refusal = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);

describe('the key of what the reader liked', () => {
  it('is one private entry per post, by the lower-cased id, apart from the public posts root', () => {
    expect(myPostLikesKey(POST)).toEqual(['likes', 'post', post]);
    expect(myPostLikesKey(POST)).toEqual(myPostLikesKey(post));
    // Never fetched on the server nor dehydrated into the HTML: whose like is nobody else's.
    expect(isPrivateQueryKey(myPostLikesKey(POST))).toBe(true);
    expect(isPrivateQueryKey(LIKES_KEY)).toBe(true);
    // The counts are public and stay under the posts' root, which the server seeds.
    expect(isPrivateQueryKey(postKey(post))).toBe(false);
    expect(isPrivateQueryKey(postCommentsKey(post))).toBe(false);
    expect(myPostLikesKey(post)[0]).not.toBe(POSTS_KEY[0]);
  });

  it('names the presses of each target apart, by the lower-cased ids (ADR-0076 7-30)', () => {
    const comment = { kind: 'comment', id: COMMENT } as const;
    expect(likePressId(POST, comment)).toBe(`likes press ${post} comment ${commentId}`);
    expect(likePressId(post, { kind: 'comment', id: commentId })).toBe(likePressId(POST, comment));
    expect(likePressId(POST, { kind: 'post', id: POST })).toBe(`likes press ${post} post ${post}`);
    // Another target's presses are not this one's, the same id of another kind neither.
    expect(likePressId(POST, { kind: 'comment', id: REPLY })).not.toBe(likePressId(POST, comment));
    expect(likePressId(POST, { kind: 'comment', id: POST })).not.toBe(
      likePressId(POST, { kind: 'post', id: POST }),
    );
  });
});

describe('likedIn and withLiked', () => {
  it('read the post’s state and a comment’s by its id, whatever its case', () => {
    expect(likedIn(undefined, { kind: 'post', id: post })).toBeUndefined();
    expect(likedIn(mine(true), { kind: 'post', id: post })).toBe(true);
    expect(likedIn(mine(false, [commentId]), { kind: 'post', id: post })).toBe(false);
    expect(likedIn(mine(false, [commentId]), { kind: 'comment', id: COMMENT })).toBe(true);
    // A comment written after the answer is in none of its ids: not liked.
    expect(likedIn(mine(true, [commentId]), { kind: 'comment', id: REPLY })).toBe(false);
  });

  it('set one target and leave every other as it was, never listing a comment twice', () => {
    const held = mine(false, [OTHER]);
    expect(withLiked(held, { kind: 'post', id: post }, true)).toEqual(mine(true, [OTHER]));
    expect(withLiked(held, { kind: 'comment', id: COMMENT }, true)).toEqual(
      mine(false, [OTHER, commentId]),
    );
    expect(withLiked(mine(false, [commentId]), { kind: 'comment', id: COMMENT }, true)).toEqual(
      mine(false, [commentId]),
    );
    expect(
      withLiked(mine(true, [OTHER, commentId]), { kind: 'comment', id: COMMENT }, false),
    ).toEqual(mine(true, [OTHER]));
    // The held answer itself is never changed in place (TanStack compares references).
    expect(held).toEqual(mine(false, [OTHER]));
  });
});

describe('the counts held', () => {
  it('move by one for a press that changes the state, never below zero', () => {
    expect(movedLikeCount(3, false, true)).toBe(4);
    expect(movedLikeCount(3, true, false)).toBe(2);
    expect(movedLikeCount(3, true, true)).toBe(3);
    expect(movedLikeCount(3, false, false)).toBe(3);
    // A count read before somebody else's unlike may already be one short.
    expect(movedLikeCount(0, true, false)).toBe(0);
  });

  it('are the published post’s only: a placeholder has none to read or set', () => {
    expect(postLikeCount(published(5))).toBe(5);
    expect(withPostLikeCount(published(5), 6)).toMatchObject({ likeCount: 6 });
    const placeholder = { state: 'deleted', id: post, commentCount: 1 } as unknown as Post;
    expect(postLikeCount(placeholder)).toBeUndefined();
    expect(withPostLikeCount(placeholder, 6)).toBe(placeholder);
    expect(postLikeCount(undefined)).toBeUndefined();
    expect(withPostLikeCount(undefined, 6)).toBeUndefined();
  });

  it('find and set a 댓글’s or a 대댓글’s count on any page held, and nothing else', () => {
    const held = pages();
    expect(commentLikeCount(held, COMMENT)).toBe(2);
    expect(commentLikeCount(held, REPLY)).toBe(1);
    expect(commentLikeCount(held, OTHER)).toBe(0);
    // A placeholder carries no count (#49: it takes no like).
    expect(commentLikeCount(held, DELETED)).toBeUndefined();
    expect(commentLikeCount(held, UNDER_DELETED)).toBe(3);
    expect(commentLikeCount(held, READ_ON)).toBe(4);
    expect(commentLikeCount(undefined, COMMENT)).toBeUndefined();

    const reply = withCommentLikeCount(held, REPLY, 7);
    expect(commentLikeCount(reply, REPLY)).toBe(7);
    expect(commentLikeCount(reply, COMMENT)).toBe(2);
    expect(reply?.pages[1]).toEqual(held.pages[1]);
    expect(reply?.pageParams).toEqual(held.pageParams);
    // A 대댓글 '답글 더 보기' read is set the same way, and the thread keeps the cursor of the rest
    // (#48): a count never costs the thread its '답글 더 보기'.
    const readOn = withCommentLikeCount(held, READ_ON, 5);
    expect(commentLikeCount(readOn, READ_ON)).toBe(5);
    expect(commentLikeCount(readOn, REPLY)).toBe(1);
    expect(readOn?.pages[0]?.items[0]?.repliesNextCursor).toBe('r2');
    expect(reply?.pages[0]?.items[0]?.repliesNextCursor).toBe('r2');
    const other = withCommentLikeCount(held, OTHER, 1);
    expect(commentLikeCount(other, OTHER)).toBe(1);
    expect(other?.pages[0]).toEqual(held.pages[0]);
    expect(withCommentLikeCount(held, DELETED, 9)?.pages[1]?.items[1]?.comment).toEqual({
      state: 'deleted',
      id: DELETED,
    });
    expect(withCommentLikeCount(undefined, COMMENT, 1)).toBeUndefined();
    // The pages held are never changed in place.
    expect(held).toEqual(pages());
  });

  it('read as ‘좋아요 N’, a 0 written as 0 and no number format of the browser’s', () => {
    expect(likeCountText(0)).toBe(`${copy.likeToggle} 0`);
    expect(likeCountText(12_345)).toBe(`${copy.likeToggle} 12345`);
  });
});

/** A signed-in reader whose likes have answered "not liked", nothing in flight. */
const settled: LikeButtonInput = {
  sessionPending: false,
  signedIn: true,
  mine: { isFetched: true, liked: false },
  saving: false,
};

describe('likeButtonView (#49, ADR-0076)', () => {
  it('waits, unpressed, until the session is known, whatever the cache holds', () => {
    // The server render and the hydrating one are always here (`useSession`), so the HTML says
    // nothing about anybody's likes — only the public count, which every rung draws.
    for (const liked of [true, false, undefined]) {
      expect(
        likeButtonView({ ...settled, sessionPending: true, mine: { isFetched: true, liked } }),
      ).toEqual({ kind: 'pending' });
    }
  });

  it('is a visitor’s button, even with a previous account’s likes still in the cache', () => {
    expect(likeButtonView({ ...settled, signedIn: false })).toEqual({ kind: 'signed-out' });
    expect(
      likeButtonView({ ...settled, signedIn: false, mine: { isFetched: true, liked: true } }),
    ).toEqual({ kind: 'signed-out' });
  });

  it('waits for the first read of a member’s likes, and cannot be pressed when it failed', () => {
    expect(likeButtonView({ ...settled, mine: { isFetched: false, liked: undefined } })).toEqual({
      kind: 'pending',
    });
    expect(likeButtonView({ ...settled, mine: { isFetched: true, liked: undefined } })).toEqual({
      kind: 'unavailable',
    });
  });

  it('toggles: an unpressed press likes, a pressed one takes it back, and one on the wire waits', () => {
    expect(likeButtonView(settled)).toEqual({ kind: 'toggle', pressed: false, press: 'like' });
    expect(likeButtonView({ ...settled, mine: { isFetched: true, liked: true } })).toEqual({
      kind: 'toggle',
      pressed: true,
      press: 'unlike',
    });
    expect(
      likeButtonView({ ...settled, mine: { isFetched: true, liked: true }, saving: true }),
    ).toEqual({ kind: 'toggle', pressed: true, press: 'wait' });
  });

  it('sends the state a press asks for, and nothing while one is on the wire', () => {
    const sent: Record<LikePress, LikePressAction | null> = {
      like: { kind: 'put', liked: true },
      unlike: { kind: 'put', liked: false },
      wait: null,
    };
    for (const [press, action] of Object.entries(sent)) {
      expect(
        likePressAction(
          { kind: 'toggle', pressed: press === 'unlike', press: press as LikePress },
          false,
        ),
        press,
      ).toEqual(action);
    }
  });

  it('takes a member’s press to its onboarding step left instead, sending nothing (owner decision 2026-10-20, answer 1)', () => {
    // An account facing a re-consent alone stays on the post page and sees its toggle: a like and
    // an unlike alike go to the step; one on the wire still waits.
    const step: Record<LikePress, LikePressAction | null> = {
      like: { kind: 'step' },
      unlike: { kind: 'step' },
      wait: null,
    };
    for (const [press, action] of Object.entries(step)) {
      expect(
        likePressAction(
          { kind: 'toggle', pressed: press === 'unlike', press: press as LikePress },
          true,
        ),
        press,
      ).toEqual(action);
    }
    // Nothing else changes for it: unknown or unreadable likes send nothing still.
    expect(likePressAction({ kind: 'pending' }, true)).toBeNull();
    expect(likePressAction({ kind: 'unavailable' }, true)).toBeNull();
  });

  it('takes a visitor’s press straight to the login page (owner decision 2026-10-20, answer 8)', () => {
    // As the watch button's: no prompt in place, nothing remembered for after the login.
    expect(likePressAction(likeButtonView({ ...settled, signedIn: false }), false)).toEqual({
      kind: 'login',
    });
  });

  it('sends nothing while the reader’s likes are unknown or unreadable', () => {
    expect(likePressAction({ kind: 'pending' }, false)).toBeNull();
    expect(likePressAction({ kind: 'unavailable' }, false)).toBeNull();
  });
});

describe('myLikesUnreadable (owner decision 2026-10-20, answer 10)', () => {
  const read = { sessionPending: false, signedIn: true, isFetched: true, likes: undefined };

  it('says so exactly when the buttons are on the unavailable rung', () => {
    const cases = [
      read,
      { ...read, sessionPending: true },
      { ...read, signedIn: false },
      { ...read, isFetched: false },
      { ...read, likes: { postLiked: false, likedCommentIds: [] } },
      { ...read, likes: { postLiked: true, likedCommentIds: [] } },
    ];
    for (const input of cases) {
      const liked = input.likes === undefined ? undefined : input.likes.postLiked;
      const view = likeButtonView({
        sessionPending: input.sessionPending,
        signedIn: input.signedIn,
        mine: { isFetched: input.isFetched, liked },
        saving: false,
      });
      expect(myLikesUnreadable(input), JSON.stringify(input)).toBe(view.kind === 'unavailable');
    }
    expect(myLikesUnreadable(read)).toBe(true);
  });

  it('names one line per post page', () => {
    expect(likesUnreadableId('ABC-1')).toBe(likesUnreadableId('abc-1'));
    expect(likesUnreadableId('abc-1')).not.toBe(likesUnreadableId('abc-2'));
  });
});

describe('likeRefusalMove (owner decisions 2026-10-20 answer 1 and 2026-10-21)', () => {
  /** `GET /me`'s `onboarding`: done; then a revision asked for the consent again (#57-5). */
  const DONE: Onboarding = {
    consent: true,
    verification: true,
    nickname: true,
    completed: true,
    interests: true,
    nextStep: null,
    consents: [
      {
        item: 'terms',
        version: 'draft-2026-10-18',
        agreed: true,
        recordedAt: '2026-10-18T00:00:00.000Z',
      },
      {
        item: 'privacy',
        version: 'draft-2026-10-18',
        agreed: true,
        recordedAt: '2026-10-18T00:00:00.000Z',
      },
      {
        item: 'age',
        version: 'draft-2026-10-18',
        agreed: true,
        recordedAt: '2026-10-18T00:00:00.000Z',
      },
    ],
  };
  const RECONSENT: Onboarding = { ...DONE, consent: false, completed: false, nextStep: 'consent' };
  /** An account that never finished: the gate sends it on from the post page too. */
  const FRESH: Onboarding = {
    ...DONE,
    consent: false,
    verification: false,
    nickname: false,
    completed: false,
    interests: false,
    nextStep: 'consent',
    consents: [],
  };
  const onboardingRefusal = refusal(409, 'ONBOARDING_REQUIRED');
  const onPost = (onboarding: Onboarding | undefined, pathname = `/community/posts/${post}`) =>
    likeRefusalMove(onboardingRefusal, { postId: POST, pathname, onboarding });

  it('goes to the step, with no toast, once `GET /me` read again names one on this post’s page', () => {
    // A re-consent account pressed before `GET /me` said so: the server refused, and the press goes
    // where it would have gone had `GET /me` answered first — the URL's case aside.
    expect(onPost(RECONSENT)).toBe('step');
    expect(onPost(RECONSENT, `/community/posts/${POST}`)).toBe('step');
  });

  it('leaves it to the gate when the gate takes the account from the page', () => {
    // One that never finished its onboarding is not let stay on the post page; nor is a re-consent
    // account on a page that is not exempt (it went there meanwhile).
    expect(onPost(FRESH)).toBe('gate');
    expect(onPost(RECONSENT, '/community')).toBe('gate');
  });

  it('says why in a toast only when there is no step to go to', () => {
    // `GET /me` could not be read again (nothing held), or names no step left.
    expect(onPost(undefined)).toBeUndefined();
    expect(onPost(DONE)).toBeUndefined();
    // The reader left the post for a page the gate lets it stay on.
    expect(onPost(RECONSENT, `/community/posts/${OTHER}`)).toBeUndefined();
    expect(onPost(RECONSENT, '/terms')).toBeUndefined();
    // Any other refusal is the toast's (`likeFailureMessage`).
    for (const error of [
      refusal(409, 'LIKE_NOT_ALLOWED', { reason: 'hidden' }),
      refusal(503, 'INTERNAL'),
      new TypeError('fetch failed'),
    ]) {
      expect(
        likeRefusalMove(error, {
          postId: POST,
          pathname: `/community/posts/${post}`,
          onboarding: RECONSENT,
        }),
      ).toBeUndefined();
    }
  });
});

describe('likeFailureMessage', () => {
  it('says which change did not happen, or why it could not', () => {
    // A gateway's 502 with no envelope of ours, and a request that never left: not reached.
    expect(likeFailureMessage(new ApiError(502, undefined), 'post', true)).toBe(copy.errNetwork);
    expect(likeFailureMessage(new TypeError('fetch failed'), 'comment', false)).toBe(
      copy.errNetwork,
    );
    // The API answered and refused, or failed in its own words: the change that did not happen.
    expect(likeFailureMessage(refusal(503, 'INTERNAL'), 'post', true)).toBe(copy.likeAddFailed);
    const odd = refusal(400, 'VALIDATION_ERROR', [{ path: ['liked'], message: 'x' }]);
    expect(likeFailureMessage(odd, 'post', true)).toBe(copy.likeAddFailed);
    expect(likeFailureMessage(odd, 'comment', false)).toBe(copy.likeRemoveFailed);
    const other = refusal(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'x' }]);
    expect(likeFailureMessage(other, 'post', true)).toBe(copy.sessionChanged);
    expect(likeFailureMessage(refusal(403, 'ONBOARDING_REQUIRED'), 'comment', true)).toBe(
      copy.errPostOnboarding,
    );
  });

  it('names the deleted or hidden post or comment, and the one gone', () => {
    const deleted = refusal(409, 'LIKE_NOT_ALLOWED', { reason: 'deleted' });
    const hidden = refusal(409, 'LIKE_NOT_ALLOWED', { reason: 'hidden' });
    expect(likeFailureMessage(deleted, 'post', true)).toBe(copy.errLikePostDeleted);
    expect(likeFailureMessage(hidden, 'post', true)).toBe(copy.errLikePostHidden);
    expect(likeFailureMessage(deleted, 'comment', true)).toBe(copy.errLikeCommentDeleted);
    expect(likeFailureMessage(hidden, 'comment', true)).toBe(copy.errLikeCommentHidden);
    // A taking back is refused too (ADR-0076 7-6): the toast says the like stays, not that it
    // cannot be pressed.
    expect(likeFailureMessage(deleted, 'post', false)).toBe(copy.errLikePostDeletedRemove);
    expect(likeFailureMessage(hidden, 'post', false)).toBe(copy.errLikePostHiddenRemove);
    expect(likeFailureMessage(deleted, 'comment', false)).toBe(copy.errLikeCommentDeletedRemove);
    expect(likeFailureMessage(hidden, 'comment', false)).toBe(copy.errLikeCommentHiddenRemove);
    // A reason this screen does not know: the change that did not happen.
    const unknown = refusal(409, 'LIKE_NOT_ALLOWED', { reason: 'archived' });
    expect(likeFailureMessage(unknown, 'post', true)).toBe(copy.likeAddFailed);
    expect(likeFailureMessage(unknown, 'comment', false)).toBe(copy.likeRemoveFailed);
    const gone = refusal(404, 'NOT_FOUND');
    expect(likeFailureMessage(gone, 'post', true)).toBe(copy.errPostGone);
    expect(likeFailureMessage(gone, 'comment', true)).toBe(copy.errCommentGone);
  });

  it('reads the page again only for a refusal that says it is out of date', () => {
    expect(isStaleLikeRefusal(refusal(409, 'LIKE_NOT_ALLOWED', { reason: 'hidden' }))).toBe(true);
    expect(isStaleLikeRefusal(refusal(404, 'NOT_FOUND'))).toBe(true);
    expect(isStaleLikeRefusal(refusal(403, 'ONBOARDING_REQUIRED'))).toBe(false);
    expect(isStaleLikeRefusal(refusal(503, 'INTERNAL'))).toBe(false);
    expect(isStaleLikeRefusal(new TypeError('fetch failed'))).toBe(false);
  });
});
