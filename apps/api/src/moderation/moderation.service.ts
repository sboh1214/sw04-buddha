import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { isNicknameHeld, lockNicknames, schema, type Db } from '@buddha/db';
import {
  AUTO_NICKNAME_ALPHABET,
  AUTO_NICKNAME_PREFIX,
  AUTO_NICKNAME_SUFFIX_LENGTH,
  isAutoNickname,
  type AdminActionType,
  type AdminModerationAction,
  type AdminReport,
  type ModerationActionType,
  type ModerationNotAllowedDetails,
  type ModerationRefusal,
  type ParsedModerationActionBody,
  type ParsedWarningBody,
  type ReportReason,
  type ReportTargetType,
} from '@buddha/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { NICKNAME_UNIQUE_INDEX } from '../me/nickname.service.js';
import { ModerationReadsService } from './moderation-reads.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The reason every action carries: a report reason and the explanation the member reads. */
interface ActionReason {
  reason: ReportReason;
  note: string | null;
}

/** What an action is written with, besides its reason. */
interface ActionRow {
  type: ModerationActionType;
  userId: string;
  postId?: string | null;
  commentId?: string | null;
}

/** A target whose pending reports an action resolves. */
interface ReportTarget {
  targetType: ReportTargetType;
  targetKey: string;
}

/** The standing-hiding indexes (migration 0038): a second hiding of one item at once. */
const STANDING_HIDE_INDEXES = [
  'moderation_actions_standing_post_hide_idx',
  'moderation_actions_standing_comment_hide_idx',
];

/** How many auto nicknames a reset draws before it gives up (the sign-up trigger's ten). */
const NICKNAME_DRAWS = 10;

/**
 * 운영 처리 (#50, ADR-0081; ADR-0069 decision 2 #45-5, #45-11…#45-14, decision 3 #37-10, decision
 * 4 #50 rows): what an operator does on the admin screen — hide a 근거 글 or a comment, warn a
 * member, give a nickname back to an auto nickname, empty a 소개, remove a profile image, cancel
 * an action, dismiss reports (기각). Chosen by the violation's weight, from the report queue or
 * directly without a report (decision 4 #50); never step by step and never by a count of reports
 * (#45-10, #45-11).
 *
 * Every write is one transaction with its records: the effect (the item's `hidden_at`, the
 * profile), the `moderation_actions` row (reason, operator, time — what the member reads, without
 * the operator, #45-13), the pending reports on the same target resolved as `actioned` (the
 * reporters read 조치함), and the `admin_actions` audit row (admin-audit.test.ts). Effects are
 * immediate (#45-13).
 *
 * An operator never acts on themselves — their post, comment or profile, or a report on one
 * (decision 4 #50 «다른 운영자만 처리한다»): MODERATION_NOT_ALLOWED `own`, and the CHECKs of migration
 * 0038 hold it whoever writes. The item's row is locked FOR UPDATE first: a report on it holds it
 * shared (ReportsService), so every report committed before the action is resolved by it and none
 * lands on a hidden item after; a new comment or like waits likewise (ADR-0074, ADR-0076).
 */
