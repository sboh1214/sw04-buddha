import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  PUBLIC_ID_PATTERN,
  adminMediaPath,
  decodeKeyset,
  encodeKeyset,
  postExcerpt,
  type AdminCommentModeration,
  type AdminModerationAction,
  type AdminPostComment,
  type AdminPostModeration,
  type AdminReport,
  type AdminReportGroup,
  type AdminReportQuery,
  type AdminUserModeration,
  type CursorQuery,
  type ModerationActionType,
  type ModerationItemState,
  type ModerationTarget,
  type MyActionSubject,
  type MyModerationAction,
  type RemovedProfileItem,
  type ReportTargetType,
} from '@buddha/shared';
import { and, asc, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { commentHasRepliesSql, postHasCommentsSql } from '../comments/comment-queries.js';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate, tupleKeysetPredicate } from '../common/keyset.js';
import { DB } from '../infra/db/db.provider.js';
import { cardText, publicStateOf } from '../posts/posts.service.js';
import { type Page } from '../wallet/wallet.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/** The accounts a moderation read names, each under its own name. */
const member = alias(schema.profiles, 'member');
const reporterProfile = alias(schema.profiles, 'reporter_profile');
const resolverProfile = alias(schema.profiles, 'resolver_profile');
const creatorProfile = alias(schema.profiles, 'creator_profile');
const cancellerProfile = alias(schema.profiles, 'canceller_profile');

/**
 * An account's columns as the moderation screens name it (`ModerationUser`): the member acted on or
 * reported, and the reporter.
 */
const memberColumns = {
  id: member.userId,
  publicId: member.publicId,
  nickname: member.nickname,
  role: member.role,
};
const reporterColumns = {
  id: reporterProfile.userId,
  publicId: reporterProfile.publicId,
  nickname: reporterProfile.nickname,
  role: reporterProfile.role,
};

/** What an item is, for operators: the public's three and `gone` (deleted with nothing under it). */
export function itemStateOf(
  item: { deletedAt: Date | null; hiddenAt: Date | null },
  hasReplies: boolean,
): ModerationItemState {
  return publicStateOf(item, hasReplies);
}

/** The report queue's group: the target type and its key, one text (`post:<id>`). */
const GROUP_KEY = sql<string>`${schema.reports.targetType}::text || ':' || ${schema.reports.targetKey}`;

/**
 * The reads of #50 (ADR-0081): the operators' report queue, an item's and a member's moderation
 * pages and every action (ADR-0056 1-2: every admin reads them all, the reporters included), and
 * the member's own actions on MY (#45-13: the type, the reason, the end and the appeal — never the
 * operator, a report or its reporter). Nothing here is read by a public route.
 *
 * An admin who is the member reported or acted on (`viewerId`) reads those records without who
 * reported, what the reporter wrote and which operators processed, acted and cancelled (owner
 * decision 2026-10-21: #45-10 and #45-13 over ADR-0056 1-2 for a record about oneself) — the
 * reasons, the times and what was done stay (`aboutViewer`, `withheldFor`). The processing is kept
 * from them as well (`own`, decision 4 #50).
 */
