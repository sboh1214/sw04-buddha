import { schema, type Db } from '@buddha/db';
import { type Keyset } from '@buddha/shared';
import { and, asc, eq, isNull, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/**
 * What the post and comment reads ask of `post_comments` (#48, ADR-0074), in one place so the
 * rules below read the same everywhere: whether something hangs under a post or a 댓글 — which
 * keeps a deleted one as the placeholder '삭제된 글입니다' (#45-5) — which 댓글 a page of a post's
 * comments holds, and how many comments a post shows.
 *
 * None of them walks a deleted comment that left every view (Codex review on PR #220): each reads
 * the partial indexes of the comments not deleted (`post_comments_live_*`, migration 0034), so a
 * post or a thread whose authors wrote and deleted without end costs what is in view and no more.
 */

/**
 * The comment rows a subquery reads, under their own name: inside a subquery and `count(…)` the
 * outer query's `post_comments` stays the outer one.
 */
const under = alias(schema.postComments, 'under');

/**
 * Whether the subquery `SELECT true FROM post_comments AS under WHERE <where> ORDER BY <order>`
 * finds a row: the first row in the order of the partial index `where` reads, as a scalar
 * subquery rather than `EXISTS`. Postgres drops an `EXISTS` subquery's ORDER BY and plans it to
 * stop at the first row found, so a post or a thread whose rows are mostly deleted — estimated
 * from the whole table, where rows not deleted are many — could be read by a sequential scan that
 * expects an early match and meets the deleted history first (seen on a table of 450,000 deleted
 * comments and 100,000 others, ADR-0074 decision 4). Ordered as its index is, the first row is one
 * descent of that index and a scan would have to read and sort every row: the index is the plan.
 */
function anyInOrder(where: SQL, order: SQL): SQL<boolean> {
  return sql<boolean>`COALESCE((SELECT true FROM ${schema.postComments} AS ${under} WHERE ${where} ORDER BY ${order} LIMIT 1), false)`;
}

/**
 * Whether a comment its author did not delete hangs under the post (#45-5: «아래가 달린 것»).
 * Hidden ones count: they stay in view as their placeholder. A deleted one does not: it left
 * every view — a deleted 대댓글 always, a deleted 댓글 when nothing hangs under it either, and then
 * nothing under it is undeleted, so this asks only for an undeleted comment anywhere on the post
 * (`postHasCommentsSql`).
 */
export async function postHasComments(executor: Executor, postId: string): Promise<boolean> {
  const { rows } = await executor.execute<{ has: boolean }>(
    sql`SELECT ${postHasCommentsSql(sql`${postId}::uuid`)} AS has`,
  );
  return rows[0]?.has === true;
}

/**
 * Whether a 대댓글 its author did not delete hangs under the 댓글 (#45-5), hidden ones counting: the
 * first of them down `post_comments_live_parent_id_created_at_id_idx` (`anyInOrder`).
 */
export async function commentHasReplies(executor: Executor, commentId: string): Promise<boolean> {
  const { postComments } = schema;
  const [row] = await executor
    .select({ id: postComments.id })
    .from(postComments)
    .where(and(eq(postComments.parentId, commentId), isNull(postComments.deletedAt)))
    .orderBy(asc(postComments.createdAt), asc(postComments.id))
    .limit(1);
  return row !== undefined;
}

/**
 * `postHasComments` as a column of a query over posts: `postId` is the outer post's id. Asked as a
 * 댓글 not deleted or a 대댓글 not deleted — each the first row of its partial index, the post's
 * undeleted 댓글 and its undeleted 대댓글 (`anyInOrder`) — rather than as any comment not deleted,
 * which no index holds alone: that walked the post's deleted comments until the first one in view,
 * all of them when none is (Codex review on PR #220).
 */
export function postHasCommentsSql(postId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`(${anyInOrder(
    sql`${under.postId} = ${postId} AND ${under.parentId} IS NULL AND ${under.deletedAt} IS NULL`,
    sql`${under.createdAt}, ${under.id}`,
  )} OR ${anyInOrder(
    sql`${under.postId} = ${postId} AND ${under.parentId} IS NOT NULL AND ${under.deletedAt} IS NULL`,
    sql`${under.parentCreatedAt}, ${under.parentId}`,
  )})`;
}

/** `commentHasReplies` as a column of a query over comments: `commentId` is the outer 댓글's id. */
export function commentHasRepliesSql(commentId: SQLWrapper): SQL<boolean> {
  return anyInOrder(
    sql`${under.parentId} = ${commentId} AND ${under.deletedAt} IS NULL`,
    sql`${under.createdAt}, ${under.id}`,
  );
}

/**
 * The ids of a page of the post's 댓글 in view, oldest first after `after` (the page's keyset
 * cursor, opened), `limit` at most — as an array the outer query looks its rows up by
 * (`id = ANY (…)`, the primary key). A 댓글 is in view while its author has not deleted it, or a
 * 대댓글 not deleted hangs under it (the placeholder '삭제된 글입니다', #45-5); a deleted 댓글 with
 * nothing in view under it takes no place on a page (ADR-0074 7-2).
 *
 * Two walks, merged (Codex review on PR #220 — the one walk before this read every 댓글 of the
 * post in order, the deleted ones too, and dropped those out of view, so a post whose 댓글 were
 * written and deleted without end cost every page all of them, an empty one too):
 *
 * - the 댓글 not deleted, `limit` at most, down `post_comments_live_post_id_created_at_id_idx`;
 * - the 댓글 that 대댓글 not deleted hang under, in the same order: the post's 대댓글 not deleted
 *   walked in their 댓글's order down `post_comments_live_post_id_parent_created_at_parent_id_idx`
 *   one 댓글 at a time — each step one descent past the last 댓글 found (`parent_created_at` is the
 *   댓글's `created_at`, held to it by the parent's foreign key) — `limit` 댓글 at most, of which
 *   the deleted ones are the placeholders.
 *
 * The first `limit` of the two together are the page: every 댓글 in view up to the page's last is
 * in one of them — not deleted, it is among the first `limit` of the first walk; deleted, a 대댓글
 * in view hangs under it, and the 댓글 with 대댓글 in view up to the page's last are on the page,
 * so `limit` at most, all among the first `limit` of the second. The page reads at most `limit`
 * 댓글 down one index and `limit` descents down the other, whatever the post's deleted history.
 */
export function commentPageIdsSql(postId: string, after: Keyset | undefined, limit: number): SQL {
  const cursor =
    after === undefined
      ? undefined
      : sql`(${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)`;
  return sql`ARRAY(
    WITH RECURSIVE threads (created_at, id, depth) AS (
      (SELECT reply.parent_created_at, reply.parent_id, 1
         FROM post_comments AS reply
        WHERE reply.post_id = ${postId}::uuid
          AND reply.parent_id IS NOT NULL
          AND reply.deleted_at IS NULL
          ${cursor === undefined ? sql`` : sql`AND (reply.parent_created_at, reply.parent_id) > ${cursor}`}
        ORDER BY reply.parent_created_at, reply.parent_id
        LIMIT 1)
      UNION ALL
      SELECT next.parent_created_at, next.parent_id, threads.depth + 1
        FROM threads
        CROSS JOIN LATERAL (
          SELECT reply.parent_created_at, reply.parent_id
            FROM post_comments AS reply
           WHERE reply.post_id = ${postId}::uuid
             AND reply.parent_id IS NOT NULL
             AND reply.deleted_at IS NULL
             AND (reply.parent_created_at, reply.parent_id) > (threads.created_at, threads.id)
           ORDER BY reply.parent_created_at, reply.parent_id
           LIMIT 1
        ) AS next
       WHERE threads.depth < ${limit}::int
    ),
    in_view (created_at, id) AS (
      (SELECT comment.created_at, comment.id
         FROM post_comments AS comment
        WHERE comment.post_id = ${postId}::uuid
          AND comment.parent_id IS NULL
          AND comment.deleted_at IS NULL
          ${cursor === undefined ? sql`` : sql`AND (comment.created_at, comment.id) > ${cursor}`}
        ORDER BY comment.created_at, comment.id
        LIMIT ${limit}::int)
      UNION ALL
      SELECT comment.created_at, comment.id
        FROM threads
        JOIN post_comments AS comment ON comment.id = threads.id
       WHERE comment.deleted_at IS NOT NULL
    )
    SELECT id FROM in_view ORDER BY created_at, id LIMIT ${limit}::int
  )`;
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
