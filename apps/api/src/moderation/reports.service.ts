import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  PUBLIC_ID_PATTERN,
  REPORTS_PER_DAY,
  REPORT_WINDOW_HOURS,
  decodeKeyset,
  encodeKeyset,
  postExcerpt,
  type CursorQuery,
  type MyReport,
  type OnboardingRequiredDetails,
  type ParsedReportBody,
  type ReportLimitedDetails,
  type ReportNotAllowedDetails,
  type ReportRefusal,
  type ReportTarget,
  type ReportTargetType,
} from '@buddha/shared';
import { and, desc, eq, gt, or, sql, type SQL } from 'drizzle-orm';
import {
  commentHasReplies,
  commentHasRepliesSql,
  postHasComments,
  postHasCommentsSql,
} from '../comments/comment-queries.js';
import { AppError } from '../common/errors/app-error.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { PhoneHasher } from '../identity/phone-hash.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { assertOnboarded } from '../onboarding/onboarded.guard.js';
import { authorColumns, cardText, postAuthorOf, publicStateOf } from '../posts/posts.service.js';
import { type Page } from '../wallet/wallet.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Who reports: the account, the keyed hash of its verified number, and whether it is an admin. */
interface Reporter {
  readonly userId: string;
  readonly phoneHash: string;
  readonly isAdmin: boolean;
}

/** A target found and locked for a report: its type, its key and its member. */
interface LockedTarget {
  readonly targetType: ReportTargetType;
  readonly postId: string | null;
  readonly commentId: string | null;
  readonly reportedUserId: string;
}

/** The unique index of one pending report per account and target (migration 0039). */
const PENDING_REPORT_INDEX = 'reports_pending_reporter_target_idx';

const HOUR_MS = 60 * 60 * 1_000;