@Injectable()
export class ModerationReadsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- the member -------------------------------------------------------------------------------

  /**
   * `GET /me/moderation/actions`: the actions taken on the member, newest first, each with what it
   * was about — their own item, the title and start of its text, or nothing of it once they
   * deleted it (MY shows no deleted item, #45-5).
   */
  async myActions(userId: string, query: CursorQuery): Promise<Page<MyModerationAction>> {
    const { moderationActions, posts, postComments } = schema;
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.db
      .select({
        id: moderationActions.id,
        type: moderationActions.type,
        postId: moderationActions.postId,
        commentId: moderationActions.commentId,
        reason: moderationActions.reason,
        note: moderationActions.note,
        createdAt: moderationActions.createdAt,
        endsAt: moderationActions.endsAt,
        cancelledAt: moderationActions.cancelledAt,
        postTitle: posts.title,
        postText: cardText(posts.bodyText),
        postDeletedAt: posts.deletedAt,
        commentPostId: postComments.postId,
        commentBody: postComments.body,
        commentDeletedAt: postComments.deletedAt,
      })
      .from(moderationActions)
      .leftJoin(posts, eq(posts.id, moderationActions.postId))
      .leftJoin(postComments, eq(postComments.id, moderationActions.commentId))
      .where(
        and(
          eq(moderationActions.userId, userId),
          cursor === undefined
            ? undefined
            : keysetPredicate(moderationActions.createdAt, moderationActions.id, cursor, 'uuid'),
        ),
      )
      .orderBy(desc(moderationActions.createdAt), desc(moderationActions.id))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => {
        const type = row.type as ModerationActionType;
        let subject: MyActionSubject | null = null;
        if (row.postId !== null) {
          const shown = row.postDeletedAt === null;
          subject = {
            type: 'post',
            id: row.postId,
            title: shown ? row.postTitle : null,
            excerpt: shown ? postExcerpt(row.postText) : null,
          };
        } else if (row.commentId !== null) {
          subject = {
            type: 'comment',
            id: row.commentId,
            postId: row.commentPostId!,
            excerpt: row.commentDeletedAt === null ? postExcerpt(row.commentBody ?? '') : null,
          };
        } else if (type !== 'warning') {
          subject = { type: 'profile' };
        }
        return {
          id: row.id,
          type,
          reason: { code: row.reason, note: row.note },
          subject,
          createdAt: row.createdAt.toISOString(),
          endsAt: row.endsAt?.toISOString() ?? null,
          cancelledAt: row.cancelledAt?.toISOString() ?? null,
        };
      }),
      nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  // ---- operators: the queue ---------------------------------------------------------------------

  /**
   * `GET /admin/reports`: the reports grouped by target (#50 guidance). `pending` — targets with a
   * pending report, the one waiting longest first (its oldest pending report's intake); `resolved`
   * — targets whose reports were all processed, the latest processing first. Each entry with the
   * target as it is now, its member, the counts and the times. The counts are for operators to
   * read; nothing acts on them (#45-10). A cursor that does not decode serves the first page.
   *
   * The groups are aggregated over the whole table each time: reports are few beside posts, and a
   * page of groups needs every report of its targets anyway. An index on the pending reports is the
   * step when the volume asks for it (ADR-0081).
   */
  async queue(query: AdminReportQuery): Promise<Page<AdminReportGroup>> {
    const { reports } = schema;
    const pending = query.status === 'pending';
    const groups = this.db
      .select({
        targetType: reports.targetType,
        targetKey: reports.targetKey,
        postId: reports.postId,
        commentId: reports.commentId,
        reportedUserId: reports.reportedUserId,
        groupKey: GROUP_KEY.as('group_key'),
        pendingCount: sql<number>`count(*) FILTER (WHERE ${reports.status} = 'pending')::int`.as(
          'pending_count',
        ),
        reportCount: sql<number>`count(*)::int`.as('report_count'),
        reporterCount: sql<number>`count(DISTINCT ${reports.reporterId})::int`.as('reporter_count'),
        firstPendingAt:
          sql<Date | null>`min(${reports.createdAt}) FILTER (WHERE ${reports.status} = 'pending')`
            .mapWith(reports.createdAt)
            .as('first_pending_at'),
        latestReportAt: sql<Date>`max(${reports.createdAt})`
          .mapWith(reports.createdAt)
          .as('latest_report_at'),
        lastResolvedAt: sql<Date | null>`max(${reports.resolvedAt})`
          .mapWith(reports.createdAt)
          .as('last_resolved_at'),
      })
      .from(reports)
      .groupBy(
        reports.targetType,
        reports.targetKey,
        reports.postId,
        reports.commentId,
        reports.reportedUserId,
      )
      .as('groups');
    const cursor = decodeGroupCursor(query.cursor);
    const sortKey = pending ? groups.firstPendingAt : groups.lastResolvedAt;
    const rows = await this.db
      .select()
      .from(groups)
      .where(
        and(
          pending ? gt(groups.pendingCount, 0) : eq(groups.pendingCount, 0),
          cursor === undefined
            ? undefined
            : tupleKeysetPredicate(
                [
                  { key: sql`${sortKey}`, value: cursor.at.toISOString(), cast: 'timestamptz' },
                  { key: sql`${groups.groupKey}`, value: cursor.key, cast: 'text' },
                ],
                pending ? 'after' : 'before',
              ),
        ),
      )
      .orderBy(
        ...(pending
          ? [asc(groups.firstPendingAt), asc(groups.groupKey)]
          : [desc(groups.lastResolvedAt), desc(groups.groupKey)]),
      )
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    const items = await this.describeGroups(kept, pending);
    const lastAt = last ? (pending ? last.firstPendingAt : last.lastResolvedAt) : null;
    return {
      items,
      nextCursor:
        hasMore && last && lastAt ? encodeGroupCursor({ at: lastAt, key: last.groupKey }) : null,
    };
  }

  /** The queue's entries for a page of groups: the reasons, the targets and their members. */
  private async describeGroups(
    groups: {
      targetType: ReportTargetType;
      targetKey: string;
      postId: string | null;
      commentId: string | null;
      reportedUserId: string;
      groupKey: string;
      pendingCount: number;
      reportCount: number;
      reporterCount: number;
      firstPendingAt: Date | null;
      latestReportAt: Date;
      lastResolvedAt: Date | null;
    }[],
    pending: boolean,
  ): Promise<AdminReportGroup[]> {
    if (groups.length === 0) return [];
    const { reports, posts, postComments, profiles } = schema;
    const keys = groups.map((group) => group.groupKey);
    const reasonRows = await this.db
      .select({
        groupKey: GROUP_KEY,
        reason: reports.reason,
        count: sql<number>`count(*)::int`,
      })
      .from(reports)
      .where(and(inArray(GROUP_KEY, keys), pending ? eq(reports.status, 'pending') : undefined))
      .groupBy(reports.targetType, reports.targetKey, reports.reason)
      .orderBy(asc(reports.reason));
    const postIds = groups.flatMap((group) => (group.postId ? [group.postId] : []));
    const commentIds = groups.flatMap((group) => (group.commentId ? [group.commentId] : []));
    const userIds = [...new Set(groups.map((group) => group.reportedUserId))];
    const postRows =
      postIds.length === 0
        ? []
        : await this.db
            .select({
              id: posts.id,
              title: posts.title,
              text: cardText(posts.bodyText),
              deletedAt: posts.deletedAt,
              hiddenAt: posts.hiddenAt,
              hasComments: postHasCommentsSql(posts.id),
            })
            .from(posts)
            .where(inArray(posts.id, postIds));
    const commentRows =
      commentIds.length === 0
        ? []
        : await this.db
            .select({
              id: postComments.id,
              postId: postComments.postId,
              parentId: postComments.parentId,
              body: postComments.body,
              deletedAt: postComments.deletedAt,
              hiddenAt: postComments.hiddenAt,
              hasReplies: commentHasRepliesSql(postComments.id),
            })
            .from(postComments)
            .where(inArray(postComments.id, commentIds));
    const userRows = await this.db
      .select({
        id: profiles.userId,
        publicId: profiles.publicId,
        nickname: profiles.nickname,
        role: profiles.role,
      })
      .from(profiles)
      .where(inArray(profiles.userId, userIds));
    const postOf = new Map(postRows.map((row) => [row.id, row]));
    const commentOf = new Map(commentRows.map((row) => [row.id, row]));
    const userOf = new Map(userRows.map((row) => [row.id, row]));
    return groups.map((group) => {
      const user = userOf.get(group.reportedUserId)!;
      let target: ModerationTarget;
      let state: ModerationItemState = 'published';
      let title: string | null = null;
      let excerpt: string;
      if (group.postId !== null) {
        const post = postOf.get(group.postId)!;
        target = { type: 'post', postId: post.id };
        state = itemStateOf(post, post.hasComments);
        title = post.title;
        excerpt = postExcerpt(post.text);
      } else if (group.commentId !== null) {
        const comment = commentOf.get(group.commentId)!;
        target = { type: 'comment', commentId: comment.id, postId: comment.postId };
        state = itemStateOf(comment, comment.parentId === null && comment.hasReplies);
        excerpt = postExcerpt(comment.body);
      } else {
        target = { type: 'profile', userId: user.id };
        excerpt = user.nickname;
      }
      return {
        target,
        user,
        state,
        title,
        excerpt,
        pendingCount: group.pendingCount,
        reportCount: group.reportCount,
        reporterCount: group.reporterCount,
        reasons: reasonRows
          .filter((row) => row.groupKey === group.groupKey)
          .map((row) => ({ reason: row.reason, count: row.count })),
        firstPendingAt: group.firstPendingAt?.toISOString() ?? null,
        latestReportAt: group.latestReportAt.toISOString(),
        lastResolvedAt: group.lastResolvedAt?.toISOString() ?? null,
      };
    });
  }

  // ---- operators: an item's and a member's pages -------------------------------------------------

  /**
   * `GET /admin/moderation/posts/:postId`: the post whatever its state — its deleted original too
   * (#45-5) — with its earlier versions (#45-4), every comment under it (`postComments`), its
   * reports, its actions and its author's record.
   */
  async postPage(postId: string, viewerId: string): Promise<AdminPostModeration> {
    const { posts, markets, postRevisions } = schema;
    const [row] = await this.db
      .select({
        id: posts.id,
        title: posts.title,
        body: posts.body,
        createdAt: posts.createdAt,
        editedAt: posts.editedAt,
        deletedAt: posts.deletedAt,
        hiddenAt: posts.hiddenAt,
        hasComments: postHasCommentsSql(posts.id),
        market: { id: markets.id, slug: markets.slug, title: markets.title },
        author: memberColumns,
      })
      .from(posts)
      .innerJoin(markets, eq(markets.id, posts.marketId))
      .innerJoin(member, eq(member.userId, posts.authorId))
      .where(eq(posts.id, postId))
      .limit(1);
    if (!row) throw notFound('Post');
    const revisions = await this.db
      .select()
      .from(postRevisions)
      .where(eq(postRevisions.postId, postId))
      .orderBy(asc(postRevisions.id));
    const { reports, reporterCount } = await this.reportsAndReporters(
      eq(schema.reports.postId, postId),
      viewerId,
    );
    return {
      id: row.id,
      state: itemStateOf(row, row.hasComments),
      title: row.title,
      body: row.body,
      market: row.market,
      author: row.author,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      hiddenAt: row.hiddenAt?.toISOString() ?? null,
      revisions: revisions.map((revision) => ({
        id: revision.id,
        title: revision.title,
        body: revision.body,
        writtenAt: revision.writtenAt.toISOString(),
        replacedAt: revision.replacedAt.toISOString(),
      })),
      comments: await this.postComments(postId),
      reports,
      reporterCount,
      actions: await this.actions(this.db, eq(schema.moderationActions.postId, postId), viewerId),
      authorActions: await this.actions(
        this.db,
        eq(schema.moderationActions.userId, row.author.id),
        viewerId,
      ),
    };
  }

  /**
   * Every comment under a post, for its operators' page: the way to a comment's own page, reported
   * or not (decision 4 #50 — an action without a report; the public screens give a comment no
   * address of its own). Each 댓글 oldest first, its 대댓글 after it oldest first, whatever their
   * state, with the start of the text a deleted one had (#45-5: kept for operators). All at once,
   * as the page's reports and actions are (ADR-0081 결과 5).
   */
  private async postComments(postId: string): Promise<AdminPostComment[]> {
    const { postComments } = schema;
    const rows = await this.db
      .select({
        id: postComments.id,
        parentId: postComments.parentId,
        body: postComments.body,
        createdAt: postComments.createdAt,
        deletedAt: postComments.deletedAt,
        hiddenAt: postComments.hiddenAt,
        hasReplies: commentHasRepliesSql(postComments.id),
        author: memberColumns,
      })
      .from(postComments)
      .innerJoin(member, eq(member.userId, postComments.authorId))
      .where(eq(postComments.postId, postId))
      .orderBy(asc(postComments.createdAt), asc(postComments.id));
    const commentOf = (row: (typeof rows)[number]): AdminPostComment => ({
      id: row.id,
      parentId: row.parentId,
      author: row.author,
      state: itemStateOf(row, row.parentId === null && row.hasReplies),
      excerpt: postExcerpt(row.body),
      createdAt: row.createdAt.toISOString(),
    });
    return rows
      .filter((row) => row.parentId === null)
      .flatMap((thread) => [
        commentOf(thread),
        ...rows.filter((row) => row.parentId === thread.id).map(commentOf),
      ]);
  }

  /** `GET /admin/moderation/comments/:commentId`: the same for a 댓글 or a 대댓글. */
  async commentPage(commentId: string, viewerId: string): Promise<AdminCommentModeration> {
    const { postComments, posts, postCommentRevisions } = schema;
    const [row] = await this.db
      .select({
        id: postComments.id,
        parentId: postComments.parentId,
        body: postComments.body,
        createdAt: postComments.createdAt,
        editedAt: postComments.editedAt,
        deletedAt: postComments.deletedAt,
        hiddenAt: postComments.hiddenAt,
        hasReplies: commentHasRepliesSql(postComments.id),
        post: {
          id: posts.id,
          title: posts.title,
          deletedAt: posts.deletedAt,
          hiddenAt: posts.hiddenAt,
          hasComments: postHasCommentsSql(posts.id),
        },
        author: memberColumns,
      })
      .from(postComments)
      .innerJoin(posts, eq(posts.id, postComments.postId))
      .innerJoin(member, eq(member.userId, postComments.authorId))
      .where(eq(postComments.id, commentId))
      .limit(1);
    if (!row) throw notFound('Comment');
    const revisions = await this.db
      .select()
      .from(postCommentRevisions)
      .where(eq(postCommentRevisions.commentId, commentId))
      .orderBy(asc(postCommentRevisions.id));
    const { reports, reporterCount } = await this.reportsAndReporters(
      eq(schema.reports.commentId, commentId),
      viewerId,
    );
    return {
      id: row.id,
      state: itemStateOf(row, row.parentId === null && row.hasReplies),
      parentId: row.parentId,
      body: row.body,
      post: {
        id: row.post.id,
        title: row.post.title,
        state: itemStateOf(row.post, row.post.hasComments),
      },
      author: row.author,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      hiddenAt: row.hiddenAt?.toISOString() ?? null,
      revisions: revisions.map((revision) => ({
        id: revision.id,
        body: revision.body,
        writtenAt: revision.writtenAt.toISOString(),
        replacedAt: revision.replacedAt.toISOString(),
      })),
      reports,
      reporterCount,
      actions: await this.actions(
        this.db,
        eq(schema.moderationActions.commentId, commentId),
        viewerId,
      ),
      authorActions: await this.actions(
        this.db,
        eq(schema.moderationActions.userId, row.author.id),
        viewerId,
      ),
    };
  }

  /**
   * `GET /admin/moderation/users/:userId`: the member's public profile now, the reports on it and
   * every action on the member — what the profile actions took away among them (#37-10).
   */
  async userPage(userId: string, viewerId: string): Promise<AdminUserModeration> {
    return this.memberPage(eq(member.userId, userId), viewerId);
  }

  /**
   * `GET /admin/moderation/profiles/:publicId`: the same page, found by the public id a profile's
   * address carries — the way from a public profile's '운영' link (owner decision 2026-10-21,
   * ADR-0081), which names no account id. Lower-cased as the public profile reads it; one that is
   * not of the shape is NOT_FOUND, as there.
   */
  async profilePage(publicId: string, viewerId: string): Promise<AdminUserModeration> {
    const id = publicId.toLowerCase();
    if (!PUBLIC_ID_PATTERN.test(id)) throw notFound('User');
    return this.memberPage(eq(member.publicId, id), viewerId);
  }

  private async memberPage(where: SQL, viewerId: string): Promise<AdminUserModeration> {
    const [row] = await this.db
      .select({ ...memberColumns, bio: member.bio, imageId: member.imageId })
      .from(member)
      .where(where)
      .limit(1);
    if (!row) throw notFound('User');
    const { reports } = schema;
    const profileReports = await this.reportsAndReporters(
      and(eq(reports.targetType, 'profile'), eq(reports.reportedUserId, row.id)),
      viewerId,
    );
    return {
      user: { id: row.id, publicId: row.publicId, nickname: row.nickname, role: row.role },
      bio: row.bio,
      imageUrl: row.imageId === null ? null : adminMediaPath(row.imageId),
      reports: profileReports.reports,
      reporterCount: profileReports.reporterCount,
      actions: await this.actions(this.db, eq(schema.moderationActions.userId, row.id), viewerId),
    };
  }

  /** `GET /admin/moderation/actions`: every action, newest first, a page at a time. */
  async allActions(query: CursorQuery, viewerId: string): Promise<Page<AdminModerationAction>> {
    const { moderationActions } = schema;
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.actions(
      this.db,
      cursor === undefined
        ? undefined
        : keysetPredicate(moderationActions.createdAt, moderationActions.id, cursor, 'uuid'),
      viewerId,
      query.limit + 1,
    );
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept,
      nextCursor:
        hasMore && last ? encodeKeyset({ createdAt: new Date(last.createdAt), id: last.id }) : null,
    };
  }

  // ---- shared reads, for the writes' answers too -------------------------------------------------

  /**
   * Reports matching `where`, newest first, with the reporter and the processing operator — both
   * withheld, with the description, from `viewerId` where the report is about them (`withheldFor`).
   */
  async reports(
    executor: Executor,
    where: SQL | undefined,
    viewerId: string,
  ): Promise<AdminReport[]> {
    const rows = await this.reportRows(executor, where);
    return rows.map((row) => adminReportOf(row, viewerId));
  }

  /**
   * A page's reports (`reports`) and how many accounts filed them — counted before anything is
   * withheld: the number of reporters is no reporter's identity (owner decision 2026-10-21).
   */
  private async reportsAndReporters(
    where: SQL | undefined,
    viewerId: string,
  ): Promise<{ reports: AdminReport[]; reporterCount: number }> {
    const rows = await this.reportRows(this.db, where);
    return {
      reports: rows.map((row) => adminReportOf(row, viewerId)),
      reporterCount: new Set(rows.map((row) => row.reporter.id)).size,
    };
  }

  private reportRows(executor: Executor, where: SQL | undefined) {
    const { reports } = schema;
    return executor
      .select({
        id: reports.id,
        targetType: reports.targetType,
        postId: reports.postId,
        commentId: reports.commentId,
        reportedUserId: reports.reportedUserId,
        commentPostId: schema.postComments.postId,
        reporter: reporterColumns,
        reason: reports.reason,
        description: reports.description,
        createdAt: reports.createdAt,
        status: reports.status,
        resolvedAt: reports.resolvedAt,
        resolvedById: reports.resolvedBy,
        resolvedByNickname: resolverProfile.nickname,
        actionId: reports.actionId,
        dismissalReason: reports.dismissalReason,
      })
      .from(reports)
      .innerJoin(reporterProfile, eq(reporterProfile.userId, reports.reporterId))
      .leftJoin(resolverProfile, eq(resolverProfile.userId, reports.resolvedBy))
      .leftJoin(schema.postComments, eq(schema.postComments.id, reports.commentId))
      .where(where)
      .orderBy(desc(reports.createdAt), desc(reports.id));
  }

  /**
   * Actions matching `where`, newest first, with everything recorded with them — the operators
   * withheld from `viewerId` where the action is on them (`withheldFor`).
   */
  async actions(
    executor: Executor,
    where: SQL | undefined,
    viewerId: string,
    limit?: number,
  ): Promise<AdminModerationAction[]> {
    const { moderationActions, profileItemRemovals, postComments, reports } = schema;
    const query = executor
      .select({
        id: moderationActions.id,
        type: moderationActions.type,
        user: memberColumns,
        postId: moderationActions.postId,
        commentId: moderationActions.commentId,
        commentPostId: postComments.postId,
        reason: moderationActions.reason,
        note: moderationActions.note,
        createdById: moderationActions.createdBy,
        createdByNickname: creatorProfile.nickname,
        createdAt: moderationActions.createdAt,
        endsAt: moderationActions.endsAt,
        cancelledAt: moderationActions.cancelledAt,
        cancelledById: moderationActions.cancelledBy,
        cancelledByNickname: cancellerProfile.nickname,
        cancelReason: moderationActions.cancelReason,
        removedNickname: profileItemRemovals.nickname,
        removedBio: profileItemRemovals.bio,
        removedImageId: profileItemRemovals.imageId,
        reportCount: sql<number>`(SELECT count(*)::int FROM ${reports} WHERE ${reports.actionId} = ${moderationActions.id})`,
      })
      .from(moderationActions)
      .innerJoin(member, eq(member.userId, moderationActions.userId))
      .innerJoin(creatorProfile, eq(creatorProfile.userId, moderationActions.createdBy))
      .leftJoin(cancellerProfile, eq(cancellerProfile.userId, moderationActions.cancelledBy))
      .leftJoin(profileItemRemovals, eq(profileItemRemovals.actionId, moderationActions.id))
      .leftJoin(postComments, eq(postComments.id, moderationActions.commentId))
      .where(where)
      .orderBy(desc(moderationActions.createdAt), desc(moderationActions.id));
    const rows = await (limit === undefined ? query : query.limit(limit));
    return rows.map((row) => {
      const withheld = withheldFor(viewerId, row.user.id);
      return {
        id: row.id,
        type: row.type as ModerationActionType,
        user: row.user,
        subject:
          row.postId !== null
            ? { type: 'post', postId: row.postId }
            : row.commentId !== null
              ? { type: 'comment', commentId: row.commentId, postId: row.commentPostId! }
              : null,
        reason: { code: row.reason, note: row.note },
        createdBy: withheld ? null : { id: row.createdById, nickname: row.createdByNickname },
        createdAt: row.createdAt.toISOString(),
        endsAt: row.endsAt?.toISOString() ?? null,
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
        cancelledBy:
          withheld || row.cancelledById === null
            ? null
            : { id: row.cancelledById, nickname: row.cancelledByNickname ?? '' },
        cancelReason: row.cancelReason,
        removed: removedOf(row),
        reportCount: row.reportCount,
        aboutViewer: withheld,
      };
    });
  }
}