@Injectable()
export class ModerationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reads: ModerationReadsService,
  ) {}

  /**
   * `POST /admin/moderation/posts/:postId/hide` (#45-5): out of the community list and the
   * profile, the placeholder on its page, no new comment, no edit by its author (who may delete
   * it); its images are served to nobody. Refused: the author's own deletion (`deleted` — the
   * public sees it gone or as its placeholder already) and a hidden post (`hidden`).
   */
  async hidePost(
    adminId: string,
    postId: string,
    body: ParsedModerationActionBody,
  ): Promise<AdminModerationAction> {
    const id = await this.db.transaction(async (tx) => {
      const { posts } = schema;
      const [post] = await tx
        .select({ authorId: posts.authorId, deletedAt: posts.deletedAt, hiddenAt: posts.hiddenAt })
        .from(posts)
        .where(eq(posts.id, postId))
        .for('update');
      if (!post) throw notFound('Post');
      if (post.authorId === adminId) throw refused('own');
      if (post.deletedAt !== null) throw refused('deleted');
      if (post.hiddenAt !== null) throw refused('hidden');
      const now = await clockTimestamp(tx);
      await tx.update(posts).set({ hiddenAt: now }).where(eq(posts.id, postId));
      return this.record(
        tx,
        adminId,
        { type: 'hide', userId: post.authorId, postId },
        body,
        { targetType: 'post', targetKey: postId },
        'moderation_post_hide',
        { postId },
      );
    });
    return this.answer(id, adminId);
  }

  /** `POST /admin/moderation/comments/:commentId/hide`: the same for a 댓글 or a 대댓글. */
  async hideComment(
    adminId: string,
    commentId: string,
    body: ParsedModerationActionBody,
  ): Promise<AdminModerationAction> {
    const id = await this.db.transaction(async (tx) => {
      const { postComments } = schema;
      const [comment] = await tx
        .select({
          authorId: postComments.authorId,
          deletedAt: postComments.deletedAt,
          hiddenAt: postComments.hiddenAt,
        })
        .from(postComments)
        .where(eq(postComments.id, commentId))
        .for('update');
      if (!comment) throw notFound('Comment');
      if (comment.authorId === adminId) throw refused('own');
      if (comment.deletedAt !== null) throw refused('deleted');
      if (comment.hiddenAt !== null) throw refused('hidden');
      const now = await clockTimestamp(tx);
      await tx.update(postComments).set({ hiddenAt: now }).where(eq(postComments.id, commentId));
      return this.record(
        tx,
        adminId,
        { type: 'hide', userId: comment.authorId, commentId },
        body,
        { targetType: 'comment', targetKey: commentId },
        'moderation_comment_hide',
        { commentId },
      );
    });
    return this.answer(id, adminId);
  }

  /**
   * `POST /admin/moderation/users/:userId/warn` (#45-11: a record and the member's notice only).
   * With a subject — the member's post, comment or profile — the pending reports on it are
   * resolved by the warning; one not the member's is `not_theirs`.
   */
  async warn(
    adminId: string,
    userId: string,
    body: ParsedWarningBody,
  ): Promise<AdminModerationAction> {
    const id = await this.db.transaction(async (tx) => {
      if (userId === adminId) throw refused('own');
      await this.lockProfile(tx, userId);
      const subject = body.subject;
      let postId: string | null = null;
      let commentId: string | null = null;
      let target: ReportTarget | null = null;
      if (subject?.type === 'post') {
        const [post] = await tx
          .select({ authorId: schema.posts.authorId })
          .from(schema.posts)
          .where(eq(schema.posts.id, subject.postId))
          .for('update');
        if (!post) throw notFound('Post');
        if (post.authorId !== userId) throw refused('not_theirs');
        postId = subject.postId;
        target = { targetType: 'post', targetKey: postId };
      } else if (subject?.type === 'comment') {
        const [comment] = await tx
          .select({ authorId: schema.postComments.authorId })
          .from(schema.postComments)
          .where(eq(schema.postComments.id, subject.commentId))
          .for('update');
        if (!comment) throw notFound('Comment');
        if (comment.authorId !== userId) throw refused('not_theirs');
        commentId = subject.commentId;
        target = { targetType: 'comment', targetKey: commentId };
      } else if (subject?.type === 'profile') {
        target = { targetType: 'profile', targetKey: userId };
      }
      return this.record(
        tx,
        adminId,
        { type: 'warning', userId, postId, commentId },
        body,
        target,
        'moderation_warning',
        { subject },
      );
    });
    return this.answer(id, adminId);
  }

  /**
   * `POST /admin/moderation/users/:userId/nickname-reset` (#37-10): the nickname back to an auto
   * nickname, drawn as the sign-up trigger draws one (`user_` and four of AUTO_NICKNAME_ALPHABET)
   * under the same rules (#57-6) — never one another account has, ignoring case, nor one held from
   * the member (`nickname_held()`), each candidate under its nickname lock. The nickname taken away
   * is held for NICKNAME_HOLD_DAYS from everybody, the member included (owner decision 2026-10-21:
   * the hold other accounts get — a `nickname_holds` row naming no account, ADR-0081), and kept for
   * operators (`profile_item_removals`). The hold names the action (`action_id`) and starts at the
   * action's own time, so its cancellation finds it (`cancel`) and the member's 조치·신고 내역 counts
   * its 30 days from the action. The member's 30-day change interval is waived (the same
   * decision): `nickname_changed_at` is cleared, so they pick a new nickname at once, and that pick
   * starts the 30 days again (NicknameService). An auto nickname already is `nothing_to_remove`.
   */
  async resetNickname(
    adminId: string,
    userId: string,
    body: ParsedModerationActionBody,
  ): Promise<AdminModerationAction> {
    const id = await this.db.transaction(async (tx) => {
      if (userId === adminId) throw refused('own');
      const profile = await this.lockProfile(tx, userId);
      if (isAutoNickname(profile.nickname)) throw refused('nothing_to_remove');
      const now = await clockTimestamp(tx);
      await this.giveAutoNickname(tx, userId, profile.nickname);
      await tx
        .update(schema.profiles)
        .set({ nicknameChangedAt: null })
        .where(eq(schema.profiles.userId, userId));
      const actionId = await this.record(
        tx,
        adminId,
        { type: 'nickname_reset', userId },
        body,
        { targetType: 'profile', targetKey: userId },
        'moderation_nickname_reset',
        {},
        { nickname: profile.nickname },
        now,
      );
      await tx
        .insert(schema.nicknameHolds)
        .values({ nickname: profile.nickname, userId: null, releasedAt: now, actionId });
      return actionId;
    });
    return this.answer(id, adminId);
  }

  /** `POST /admin/moderation/users/:userId/bio-clear` (#37-10): the 소개 emptied, kept for operators. */
  async clearBio(
    adminId: string,
    userId: string,
    body: ParsedModerationActionBody,
  ): Promise<AdminModerationAction> {
    const id = await this.db.transaction(async (tx) => {
      if (userId === adminId) throw refused('own');
      const profile = await this.lockProfile(tx, userId);
      if (profile.bio === null) throw refused('nothing_to_remove');
      await tx.update(schema.profiles).set({ bio: null }).where(eq(schema.profiles.userId, userId));
      return this.record(
        tx,
        adminId,
        { type: 'bio_clear', userId },
        body,
        { targetType: 'profile', targetKey: userId },
        'moderation_bio_clear',
        {},
        { bio: profile.bio },
      );
    });
    return this.answer(id, adminId);
  }

  /**
   * `POST /admin/moderation/users/:userId/image-remove` (#37-10, ADR-0079 7-6): the profile lets go
   * of its image, and the image stays — its `media_objects` row and its bytes, attached and named
   * by no profile, so `GET /media/:mediaId` serves it to nobody — kept for operators
   * (`profile_item_removals`, read at `GET /admin/media/:mediaId`) until #184 removes it.
   */
  async removeImage(
    adminId: string,
    userId: string,
    body: ParsedModerationActionBody,
  ): Promise<AdminModerationAction> {
    const id = await this.db.transaction(async (tx) => {
      if (userId === adminId) throw refused('own');
      const profile = await this.lockProfile(tx, userId);
      if (profile.imageId === null) throw refused('nothing_to_remove');
      await tx
        .update(schema.profiles)
        .set({ imageId: null })
        .where(eq(schema.profiles.userId, userId));
      return this.record(
        tx,
        adminId,
        { type: 'image_remove', userId },
        body,
        { targetType: 'profile', targetKey: userId },
        'moderation_image_remove',
        {},
        { imageId: profile.imageId },
      );
    });
    return this.answer(id, adminId);
  }

  /**
   * `POST /admin/moderation/actions/:actionId/cancel` (decision 4 #50 «사유를 남기고 취소», #45-14:
   * how an accepted appeal is answered): the action no longer stands — a hiding's item shows again
   * (`hidden_at` cleared); a profile item is not restored (#37-10: the member sets it again). A
   * nickname reset's hold of the nickname it took away becomes the member's (owner decision
   * 2026-10-22: «그 보류가 본인의 것이 됨 … 닉네임을 저절로 되살리지는 않음»): the hold the reset wrote
   * (`action_id`) names the member from then on, so they may pick that nickname again, and every
   * other account stays held for the rest of the 30 days from the reset — the hold a member's own
   * change gives (`nickname_held()`). No interval is written: while that hold stands the member
   * picks that nickname with no interval even after changing to another since the reset — once:
   * taken back and given up again, it waits the interval — and any other nickname keeps the
   * interval (NicknameService's `handedBack`, owner decisions 2026-10-22 (2차) 1 and (4차) 1,
   * ADR-0081 7-13). Past the hold (30 days from the reset) there is nothing left to hand:
   * the nickname is anybody's, the member's interval applies to it as to any. Under
   * that nickname's lock (`lockNicknames`), the lock a pick of it takes: a pick in flight is
   * answered before the hold changes hands, and one that comes while this runs waits for it and
   * reads the hold as handed. The reports it resolved stay resolved (조치함 is what was done).
   * Refused: an action on the acting operator (`own`) and one cancelled already (`cancelled`).
   */
  async cancel(adminId: string, actionId: string, reason: string): Promise<AdminModerationAction> {
    await this.db.transaction(async (tx) => {
      const { moderationActions, posts, postComments } = schema;
      const [action] = await tx
        .select()
        .from(moderationActions)
        .where(eq(moderationActions.id, actionId))
        .for('update');
      if (!action) throw notFound('Action');
      if (action.userId === adminId) throw refused('own');
      if (action.cancelledAt !== null) throw refused('cancelled');
      if (action.type === 'hide') {
        // The item's row after the action's. A hiding of the same item meanwhile holds the item
        // first and finds it hidden (`hidden`) before it reaches the action: no lock is waited for
        // in the other order.
        if (action.postId !== null) {
          await tx.update(posts).set({ hiddenAt: null }).where(eq(posts.id, action.postId));
        } else if (action.commentId !== null) {
          await tx
            .update(postComments)
            .set({ hiddenAt: null })
            .where(eq(postComments.id, action.commentId));
        }
      } else if (action.type === 'nickname_reset') {
        await this.handHoldOver(tx, action.id, action.userId);
      }
      const now = await clockTimestamp(tx);
      await tx
        .update(moderationActions)
        .set({ cancelledAt: now, cancelledBy: adminId, cancelReason: reason })
        .where(eq(moderationActions.id, actionId));
      await this.audit(tx, adminId, 'moderation_cancel', 'moderation_action', actionId, {
        actionId,
        type: action.type,
        userId: action.userId,
        reason,
      });
    });
    return this.answer(actionId, adminId);
  }

  /**
   * `POST /admin/reports/dismiss` (기각: nothing done to anyone, #45-11): the reports named — the
   * ones the operator's screen showed, so one that arrived since stays pending — each pending and
   * none on the acting operator's own item or profile. The reporters read 기각. The reports are
   * locked in id order, the order an action takes the ones it resolves (`resolveReports`), so a
   * dismissal and an action on the same reports wait for each other instead of deadlocking.
   */
  async dismiss(
    adminId: string,
    reportIds: readonly string[],
    reason: string,
  ): Promise<AdminReport[]> {
    const ids = [...new Set(reportIds)];
    await this.db.transaction(async (tx) => {
      const { reports } = schema;
      const rows = await tx
        .select({ id: reports.id, status: reports.status, reportedUserId: reports.reportedUserId })
        .from(reports)
        .where(inArray(reports.id, ids))
        .orderBy(reports.id)
        .for('update');
      if (rows.length !== ids.length) {
        throw new AppError('NOT_FOUND', {
          message: 'Report not found',
          details: [{ path: ['reportIds'], message: 'no such report' }],
        });
      }
      if (rows.some((row) => row.reportedUserId === adminId)) throw refused('own');
      if (rows.some((row) => row.status !== 'pending')) throw refused('resolved');
      const now = await clockTimestamp(tx);
      await tx
        .update(reports)
        .set({ status: 'dismissed', resolvedAt: now, resolvedBy: adminId, dismissalReason: reason })
        .where(inArray(reports.id, ids));
      await this.audit(tx, adminId, 'report_dismiss', null, null, { reportIds: ids, reason });
    });
    return this.reads.reports(this.db, inArray(schema.reports.id, ids), adminId);
  }

  /**
   * The records of an action, in its transaction: the action, what a profile action took away, the
   * pending reports on `target` resolved by it, and the audit row. Answers the action's id. `at` is
   * the action's time when the caller wrote something at that instant (a nickname reset's hold);
   * the database clock's now otherwise.
   */
  private async record(
    tx: Tx,
    adminId: string,
    row: ActionRow,
    body: ActionReason,
    target: ReportTarget | null,
    auditType: AdminActionType,
    payload: Record<string, unknown>,
    removed?: { nickname?: string; bio?: string; imageId?: string },
    at?: Date,
  ): Promise<string> {
    const { moderationActions, profileItemRemovals } = schema;
    const now = at ?? (await clockTimestamp(tx));
    let action: { id: string } | undefined;
    try {
      [action] = await tx
        .insert(moderationActions)
        .values({
          type: row.type,
          userId: row.userId,
          postId: row.postId ?? null,
          commentId: row.commentId ?? null,
          reason: body.reason,
          note: body.note,
          createdBy: adminId,
          createdAt: now,
        })
        .returning({ id: moderationActions.id });
    } catch (error) {
      // Another operator's hiding of the same item committed first, past this one's row lock
      // only if the item was never locked — kept as the database's answer.
      if (STANDING_HIDE_INDEXES.some((index) => isPgError(error, PG_UNIQUE_VIOLATION, index))) {
        throw refused('hidden');
      }
      throw error;
    }
    const actionId = action!.id;
    if (removed !== undefined) {
      await tx.insert(profileItemRemovals).values({
        actionId,
        nickname: removed.nickname ?? null,
        bio: removed.bio ?? null,
        imageId: removed.imageId ?? null,
      });
    }
    const resolved =
      target === null ? [] : await this.resolveReports(tx, adminId, target, actionId, now);
    await this.audit(tx, adminId, auditType, 'moderation_action', actionId, {
      actionId,
      userId: row.userId,
      ...payload,
      reason: body.reason,
      note: body.note,
      reportIds: resolved.map((report) => report.id),
    });
    return actionId;
  }

  /**
   * The pending reports on `target`, resolved as `actioned` by the action: locked first in id
   * order — the order a dismissal locks the reports it names (`dismiss`) — and only then updated.
   * A dismissal takes no lock on the item or the profile, so nothing else puts the two in turn; an
   * UPDATE alone would take the rows in its scan's order (intake time, or where they lie), and a
   * dismissal and an action on the same reports at once could each hold one the other waits for
   * (a deadlock, 40P01 — a 500 to one operator). After a wait the lock reads the row again, so a
   * report a dismissal closed meanwhile is no longer pending and is left as it was.
   */
  private async resolveReports(
    tx: Tx,
    adminId: string,
    target: ReportTarget,
    actionId: string,
    now: Date,
  ): Promise<{ id: string }[]> {
    const { reports } = schema;
    const pending = await tx
      .select({ id: reports.id })
      .from(reports)
      .where(
        and(
          eq(reports.status, 'pending'),
          eq(reports.targetType, target.targetType),
          eq(reports.targetKey, target.targetKey),
        ),
      )
      .orderBy(reports.id)
      .for('update');
    if (pending.length === 0) return [];
    return tx
      .update(reports)
      .set({ status: 'actioned', resolvedAt: now, resolvedBy: adminId, actionId })
      .where(
        and(
          inArray(
            reports.id,
            pending.map((report) => report.id),
          ),
          eq(reports.status, 'pending'),
        ),
      )
      .returning({ id: reports.id });
  }

  /** The `admin_actions` row of a write (admin-audit.test.ts), in its transaction. */
  private async audit(
    tx: Tx,
    adminId: string,
    type: AdminActionType,
    targetType: string | null,
    targetId: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(schema.adminActions).values({ adminId, type, targetType, targetId, payload });
  }

  /**
   * A cancelled nickname reset's hold, handed to the member (`cancel`): the hold the reset wrote
   * (`nickname_holds.action_id`) names the member from now on. Taken under that nickname's lock
   * (`lockNicknames`, migration 0032's `lock_nickname`), as every nickname write and every pick of
   * a nickname is, after the action's row: nothing takes a nickname's lock and then an action's.
   * A reset whose hold is gone (#184 removes it past the 30 days) hands nothing.
   */
  private async handHoldOver(tx: Tx, actionId: string, userId: string): Promise<void> {
    const { nicknameHolds } = schema;
    const [hold] = await tx
      .select({ id: nicknameHolds.id, nickname: nicknameHolds.nickname })
      .from(nicknameHolds)
      .where(eq(nicknameHolds.actionId, actionId))
      .limit(1);
    if (!hold) return;
    await lockNicknames(tx, [hold.nickname]);
    await tx.update(nicknameHolds).set({ userId }).where(eq(nicknameHolds.id, hold.id));
  }

  /** The member's profile row, locked for the write (a report on the profile holds it shared). */
  private async lockProfile(tx: Tx, userId: string) {
    const { profiles } = schema;
    const [profile] = await tx
      .select({ nickname: profiles.nickname, bio: profiles.bio, imageId: profiles.imageId })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1)
      .for('update');
    if (!profile) throw notFound('User');
    return profile;
  }

  /**
   * Draws an auto nickname for the member and writes it (`resetNickname`): each candidate under the
   * nickname locks of the one given up and itself (`lockNicknames`, the order every nickname write
   * takes them in), skipped while held from the member or taken by another account in any case.
   * The write runs in a savepoint, so a candidate that turns out taken after all is one more draw.
   */
  private async giveAutoNickname(tx: Tx, userId: string, current: string): Promise<void> {
    const { profiles } = schema;
    for (let draw = 1; draw <= NICKNAME_DRAWS; draw += 1) {
      let candidate = AUTO_NICKNAME_PREFIX;
      for (let i = 0; i < AUTO_NICKNAME_SUFFIX_LENGTH; i += 1) {
        candidate += AUTO_NICKNAME_ALPHABET[randomInt(AUTO_NICKNAME_ALPHABET.length)];
      }
      await lockNicknames(tx, [current, candidate]);
      if (await isNicknameHeld(tx, candidate, userId)) continue;
      const [taken] = await tx
        .select({ one: sql`1` })
        .from(profiles)
        .where(sql`lower(${profiles.nickname}) = lower(${candidate})`)
        .limit(1);
      if (taken) continue;
      try {
        await tx.transaction(async (savepoint) => {
          await savepoint
            .update(profiles)
            .set({ nickname: candidate })
            .where(eq(profiles.userId, userId));
        });
        return;
      } catch (error) {
        if (isPgError(error, PG_UNIQUE_VIOLATION, NICKNAME_UNIQUE_INDEX)) continue;
        throw error;
      }
    }
    throw new AppError('INTERNAL', {
      message: `No free auto nickname after ${String(NICKNAME_DRAWS)} draws`,
    });
  }

  /** The action as operators read it, after its commit. */
  private async answer(actionId: string, adminId: string): Promise<AdminModerationAction> {
    const [action] = await this.reads.actions(
      this.db,
      eq(schema.moderationActions.id, actionId),
      adminId,
    );
    if (!action) throw notFound('Action');
    return action;
  }
}

function refused(reason: ModerationRefusal): AppError {
  const details: ModerationNotAllowedDetails = { reason };
  return new AppError('MODERATION_NOT_ALLOWED', { message: `Not allowed: ${reason}`, details });
}

function notFound(what: 'Post' | 'Comment' | 'User' | 'Action'): AppError {
  return new AppError('NOT_FOUND', { message: `${what} not found` });
}
