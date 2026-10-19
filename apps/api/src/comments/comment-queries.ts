import { schema, type Db } from '@buddha/db';
import { and, eq, isNull, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/**
 * What the post and comment reads ask of `post_comments` (#48, ADR-0074), in one place so the
 * two rules below read the same everywhere: whether something hangs under a post or a 댓글 — which
 * keeps a deleted one as the placeholder '삭제된 글입니다' (#45-5) — and how many comments a post
 * shows.
 */

/**
 * The comment rows a subquery reads, under their own name: inside `EXISTS (…)` and `count(…)` the
 * outer query's `post_comments` stays the outer one.
 */
const under = alias(schema.postComments, 'under');

/**
 * Whether a comment its author did not delete hangs under the post (#45-5: «아래가 달린 것»).
 * Hidden ones count: they stay in view as their placeholder. A deleted one does not: it left
 * every view — a deleted 대댓글 always, a deleted 댓글 when nothing hangs under it either, and then
 * nothing under it is undeleted, so this asks only for an undeleted comment anywhere on the post.
 */
export async function postHasComments(executor: Executor, postId: string): Promise<boolean> {
  const { postComments } = schema;
  const [row] = await executor
    .select({ id: postComments.id })
    .from(postComments)
    .where(and(eq(postComments.postId, postId), isNull(postComments.deletedAt)))
    .limit(1);
  return row !== undefined;
}

/** Whether a 대댓글 its author did not delete hangs under the 댓글 (#45-5), hidden ones counting. */
export async function commentHasReplies(executor: Executor, commentId: string): Promise<boolean> {
  const { postComments } = schema;
  const [row] = await executor
    .select({ id: postComments.id })
    .from(postComments)
    .where(and(eq(postComments.parentId, commentId), isNull(postComments.deletedAt)))
    .limit(1);
  return row !== undefined;
}

/** `postHasComments` as a column of a query over posts: `postId` is the outer post's id. */
export function postHasCommentsSql(postId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM ${schema.postComments} AS ${under} WHERE ${under.postId} = ${postId} AND ${under.deletedAt} IS NULL)`;
}

/** `commentHasReplies` as a column of a query over comments: `commentId` is the outer 댓글's id. */
export function commentHasRepliesSql(commentId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM ${schema.postComments} AS ${under} WHERE ${under.parentId} = ${commentId} AND ${under.deletedAt} IS NULL)`;
}

/**
 * A post's comment count (#45-7: «댓글 수» on its card; ADR-0074 picked which): the comments the
 * public reads as comments, 댓글 and 대댓글 alike — never a deleted one, nor a hidden one, which shows
 * only as its placeholder. A 대댓글 under a deleted or hidden 댓글 counts: it is read in full. One
 * walk of `post_comments_visible_post_id_idx`, which holds exactly these rows. `postId` is the
 * outer post's id.
 */
export function visibleCommentCountSql(postId: SQLWrapper): SQL<number> {
  return sql<number>`(SELECT count(*)::int FROM ${schema.postComments} AS ${under} WHERE ${under.postId} = ${postId} AND ${under.deletedAt} IS NULL AND ${under.hiddenAt} IS NULL)`;
}