/**
 * Whether a record about `memberId` — a report on their item or profile, an action on them — is
 * read by that member as an admin: then who reported, what the reporter wrote and which operators
 * processed, acted and cancelled are withheld (owner decision 2026-10-21, ADR-0081).
 */
export function withheldFor(viewerId: string, memberId: string): boolean {
  return viewerId === memberId;
}

/** A report as `viewerId` reads it on the admin screens. */
function adminReportOf(
  row: Awaited<ReturnType<ModerationReadsService['reportRows']>>[number],
  viewerId: string,
): AdminReport {
  const withheld = withheldFor(viewerId, row.reportedUserId);
  return {
    id: row.id,
    target: targetOf(row),
    reporter: withheld ? null : row.reporter,
    reason: row.reason,
    description: withheld ? null : row.description,
    createdAt: row.createdAt.toISOString(),
    status: row.status,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy:
      withheld || row.resolvedById === null
        ? null
        : { id: row.resolvedById, nickname: row.resolvedByNickname ?? '' },
    actionId: row.actionId,
    dismissalReason: row.dismissalReason,
    aboutViewer: withheld,
  };
}

/** A report's target, for operators. */
function targetOf(row: {
  targetType: ReportTargetType;
  postId: string | null;
  commentId: string | null;
  commentPostId: string | null;
  reportedUserId: string;
}): ModerationTarget {
  switch (row.targetType) {
    case 'post':
      return { type: 'post', postId: row.postId! };
    case 'comment':
      return { type: 'comment', commentId: row.commentId!, postId: row.commentPostId! };
    case 'profile':
      return { type: 'profile', userId: row.reportedUserId };
  }
}

/** What a profile action took away, kept for operators (#37-10). */
function removedOf(row: {
  removedNickname: string | null;
  removedBio: string | null;
  removedImageId: string | null;
}): RemovedProfileItem | null {
  if (row.removedNickname !== null) return { item: 'nickname', nickname: row.removedNickname };
  if (row.removedBio !== null) return { item: 'bio', bio: row.removedBio };
  if (row.removedImageId !== null) {
    return { item: 'image', imageUrl: adminMediaPath(row.removedImageId) };
  }
  return null;
}

/** The queue's cursor: the sort time and the group key (`<millis>_<type>:<key>`). */
function encodeGroupCursor(cursor: { at: Date; key: string }): string {
  return encodeKeyset({ createdAt: cursor.at, id: cursor.key });
}

function decodeGroupCursor(cursor: string | undefined): { at: Date; key: string } | undefined {
  const keyset = decodeKeyset(cursor, 'text');
  return keyset === undefined ? undefined : { at: keyset.createdAt, key: keyset.id };
}

function notFound(what: 'Post' | 'Comment' | 'User'): AppError {
  return new AppError('NOT_FOUND', { message: `${what} not found` });
}