/**
 * 신고 접수 (#50, ADR-0081; ADR-0069 decision 2 #45-10, #45-13, #45-15, decision 3 #37-10, decision
 * 7): a member reports a 근거 글, a comment or a profile, and reads their own reports and how they
 * were processed. Nothing here hides anything or acts on anyone: a report waits for an operator
 * (#45-10 «자동 숨김 없다»), and no count of reports is read anywhere but the admin screens.
 *
 * A report is one transaction:
 * 1. `lockReporter`: the account's 본인확인 record FOR KEY SHARE (its number cannot change or go
 *    until the report commits, as a like holds it, ADR-0076), the onboarding again (#57-8:
 *    OnboardedGuard asked before the body was read; this holds it to the commit), and the
 *    number's own lock (`buddha:reports`, the hash): two reports of one person — two tabs, or the
 *    accounts a number verified one after another — are counted one after the other.
 * 2. The target, held shared (`FOR SHARE`): the author's deletion and an operator's hiding update
 *    its row and so wait for the report, or it for them — a report never lands on an item whose
 *    hiding committed without seeing it, and an operator's action resolves every report committed
 *    before it (ModerationService locks the row FOR UPDATE).
 * 3. The rules, in this order: a target gone from every view (NOT_FOUND, as to the public), one's
 *    own (`own`), a placeholder (`deleted`, `hidden`), the same person's pending report on it
 *    (`duplicate`, decision 7), and the person's count of the last REPORT_WINDOW_HOURS
 *    (REPORT_LIMITED; an operator has no limit, #45-15).
 *
 * The same person is the account, or the number for the reports of an account that has no
 * 본인확인 record any more — it withdrew (#140): a new account on the same number keeps that
 * account's pending reports and count (decision 7), as a like is matched (`likedBy`, ADR-0076). An
 * operator's change of a live account's number (#57-3) takes the hash of its pending reports and
 * those of the last 24 hours to the new number (docs/OPERATIONS.md, owner decision 2026-10-21,
 * ADR-0081): they stay the account's by its id whatever they carry, and once it withdraws they are
 * the new number's next account's, as its likes are. Nothing here writes that hash after a report
 * is sent (the keep-record trigger refuses it outside the operator's change).
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly hasher: PhoneHasher,
  ) {}

  /** `POST /posts/:postId/reports`. */
  async reportPost(userId: string, postId: string, body: ParsedReportBody): Promise<MyReport> {
    return this.report(userId, body, async (tx) => {
      const { posts } = schema;
      const [post] = await tx
        .select({ authorId: posts.authorId, deletedAt: posts.deletedAt, hiddenAt: posts.hiddenAt })
        .from(posts)
        .where(eq(posts.id, postId))
        .for('share');
      if (!post) throw notFound('Post');
      const state = publicStateOf(post, await postHasComments(tx, postId));
      return {
        target: { targetType: 'post', postId, commentId: null, reportedUserId: post.authorId },
        state,
        what: 'Post',
      };
    });
  }

  /** `POST /comments/:commentId/reports`: a 댓글 or a 대댓글. */
  async reportComment(
    userId: string,
    commentId: string,
    body: ParsedReportBody,
  ): Promise<MyReport> {
    return this.report(userId, body, async (tx) => {
      const { postComments } = schema;
      const [comment] = await tx
        .select({
          authorId: postComments.authorId,
          parentId: postComments.parentId,
          deletedAt: postComments.deletedAt,
          hiddenAt: postComments.hiddenAt,
        })
        .from(postComments)
        .where(eq(postComments.id, commentId))
        .for('share');
      if (!comment) throw notFound('Comment');
      // A 대댓글 has nothing under it: deleted, it is gone.
      const hasReplies = comment.parentId === null && (await commentHasReplies(tx, commentId));
      return {
        target: {
          targetType: 'comment',
          postId: null,
          commentId,
          reportedUserId: comment.authorId,
        },
        state: publicStateOf(comment, hasReplies),
        what: 'Comment',
      };
    });
  }

  /**
   * `POST /profiles/:publicId/reports` (#37-10): the profile — its nickname, image and 소개 —
   * whatever the item. NOT_FOUND where the profile is (an unknown or malformed public id, and a
   * withdrawn account, #37-16).
   */
  async reportProfile(userId: string, publicId: string, body: ParsedReportBody): Promise<MyReport> {
    return this.report(userId, body, async (tx) => {
      const id = publicId.toLowerCase();
      if (!PUBLIC_ID_PATTERN.test(id)) throw notFound('Profile');
      const { profiles } = schema;
      const [profile] = await tx
        .select({ userId: profiles.userId, ...authorColumns })
        .from(profiles)
        .where(eq(profiles.publicId, id))
        .limit(1)
        .for('share');
      if (!profile || postAuthorOf(profile).kind !== 'member') throw notFound('Profile');
      return {
        target: {
          targetType: 'profile',
          postId: null,
          commentId: null,
          reportedUserId: profile.userId,
        },
        state: 'published',
        what: 'Profile',
      };
    });
  }

  /**
   * `GET /me/reports`: the member's reports, newest first, each with what it was about as the
   * public sees it now and its result (#45-13). A page at a time on the (created at, id) keyset.
   */
  async myReports(userId: string, query: CursorQuery): Promise<Page<MyReport>> {
    const { reports } = schema;
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.reportRows(
      and(
        eq(reports.reporterId, userId),
        cursor === undefined
          ? undefined
          : keysetPredicate(reports.createdAt, reports.id, cursor, 'uuid'),
      ),
      query.limit + 1,
    );
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map(myReportOf),
      nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  /** One report's transaction (the class doc's steps), answering it as `GET /me/reports` lists it. */
  private async report(
    userId: string,
    body: ParsedReportBody,
    lockTarget: (tx: Tx) => Promise<{
      target: LockedTarget;
      state: ReturnType<typeof publicStateOf>;
      what: 'Post' | 'Comment' | 'Profile';
    }>,
  ): Promise<MyReport> {
    const id = await this.db.transaction(async (tx) => {
      const reporter = await this.lockReporter(tx, userId);
      const { target, state, what } = await lockTarget(tx);
      if (state === 'gone') throw notFound(what);
      if (target.reportedUserId === userId) throw reportNotAllowed('own');
      if (state === 'deleted' || state === 'hidden') throw reportNotAllowed(state);
      const { reports } = schema;
      const targetKey = target.postId ?? target.commentId ?? target.reportedUserId;
      const [pending] = await tx
        .select({ id: reports.id })
        .from(reports)
        .where(
          and(
            samePerson(reporter),
            eq(reports.targetType, target.targetType),
            eq(reports.targetKey, targetKey),
            eq(reports.status, 'pending'),
          ),
        )
        .limit(1);
      if (pending) throw reportNotAllowed('duplicate');
      const now = await clockTimestamp(tx);
      if (!reporter.isAdmin) await assertWithinLimit(tx, reporter, now);
      try {
        const [row] = await tx
          .insert(reports)
          .values({
            targetType: target.targetType,
            postId: target.postId,
            commentId: target.commentId,
            reportedUserId: target.reportedUserId,
            reporterId: userId,
            reporterPhoneHash: reporter.phoneHash,
            reason: body.reason,
            description: body.description,
            createdAt: now,
          })
          .returning({ id: reports.id });
        return row!.id;
      } catch (error) {
        // Under the number's lock only an account's own twin request could get here first.
        if (isPgError(error, PG_UNIQUE_VIOLATION, PENDING_REPORT_INDEX)) {
          throw reportNotAllowed('duplicate');
        }
        throw error;
      }
    });
    const [row] = await this.reportRows(eq(schema.reports.id, id), 1);
    return myReportOf(row!);
  }

  /** Step 1 of the class doc. */
  private async lockReporter(tx: Tx, userId: string): Promise<Reporter> {
    const { phoneVerifications, profiles } = schema;
    const [verified] = await tx
      .select({ phone: phoneVerifications.phone })
      .from(phoneVerifications)
      .where(eq(phoneVerifications.userId, userId))
      .limit(1)
      .for('key share');
    await assertOnboarded(tx, userId);
    // The onboarding includes 본인확인, so the record is there unless one was written between the
    // read above and the onboarding's check: the same refusal as if the check had seen it missing.
    if (!verified) {
      const details: OnboardingRequiredDetails = { steps: ['verification'] };
      throw new AppError('ONBOARDING_REQUIRED', { message: 'The onboarding is not done', details });
    }
    const phoneHash = this.hasher.hash(verified.phone);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('buddha:reports'), hashtext(${phoneHash}))`,
    );
    const [profile] = await tx
      .select({ role: profiles.role })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);
    return { userId, phoneHash, isAdmin: profile?.role === 'admin' };
  }

  /** Reports with what the reporter's list shows of their targets. */
  private reportRows(where: SQL | undefined, limit: number) {
    const { reports, posts, postComments, profiles } = schema;
    return this.db
      .select({
        id: reports.id,
        targetType: reports.targetType,
        postId: reports.postId,
        commentId: reports.commentId,
        reason: reports.reason,
        description: reports.description,
        createdAt: reports.createdAt,
        status: reports.status,
        resolvedAt: reports.resolvedAt,
        postTitle: posts.title,
        postText: cardText(posts.bodyText),
        postDeletedAt: posts.deletedAt,
        postHiddenAt: posts.hiddenAt,
        postHasComments: postHasCommentsSql(reports.postId),
        commentPostId: postComments.postId,
        commentParentId: postComments.parentId,
        commentBody: postComments.body,
        commentDeletedAt: postComments.deletedAt,
        commentHiddenAt: postComments.hiddenAt,
        commentHasReplies: commentHasRepliesSql(reports.commentId),
        member: authorColumns,
      })
      .from(reports)
      .leftJoin(posts, eq(posts.id, reports.postId))
      .leftJoin(postComments, eq(postComments.id, reports.commentId))
      .innerJoin(profiles, eq(profiles.userId, reports.reportedUserId))
      .where(where)
      .orderBy(desc(reports.createdAt), desc(reports.id))
      .limit(limit);
  }
}

type ReportRow = Awaited<ReturnType<ReportsService['reportRows']>>[number];

/** A report as its reporter reads it (`MyReport`): the target as the public sees it now. */
function myReportOf(row: ReportRow): MyReport {
  return {
    id: row.id,
    target: reportTargetOf(row),
    reason: row.reason,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    status: row.status,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * What a report was about, now: a post or a comment published — its title and start — or its
 * placeholder by id (a deleted one with nothing under it reads as deleted: the reporter knew it), a
 * profile by its member's public face.
 */
function reportTargetOf(row: ReportRow): ReportTarget {
  switch (row.targetType) {
    case 'post': {
      const id = row.postId!;
      const state = publicStateOf(
        { deletedAt: row.postDeletedAt, hiddenAt: row.postHiddenAt },
        row.postHasComments,
      );
      if (state === 'published') {
        return {
          type: 'post',
          post: { state, id, title: row.postTitle, excerpt: postExcerpt(row.postText ?? '') },
        };
      }
      return { type: 'post', post: { state: state === 'hidden' ? 'hidden' : 'deleted', id } };
    }
    case 'comment': {
      const id = row.commentId!;
      const state = publicStateOf(
        { deletedAt: row.commentDeletedAt, hiddenAt: row.commentHiddenAt },
        row.commentParentId === null && row.commentHasReplies,
      );
      const postId = row.commentPostId!;
      if (state === 'published') {
        return {
          type: 'comment',
          postId,
          comment: { state, id, excerpt: postExcerpt(row.commentBody ?? '') },
        };
      }
      return {
        type: 'comment',
        postId,
        comment: { state: state === 'hidden' ? 'hidden' : 'deleted', id },
      };
    }
    case 'profile':
      return { type: 'profile', member: postAuthorOf(row.member) };
  }
}

/**
 * A report of `reporter`'s: their account's, or their number's when the account that filed it holds
 * no 본인확인 record any more — it withdrew (decision 7, the class doc).
 */
function samePerson(reporter: Reporter): SQL {
  const { reports, phoneVerifications } = schema;
  const withdrawn = sql`NOT EXISTS (SELECT 1 FROM ${phoneVerifications} WHERE ${phoneVerifications.userId} = ${reports.reporterId})`;
  return (
    or(
      eq(reports.reporterId, reporter.userId),
      and(eq(reports.reporterPhoneHash, reporter.phoneHash), withdrawn),
    ) ?? eq(reports.reporterId, reporter.userId)
  );
}

/**
 * The person's reports of the last REPORT_WINDOW_HOURS: REPORT_LIMITED when REPORTS_PER_DAY are in
 * it (a report exactly that old has left it), with the wait until the oldest of them leaves —
 * whole minutes, rounded up (#187's way). Refused reports were never stored and do not count.
 */
async function assertWithinLimit(tx: Tx, reporter: Reporter, now: Date): Promise<void> {
  const { reports } = schema;
  const windowMs = REPORT_WINDOW_HOURS * HOUR_MS;
  const [nth] = await tx
    .select({ createdAt: reports.createdAt })
    .from(reports)
    .where(and(samePerson(reporter), gt(reports.createdAt, new Date(now.getTime() - windowMs))))
    .orderBy(desc(reports.createdAt))
    .offset(REPORTS_PER_DAY - 1)
    .limit(1);
  if (!nth) return;
  const waitMs = nth.createdAt.getTime() + windowMs - now.getTime();
  const details: ReportLimitedDetails = {
    limit: REPORTS_PER_DAY,
    retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 60_000)) * 60,
  };
  throw new AppError('REPORT_LIMITED', {
    message: `At most ${String(REPORTS_PER_DAY)} reports in ${String(REPORT_WINDOW_HOURS)} hours`,
    details,
  });
}

function reportNotAllowed(reason: ReportRefusal): AppError {
  const details: ReportNotAllowedDetails = { reason };
  return new AppError('REPORT_NOT_ALLOWED', { message: `Not reported: ${reason}`, details });
}

function notFound(what: 'Post' | 'Comment' | 'Profile'): AppError {
  return new AppError('NOT_FOUND', { message: `${what} not found` });
}
