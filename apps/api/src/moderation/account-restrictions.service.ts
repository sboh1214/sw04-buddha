import { Inject, Injectable } from '@nestjs/common';
import { lockAdminRoles, schema, type Db } from '@buddha/db';
import {
  ACCOUNT_RESTRICTION_APPROVAL_KINDS,
  ACCOUNT_RESTRICTION_DAYS,
  accountRestrictionChangeOf,
  accountRestrictionEndOf,
  accountRestrictionReasonSchema,
  moderationTargetSchema,
  type AccountRestrictionChange,
  type AccountRestrictionDecision,
  type AccountRestrictionRequest,
  type AdminModerationAction,
  type ModerationTarget,
  type ParsedAccountRestrictionBody,
  type WarningSubject,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import {
  type ApprovalRequest,
  ApprovalService,
  approvalNotAllowed,
} from '../approvals/approval.service.js';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { ModerationReadsService, accountRestrictionMoot } from './moderation-reads.service.js';
import {
  ModerationService,
  notFound,
  refused,
  type ResolvedSubject,
} from './moderation.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** What an `apply` request keeps (`approval_requests.payload`), read back when it is approved. */
const applyPayloadSchema = z.object({
  userId: z.string(),
  reason: accountRestrictionReasonSchema,
  note: z.string(),
  days: z.literal(ACCOUNT_RESTRICTION_DAYS).nullable(),
  subject: moderationTargetSchema.nullable(),
});

/** What a `shorten` request keeps: the end asked for. A lift and a cancellation keep no more. */
const shortenPayloadSchema = z.object({ endsAt: z.iso.datetime() });

/** A change of a restriction that stands already: what a request about an action asks. */
type ActionChange = Exclude<AccountRestrictionChange, 'apply'>;

/** An `apply`'s request read back, and its subject as its approval locked it (`lockApply`). */
interface LockedApply {
  payload: z.output<typeof applyPayloadSchema>;
  subject: ResolvedSubject;
}

/** The account restriction a change names, as its approval locked it (`lockAction`). */
interface LockedAction {
  id: string;
  type: string;
  endsAt: Date | null;
  cancelledAt: Date | null;
}

/**
 * 계정 제한 (#139, ADR-0085; ADR-0069 decision 1 #57-12…#57-15, decision 2 #45-11, #45-14, decision 3
 * #37-8, #37-9, decision 4 #139 and #140 rows; ADR-0056 decision 1-7): an operator asks, another
 * admin approves. Every step — putting a member's account under restriction, bringing its end
 * forward (감경), lifting it early (조기 해제) and cancelling it (취소) — is first a request of the
 * two-person rule (`approval_requests`, ApprovalService), and is done only by an admin who is
 * neither the one who asked (APPROVAL_NOT_ALLOWED `requester`, in every environment) nor the member
 * (`own`, decision 4 #50 «다른 운영자만»), in the transaction that writes the approval. Migration
 * 0040's triggers hold the same whoever writes: no account restriction, change of its end or
 * cancellation without its approved request.
 *
 * The record keeps what #57-12 asks — the reason (one of ACCOUNT_RESTRICTION_REASONS and the
 * explanation the member reads), the operator and the time — as one `moderation_actions` row per
 * restriction: the operator who asked is its operator (`created_by`, `cancelled_by`,
 * `restriction_end_changes.created_by`), and the approval names the admin who approved it, why and
 * when. A restriction's time, and so the start of its term, is its approval's (ADR-0085 7-1): it
 * is in force from then.
 *
 * A request's life (ADR-0056 decision 5 leaves it to the consumer; ADR-0085 7-3): it waits with no
 * expiry; the one who asked cannot withdraw it — another admin rejects it with a reason, as any
 * request not wanted any more; one the restriction outgrew (cancelled, ended, past the end asked
 * for) is refused on approval for what changed (MODERATION_NOT_ALLOWED, the request's `moot`) and
 * waits for that rejection; a requester who lost the admin role since leaves their requests as they
 * are, for another admin to decide. One about an operator is decided — approved or rejected — only
 * by a third admin, so with the seed's two it waits until a third is granted (7-15). Whether it
 * should be refused, withdrawn or expire then is the owner's question, as is what becomes of a
 * pending request once its member closes the account (ADR-0085 결과 4의 12·13). Nothing here
 * touches a balance, an order or a record of trades (N02 §9: «잔액·기록·이의제기 경로는 유지»).
 */
@Injectable()
export class AccountRestrictionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly approvals: ApprovalService,
    private readonly moderation: ModerationService,
    private readonly reads: ModerationReadsService,
  ) {}

  // ---- requests ---------------------------------------------------------------------------------

  /**
   * `POST /admin/moderation/users/:userId/account-restriction`: a request to restrict the member's
   * account for `days` (or 무기한, `null`), with the reason and the explanation the member will read
   * — the request's reason as well — and what it is about (a post, a comment or the profile of the
   * member's, from the report queue; checked now and again on approval). Nothing is in force
   * until another admin approves it. Refused: the acting operator (`own`), an unknown member
   * (NOT_FOUND), a subject not the member's (`not_theirs`).
   */
  async requestApply(
    adminId: string,
    userId: string,
    body: ParsedAccountRestrictionBody,
  ): Promise<AccountRestrictionRequest> {
    const id = await this.db.transaction(async (tx) => {
      if (userId === adminId) throw refused('own');
      await this.moderation.lockProfile(tx, userId);
      const { postId, commentId } = await this.moderation.subjectOf(tx, userId, body.subject);
      const subject = await this.targetOf(tx, userId, body.subject, postId, commentId);
      const request = await this.approvals.request(
        {
          kind: ACCOUNT_RESTRICTION_APPROVAL_KINDS.apply,
          targetType: 'user',
          targetId: userId,
          payload: { userId, reason: body.reason, note: body.note, days: body.days, subject },
          requestedBy: adminId,
          reason: body.note,
        },
        tx,
      );
      await this.moderation.audit(
        tx,
        adminId,
        'account_restriction_request',
        'approval_request',
        request.id,
        {
          requestId: request.id,
          userId,
          subject,
          days: body.days,
          reason: body.reason,
          note: body.note,
        },
      );
      return request.id;
    });
    return this.reads.request(this.db, id, adminId);
  }

  /**
   * `POST /admin/moderation/actions/:actionId/account-restriction/shorten`, `…/lift` and
   * `…/cancel`: a request to bring a standing account restriction's end forward to `endsAt` (감경,
   * 무기한 to a term included), to lift it now (조기 해제) or to cancel it (취소), with the reason
   * (operators only, as #185's). Refused now what its approval would refuse — another type
   * (`not_account_restriction`), one on the acting operator (`own`), a cancelled one, one ended (a
   * cancellation excepted), a 감경 not earlier or not to come — so a request is never made for
   * nothing; its approval asks again.
   */
  async requestChange(
    adminId: string,
    actionId: string,
    change: ActionChange,
    reason: string,
    endsAt?: Date,
  ): Promise<AccountRestrictionRequest> {
    const id = await this.db.transaction(async (tx) => {
      const { moderationActions } = schema;
      const [action] = await tx
        .select({
          id: moderationActions.id,
          type: moderationActions.type,
          userId: moderationActions.userId,
          endsAt: moderationActions.endsAt,
          cancelledAt: moderationActions.cancelledAt,
        })
        .from(moderationActions)
        .where(eq(moderationActions.id, actionId))
        .limit(1);
      if (!action) throw notFound('Action');
      if (action.userId === adminId) throw refused('own');
      if (action.type !== 'account_restriction') throw refused('not_account_restriction');
      const moot = accountRestrictionMoot(action, change, await clockTimestamp(tx), endsAt ?? null);
      if (moot !== null) throw refused(moot);
      const request = await this.approvals.request(
        {
          kind: ACCOUNT_RESTRICTION_APPROVAL_KINDS[change],
          targetType: 'moderation_action',
          targetId: action.id,
          payload: {
            userId: action.userId,
            actionId: action.id,
            ...(endsAt === undefined ? {} : { endsAt: endsAt.toISOString() }),
          },
          requestedBy: adminId,
          reason,
        },
        tx,
      );
      await this.moderation.audit(
        tx,
        adminId,
        change === 'shorten'
          ? 'account_restriction_shorten_request'
          : change === 'lift'
            ? 'account_restriction_lift_request'
            : 'account_restriction_cancel_request',
        'approval_request',
        request.id,
        {
          requestId: request.id,
          actionId: action.id,
          userId: action.userId,
          ...(endsAt === undefined ? {} : { endsAt: endsAt.toISOString() }),
          reason: request.requestReason,
        },
      );
      return request.id;
    });
    return this.reads.request(this.db, id, adminId);
  }

  // ---- decisions --------------------------------------------------------------------------------

  /**
   * `POST /admin/moderation/account-restriction-requests/:requestId/approve`: another admin approves
   * the request, with a reason, and what it asked for is done in the same transaction, at the
   * approval's instant (ADR-0056 decision 1-7):
   * - `apply`: the member's profile locked FOR UPDATE first — every order (#119's `assertCanTrade`)
   *   and every public item write hold or lock it until they commit — so the restriction holds
   *   from this commit with nothing slipping past; then its subject (re-checked: the member's) and
   *   the restriction, ending `days` after the approval (or 무기한), with the pending reports on the
   *   subject resolved (조치함). A member restricted already keeps the one that ends later.
   * - `shorten`, `lift`: the restriction's end brought forward to the end asked for, or to now —
   *   the change recorded as the asking operator's, with its approval.
   * - `cancel`: the restriction cancelled at once, as the asking operator's, with its approval.
   *
   * Every lock the approval waits on is taken before the decision, whose instant (read by
   * ApprovalService after its own lock of the request) is the time of everything written here —
   * infra/db/clock.ts: read the clock after the last lock queued on. So what committed while the
   * approval waited sorts before it: an order or a report on the subject that got in first, and a
   * change of the restriction approved first — which then leaves this one `ended` or `cancelled`
   * rather than writing an end, or a cancellation, timed before it (ADR-0085 7-14). The admin-roles
   * lock comes first, shared, as the decision takes it: a role grant takes it exclusively and then
   * the grantee's profile row, so the profile after it keeps the one order (no deadlock).
   *
   * Refused: no such request of #139 (NOT_FOUND), the member deciding about themselves (`own`), the
   * one who asked (APPROVAL_NOT_ALLOWED `requester`), one decided already (`decided`), and what the
   * restriction outgrew since the request (`cancelled`, `ended`, `not_earlier`, `end_passed`) —
   * nothing is written then, the decision included.
   */
  async approve(
    deciderId: string,
    requestId: string,
    reason: string,
  ): Promise<AccountRestrictionDecision> {
    const actionId = await this.db.transaction(async (tx) => {
      const { request, change, memberId } = await this.decidable(tx, deciderId, requestId);
      // Every lock first, then the decision and its instant (see above).
      await lockAdminRoles(tx, 'shared');
      const locked =
        change === 'apply'
          ? { change, apply: await this.lockApply(tx, request, memberId) }
          : { change, action: await this.lockAction(tx, request.targetId!) };
      const decided = await this.approvals.approve(deciderId, request.id, reason, tx);
      const at = decided.decidedAt!;
      let done: { actionId: string; reportIds: string[] };
      if (locked.change === 'apply') {
        done = await this.applyApproved(tx, request, memberId, locked.apply, at);
      } else if (locked.change === 'cancel') {
        done = {
          actionId: await this.cancelApproved(tx, request, locked.action, at),
          reportIds: [],
        };
      } else {
        const actionId = await this.changeEndApproved(
          tx,
          request,
          locked.change,
          locked.action,
          at,
        );
        done = { actionId, reportIds: [] };
      }
      await this.moderation.audit(
        tx,
        deciderId,
        'account_restriction_approve',
        'approval_request',
        request.id,
        {
          requestId: request.id,
          change,
          actionId: done.actionId,
          userId: memberId,
          reason: decided.decisionReason,
          reportIds: done.reportIds,
        },
      );
      return done.actionId;
    });
    return {
      request: await this.reads.request(this.db, requestId, deciderId),
      action: await this.answer(actionId, deciderId),
    };
  }

  /**
   * `POST /admin/moderation/account-restriction-requests/:requestId/reject`: another admin rejects
   * the request, with a reason; nothing is done. The way a request not wanted any more is closed —
   * the one who asked included, who asks another admin to (ADR-0085 7-3). Refused as an approval
   * is, but for what the restriction outgrew: a moot request is rejected all the same.
   */
  async reject(
    deciderId: string,
    requestId: string,
    reason: string,
  ): Promise<AccountRestrictionDecision> {
    const actionId = await this.db.transaction(async (tx) => {
      const { request, change, memberId } = await this.decidable(tx, deciderId, requestId);
      const decided = await this.approvals.reject(deciderId, request.id, reason, tx);
      const actionId = change === 'apply' ? null : request.targetId;
      await this.moderation.audit(
        tx,
        deciderId,
        'account_restriction_reject',
        'approval_request',
        request.id,
        {
          requestId: request.id,
          change,
          actionId,
          userId: memberId,
          reason: decided.decisionReason,
        },
      );
      return actionId;
    });
    return {
      request: await this.reads.request(this.db, requestId, deciderId),
      action: actionId === null ? null : await this.answer(actionId, deciderId),
    };
  }

  /**
   * The request a decision is about, if it is #139's (NOT_FOUND otherwise — another consumer's
   * request is not decided here), with the member it is about: never the deciding admin (`own`).
   * The rest of the two-person rule is ApprovalService's, under its locks; it is asked here too,
   * before an approval queues on the member's or the restriction's row, so the one who asked and a
   * request decided already are refused as such whatever those rows hold now.
   */
  private async decidable(
    tx: Tx,
    deciderId: string,
    requestId: string,
  ): Promise<{ request: ApprovalRequest; change: AccountRestrictionChange; memberId: string }> {
    const request = await this.approvals.get(requestId, tx);
    const change = accountRestrictionChangeOf(request.kind);
    if (change === null || request.targetId === null) {
      throw new AppError('NOT_FOUND', { message: 'Approval request not found' });
    }
    let memberId = request.targetId;
    if (change !== 'apply') {
      const [action] = await tx
        .select({ userId: schema.moderationActions.userId })
        .from(schema.moderationActions)
        .where(eq(schema.moderationActions.id, request.targetId))
        .limit(1);
      if (!action) throw notFound('Action');
      memberId = action.userId;
    }
    if (memberId === deciderId) throw refused('own');
    if (request.requestedBy === deciderId) throw approvalNotAllowed('requester');
    if (request.status !== 'pending') throw approvalNotAllowed('decided');
    return { request, change, memberId };
  }

  /**
   * What an `apply`'s approval waits on, before its decision (see `approve`): the member's profile
   * FOR UPDATE, then its subject (re-checked: the member's) — the order an edit of it takes them in.
   */
  private async lockApply(
    tx: Tx,
    request: ApprovalRequest,
    memberId: string,
  ): Promise<LockedApply> {
    const payload = this.payloadOf(applyPayloadSchema, request);
    await this.moderation.lockProfile(tx, memberId);
    const subject = await this.moderation.subjectOf(
      tx,
      memberId,
      warningSubjectOf(payload.subject),
    );
    return { payload, subject };
  }

  /** An approved `apply`: the restriction in force from `at`, its rows locked (see `approve`). */
  private async applyApproved(
    tx: Tx,
    request: ApprovalRequest,
    memberId: string,
    { payload, subject }: LockedApply,
    at: Date,
  ): Promise<{ actionId: string; reportIds: string[] }> {
    const { postId, commentId, target } = subject;
    const [action] = await tx
      .insert(schema.moderationActions)
      .values({
        type: 'account_restriction',
        userId: memberId,
        postId,
        commentId,
        reason: payload.reason,
        note: payload.note,
        createdBy: request.requestedBy,
        createdAt: at,
        endsAt: accountRestrictionEndOf(at, payload.days),
        approvalId: request.id,
      })
      .returning({ id: schema.moderationActions.id });
    const actionId = action!.id;
    const resolved =
      target === null
        ? []
        : await this.moderation.resolveReports(tx, request.requestedBy, target, actionId, at);
    return { actionId, reportIds: resolved.map((report) => report.id) };
  }

  /**
   * An approved `shorten` or `lift`: the restriction locked before the decision (see `approve`),
   * the rules asked again at `at`, the end brought forward and the change recorded (the asking
   * operator's, its reason, the approval) — migration 0040's triggers hold that the change and the
   * end go together.
   */
  private async changeEndApproved(
    tx: Tx,
    request: ApprovalRequest,
    change: 'shorten' | 'lift',
    action: LockedAction,
    at: Date,
  ): Promise<string> {
    const requested =
      change === 'shorten' ? new Date(this.payloadOf(shortenPayloadSchema, request).endsAt) : null;
    const moot = accountRestrictionMoot(action, change, at, requested);
    if (moot !== null) throw refused(moot);
    const endsAt = requested ?? at;
    const { moderationActions, restrictionEndChanges } = schema;
    await tx.update(moderationActions).set({ endsAt }).where(eq(moderationActions.id, action.id));
    await tx.insert(restrictionEndChanges).values({
      actionId: action.id,
      kind: change,
      previousEndsAt: action.endsAt,
      endsAt,
      reason: request.requestReason,
      createdBy: request.requestedBy,
      createdAt: at,
      approvalId: request.id,
    });
    return action.id;
  }

  /**
   * An approved `cancel`: the restriction, locked before the decision (see `approve`), ends at
   * once, its end kept as given (#50's way).
   */
  private async cancelApproved(
    tx: Tx,
    request: ApprovalRequest,
    action: LockedAction,
    at: Date,
  ): Promise<string> {
    const moot = accountRestrictionMoot(action, 'cancel', at, null);
    if (moot !== null) throw refused(moot);
    await tx
      .update(schema.moderationActions)
      .set({
        cancelledAt: at,
        cancelledBy: request.requestedBy,
        cancelReason: request.requestReason,
        cancelApprovalId: request.id,
      })
      .where(eq(schema.moderationActions.id, action.id));
    return action.id;
  }

  /** The account restriction a change names, locked for the change. */
  private async lockAction(tx: Tx, actionId: string): Promise<LockedAction> {
    const { moderationActions } = schema;
    const [action] = await tx
      .select({
        id: moderationActions.id,
        type: moderationActions.type,
        endsAt: moderationActions.endsAt,
        cancelledAt: moderationActions.cancelledAt,
      })
      .from(moderationActions)
      .where(eq(moderationActions.id, actionId))
      .for('update');
    if (!action) throw notFound('Action');
    if (action.type !== 'account_restriction') throw refused('not_account_restriction');
    return action;
  }

  /**
   * What an `apply` is about, as the request keeps it and operators read it (`ModerationTarget`):
   * the comment with its post, so the request's page links to it.
   */
  private async targetOf(
    tx: Tx,
    userId: string,
    subject: WarningSubject | null,
    postId: string | null,
    commentId: string | null,
  ): Promise<ModerationTarget | null> {
    if (subject === null) return null;
    if (postId !== null) return { type: 'post', postId };
    if (commentId !== null) {
      const [comment] = await tx
        .select({ postId: schema.postComments.postId })
        .from(schema.postComments)
        .where(eq(schema.postComments.id, commentId))
        .limit(1);
      return { type: 'comment', commentId, postId: comment!.postId };
    }
    return { type: 'profile', userId };
  }

  /** A request's payload as this service wrote it; INTERNAL if it is not (nothing else writes it). */
  private payloadOf<T extends z.ZodType>(payloadSchema: T, request: ApprovalRequest): z.output<T> {
    const parsed = payloadSchema.safeParse(request.payload);
    if (!parsed.success) {
      throw new AppError('INTERNAL', { message: `Approval request ${request.id} has no payload` });
    }
    return parsed.data;
  }

  /** The restriction as operators read it, after its commit. */
  private async answer(actionId: string, viewerId: string): Promise<AdminModerationAction> {
    const [action] = await this.reads.actions(
      this.db,
      eq(schema.moderationActions.id, actionId),
      viewerId,
    );
    if (!action) throw notFound('Action');
    return action;
  }
}

/** A request's subject back as a body names it, for `subjectOf`. */
function warningSubjectOf(subject: ModerationTarget | null): WarningSubject | null {
  if (subject === null) return null;
  switch (subject.type) {
    case 'post':
      return { type: 'post', postId: subject.postId };
    case 'comment':
      return { type: 'comment', commentId: subject.commentId };
    case 'profile':
      return { type: 'profile' };
  }
}
