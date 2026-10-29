import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  ACCOUNT_RESTRICTION_APPROVAL_KINDS,
  PUBLIC_ID_PATTERN,
  accountRestrictionChangeOf,
  adminMediaPath,
  decodeKeyset,
  encodeKeyset,
  moderationTargetSchema,
  postExcerpt,
  type AccountRestrictionApply,
  type AccountRestrictionMoot,
  type AccountRestrictionRequest,
  type AccountRestrictionRequestQuery,
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
  type ModerationApproval,
  type ModerationItemState,
  type ModerationTarget,
  type MyActionSubject,
  type MyModerationAction,
  type MyRestriction,
  type RemovedProfileItem,
  type ReportTargetType,
  type RestrictionEndChangeKind,
} from '@buddha/shared';
import { and, asc, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { commentHasRepliesSql, postHasCommentsSql } from '../comments/comment-queries.js';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate, tupleKeysetPredicate } from '../common/keyset.js';
import { DB } from '../infra/db/db.provider.js';
import { cardText, publicStateOf } from '../posts/posts.service.js';
import { type Page } from '../wallet/wallet.service.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { accountRestrictionOf, writingRestrictionOf } from './restrictions.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/** The accounts a moderation read names, each under its own name. */
const member = alias(schema.profiles, 'member');
const reporterProfile = alias(schema.profiles, 'reporter_profile');
const resolverProfile = alias(schema.profiles, 'resolver_profile');
const creatorProfile = alias(schema.profiles, 'creator_profile');
const cancellerProfile = alias(schema.profiles, 'canceller_profile');
const changerProfile = alias(schema.profiles, 'changer_profile');
const requesterProfile = alias(schema.profiles, 'requester_profile');
const deciderProfile = alias(schema.profiles, 'decider_profile');
const approverProfile = alias(schema.profiles, 'approver_profile');
const cancelApproverProfile = alias(schema.profiles, 'cancel_approver_profile');
const changeApproverProfile = alias(schema.profiles, 'change_approver_profile');

/** The approvals an account restriction, its cancellation and each change of its end came in by. */
const applyApproval = alias(schema.approvalRequests, 'apply_approval');
const cancelApproval = alias(schema.approvalRequests, 'cancel_approval');
const changeApproval = alias(schema.approvalRequests, 'change_approval');

/** A request's restriction: the one a change is about, the one an approved `apply` put in force. */
const requestAction = alias(schema.moderationActions, 'request_action');
const appliedAction = alias(schema.moderationActions, 'applied_action');

/** The two-person rule's kinds #139 reads (`approval_requests.kind`). */
const ACCOUNT_RESTRICTION_KINDS: string[] = Object.values(ACCOUNT_RESTRICTION_APPROVAL_KINDS);

/**
 * The member an account restriction request is about: an `apply`'s target (the account), or the
 * member of the restriction a change names. The approval's target, never its payload, so the
 * member read is the one the triggers of migration 0042 hold the restriction to.
 */
const REQUEST_MEMBER_ID = sql<string>`CASE WHEN ${schema.approvalRequests.targetType} = 'user' THEN ${schema.approvalRequests.targetId} ELSE ${requestAction.userId} END`;

/** The restriction types whose ends move (`restriction_end_changes`). */
const RESTRICTION_TYPES: ReadonlySet<string> = new Set([
  'writing_restriction',
  'account_restriction',
]);

/** The actions on a public profile item (#37-10): what the member reads as about '내 프로필'. */
const PROFILE_ITEM_TYPES: ReadonlySet<ModerationActionType> = new Set<ModerationActionType>([
  'nickname_reset',
  'bio_clear',
  'image_remove',
]);

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

/** A writing restriction's end changes, read with it (#185). */
const changeRows = schema.restrictionEndChanges;

