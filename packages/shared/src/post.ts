import * as z from 'zod';
import { cursorQuerySchema } from './api/pagination.js';
import { uuidSchema } from './api/uuid.js';
import { marketStatusSchema } from './enums.js';
import { marketCategoryFilterSchema } from './market.js';
import { codePointLength, postDocumentInputSchema, postDocumentSchema } from './post-document.js';
import { publicIdSchema } from './public-id.js';

/**
 * 근거 글 (#46, ADR-0073). Owner decisions (ADR-0069 decision 2, #45): a post belongs to one market
 * in any public status, has an optional title and a formatted body whose links are the external
 * evidence links, is written by an account that finished the onboarding, can be edited at any time
 * (title and body, never the market; '수정됨', earlier versions for operators only) and deleted by
 * its author, and is hidden — never deleted — by an operator. The community list shows every
 * market's posts newest first, filtered by market and category and searched in title and body;
 * anyone reads, signed in or not. A post never carries its author's position, order or balance
 * (N05 §2, the `author-holding` item of PRIVATE_DATA), nor any score.
 */

/** A title's characters at most (owner decision 2026-10-18: «제목 길이 → 100자»), code points. */
export const POST_TITLE_MAX_LENGTH = 100;

/** A community search term (#45-7: 제목·본문 검색): trimmed, 1..100 characters. */
export const POST_SEARCH_TERM_MAX = 100;

/**
 * A title as a request sends it: optional (#45-1 «제목 선택»), trimmed, one line — no control
 * characters — and at most POST_TITLE_MAX_LENGTH characters. Absent, null or blank is no title.
 * The wire bound (twice the characters, in UTF-16 units) only stops an absurd string before the
 * count; the count is the rule. A lone UTF-16 surrogate becomes U+FFFD, as the body's text does
 * (post-document.ts) and as Postgres would store it anyway — here, so that resending the same
 * title is the same title and changes nothing.
 */
export const postTitleInputSchema = z
  .string()
  .trim()
  .overwrite((title) => title.replace(/\p{Cs}/gu, '�'))
  .max(POST_TITLE_MAX_LENGTH * 2)
  .refine((title) => !/\p{Cc}/u.test(title), {
    error: 'must be one line, without control characters',
  })
  .refine((title) => codePointLength(title) <= POST_TITLE_MAX_LENGTH, {
    error: `at most ${String(POST_TITLE_MAX_LENGTH)} characters`,
  })
  .nullish()
  .transform((title) => (title ? title : null))
  .describe(
    `Optional, one line, at most ${String(POST_TITLE_MAX_LENGTH)} characters; blank is none`,
  );

/**
 * Who wrote a post, as every public answer shows it (ADR-0069 decision 5): the account's public id
 * (the `/u/<publicId>` of #41, never the account id), its CURRENT nickname (#37-3: old posts too),
 * its image (#141; null until it has one, and the web draws the nickname's first letter) and
 * whether it is an operator (#45-9: '운영자' on every post of an admin account — operating rights
 * only, never a forecasting credential). A withdrawn author (#140) is `former_member`, shown as
 * '탈퇴한 사용자' with no link and nothing of the account (#37-16): the projection of the API has
 * one place where #140 makes it.
 */
export const postAuthorSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('member'),
      publicId: publicIdSchema,
      nickname: z.string(),
      imageUrl: z.string().nullable(),
      isAdmin: z.boolean(),
    }),
    z.object({ kind: z.literal('former_member') }),
  ])
  .meta({ id: 'PostAuthor' });
export type PostAuthor = z.infer<typeof postAuthorSchema>;

/**
 * The market a post belongs to, as a card and the post page link to it: its detail opens in every
 * status, closed and settled ones too (#46's acceptance criteria).
 */
export const postMarketSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    title: z.string(),
    status: marketStatusSchema,
    category: z.object({ slug: z.string(), nameKo: z.string() }),
  })
  .meta({ id: 'PostMarket' });
export type PostMarket = z.infer<typeof postMarketSchema>;

/**
 * One card of the community list (owner decisions 2026-10-18: a preview card — the title, two lines
 * of the text without formatting, the first image as a small square thumbnail, the author, the
 * time and the market's title). The comment and like counts the owner listed come with the comments
 * (#48) and the likes (#49): nothing here counts what does not exist yet.
 */
export const postSummarySchema = z
  .object({
    id: z.uuid(),
    title: z.string().nullable(),
    /** The start of the text, non-empty lines only (`postExcerpt`); the web clamps it to two lines. */
    excerpt: z.string(),
    /** The first image (`GET /media/:mediaId`, root-relative), or null. */
    thumbnailUrl: z.string().nullable(),
    author: postAuthorSchema,
    market: postMarketSchema,
    createdAt: z.iso.datetime(),
    /** The last edit ('수정됨'), or null while the post was never edited. */
    editedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'PostSummary' });
