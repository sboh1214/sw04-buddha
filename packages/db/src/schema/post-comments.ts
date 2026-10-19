import { desc, sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, timestampTz } from './columns.js';
import { posts } from './posts.js';

/**
 * 댓글·대댓글 (#48, ADR-0074; ADR-0069 decision 2 #45-2…#45-5): one row per comment on a post. Two
 * layers under the post (#45-2 «두층, 댓글과 대댓글만»): a 댓글 (`parent_id` NULL) and a 대댓글 under a
 * 댓글 of the same post. A 대댓글 takes no reply of its own — the API attaches a reply to a 대댓글 to
 * that 대댓글's 댓글 — and the database holds the shape whoever writes (`post_comments_parent_fk`
 * below). Like a post, a comment names no position, order or probability (N05 §2), and nothing
 * counts comments for anybody.
 *
 * - `body`: plain text (#45-3: no formatting, no images; the web links its http(s) addresses when
 *   it draws it), trimmed, line breaks kept, at most 1,000 characters — `varchar` counts code
 *   points as `codePointLength` does.
 * - `edited_at`: the last edit that changed the body ('수정됨', #45-4), or NULL; the previous
 *   versions are `post_comment_revisions`.
 * - `deleted_at`: the author deleted it (#45-5). The row and its body stay, for operators only
 *   (and #184's retention). The public sees '삭제된 글입니다' for a 댓글 while a 대댓글 not deleted
 *   hangs under it, and nothing otherwise.
 * - `hidden_at`: an operator hid it (#45-5; the action, its reason and its reversal come with
 *   #50). '운영 정책에 따라 숨긴 글입니다', no new 대댓글 under it, no edits by its author; deletable.
 * - `is_reply` and `parent_is_reply`: generated, for the parent's foreign key only.
 *
 * The post and the author are RESTRICT, as a post's market and author are: nothing here is ever
 * deleted by the app (a withdrawn author is anonymised, #37-17 and #140).
 */
export const postComments = pgTable(
  'post_comments',
  {
    id: uuid().primaryKey().defaultRandom(),
    postId: uuid()
      .notNull()
      .references(() => posts.id, { onDelete: 'restrict' }),
    /** The 댓글 a 대댓글 hangs under; NULL for a 댓글. */
    parentId: uuid(),
    authorId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    body: varchar({ length: 1_000 }).notNull(),
    createdAt: createdAt(),
    editedAt: timestampTz(),
    deletedAt: timestampTz(),
    hiddenAt: timestampTz(),
    /** Whether the row is a 대댓글: the key a 대댓글's parent is looked up by, with the post and id. */
    isReply: boolean()
      .notNull()
      .generatedAlwaysAs(sql`parent_id IS NOT NULL`),
    /**
     * What a 대댓글 requires of its parent's `is_reply` — false, a 댓글 — and NULL for a 댓글, which
     * has no parent to look up (a foreign key with a NULL column is not checked).
     */
    parentIsReply: boolean().generatedAlwaysAs(sql`CASE WHEN parent_id IS NOT NULL THEN false END`),
  },
  (t) => [
    /** A comment has text: the API trims the body and refuses a blank one. */
    check('post_comments_body_check', sql`btrim(${t.body}) <> ''`),
    /** The key the parent's foreign key references: the primary key alone cannot carry the rule. */
    unique('post_comments_post_id_id_is_reply_unique').on(t.postId, t.id, t.isReply),
    /**
     * The two layers (#45-2), held by the database: a 대댓글's parent is a comment of the same post
     * that is not itself a 대댓글. A 댓글 that has replies cannot become a 대댓글 either (its key is
     * still referenced). RESTRICT, as everything here.
     */
    foreignKey({
      name: 'post_comments_parent_fk',
      columns: [t.postId, t.parentId, t.parentIsReply],
      foreignColumns: [t.postId, t.id, t.isReply],
    }).onDelete('restrict'),
    /** A post's 댓글 in the order they are shown, oldest first (#45-2), page by page. */
    index('post_comments_post_id_created_at_id_idx')
      .on(t.postId, t.createdAt, t.id)
      .where(sql`${t.parentId} IS NULL`),
    /** A 댓글's 대댓글 in the order they are shown, and whether any hangs under it. */
    index('post_comments_parent_id_created_at_id_idx')
      .on(t.parentId, t.createdAt, t.id)
      .where(sql`${t.parentId} IS NOT NULL`),
    /**
     * A post's comment count on its card (#45-7): the comments the public reads, 댓글 and 대댓글
     * alike, never a deleted or a hidden one — exactly what this partial index holds.
     */
    index('post_comments_visible_post_id_idx')
      .on(t.postId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.hiddenAt} IS NULL`),
    /** An account's comments: MY 내 글 (#51), the profile (#41), a withdrawal (#140). */
    index('post_comments_author_id_created_at_idx').on(t.authorId, desc(t.createdAt)),
  ],
);

/**
 * 수정 이력 (#45-4: «댓글·대댓글도 같은 규칙»): every body an edit replaced, for operators only (no
 * route reads it before #50's moderation screens). Append-only like `post_revisions`: buddha_app
 * loses UPDATE (migration 0034); DELETE stays for #184, which removes a version after the
 * retention period counted from `replaced_at` (ADR-0069 decision 7).
 *
 * - `written_at`: when that version began — the comment's creation or the edit before.
 * - `replaced_at`: when an edit replaced it.
 */
export const postCommentRevisions = pgTable(
  'post_comment_revisions',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    commentId: uuid()
      .notNull()
      .references(() => postComments.id, { onDelete: 'restrict' }),
    body: varchar({ length: 1_000 }).notNull(),
    writtenAt: timestampTz().notNull(),
    replacedAt: createdAt(),
  },
  (t) => [
    /** A comment's history in order. */
    index('post_comment_revisions_comment_id_id_idx').on(t.commentId, t.id),
  ],
);