/**
 * How a writing restriction was brought forward, as its member reads it (#185, owner decision
 * 2026-10-23 answer 4: '조기 해제됨'·'감경됨', the changed end and the original end — the reason is
 * the operators'), as two columns of the member's actions' own statement (`myActions`): the kind of
 * the latest change (`endChangeKind` — null when the end never changed, and for every other type)
 * — a lift ends the restriction, so nothing follows one — and the end it was given, the first
 * change's `previous_ends_at` (`originalEndsAt`, null for 무기한). Nothing more is read: neither the
 * reason nor the operator nor the time reaches the member.
 *
 * The changes are ordered by the end each gave, never by their time (`endChanges` the same): every
 * change brings the end strictly forward — `restriction_end_changes_earlier_check` and the trigger
 * of migration 0040, under the action's lock, each change's `previous_ends_at` the end the one
 * before gave — so the latest change gives the earliest end and the first the latest. Their times
 * do not order them: a change right behind another can read the same millisecond of the clock, or
 * an earlier one should the clock step back (`strictlyAfter`, infra/db/clock.ts), and the random
 * ids order nothing — a lift could then read as made before the 감경 it followed.
 *
 * Only for a select that joins another table, as `myActions` does: in a one-table select drizzle
 * writes a field's columns without their table, and the subqueries' `id` would then be their own
 * row's — every action read as never changed.
 */
