import * as z from 'zod';

/**
 * 좋아요 (#49, ADR-0076). Owner decisions (ADR-0069 decision 4 #49 rows, decision 2 #45-12,
 * decision 3 #37-17, decision 7): a signed-in account that finished the onboarding likes a 근거 글,
 * a 댓글 or a 대댓글 — its own too — and takes the like back; a person likes a target once, counted
 * per verified number (decision 7), so a withdrawal and a new account on the same number do not
 * like it again. Only the count is public, beside the post, the comment and (later) the profile's
 * post list; nobody sees who liked, and the member sees whether they liked it themselves. A
 * deleted or hidden target takes no like and shows no count; a post of an ended market takes them.
 * A writing restriction (#185) does not stop a like (#45-12). A withdrawn account's likes keep
 * counting (#37-17).
 *
 * Display only (D5, N05 §2): a like count is never a score, a skill, a reputation, a rank or a
 * badge, never pays or charges Coin and writes no ledger entry, never sorts a list (the community
 * list and the market's discussion stay newest first) and sends no notification.
 */

/**
 * How many likes a post or a comment has: every like that stands, a withdrawn account's included
 * (#37-17). A number shown beside it, never a score of its author.
 */
export const likeCountSchema = z.number().int().min(0);

/**
 * The answer of `PUT /posts/:postId/like` and `PUT /comments/:commentId/like`: whether the caller
 * likes it now, and the count after the write. Owner-only: whether somebody liked something is
 * theirs alone (PRIVATE_DATA `likers`).
 */
export const likeStateSchema = z
  .object({ liked: z.boolean(), likeCount: likeCountSchema })
  .meta({ id: 'LikeState' });
export type LikeState = z.infer<typeof likeStateSchema>;

/**
 * `PUT /posts/:postId/like` and `PUT /comments/:commentId/like`: the state to set — `true` likes,
 * `false` takes the like back, either a second time changing nothing — and the account the screen
 * shows (`expectedAccountId`, A-PG-24, as the 관심 등록 does): the cookie decides whose like is
 * written, and a window still showing account A after another one signed in as B would otherwise
 * like as B while A's button said it was A's. Both keys are required: a body that forgot `liked`
 * is a 400, never a guess.
 */
export const updateLikeBodySchema = z
  .object({
    liked: z.boolean(),
    /** The signed-in user id the screen is showing (better-auth `user.id`, text). */
    expectedAccountId: z.string().min(1).max(255),
  })
  .meta({ id: 'UpdateLikeBody' });
export type UpdateLikeBody = z.infer<typeof updateLikeBodySchema>;

/**
 * `GET /me/likes/posts/:postId`: what the caller liked on one post page — the post, and the ids
 * of the 댓글 and 대댓글 under it they like (any page of the thread; a comment no longer in view may
 * be among them, and the screen draws only what it shows). Owner-only, the 관심 등록's way
 * (`GET /me/watchlist/:marketId`): the public post, its comments and their counts are the same
 * answer for everyone, so the server can draw them and nobody's like rides on them.
 */
export const myPostLikesSchema = z
  .object({ postLiked: z.boolean(), likedCommentIds: z.array(z.uuid()) })
  .meta({ id: 'MyPostLikes' });
export type MyPostLikes = z.infer<typeof myPostLikesSchema>;

/**
 * Why a like is refused for its target (LIKE_NOT_ALLOWED): the author deleted it and it stays as
 * its placeholder ('삭제된 글입니다', things hang under it), or an operator hid it (#49: «지운·숨긴
 * 글은 받지 않고»). A target that left every view is NOT_FOUND instead, as it is to the public.
 * Taking a like back is refused the same way: the placeholder shows no count to change.
 */
export const LIKE_NOT_ALLOWED_REASONS = ['deleted', 'hidden'] as const;
export type LikeNotAllowedReason = (typeof LIKE_NOT_ALLOWED_REASONS)[number];
export const likeNotAllowedDetailsSchema = z
  .object({ reason: z.enum(LIKE_NOT_ALLOWED_REASONS) })
  .meta({ id: 'LikeNotAllowedDetails' });
export type LikeNotAllowedDetails = z.infer<typeof likeNotAllowedDetailsSchema>;
