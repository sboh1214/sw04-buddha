import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  LINK_FLAG_REASONS,
  LINK_REPEAT_THRESHOLD,
  LINK_REPEAT_WINDOW_SECONDS,
  decodeKeyset,
  encodeKeyset,
  isOfficialSourceLink,
  officialSourceLinks,
  postExcerpt,
  type AdminLinkFlag,
  type CursorQuery,
  type LinkFlagReason,
} from '@buddha/shared';
import { desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { keysetPredicate } from '../common/keyset.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';
import { type Writer } from '../write-limits/write-limits.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A post or a comment that took links: exactly one of the two. */
export type LinkTarget =
  { postId: string; commentId?: never } | { commentId: string; postId?: never };

/** How much of an item's text the review list reads for its excerpt (`postExcerpt` keeps less). */
const EXCERPT_HEAD = 2_000;

/**
 * How many advisory locks a write's links take at most: a link's lock is one of these, picked by
 * the link's hash. Two writes of one link take the same one and so count one after the other; two
 * links that share one only queue together. A post may carry about 3,000 distinct links (one per
 * character of a 256 KiB body), and each advisory lock holds an entry of the database's shared
 * lock table (about 4,000 entries in production — max_connections 40, ADR-0083) until the commit:
 * a lock per link would let two such posts at once fill it, failing unrelated transactions too.
 */
export const LINK_LOCK_BUCKETS = 64;

/** One link's uses in the window before a write's own, as `record` counts them. */
type UsesBefore = {
  readonly url: string;
  /** The writer's posts and comments that took it. */
  readonly mine: number;
  /** Whether the item being written is among them (an edit putting back a link it took before). */
  readonly mineHasTarget: boolean;
  /** The people (verified numbers) who used it. */
  readonly people: number;
  /** Whether the writer is among them. */
  readonly peopleHasWriter: boolean;
};

/**
 * 반복 링크 탐지 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 4 #187 rows, decision 7): the
 * links posts and comments take, the two repetition rules over the last 24 hours, and the
 * operators' review list they put items on. Nothing here refuses or hides a write (decision 4
 * #187: «운영 검토 목록에 표시 … 글은 그대로 보임»).
 *
 * A write's links go to `record`, the last step of its transaction (PostsService,
 * CommentsService), once the write is certain — every check passed, the write counted
 * (WriteLimitsService.take) and its rows written. So a refused write, an edit that changes nothing
 * and an edit that puts in no link do none of this work. `record` takes the links the write puts
 * in (an edit's: those its body did not have, decision 4 #187 «수정으로 넣거나 바꾼 링크도 본다»)
 * other than the market's official sources (`isOfficialSourceLink`), and then, whatever their
 * number, a fixed handful of statements:
 * 1. the links' locks (LINK_LOCK_BUCKETS at most, in key order), so two writes of one link count one
 *    after the other and a third use is never missed by a race. Taken after every row lock of the
 *    write: from here a write takes no lock but the foreign-key checks of its inserts (FOR KEY
 *    SHARE on the posts and comments named, which no write holds FOR UPDATE), so a write waiting
 *    for a link's lock never holds up the one that has it (ADR-0083 7-13);
 * 2. the database clock, and each link's uses in the window before this write: the writer's posts
 *    and comments (`same_account`) and the people (`many_accounts`);
 * 3. the uses (`link_uses`), all in one insert;
 * 4. the review list (`link_flags`, once per item, link and rule). A rule this write meets for the
 *    first time puts every item it counts on it; a rule met already puts only this item — the
 *    others went on when it was met, as every use of the link is counted under its lock and the
 *    window only lets uses out between two of them.
 * An operator's write does none of it (decision 4 #187: «운영자 글은 예외»): it takes no lock, is not
 * recorded, and so counts toward nobody's repetition either.
 */
@Injectable()
export class LinkReviewService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * The class doc's steps: `links` (normalised, each once) that `target` on `marketId` takes now,
   * as the last thing its write's transaction does.
   */
  async record(
    tx: Tx,
    writer: Writer,
    target: LinkTarget,
    marketId: string,
    links: readonly string[],
  ): Promise<void> {
    if (writer.isAdmin || links.length === 0) return;
    const [market] = await tx
      .select({ resolutionSource: schema.markets.resolutionSource })
      .from(schema.markets)
      .where(eq(schema.markets.id, marketId));
    const sources = officialSourceLinks(market?.resolutionSource ?? null);
    const counted = links.filter((link) => !isOfficialSourceLink(link, sources));
    if (counted.length === 0) return;
    // One parameter for all the links, however many.
    const urls = sql`${sql.param(counted)}::text[]`;
    const postId = sql`${target.postId ?? null}::uuid`;
    const commentId = sql`${target.commentId ?? null}::uuid`;
    const phoneHash = writer.phoneHash;

    // 1. The locks, in key order: PostgreSQL evaluates a volatile output expression after the
    // ORDER BY sort (since 9.6), so writes whose links overlap take the shared ones in one order.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext('buddha:link'), key)
      FROM (
        SELECT DISTINCT hashtext(link) & ${LINK_LOCK_BUCKETS - 1}::int AS key
        FROM unnest(${urls}) AS link
      ) AS keys
      ORDER BY key`);

    // 2. Read after the locks: a write of the same link that committed meanwhile is in the counts.
    const now = await clockTimestamp(tx);
    const at = sql`${now.toISOString()}::timestamptz`;
    const since = sql`${new Date(now.getTime() - LINK_REPEAT_WINDOW_SECONDS * 1_000).toISOString()}::timestamptz`;
    const isTarget =
      target.postId === undefined ? sql`comment_id = ${commentId}` : sql`post_id = ${postId}`;
    const { rows } = await tx.execute<UsesBefore>(sql`
      SELECT url,
             (count(DISTINCT post_id) FILTER (WHERE phone_hash = ${phoneHash})
               + count(DISTINCT comment_id) FILTER (WHERE phone_hash = ${phoneHash}))::int AS mine,
             coalesce(bool_or(phone_hash = ${phoneHash} AND ${isTarget}), false) AS "mineHasTarget",
             count(DISTINCT phone_hash)::int AS people,
             coalesce(bool_or(phone_hash = ${phoneHash}), false) AS "peopleHasWriter"
      FROM link_uses
      WHERE url = ANY(${urls}) AND used_at > ${since}
      GROUP BY url`);
    const before = new Map(rows.map((row) => [row.url, row]));
    // Per rule: the links it is met for with this write for the first time, and those it was met
    // for already.
    const firstMet: Record<LinkFlagReason, string[]> = { same_account: [], many_accounts: [] };
    const metAlready: { url: string; reason: LinkFlagReason }[] = [];
    const judge = (url: string, reason: LinkFlagReason, counts: number, isIn: boolean) => {
      if (counts >= LINK_REPEAT_THRESHOLD) metAlready.push({ url, reason });
      else if (counts + (isIn ? 0 : 1) >= LINK_REPEAT_THRESHOLD) firstMet[reason].push(url);
    };
    for (const url of counted) {
      const uses = before.get(url);
      judge(url, 'same_account', uses?.mine ?? 0, uses?.mineHasTarget ?? false);
      judge(url, 'many_accounts', uses?.people ?? 0, uses?.peopleHasWriter ?? false);
    }

    // 3.
    await tx.execute(sql`
      INSERT INTO link_uses (url, phone_hash, post_id, comment_id, used_at)
      SELECT link, ${phoneHash}, ${postId}, ${commentId}, ${at}
      FROM unnest(${urls}) AS link`);

    // 4. `link_flags_url_reason_target_unique` (NULLS NOT DISTINCT) is the only key a new row can
    // meet: an item on the list for a link and rule stays as it was put there.
    if (metAlready.length > 0) {
      await tx.execute(sql`
        INSERT INTO link_flags (url, reason, post_id, comment_id, flagged_at)
        SELECT flag.url, flag.reason, ${postId}, ${commentId}, ${at}
        FROM unnest(
          ${sql.param(metAlready.map((flag) => flag.url))}::text[],
          ${sql.param(metAlready.map((flag) => flag.reason))}::text[]
        ) AS flag(url, reason)
        ON CONFLICT DO NOTHING`);
    }
    for (const reason of LINK_FLAG_REASONS) {
      if (firstMet[reason].length === 0) continue;
      // The items the rule counts: the writer's for `same_account`, everyone's for `many_accounts`.
      const whose = reason === 'same_account' ? sql`AND phone_hash = ${phoneHash}` : sql.empty();
      await tx.execute(sql`
        INSERT INTO link_flags (url, reason, post_id, comment_id, flagged_at)
        SELECT DISTINCT url, ${reason}::text, post_id, comment_id, ${at}
        FROM link_uses
        WHERE url = ANY(${sql.param(firstMet[reason])}::text[]) AND used_at > ${since} ${whose}
        ON CONFLICT DO NOTHING`);
    }
  }

  /**
   * `GET /admin/link-flags`: the review list, newest first, a page at a time — each entry with its
   * post or comment as it is now (its excerpt, times and author, its market), so an operator sees
   * what was flagged, why, and what became of it since. A cursor that does not decode serves the
   * first page.
   */
  async list(query: CursorQuery): Promise<Page<AdminLinkFlag>> {
    const { linkFlags, postComments, posts, profiles, markets } = schema;
    const comment = alias(postComments, 'flagged_comment');
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.db
      .select({
        id: linkFlags.id,
        url: linkFlags.url,
        reason: linkFlags.reason,
        flaggedAt: linkFlags.flaggedAt,
        postId: posts.id,
        commentId: comment.id,
        title: posts.title,
        postHead: sql<string>`left(${posts.bodyText}, ${EXCERPT_HEAD})`,
        commentHead: sql<string | null>`left(${comment.body}, ${EXCERPT_HEAD})`,
        post: {
          createdAt: posts.createdAt,
          editedAt: posts.editedAt,
          deletedAt: posts.deletedAt,
          hiddenAt: posts.hiddenAt,
        },
        comment: {
          createdAt: comment.createdAt,
          editedAt: comment.editedAt,
          deletedAt: comment.deletedAt,
          hiddenAt: comment.hiddenAt,
        },
        author: {
          userId: profiles.userId,
          publicId: profiles.publicId,
          nickname: profiles.nickname,
        },
        market: { id: markets.id, slug: markets.slug, title: markets.title },
      })
      .from(linkFlags)
      .leftJoin(comment, eq(comment.id, linkFlags.commentId))
      .innerJoin(posts, eq(posts.id, sql`coalesce(${linkFlags.postId}, ${comment.postId})`))
      .innerJoin(
        profiles,
        eq(profiles.userId, sql`coalesce(${comment.authorId}, ${posts.authorId})`),
      )
      .innerJoin(markets, eq(markets.id, posts.marketId))
      .where(
        cursor === undefined
          ? undefined
          : keysetPredicate(linkFlags.flaggedAt, linkFlags.id, cursor, 'uuid'),
      )
      .orderBy(desc(linkFlags.flaggedAt), desc(linkFlags.id))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => {
        // The item's own times: the comment's for a comment (a left join's object is null without
        // one), the post's for a post.
        const times = row.commentId === null || row.comment === null ? row.post : row.comment;
        return {
          id: row.id,
          url: row.url,
          reason: row.reason,
          flaggedAt: row.flaggedAt.toISOString(),
          target: {
            kind: row.commentId === null ? 'post' : 'comment',
            postId: row.postId,
            commentId: row.commentId,
            excerpt:
              row.commentId === null
                ? (row.title ?? postExcerpt(row.postHead))
                : postExcerpt(row.commentHead ?? ''),
            createdAt: times.createdAt.toISOString(),
            editedAt: times.editedAt?.toISOString() ?? null,
            deletedAt: times.deletedAt?.toISOString() ?? null,
            hiddenAt: times.hiddenAt?.toISOString() ?? null,
            author: row.author,
            market: row.market,
          },
        };
      }),
      nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.flaggedAt, id: last.id }) : null,
    };
  }
}
