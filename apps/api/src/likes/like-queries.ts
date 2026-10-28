import { schema } from '@buddha/db';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * The like counts the public reads (#49, ADR-0076), in one place so the card, the post page and
 * the comment thread count the same way: every like that stands on the target, a withdrawn
 * account's included (#37-17). A count beside the post or the comment and nothing more — it is
 * never a score and nothing orders by it (N05 §2, D5). Each is one walk of the target's index
 * (`post_likes_post_id_idx`, `comment_likes_comment_id_idx`), for the rows a page shows.
 *
 * Aggregates rather than a counter kept on the target: a like and an unlike write their own row
 * only, so two at once never contend on the post's or the comment's row (which a deletion and a
 * hiding lock), and the count is exact by construction.
 */

/** A post's like count, as a column of a query over posts: `postId` is the outer post's id. */
export function postLikeCountSql(postId: SQLWrapper): SQL<number> {
  return sql<number>`(SELECT count(*)::int FROM ${schema.postLikes} WHERE ${schema.postLikes.postId} = ${postId})`;
}

/** A comment's like count, as a column of a query over comments: the outer comment's id. */
export function commentLikeCountSql(commentId: SQLWrapper): SQL<number> {
  return sql<number>`(SELECT count(*)::int FROM ${schema.commentLikes} WHERE ${schema.commentLikes.commentId} = ${commentId})`;
}
