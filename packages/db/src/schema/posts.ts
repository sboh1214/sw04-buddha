import { type PostDocument } from '@buddha/shared';
import { desc, sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, timestampTz } from './columns.js';
import { markets } from './markets.js';
import { mediaObjects } from './media-objects.js';

/**
 * 근거 글 (#46, ADR-0073; ADR-0069 decision 2 #45): one row per post, on one market (any public
 * status, #45-6), by one account. Writing and trading are independent: nothing here names a
 * position, an order or a probability (N05 §2), and no count of posts is kept for anybody.
 *
 * - `title`: optional, at most 100 characters (owner decision 2026-10-18; `varchar` counts
 *   characters as `codePointLength` does).
 * - `body`: the normalised document (`sanitizePostDocument` in @buddha/shared) — the allow-list's
 *   nodes and marks only, images by media id. Never HTML.
 * - `body_text`: the same body without formatting, derived when it is written (`readPostDocument`):
 *   the list's preview and, with the title, the search (`search_text`).
 * - `image_ids`: the media ids of the body's images in order, each once, derived with `body_text`:
 *   the card's thumbnail is the first, and `GET /media/:mediaId` serves an image only while the
 *   post shows it (it is in this list and the post is neither deleted nor hidden).
 * - `search_text`: generated, title and text, for the community search (`ILIKE`, #45-7) through
 *   the trigram index below.
 * - `edited_at`: the last edit that changed something ('수정됨', #45-4), or NULL; the previous
 *   versions are `post_revisions`.
 * - `deleted_at`: the author deleted it (#45-5). The row and its content stay, for operators only
 *   (and #184's retention); public answers show the placeholder while replies hang under it and
 *   nothing otherwise.
 * - `hidden_at`: an operator hid it (#45-5; the action, its reason and its reversal are #50's
 *   `moderation_actions`). Out of the list, no new replies, no edits by the author; deletable.
 *
 * The market and the author are RESTRICT: markets are never deleted, and a withdrawn author's
 * posts stay with the author anonymised (#37-17, #140).
 */
export const posts = pgTable(
  'posts',
  {
    id: uuid().primaryKey().defaultRandom(),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    authorId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    title: varchar({ length: 100 }),
    body: jsonb().$type<PostDocument>().notNull(),
    bodyText: text().notNull(),
    imageIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    searchText: text()
      .notNull()
      .generatedAlwaysAs(sql`coalesce(title, '') || E'\\n' || body_text`),
    createdAt: createdAt(),
    editedAt: timestampTz(),
    deletedAt: timestampTz(),
    hiddenAt: timestampTz(),
  },
  (t) => [
    /** A title is absent or has text: the API turns a blank one into none. */
    check('posts_title_check', sql`${t.title} IS NULL OR btrim(${t.title}) <> ''`),
    /**
     * The community list, newest first (`GET /posts`, #45-7): only what it shows, so a page is one
     * index walk however many posts were deleted or hidden.
     */
    index('posts_listed_created_at_id_idx')
      .on(desc(t.createdAt), desc(t.id))
      .where(sql`${t.deletedAt} IS NULL AND ${t.hiddenAt} IS NULL`),
    /** One market's posts, newest first: the list's market filter and #47's discussion. */
    index('posts_market_id_created_at_id_idx').on(t.marketId, desc(t.createdAt), desc(t.id)),
    /** An account's posts: MY 내 글 (#51), the profile (#41), a withdrawal (#140). */
    index('posts_author_id_created_at_idx').on(t.authorId, desc(t.createdAt)),
    /**
     * The search (#45-7): a case-insensitive partial match of the title and the text. A trigram
     * GIN index serves `ILIKE '%term%'` for terms of three characters or more; shorter ones (a
     * two-syllable Korean word) cannot use it and read the list's own order instead.
     */
    index('posts_search_text_trgm_idx').using('gin', sql`${t.searchText} gin_trgm_ops`),
  ],
);

/**
 * 수정 이력 (#45-4: «이전 내용은 운영자만 보는 이력»): every version an edit replaced, title and
 * body as they were, for operators only (#50's moderation page,
 * `GET /admin/moderation/posts/:postId`). Append-only: buddha_app loses UPDATE (migration 0033);
 * DELETE stays for #184, which removes a version after the retention period counted from
 * `replaced_at` (ADR-0069 decision 7).
 *
 * - `written_at`: when that version began — the post's creation or the edit before.
 * - `replaced_at`: when an edit replaced it.
 * - `image_ids`: its images, so #184 can tell which images only old versions used.
 */
export const postRevisions = pgTable(
  'post_revisions',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    postId: uuid()
      .notNull()
      .references(() => posts.id, { onDelete: 'restrict' }),
    title: varchar({ length: 100 }),
    body: jsonb().$type<PostDocument>().notNull(),
    bodyText: text().notNull(),
    imageIds: uuid().array().notNull(),
    writtenAt: timestampTz().notNull(),
    replacedAt: createdAt(),
  },
  (t) => [
    /** A post's history in order. */
    index('post_revisions_post_id_id_idx').on(t.postId, t.id),
  ],
);

/**
 * Which post an upload belongs to: written when a post first uses the image (creation or edit)
 * and kept while any version of the post may need it. An image belongs to one post (the unique
 * `media_id`): another post, even the same author's, uploads its own.
 */
export const postImages = pgTable(
  'post_images',
  {
    postId: uuid()
      .notNull()
      .references(() => posts.id, { onDelete: 'restrict' }),
    mediaId: uuid()
      .notNull()
      .unique('post_images_media_id_unique')
      .references(() => mediaObjects.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.mediaId] })],
);
