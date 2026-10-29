import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  LINK_FLAG_REASONS,
  LINK_REPEAT_THRESHOLD,
  LINK_REPEAT_WINDOW_SECONDS,
  decodeKeyset,
  encodeKeyset,
  isOfficialSourceLink,
  linkFlagReviewPayloadSchema,
  officialSourceLinks,
  postExcerpt,
  type AdminLinkFlag,
  type AdminLinkFlagGroup,
  type AdminLinkFlagItemsQuery,
  type AdminLinkFlagListQuery,
  type AdminLinkFlagReviewBody,
  type LinkFlagReason,
  type LinkFlagReviewPayload,
} from '@buddha/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AppError } from '../common/errors/app-error.js';
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
 * The advisory locks a link may take: a link's lock is one of these, picked by the link's hash.
 * Two writes of one link take the same one and so count one after the other; two links that share
 * one only queue together. A write records LINK_CHECK_MAX links at most (owner decision
 * 2026-10-22), so it takes at most that many; the buckets were the bound before that cap — a post
 * may carry about 3,000 distinct links, and each advisory lock holds an entry of the database's
 * shared lock table until the commit (ADR-0083 7-15) — and stay as a second one.
 */
export const LINK_LOCK_BUCKETS = 64;

/** `admin_actions.target_type` of a mark '확인함': the target is the link (its normalised url). */
const REVIEW_TARGET_TYPE = 'link';

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
 * in — of the item's first LINK_CHECK_MAX in body order (`postDocumentLinks`, `commentLinks`, owner
 * decision 2026-10-22); an edit's: those of them its body's first did not have (decision 4 #187
 * «수정으로 넣거나 바꾼 링크도 본다») — other than the market's official sources
 * (`isOfficialSourceLink`), and then a fixed handful of statements:
 * 1. the links' locks (LINK_LOCK_BUCKETS at most, in key order), so two writes of one link count one
 *    after the other and a third use is never missed by a race. Taken after every row lock of the
 *    write: from here a write takes no lock but the foreign-key checks of its inserts (FOR KEY
 *    SHARE on the posts and comments named), and nothing holds those rows FOR UPDATE — a counted
 *    write's own lock is FOR NO KEY UPDATE, and so is an operator's action on the item (#50,
 *    ModerationService) — so a write waiting for a link's lock never holds up the one that has it.
 *    The write may hold its post's comment count by then (its comment's insert, #48's trigger),
 *    which a hiding's `hidden_at` moves: were that hiding to hold the comment named FOR UPDATE, the
 *    two would wait for each other (ADR-0083 7-13);
 * 2. the database clock, and each link's uses in the window before this write: the writer's posts
 *    and comments (`same_account`) and the people (`many_accounts`);
 * 3. the uses (`link_uses`), all in one insert;
 * 4. the review list (`link_flags`, once per item, link and rule). A rule this write meets puts
 *    every item it counts on it (owner decision 2026-10-22 answer 1, ADR-0083 7-10): `same_account`
 *    each time it is met, reading the writer's own items in the window again — an operator's change
 *    of the number can bring the count to three without a write, moving the old number's last day
 *    onto a number that has uses already (a withdrawn account's, OPERATOR_PHONE_CHANGE_SQL), and
 *    the write limits keep the writer's items to a few hundred a day; `many_accounts` the first
 *    time only, and only this item when it was met already — the others went on then, as every use
 *    of the link is counted under its lock, the window only lets uses out between two of them, and
 *    a change of number only merges two people, never adds one (so a popular link's whole window
 *    is not read again on every write).
 * An operator's write does none of it (decision 4 #187: «운영자 글은 예외»): it takes no lock, is not
 * recorded, and so counts toward nobody's repetition either.
 *
 * The review list (owner decision 2026-10-22): `list` groups the entries by link and rule, the
 * default list those no operator has marked yet and the reviewed list one row per mark; `items`
 * reads one group's entries a page at a time; `review` marks a group '확인함' with what came of it,
 * an `admin_actions` row that the marked entries name.
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
    // Per rule, the links met with this write: those whose every counted item goes on the list,
    // and those of `many_accounts` met already, for which this item alone does (step 4).
    const flagCounted: Record<LinkFlagReason, string[]> = { same_account: [], many_accounts: [] };
    const flagThis: { url: string; reason: LinkFlagReason }[] = [];
    const judge = (url: string, reason: LinkFlagReason, counts: number, isIn: boolean) => {
      if (counts + (isIn ? 0 : 1) < LINK_REPEAT_THRESHOLD) return;
      if (reason === 'many_accounts' && counts >= LINK_REPEAT_THRESHOLD) {
        flagThis.push({ url, reason });
      } else {
        flagCounted[reason].push(url);
      }
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
    if (flagThis.length > 0) {
      await tx.execute(sql`
        INSERT INTO link_flags (url, reason, post_id, comment_id, flagged_at)
        SELECT flag.url, flag.reason, ${postId}, ${commentId}, ${at}
        FROM unnest(
          ${sql.param(flagThis.map((flag) => flag.url))}::text[],
          ${sql.param(flagThis.map((flag) => flag.reason))}::text[]
        ) AS flag(url, reason)
        ON CONFLICT DO NOTHING`);
    }
    for (const reason of LINK_FLAG_REASONS) {
      if (flagCounted[reason].length === 0) continue;
      // The items the rule counts — this write's among them (step 3): the writer's for
      // `same_account`, everyone's for `many_accounts`.
      const whose = reason === 'same_account' ? sql`AND phone_hash = ${phoneHash}` : sql.empty();
      await tx.execute(sql`
        INSERT INTO link_flags (url, reason, post_id, comment_id, flagged_at)
        SELECT DISTINCT url, ${reason}::text, post_id, comment_id, ${at}
        FROM link_uses
        WHERE url = ANY(${sql.param(flagCounted[reason])}::text[]) AND used_at > ${since} ${whose}
        ON CONFLICT DO NOTHING`);
    }
  }

  /**
   * `GET /admin/link-flags`: the review list grouped by link and rule (owner decision 2026-10-22:
   * «같은 주소·규칙끼리 묶어 항목 수 보임»), a page at a time. `open`: the entries no operator has
   * marked, one row per link and rule with how many and the latest time, newest first by that time
   * (then by the id of the group's newest entry, so a page's cursor names one row). `reviewed`: one
   * row per mark — the entries it covered, how many, the latest time, and the mark — newest mark
   * first. A cursor that does not decode serves the first page.
   */
  async list(query: AdminLinkFlagListQuery): Promise<Page<AdminLinkFlagGroup>> {
    const cursor = decodeKeyset(query.cursor, 'uuid');
    return query.status === 'open'
      ? this.openGroups(cursor, query.limit)
      : this.reviewedGroups(cursor, query.limit);
  }

  /** The default list: the unmarked entries by link and rule. */
  private async openGroups(
    cursor: ReturnType<typeof decodeKeyset>,
    limit: number,
  ): Promise<Page<AdminLinkFlagGroup>> {
    const after =
      cursor === undefined
        ? sql.empty()
        : sql`WHERE (latest, head_id) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
    // The latest time as epoch millis in text (a raw row's timestamp is the driver's string).
    const { rows } = await this.db.execute<{
      url: string;
      reason: LinkFlagReason;
      item_count: number;
      latest_ms: string;
      head_id: string;
    }>(sql`
      SELECT url, reason, item_count, head_id,
             (extract(epoch FROM latest) * 1000)::bigint::text AS latest_ms
      FROM (
        SELECT url, reason, count(*)::int AS item_count, max(flagged_at) AS latest,
               (array_agg(id ORDER BY flagged_at DESC, id DESC))[1] AS head_id
        FROM link_flags
        WHERE review_action_id IS NULL
        GROUP BY url, reason
      ) AS open_groups
      ${after}
      ORDER BY latest DESC, head_id DESC
      LIMIT ${limit + 1}`);
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => ({
        url: row.url,
        reason: row.reason,
        itemCount: row.item_count,
        latestFlaggedAt: new Date(Number(row.latest_ms)).toISOString(),
        review: null,
      })),
      nextCursor:
        hasMore && last
          ? encodeKeyset({ createdAt: new Date(Number(last.latest_ms)), id: last.head_id })
          : null,
    };
  }

  /** The reviewed list: one row per mark, with the entries it covered. */
  private async reviewedGroups(
    cursor: ReturnType<typeof decodeKeyset>,
    limit: number,
  ): Promise<Page<AdminLinkFlagGroup>> {
    const { adminActions, linkFlags, profiles } = schema;
    const rows = await this.db
      .select({
        id: adminActions.id,
        reviewedAt: adminActions.createdAt,
        payload: adminActions.payload,
        adminId: adminActions.adminId,
        nickname: profiles.nickname,
        url: sql<string>`min(${linkFlags.url})`,
        reason: sql<LinkFlagReason>`min(${linkFlags.reason})`,
        itemCount: sql<number>`count(*)::int`.mapWith(Number),
        latest: sql<Date>`max(${linkFlags.flaggedAt})`.mapWith(linkFlags.flaggedAt),
      })
      .from(adminActions)
      .innerJoin(linkFlags, eq(linkFlags.reviewActionId, adminActions.id))
      .innerJoin(profiles, eq(profiles.userId, adminActions.adminId))
      .where(
        and(
          eq(adminActions.type, 'link_flag_review'),
          cursor === undefined
            ? undefined
            : keysetPredicate(adminActions.createdAt, adminActions.id, cursor, 'uuid'),
        ),
      )
      .groupBy(adminActions.id, profiles.nickname)
      .orderBy(desc(adminActions.createdAt), desc(adminActions.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => {
        const payload = linkFlagReviewPayloadSchema.parse(row.payload);
        return {
          url: row.url,
          reason: row.reason,
          itemCount: row.itemCount,
          latestFlaggedAt: row.latest.toISOString(),
          review: {
            id: row.id,
            outcome: payload.outcome,
            note: payload.note,
            reviewedAt: row.reviewedAt.toISOString(),
            admin: { userId: row.adminId, nickname: row.nickname },
          },
        };
      }),
      nextCursor:
        hasMore && last ? encodeKeyset({ createdAt: last.reviewedAt, id: last.id }) : null,
    };
  }

  /**
   * `GET /admin/link-flags/items`: one group's entries (owner decision 2026-10-22: the group's
   * items, paged) — those of `url` and `reason` no operator has marked, or with `reviewId` those
   * that mark covered — newest first, a page at a time, each with its post or comment as it is now
   * (its excerpt, times and author, its market), so an operator sees what was flagged, why, and
   * what became of it since. An unknown group is an empty page. A cursor that does not decode
   * serves the first page.
   */
  async items(query: AdminLinkFlagItemsQuery): Promise<Page<AdminLinkFlag>> {
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
        and(
          eq(linkFlags.url, query.url),
          eq(linkFlags.reason, query.reason),
          query.reviewId === undefined
            ? isNull(linkFlags.reviewActionId)
            : eq(linkFlags.reviewActionId, query.reviewId),
          cursor === undefined
            ? undefined
            : keysetPredicate(linkFlags.flaggedAt, linkFlags.id, cursor, 'uuid'),
        ),
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

  /**
   * `POST /admin/link-flags/reviews`: an operator marks a group of the default list '확인함' with
   * what came of it (owner decision 2026-10-22: «'확인함' 표시(문제 없음·조치함, 운영 기록, 확인한
   * 것은 기본 목록에서 빠짐)»). The group's entries of `url` and `reason` no operator has marked,
   * put on the list at or before `through` — the group's latest time as the screen showed it, so an
   * entry that arrives after the operator looked stays on the default list — are locked (FOR
   * UPDATE: two operators marking one group at once mark it once, the second finding nothing left),
   * the mark is written (`admin_actions`, `link_flag_review`: target `link` / the url, payload
   * `LinkFlagReviewPayload`), and the entries name it — in one transaction, so neither is kept
   * without the other. The action itself (hiding, a warning, a restriction) is #50's; `actioned`
   * only records that it was taken. NOT_FOUND when nothing is left to mark (another operator marked
   * it, or no such group): nothing is written. Answers the group as the reviewed list shows it.
   */
  async review(adminId: string, body: AdminLinkFlagReviewBody): Promise<AdminLinkFlagGroup> {
    const note = body.note === undefined || body.note === '' ? null : body.note;
    const { adminActions, linkFlags, profiles } = schema;
    return this.db.transaction(async (tx) => {
      const entries = await tx
        .select({ id: linkFlags.id, flaggedAt: linkFlags.flaggedAt })
        .from(linkFlags)
        .where(
          and(
            eq(linkFlags.url, body.url),
            eq(linkFlags.reason, body.reason),
            isNull(linkFlags.reviewActionId),
            sql`${linkFlags.flaggedAt} <= ${body.through}::timestamptz`,
          ),
        )
        .for('update');
      if (entries.length === 0) {
        throw new AppError('NOT_FOUND', {
          message: 'No entry of this link and rule is left to mark',
        });
      }
      const now = await clockTimestamp(tx);
      const payload: LinkFlagReviewPayload = {
        reason: body.reason,
        outcome: body.outcome,
        note,
        itemCount: entries.length,
        through: new Date(body.through).toISOString(),
      };
      const [action] = await tx
        .insert(adminActions)
        .values({
          adminId,
          type: 'link_flag_review',
          targetType: REVIEW_TARGET_TYPE,
          targetId: body.url,
          payload,
          createdAt: now,
        })
        .returning({ id: adminActions.id });
      await tx
        .update(linkFlags)
        .set({ reviewActionId: action!.id })
        .where(sql`${linkFlags.id} = ANY(${sql.param(entries.map((entry) => entry.id))}::uuid[])`);
      const [admin] = await tx
        .select({ nickname: profiles.nickname })
        .from(profiles)
        .where(eq(profiles.userId, adminId));
      const latest = Math.max(...entries.map((entry) => entry.flaggedAt.getTime()));
      return {
        url: body.url,
        reason: body.reason,
        itemCount: entries.length,
        latestFlaggedAt: new Date(latest).toISOString(),
        review: {
          id: action!.id,
          outcome: body.outcome,
          note,
          reviewedAt: now.toISOString(),
          admin: { userId: adminId, nickname: admin?.nickname ?? null },
        },
      };
    });
  }
}
