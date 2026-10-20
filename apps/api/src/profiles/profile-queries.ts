import { schema, type Db } from '@buddha/db';
import { and, count, eq, isNull } from 'drizzle-orm';

/** The public profile's counts (`PublicProfile`). */
export interface ProfileCounts {
  postCount: number;
  commentCount: number;
  receivedLikeCount: number;
}

/** The member's posts the profile counts: theirs, neither deleted nor hidden. */
function visiblePostsOf(authorId: string) {
  const { posts } = schema;
  return and(eq(posts.authorId, authorId), isNull(posts.deletedAt), isNull(posts.hiddenAt));
}

/** The member's 댓글 and 대댓글 the profile counts: theirs, neither deleted nor hidden. */
function visibleCommentsOf(authorId: string) {
  const { postComments } = schema;
  return and(
    eq(postComments.authorId, authorId),
    isNull(postComments.deletedAt),
    isNull(postComments.hiddenAt),
  );
}

/**
 * The public profile's counts (#41, ADR-0069 decision 3 #37-4: «글·댓글 수와 받은 좋아요 합계»). They
 * count what the profile's lists show (#37-14, #51): the member's posts and comments that are
 * neither deleted nor hidden — those on an ended or voided market and those written during a
 * restriction included — and the likes on exactly those (owner decision 2026-10-20: a deleted or
 * hidden post's or comment's likes leave the total). The same visibility a post page reads for
 * each: a 대댓글 under a deleted or hidden 댓글 stays in view and counts, and so does a comment under
 * a hidden post or under a deleted one it keeps as the placeholder. Likes are counted as everywhere
 * (likes/like-queries.ts): every row that stands, a withdrawn liker's included (#37-17), and the
 * member's own on their own post or comment too (#49 lets one like one's own) — the total is the
 * sum of the `likeCount` each of those shows (ADR-0078 7-3, an owner question there).
 *
 * Numbers shown on the profile and nothing more — never a score, a rank or a skill of the member,
 * and nothing orders by them (N04 §4, N05 §2, D5). Each walks the author's index
 * (`posts_author_id_created_at_idx`, `post_comments_author_id_created_at_idx`) and, for the likes,
 * each target's (`post_likes_post_id_idx`, `comment_likes_comment_id_idx`), for one profile.
 *
 * Plain queries rather than scalar subqueries beside the profile's row: drizzle writes a column of
 * a one-table query without its table's name, also inside a `sql` subquery (aliases included), so
 * `post_likes.user_id` would have stood in for the profile's `user_id` there.
 */
export async function readProfileCounts(executor: Db, authorId: string): Promise<ProfileCounts> {
  const { posts, postComments, postLikes, commentLikes } = schema;
  const [postCount, commentCount, postLikeRows, commentLikeRows] = await Promise.all([
    executor.$count(posts, visiblePostsOf(authorId)),
    executor.$count(postComments, visibleCommentsOf(authorId)),
    executor
      .select({ count: count() })
      .from(postLikes)
      .innerJoin(posts, eq(posts.id, postLikes.postId))
      .where(visiblePostsOf(authorId)),
    executor
      .select({ count: count() })
      .from(commentLikes)
      .innerJoin(postComments, eq(postComments.id, commentLikes.commentId))
      .where(visibleCommentsOf(authorId)),
  ]);
  return {
    postCount,
    commentCount,
    receivedLikeCount: (postLikeRows[0]?.count ?? 0) + (commentLikeRows[0]?.count ?? 0),
  };
}