const memberEndChange = {
  endChangeKind: sql<string | null>`(
    SELECT ${changeRows.kind} FROM ${changeRows}
     WHERE ${changeRows.actionId} = ${schema.moderationActions.id}
     ORDER BY ${changeRows.endsAt} ASC LIMIT 1)`,
  originalEndsAt: sql<Date | null>`(
    SELECT ${changeRows.previousEndsAt} FROM ${changeRows}
     WHERE ${changeRows.actionId} = ${schema.moderationActions.id}
     ORDER BY ${changeRows.endsAt} DESC LIMIT 1)`.mapWith(changeRows.previousEndsAt),
};

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
   * `GET /me/moderation/restriction` (#185, ADR-0082; #139, ADR-0085): the writing and the account
   * restriction that govern the member now, each read as the refusals read it
   * (`writingRestrictionOf`, `accountRestrictionOf` — 무기한 over any term, else the latest end, by
   * the database clock), so a banner says the end a refused write or order names. Its own read
   * rather than the actions' first page: a restriction followed by twenty other actions still
   * stands, and the banner must say so (ADR-0069 decision 4 #50). A request no admin approved yet
   * is nothing in force: it is never here.
   */
  async myRestrictions(userId: string): Promise<MyRestriction> {
    return {
      restriction: await writingRestrictionOf(this.db, userId),
      accountRestriction: await accountRestrictionOf(this.db, userId),
    };
  }

  /**
   * `GET /me/moderation/actions`: the actions taken on the member, newest first, each with what it
   * was about — their own item, the title and start of its text, or nothing of it once they
   * deleted it (MY shows no deleted item, #45-5) — and, for a writing restriction an operator
   * lifted early or shortened, how its end was brought forward (`memberEndChange`).
   *
   * One statement: the end a restriction has now and how it was brought forward are read from one
   * snapshot. Read apart, a lift committed between the two would pair the end before it with
   * '조기 해제됨' — '진행 중' and lifted on one card, a state that never was.
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
        ...memberEndChange,
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
        } else if (PROFILE_ITEM_TYPES.has(type)) {
          // A profile item's action is about the profile. A warning or a restriction without an
          // item is about nothing in particular — its subject 'profile' is not kept (ADR-0081
          // 7-9), and a restriction is the member's writing or account, not their profile (#185,
          // #139).
          subject = { type: 'profile' };
        }
        return {
          id: row.id,
          type,
          reason: { code: row.reason, note: row.note },
          subject,
          createdAt: row.createdAt.toISOString(),
          endsAt: row.endsAt?.toISOString() ?? null,
          endChange:
            row.endChangeKind === null
              ? null
              : {
                  kind: row.endChangeKind as RestrictionEndChangeKind,
                  originalEndsAt: row.originalEndsAt?.toISOString() ?? null,
                },
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
      let excerpt: string | null;
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
      accountRestrictionRequests: await this.requests(
        this.db,
        and(eq(schema.approvalRequests.status, 'pending'), sql`${REQUEST_MEMBER_ID} = ${row.id}`),
        viewerId,
        [asc(schema.approvalRequests.requestedAt), asc(schema.approvalRequests.id)],
      ),
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
        approvalId: applyApproval.id,
        approvalDecidedById: applyApproval.decidedBy,
        approvalDecidedByNickname: approverProfile.nickname,
        approvalReason: applyApproval.decisionReason,
        approvalDecidedAt: applyApproval.decidedAt,
        cancelApprovalId: cancelApproval.id,
        cancelApprovalDecidedById: cancelApproval.decidedBy,
        cancelApprovalDecidedByNickname: cancelApproverProfile.nickname,
        cancelApprovalReason: cancelApproval.decisionReason,
        cancelApprovalDecidedAt: cancelApproval.decidedAt,
        removedNickname: profileItemRemovals.nickname,
        removedBio: profileItemRemovals.bio,
        removedImageId: profileItemRemovals.imageId,
        reportCount: sql<number>`(SELECT count(*)::int FROM ${reports} WHERE ${reports.actionId} = ${moderationActions.id})`,
      })
      .from(moderationActions)
      .innerJoin(member, eq(member.userId, moderationActions.userId))
      .innerJoin(creatorProfile, eq(creatorProfile.userId, moderationActions.createdBy))
      .leftJoin(cancellerProfile, eq(cancellerProfile.userId, moderationActions.cancelledBy))
      .leftJoin(applyApproval, eq(applyApproval.id, moderationActions.approvalId))
      .leftJoin(approverProfile, eq(approverProfile.userId, applyApproval.decidedBy))
      .leftJoin(cancelApproval, eq(cancelApproval.id, moderationActions.cancelApprovalId))
      .leftJoin(cancelApproverProfile, eq(cancelApproverProfile.userId, cancelApproval.decidedBy))
      .leftJoin(profileItemRemovals, eq(profileItemRemovals.actionId, moderationActions.id))
      .leftJoin(postComments, eq(postComments.id, moderationActions.commentId))
      .where(where)
      .orderBy(desc(moderationActions.createdAt), desc(moderationActions.id));
    const rows = await (limit === undefined ? query : query.limit(limit));
    const changes = await this.endChanges(
      executor,
      rows.filter((row) => RESTRICTION_TYPES.has(row.type)).map((row) => row.id),
    );
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
        approval: approvalOf(
          {
            id: row.approvalId,
            decidedById: row.approvalDecidedById,
            decidedByNickname: row.approvalDecidedByNickname,
            reason: row.approvalReason,
            decidedAt: row.approvalDecidedAt,
          },
          withheld,
        ),
        endsAt: row.endsAt?.toISOString() ?? null,
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
        cancelledBy:
          withheld || row.cancelledById === null
            ? null
            : { id: row.cancelledById, nickname: row.cancelledByNickname },
        cancelReason: row.cancelReason,
        cancelApproval: approvalOf(
          {
            id: row.cancelApprovalId,
            decidedById: row.cancelApprovalDecidedById,
            decidedByNickname: row.cancelApprovalDecidedByNickname,
            reason: row.cancelApprovalReason,
            decidedAt: row.cancelApprovalDecidedAt,
          },
          withheld,
        ),
        removed: removedOf(row),
        reportCount: row.reportCount,
        endChanges: (changes.get(row.id) ?? []).map((change) => ({
          kind: change.kind as RestrictionEndChangeKind,
          previousEndsAt: change.previousEndsAt?.toISOString() ?? null,
          endsAt: change.endsAt.toISOString(),
          reason: change.reason,
          createdBy: withheld
            ? null
            : { id: change.createdById, nickname: change.createdByNickname },
          createdAt: change.createdAt.toISOString(),
          approval: approvalOf(
            {
              id: change.approvalId,
              decidedById: change.approvalDecidedById,
              decidedByNickname: change.approvalDecidedByNickname,
              reason: change.approvalReason,
              decidedAt: change.approvalDecidedAt,
            },
            withheld,
          ),
        })),
        aboutViewer: withheld,
      };
    });
  }

  /**
   * The changes of the restrictions `actionIds` (#185, #139: shortenings and lifts), oldest first
   * per action — by the end each gave, the latest first, as `memberEndChange` orders them, never by
   * their time — with the operator who made each and, for an account restriction, the approval it
   * came in by.
   */
  private async endChanges(executor: Executor, actionIds: string[]) {
    const byAction = new Map<
      string,
      {
        kind: string;
        previousEndsAt: Date | null;
        endsAt: Date;
        reason: string;
        createdById: string;
        createdByNickname: string | null;
        createdAt: Date;
        approvalId: string | null;
        approvalDecidedById: string | null;
        approvalDecidedByNickname: string | null;
        approvalReason: string | null;
        approvalDecidedAt: Date | null;
      }[]
    >();
    if (actionIds.length === 0) return byAction;
    const { restrictionEndChanges } = schema;
    const rows = await executor
      .select({
        actionId: restrictionEndChanges.actionId,
        kind: restrictionEndChanges.kind,
        previousEndsAt: restrictionEndChanges.previousEndsAt,
        endsAt: restrictionEndChanges.endsAt,
        reason: restrictionEndChanges.reason,
        createdById: restrictionEndChanges.createdBy,
        createdByNickname: changerProfile.nickname,
        createdAt: restrictionEndChanges.createdAt,
        approvalId: changeApproval.id,
        approvalDecidedById: changeApproval.decidedBy,
        approvalDecidedByNickname: changeApproverProfile.nickname,
        approvalReason: changeApproval.decisionReason,
        approvalDecidedAt: changeApproval.decidedAt,
      })
      .from(restrictionEndChanges)
      .leftJoin(changerProfile, eq(changerProfile.userId, restrictionEndChanges.createdBy))
      .leftJoin(changeApproval, eq(changeApproval.id, restrictionEndChanges.approvalId))
      .leftJoin(changeApproverProfile, eq(changeApproverProfile.userId, changeApproval.decidedBy))
      .where(inArray(restrictionEndChanges.actionId, actionIds))
      .orderBy(desc(restrictionEndChanges.endsAt));
    for (const { actionId, ...change } of rows) {
      const list = byAction.get(actionId) ?? [];
      list.push(change);
      byAction.set(actionId, list);
    }
    return byAction;
  }

  // ---- account restriction requests (#139) -------------------------------------------------------

  /**
   * `GET /admin/moderation/account-restriction-requests`: `pending` — the requests waiting for a
   * decision, the one waiting longest first — `decided` — approved or rejected, the latest decision
   * first — or `retracted` — retracted by the one who asked, the latest first; a page at a time. A
   * cursor that does not decode serves the first page.
   */
  async requestQueue(
    query: AccountRestrictionRequestQuery,
    viewerId: string,
  ): Promise<Page<AccountRestrictionRequest>> {
    const { approvalRequests } = schema;
    const pending = query.status === 'pending';
    const retracted = query.status === 'retracted';
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const sortKey = pending
      ? approvalRequests.requestedAt
      : retracted
        ? approvalRequests.retractedAt
        : approvalRequests.decidedAt;
    const items = await this.requests(
      this.db,
      and(
        pending
          ? eq(approvalRequests.status, 'pending')
          : retracted
            ? eq(approvalRequests.status, 'retracted')
            : inArray(approvalRequests.status, ['approved', 'rejected']),
        cursor === undefined
          ? undefined
          : keysetPredicate(
              sortKey,
              approvalRequests.id,
              cursor,
              'uuid',
              pending ? 'after' : 'before',
            ),
      ),
      viewerId,
      pending
        ? [asc(sortKey), asc(approvalRequests.id)]
        : [desc(sortKey), desc(approvalRequests.id)],
      query.limit + 1,
    );
    const hasMore = items.length > query.limit;
    const kept = hasMore ? items.slice(0, query.limit) : items;
    const last = kept.at(-1);
    const lastAt = last
      ? pending
        ? last.requestedAt
        : retracted
          ? last.retractedAt
          : last.decidedAt
      : null;
    return {
      items: kept,
      nextCursor:
        hasMore && last && lastAt
          ? encodeKeyset({ createdAt: new Date(lastAt), id: last.id })
          : null,
    };
  }

  /** One account restriction request as operators read it, or NOT_FOUND (another kind too). */
  async request(
    executor: Executor,
    requestId: string,
    viewerId: string,
  ): Promise<AccountRestrictionRequest> {
    const [request] = await this.requests(
      executor,
      eq(schema.approvalRequests.id, requestId),
      viewerId,
      [],
    );
    if (!request) throw new AppError('NOT_FOUND', { message: 'Approval request not found' });
    return request;
  }

  /**
   * The account restriction requests matching `where` (#139's kinds only), with the member, what
   * each asks for — a change with the restriction it changes as it stands (`target`), so the
   * approving admin knows which of the member's restrictions it is — who asked and decided —
   * withheld from `viewerId` where it is about them (`withheldFor`) — and, while pending, what an
   * approval would be refused for now (`moot`, read against the restriction as it stands and the
   * database clock).
   */
  async requests(
    executor: Executor,
    where: SQL | undefined,
    viewerId: string,
    orderBy: SQL[],
    limit?: number,
  ): Promise<AccountRestrictionRequest[]> {
    const { approvalRequests } = schema;
    const query = executor
      .select({
        id: approvalRequests.id,
        kind: approvalRequests.kind,
        payload: approvalRequests.payload,
        user: memberColumns,
        changedActionId: requestAction.id,
        changedType: requestAction.type,
        changedCreatedAt: requestAction.createdAt,
        changedEndsAt: requestAction.endsAt,
        changedCancelledAt: requestAction.cancelledAt,
        changedReason: requestAction.reason,
        changedNote: requestAction.note,
        appliedActionId: appliedAction.id,
        requestReason: approvalRequests.requestReason,
        requestedById: approvalRequests.requestedBy,
        requestedByNickname: requesterProfile.nickname,
        requestedAt: approvalRequests.requestedAt,
        status: approvalRequests.status,
        decidedById: approvalRequests.decidedBy,
        decidedByNickname: deciderProfile.nickname,
        decisionReason: approvalRequests.decisionReason,
        decidedAt: approvalRequests.decidedAt,
        retractedAt: approvalRequests.retractedAt,
      })
      .from(approvalRequests)
      .leftJoin(
        requestAction,
        and(
          eq(approvalRequests.targetType, 'moderation_action'),
          eq(sql`${requestAction.id}::text`, approvalRequests.targetId),
        ),
      )
      .innerJoin(member, eq(member.userId, REQUEST_MEMBER_ID))
      .leftJoin(appliedAction, eq(appliedAction.approvalId, approvalRequests.id))
      .innerJoin(requesterProfile, eq(requesterProfile.userId, approvalRequests.requestedBy))
      .leftJoin(deciderProfile, eq(deciderProfile.userId, approvalRequests.decidedBy))
      .where(and(inArray(approvalRequests.kind, ACCOUNT_RESTRICTION_KINDS), where))
      .orderBy(...orderBy);
    const rows = await (limit === undefined ? query : query.limit(limit));
    if (rows.length === 0) return [];
    const now = await clockTimestamp(executor);
    return rows.map((row) => {
      const change = accountRestrictionChangeOf(row.kind)!;
      const payload = row.payload ?? {};
      const withheld = withheldFor(viewerId, row.user.id);
      const requestedEnd =
        change === 'shorten' && typeof payload.endsAt === 'string'
          ? new Date(payload.endsAt)
          : null;
      return {
        id: row.id,
        change,
        user: row.user,
        actionId: change === 'apply' ? row.appliedActionId : row.changedActionId,
        target:
          change === 'apply' || row.changedCreatedAt === null || row.changedReason === null
            ? null
            : {
                createdAt: row.changedCreatedAt.toISOString(),
                endsAt: row.changedEndsAt?.toISOString() ?? null,
                reason: { code: row.changedReason, note: row.changedNote },
                cancelledAt: row.changedCancelledAt?.toISOString() ?? null,
              },
        apply: change === 'apply' ? applyOf(payload, withheld) : null,
        endsAt: requestedEnd?.toISOString() ?? null,
        requestReason: row.requestReason,
        requestedBy: withheld ? null : { id: row.requestedById, nickname: row.requestedByNickname },
        requestedAt: row.requestedAt.toISOString(),
        status: row.status,
        decidedBy:
          withheld || row.decidedById === null
            ? null
            : { id: row.decidedById, nickname: row.decidedByNickname },
        decisionReason: row.decisionReason,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        // Rejected by no admin is the closure's (#140, migration 0043): read from the row, not
        // from `decidedBy`, which is withheld from the admin the request is about as well.
        closedByAccountClosure: row.status === 'rejected' && row.decidedById === null,
        retractedAt: row.retractedAt?.toISOString() ?? null,
        moot:
          row.status !== 'pending' || change === 'apply' || row.changedType === null
            ? null
            : accountRestrictionMoot(
                {
                  cancelledAt: row.changedCancelledAt,
                  endsAt: row.changedEndsAt,
                },
                change,
                now,
                requestedEnd,
              ),
        aboutViewer: withheld,
      };
    });
  }
}

/**
 * What approving a change of an account restriction would be refused for at `now` — the rules
 * the approval applies (AccountRestrictionService): a cancelled restriction changes no more
 * (`cancelled`); one ended has no end to bring forward (`ended`, a cancellation excepted — an ended
 * restriction may still be cancelled, as #50's may); a 감경's end must be to come (`end_passed`) and
 * before the end now (`not_earlier`; any is, for 무기한). Null when it can be approved.
 */
export function accountRestrictionMoot(
  action: { cancelledAt: Date | null; endsAt: Date | null },
  change: 'shorten' | 'lift' | 'cancel',
  now: Date,
  requestedEnd: Date | null,
): AccountRestrictionMoot | null {
  if (action.cancelledAt !== null) return 'cancelled';
  if (change === 'cancel') return null;
  if (action.endsAt !== null && action.endsAt.getTime() <= now.getTime()) return 'ended';
  if (change === 'shorten') {
    if (requestedEnd === null || requestedEnd.getTime() <= now.getTime()) return 'end_passed';
    if (action.endsAt !== null && requestedEnd.getTime() >= action.endsAt.getTime()) {
      return 'not_earlier';
    }
  }
  return null;
}

/**
 * What an `apply` request's payload asks for (AccountRestrictionService writes it), the operators'
 * memo withheld from the admin the request is about (`withheld`): it is never the member's (owner
 * decision 2026-10-23).
 */
function applyOf(payload: Record<string, unknown>, withheld: boolean): AccountRestrictionApply {
  const subject = moderationTargetSchema.safeParse(payload.subject);
  return {
    reason: {
      code: payload.reason as AccountRestrictionApply['reason']['code'],
      note: typeof payload.note === 'string' ? payload.note : null,
    },
    days: typeof payload.days === 'number' ? payload.days : null,
    subject: subject.success ? subject.data : null,
    memo: !withheld && typeof payload.memo === 'string' ? payload.memo : null,
  };
}

/**
 * An approval as operators read it on an account restriction's record (#139), or null where none
 * was needed; the approving admin withheld for the admin the restriction is on (`withheld`).
 */
function approvalOf(
  row: {
    id: string | null;
    decidedById: string | null;
    decidedByNickname: string | null;
    reason: string | null;
    decidedAt: Date | null;
  },
  withheld: boolean,
): ModerationApproval | null {
  if (row.id === null || row.decidedAt === null) return null;
  return {
    requestId: row.id,
    decidedBy:
      withheld || row.decidedById === null
        ? null
        : { id: row.decidedById, nickname: row.decidedByNickname },
    reason: row.reason ?? '',
    decidedAt: row.decidedAt.toISOString(),
  };
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
        : { id: row.resolvedById, nickname: row.resolvedByNickname },
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
