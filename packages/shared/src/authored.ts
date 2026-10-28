import * as z from 'zod';
import { reportReasonSchema } from './enums.js';
import { likeCountSchema } from './like.js';
import { postAuthorSchema, postMarketSchema, postSummarySchema } from './post.js';

/**
 * 작성자별 글·댓글 목록 (#51, ADR-0080): what a member wrote, listed on their public profile and on
 * their own MY '내 글'. Owner decisions (ADR-0069):
 *
 * - The profile's lists (decision 3 #37-14): 글 (근거 글) and 댓글 (댓글 and 대댓글 together) on two
 *   tabs, newest first; what was deleted or hidden is left out, and what sits on an ended or
 *   voided market stays, as all of it does while the member is under a restriction (the owner's
 *   «제재 중인 사람의 글»). They show what the profile's counts count (ADR-0078): the same rule,
 *   so a tab never holds more or fewer items than its number.
 * - MY '내 글' (decision 4 #51, decision 2 #45-5): the same two tabs, newest first, no filter; a
 *   hidden one stays, its content and counts as they are, marked '숨김' with the reason — a report
 *   reason and the operator's explanation (owner decision 2026-10-22) — for the member alone, who
 *   may delete it there; a deleted one is not shown.
 * - Each item leads to its post page and its market, an ended market too (N04 §2, N05 §3), and the
 *   like count rides on it (decision 4 #49).
 *
 * Writing and trading are independent: no item carries the member's position, order, balance or
 * PnL (N04 §2, N05 §2), and the counts are numbers beside an item — never a score, a rank or a
 * skill, and nothing orders by them (N05 §2, D5). A profile's posts are the community list's cards
 * (`PostSummary`): the same card wherever a post is listed.
 */

// ---- a comment, listed by its author ------------------------------------------------------------

/**
 * The post a listed comment sits under, as the public sees it (`GET /posts/:postId`): a published
 * post by its title and the start of its text (`PostSummary.excerpt`: what names a post without a
 * title), and the placeholders by their id alone — a post its author deleted while comments hang
 * under it (a listed comment is one), and a post an operator hid (#45-5) — so no word of those
 * leaves through a comment. Each opens the post page, where the comment is read in place.
 */
export const commentedPostSchema = z
  .discriminatedUnion('state', [
    z
      .object({
        state: z.literal('published'),
        id: z.uuid(),
        title: z.string().nullable(),
        /** The start of the text, non-empty lines only (`postExcerpt`), as a card's. */
        excerpt: z.string(),
      })
      .meta({ id: 'CommentedPublishedPost' }),
    z.object({ state: z.literal('deleted'), id: z.uuid() }).meta({ id: 'CommentedDeletedPost' }),
    z.object({ state: z.literal('hidden'), id: z.uuid() }).meta({ id: 'CommentedHiddenPost' }),
  ])
  .meta({ id: 'CommentedPost' });
export type CommentedPost = z.infer<typeof commentedPostSchema>;

/**
 * One item of a profile's 댓글 tab (#37-14): a 댓글 or a 대댓글 (`parentId` says which) as its post
 * page shows it — the text, the author's public face, the times and the like count — with the post
 * it sits under and that post's market, so the item leads to both. The author is the profile's
 * member, shown as every byline is (ADR-0069 decision 5).
 */
export const authoredCommentSchema = z
  .object({
    id: z.uuid(),
    /** The 댓글 a 대댓글 hangs under; null for a 댓글. */
    parentId: z.uuid().nullable(),
    body: z.string(),
    author: postAuthorSchema,
    createdAt: z.iso.datetime(),
    /** The last edit ('수정됨'), or null while the comment was never edited. */
    editedAt: z.iso.datetime().nullable(),
    likeCount: likeCountSchema,
    post: commentedPostSchema,
    market: postMarketSchema,
  })
  .meta({ id: 'AuthoredComment' });
export type AuthoredComment = z.infer<typeof authoredCommentSchema>;

// ---- MY '내 글' -----------------------------------------------------------------------------------

/**
 * Why an operator hid a post or a comment, as MY '내 글' shows it to its author (owner decision
 * 2026-10-22, ADR-0080: «사유 목록 중 하나 + 운영자 설명»): one of the report reasons (#45-10,
 * `REPORT_REASONS`) and the explanation the operator wrote, if they wrote one — what #50's hiding
 * records (`moderation_actions`, ADR-0081).
 */
export const hiddenReasonSchema = z
  .object({
    /** The report reason the operator picked (#45-10). */
    code: reportReasonSchema,
    /** The operator's explanation, as they wrote it; null when they wrote none. */
    note: z.string().nullable(),
  })
  .meta({ id: 'HiddenReason' });
export type HiddenReason = z.infer<typeof hiddenReasonSchema>;

/**
 * What MY '내 글' says of a post or a comment an operator hid (#45-5: '숨김' and the reason, to the
 * member alone): the reason the standing hiding was recorded with (#50's moderation records; a
 * cancelled hiding no longer hides anything). Null only for an item hidden with no hiding recorded,
 * which nothing writes now. Never the operator who hid it, nor anything of a report (#45-13: the
 * reporter and the operator are not shown).
 */
export const hiddenNoticeSchema = z
  .object({
    /** The reason the standing hiding was recorded with (#50); null when none was recorded. */
    reason: hiddenReasonSchema.nullable(),
  })
  .meta({ id: 'HiddenNotice' });
export type HiddenNotice = z.infer<typeof hiddenNoticeSchema>;

/**
 * One item of MY '내 글''s 글 tab: the member's post as the community card shows it, and `hidden`
 * when an operator hid it (null otherwise). A hidden post's card keeps its title and text — the
 * member's own words, read by the member — but no thumbnail: `GET /media/:mediaId` serves no image
 * of a hidden post.
 */
export const myPostSchema = postSummarySchema
  .extend({ hidden: hiddenNoticeSchema.nullable() })
  .meta({ id: 'MyPost' });
export type MyPost = z.infer<typeof myPostSchema>;

/** One item of MY '내 글''s 댓글 tab: the member's comment, and `hidden` when an operator hid it. */
export const myCommentSchema = authoredCommentSchema
  .extend({ hidden: hiddenNoticeSchema.nullable() })
  .meta({ id: 'MyComment' });
export type MyComment = z.infer<typeof myCommentSchema>;