export type PostSummary = z.infer<typeof postSummarySchema>;

/** What a post page shows (`GET /posts/:postId`), by the post's state. */
export const POST_STATES = ['published', 'deleted', 'hidden'] as const;
export type PostState = (typeof POST_STATES)[number];

/**
 * A post page. `published`: the whole post. A post its author deleted is `deleted` only while
 * replies hang under it (#45-5: '삭제된 글입니다', the author hidden, never restored) — with none it
 * is gone (NOT_FOUND); there are no replies before #48, so today a deleted post is always gone.
 * `hidden`: an operator hid it (#45-5, the action comes with #50): '운영 정책에 따라 숨긴 글입니다',
 * nothing of the post but its market. Neither placeholder names the author or keeps a word of the
 * post; the original stays for operators only.
 */
export const postSchema = z
  .discriminatedUnion('state', [
    z
      .object({
        state: z.literal('published'),
        id: z.uuid(),
        title: z.string().nullable(),
        body: postDocumentSchema,
        author: postAuthorSchema,
        market: postMarketSchema,
        createdAt: z.iso.datetime(),
        editedAt: z.iso.datetime().nullable(),
      })
      .meta({ id: 'PublishedPost' }),
    z
      .object({ state: z.literal('deleted'), id: z.uuid(), market: postMarketSchema })
      .meta({ id: 'DeletedPost' }),
    z
      .object({ state: z.literal('hidden'), id: z.uuid(), market: postMarketSchema })
      .meta({ id: 'HiddenPost' }),
  ])
  .meta({ id: 'Post' });
export type Post = z.infer<typeof postSchema>;
export type PublishedPost = Extract<Post, { state: 'published' }>;

/**
 * `GET /posts` (no `.meta`: query DTO, expanded per field like `marketListQuerySchema`): newest
 * first, the only order (#45-7). `marketId` lists one market's posts; `category` a category slug
 * resolved like `GET /markets` (a top-level slug includes its sub-categories); `q` a partial,
 * case-insensitive match in the title or the text. Hidden and deleted posts are never listed.
 */
export const postListQuerySchema = cursorQuerySchema.extend({
  marketId: uuidSchema.optional(),
  category: marketCategoryFilterSchema.optional(),
  q: z.string().trim().min(1).max(POST_SEARCH_TERM_MAX).optional(),
});
export type PostListQuery = z.infer<typeof postListQuerySchema>;

/** The account the screen shows, which the cookie must be (A-PG-24, as every owner write). */
const expectedAccountIdSchema = z.string().min(1).max(255);

/**
 * `POST /posts`: a post on one market (any public status, #45-6), with an optional title and a
 * body (see `postDocumentInputSchema`). No position, order or probability rides with it (N05 §2).
 */
export const createPostBodySchema = z
  .object({
    marketId: uuidSchema,
    title: postTitleInputSchema,
    body: postDocumentInputSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'CreatePostBody' });
export type CreatePostBody = z.input<typeof createPostBodySchema>;

/**
 * `PUT /posts/:postId`: the title and the body that replace the post's (#45-4: both may change,
 * the market never). Sending what the post already says changes nothing and marks nothing edited.
 */
export const updatePostBodySchema = z
  .object({
    title: postTitleInputSchema,
    body: postDocumentInputSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'UpdatePostBody' });
export type UpdatePostBody = z.input<typeof updatePostBodySchema>;

/** `POST /posts/:postId/delete`: only the account the screen shows. */
export const deletePostBodySchema = z
  .object({ expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'DeletePostBody' });
export type DeletePostBody = z.infer<typeof deletePostBodySchema>;

/**
 * The answer of a deletion: whether the post stays as the placeholder '삭제된 글입니다' (replies
 * hang under it, #45-5) or is gone from every view. Always gone before #48 brings replies.
 */
export const postDeletionSchema = z
  .object({ id: z.uuid(), placeholder: z.boolean() })
  .meta({ id: 'PostDeletion' });
export type PostDeletion = z.infer<typeof postDeletionSchema>;

/**
 * Why the author cannot edit the post (POST_NOT_EDITABLE): an operator hid it (#45-5: a hidden
 * post cannot be edited, it can be deleted).
 */
export const POST_NOT_EDITABLE_REASONS = ['hidden'] as const;
export type PostNotEditableReason = (typeof POST_NOT_EDITABLE_REASONS)[number];
export const postNotEditableDetailsSchema = z
  .object({ reason: z.enum(POST_NOT_EDITABLE_REASONS) })
  .meta({ id: 'PostNotEditableDetails' });
export type PostNotEditableDetails = z.infer<typeof postNotEditableDetailsSchema>;
