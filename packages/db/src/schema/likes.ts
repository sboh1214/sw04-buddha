import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt } from './columns.js';
import { postComments } from './post-comments.js';
import { posts } from './posts.js';

/**
 * 좋아요 (#49, ADR-0076; ADR-0069 decision 4 #49 rows and decision 7): one row per like that
 * stands, on a 근거 글 (`post_likes`) or on a 댓글·대댓글 (`comment_likes`). Liking inserts the row
 * and unliking deletes it (LikesService); a repeated like or an unlike of nothing changes nothing.
 * Display only: the public sees how many rows a post or a comment has, never whose (no list of
 * likers, PRIVATE_DATA `likers`), and nothing turns them into a score, a skill, a rank or Coin, nor
 * sorts by them (N05 §2, D5).
 *
 * Once per person, held by the database (ADR-0069 decision 7: «좋아요 한 번» counts per verified
 * number, not per account):
 * - `phone_hash` is the keyed hash of the liker's verified number when the like was made (the
 *   ADR-0071 hash, `PhoneHasher` in apps/api), and the primary key is (hash, target): an account
 *   that withdraws and signs up again with the same number cannot like the same target twice. The
 *   CHECK keeps it the 64 lower-case hex the hash is.
 * - (`user_id`, target) is UNIQUE as well: one like per account, should an operator change the
 *   account's number by hand (#57-3) after it liked.
 * The constraints, not a read before the write, are what hold this when two requests like at once.
 *
 * A withdrawn account's likes stay and keep counting (#37-17): the account and the target are
 * RESTRICT, as the authors and posts of the comments are — the app deletes a like only when its
 * liker takes it back. buddha_app loses UPDATE (migration 0035): a like is never moved to another
 * target or account, only inserted or deleted.
 */
export const postLikes = pgTable(
  'post_likes',
  {
    postId: uuid()
      .notNull()
      .references(() => posts.id, { onDelete: 'restrict' }),
    /** The account that liked: whose like it is, for the viewer's own state (`GET /me/likes/...`). */
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** Lower-case hex of HMAC-SHA256(PHONE_HASH_KEY, digits) of the liker's number: 64 characters. */
    phoneHash: varchar({ length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    /** One like per verified number and post; also the lookup of a number's likes. */
    primaryKey({ columns: [t.phoneHash, t.postId] }),
    /** One like per account and post; also the lookup of an account's likes. */
    unique('post_likes_user_id_post_id_unique').on(t.userId, t.postId),
    /** A post's like count, on its card and page: an index-only count by post. */
    index('post_likes_post_id_idx').on(t.postId),
    check('post_likes_phone_hash_check', sql`${t.phoneHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * A like on a 댓글 or a 대댓글 (#49: «근거 글과 댓글·대댓글»), held as `post_likes` holds a post's: one
 * per verified number and comment, one per account and comment.
 */
export const commentLikes = pgTable(
  'comment_likes',
  {
    commentId: uuid()
      .notNull()
      .references(() => postComments.id, { onDelete: 'restrict' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    phoneHash: varchar({ length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.phoneHash, t.commentId] }),
    unique('comment_likes_user_id_comment_id_unique').on(t.userId, t.commentId),
    /** A comment's like count, beside it in the thread. */
    index('comment_likes_comment_id_idx').on(t.commentId),
    check('comment_likes_phone_hash_check', sql`${t.phoneHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
