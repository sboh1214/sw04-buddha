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
import { and, eq, notInArray, sql } from 'drizzle-orm';
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
  /** The operators' memo (owner decision 2026-10-23), null for none; never the member's. */
  memo: z.string().nullable().default(null),
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
 * 0042's triggers hold the same whoever writes: no account restriction, change of its end or
 * cancellation without its approved request.
 *
 * The record keeps what #57-12 asks — the reason (one of ACCOUNT_RESTRICTION_REASONS and the
 * explanation the member reads), the operator and the time — as one `moderation_actions` row per
 * restriction: the operator who asked is its operator (`created_by`, `cancelled_by`,
 * `restriction_end_changes.created_by`), and the approval names the admin who approved it, why and
 * when. A restriction's time, and so the start of its term, is its approval's (ADR-0085 7-1): it
 * is in force from then.
 *
 * A request's life (ADR-0056 decision 5 leaves it to the consumer; owner decision 2026-10-23,
 * ADR-0085 decision 1 and 7-3): it waits with no expiry, until another admin approves or rejects
 * it or the one who asked retracts it — theirs alone, before any decision, recorded with who and
 * when (`retract`; a retracted request is decided by no one). It is not taken at all when no
 * admin could decide it — none but the one asking and the member it is about (MODERATION_NOT_ALLOWED
 * `no_decider`, asked under the admin-roles lock, so a grant or revoke in flight is waited for).
 * One the restriction outgrew (cancelled, ended, past the end asked for) is refused on approval
 * for what changed (MODERATION_NOT_ALLOWED, the request's `moot`) and waits for a rejection or its
 * retraction; a requester who lost the admin role since leaves their requests as they are, for
 * another admin to decide. One about an operator is decided — approved or rejected — only by a
 * third admin (7-15). An `apply` carries the operators' own memo, optional and never the member's
 * (owner decision 2026-10-23). What becomes of a pending request once its member closes the
 * account is #140's (owner decision 2026-10-23: closed then, rejected for '탈퇴' — ADR-0085 결과 5),
 * and no new `apply` about a closed account is taken or approved (`closed`, owner decision
 * 2026-10-23 (2차) 1, ADR-0086); a change of an earlier one (a cancellation, say) is asked as for
 * any member. Nothing here touches a balance, an order or a record of trades (N02 §9:
 * «잔액·기록·이의제기 경로는 유지»).
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
   * — the request's reason as well — what it is about (a post, a comment or the profile of the
   * member's, from the report queue; checked now and again on approval) and the operators' memo
   * (optional). Nothing is in force until another admin approves it. Refused: the acting operator
   * (`own`), an unknown member (NOT_FOUND), a member who closed the account (`closed`, #140 — owner
   * decision 2026-10-23 (2차) 1), a subject not the member's (`not_theirs`), no admin but the acting
   * one and the member to decide it (`no_decider`).
   */
  async requestApply(
    adminId: string,
    userId: string,
    body: ParsedAccountRestrictionBody,
  ): Promise<AccountRestrictionRequest> {
    const id = await this.db.transaction(async (tx) => {
      if (userId === adminId) throw refused('own');
      // The role lock before the profile's, as a role grant takes them (see `assertDecider`).
      await lockAdminRoles(tx, 'shared');
      await this.moderation.lockOpenProfile(tx, userId);
      const { postId, commentId } = await this.moderation.subjectOf(tx, userId, body.subject);
      const subject = await this.targetOf(tx, userId, body.subject, postId, commentId);
      await this.assertDecider(tx, adminId, userId);
      const request = await this.approvals.request(
        {
          kind: ACCOUNT_RESTRICTION_APPROVAL_KINDS.apply,
          targetType: 'user',
          targetId: userId,
          payload: {
            userId,
            reason: body.reason,
            note: body.note,
            days: body.days,
            subject,
            memo: body.memo,
          },
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
          memo: body.memo,
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
   * nothing; its approval asks again. Refused too with no admin but the acting one and the member
   * to decide it (`no_decider`).
   */
  async requestChange(
    adminId: string,
    actionId: string,
    change: ActionChange,
    reason: string,
    endsAt?: Date,
  ): Promise<AccountRestrictionRequest> {
    const id = await this.db.transaction(async (tx) => {
      await lockAdminRoles(tx, 'shared');
      const { moderationActions } = schema;
      const [action] = await tx
        .select({
          id: moderationActions.id,
          type: moderationActions.type,
          userId: moderationActions.userId,
          endsAt: moderationActions.endsAt,
          cancelledAt: moderationActions.cancelledAt,
          postId: moderationActions.postId,
          commentId: moderationActions.commentId,
        })
        .from(moderationActions)
        .where(eq(moderationActions.id, actionId))
        .limit(1);
      if (!action) throw notFound('Action');
      if (action.userId === adminId) throw refused('own');
      if (action.type !== 'account_restriction') throw refused('not_account_restriction');
      // The member's profile, held FOR KEY SHARE until the request commits, as `requestApply` holds
      // it (FOR UPDATE): a closure in flight holds it FOR UPDATE from its start (#140), so a request
      // about the member made meanwhile waits for it and comes after it. Otherwise one committed
      // between the closure's look for the requests it closes and its commit would make migration
      // 0043's check at that commit refuse the closure (`profiles_closed_completely`: a request
      // about it waiting). Before the clock is read (infra/db/clock.ts).
      await tx
        .select({ one: sql`1` })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, action.userId))
        .for('key share');
      // The post or comment the restriction cites, held FOR SHARE until the request commits, as a
      // report holds its target: #184's retention run keeps what a pending request cites — a deleted
      // original, the edit history and the images only it used (`nothingAwaits`, ADR-0087 7-29) —
      // and asks only once it holds the item FOR NO KEY UPDATE, so a request in flight commits
      // first and is seen. After the member's profile, the order an edit or an apply's approval
      // takes the two in; nothing that holds such an item waits for a profile this holds.
      if (action.postId !== null) {
        await tx
          .select({ one: sql`1` })
          .from(schema.posts)
          .where(eq(schema.posts.id, action.postId))
          .for('share');
      }
      if (action.commentId !== null) {
        await tx
          .select({ one: sql`1` })
          .from(schema.postComments)
          .where(eq(schema.postComments.id, action.commentId))
          .for('share');
      }
      const moot = accountRestrictionMoot(action, change, await clockTimestamp(tx), endsAt ?? null);
      if (moot !== null) throw refused(moot);
      await this.assertDecider(tx, adminId, action.userId);
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
   * - `apply`: the member's profile locked FOR UPDATE first (with the deciding admin's, in
   *   account-id order — see below) — every order (#119's `assertCanTrade`) and every public item
   *   write hold or lock it until they commit — so the restriction holds from this commit with
   *   nothing slipping past; then its subject (re-checked: the member's) and the restriction,
   *   ending `days` after the approval (or 무기한), with the pending reports on the subject
   *   resolved (조치함). A member restricted already keeps the one that ends later.
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
   * the grantee's profile row, so the profiles after it keep the one order (no deadlock). Then the
   * profiles, in account-id order (`lockProfiles`, 7-17): the deciding admin's, which the
   * decision's trigger locks again, and an `apply`'s member's — so two approvals whose deciders are
   * each other's members do not deadlock — and then the rows they come before.
   *
   * Refused: no such request of #139 (NOT_FOUND), the member deciding about themselves (`own`), the
   * one who asked (APPROVAL_NOT_ALLOWED `requester`), one decided already (`decided`), an `apply`
   * about a member who closed the account (`closed`, #140), and what the restriction outgrew since
   * the request (`cancelled`, `ended`, `not_earlier`, `end_passed`) — nothing is written then, the
   * decision included.
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
      await this.lockProfiles(tx, deciderId, change === 'apply' ? memberId : null);
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
   * the request, with a reason; nothing is done. Refused as an approval is, but for what the
   * restriction outgrew: a moot request is rejected all the same (or retracted by the one who
   * asked).
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
   * `POST /admin/moderation/account-restriction-requests/:requestId/retract` (owner decision
   * 2026-10-23, ADR-0085): the one who asked takes their request back before anyone decides it —
   * nothing is done, and the request is closed as retracted, with when (ApprovalService.retract)
   * and an audit row naming them. Refused: no such request of #139 (NOT_FOUND), anyone but the one
   * who asked (APPROVAL_NOT_ALLOWED `not_requester`), one decided (`decided`) or retracted
   * (`retracted`) already. A moot request is retracted all the same.
   */
  async retract(adminId: string, requestId: string): Promise<AccountRestrictionRequest> {
    await this.db.transaction(async (tx) => {
      const { request, change, memberId } = await this.ofRestriction(tx, requestId);
      const retracted = await this.approvals.retract(adminId, request.id, tx);
      await this.moderation.audit(
        tx,
        adminId,
        'account_restriction_retract',
        'approval_request',
        retracted.id,
        {
          requestId: retracted.id,
          change,
          actionId: change === 'apply' ? null : request.targetId,
          userId: memberId,
        },
      );
    });
    return this.reads.request(this.db, requestId, adminId);
  }

  /**
   * The request a decision is about, if it is #139's (NOT_FOUND otherwise — another consumer's
   * request is not decided here), with the member it is about: never the deciding admin (`own`).
   * The rest of the two-person rule is ApprovalService's, under its locks; it is asked here too,
   * before an approval queues on the member's or the restriction's row, so the one who asked, a
   * request retracted and one decided already are refused as such whatever those rows hold now.
   */
  private async decidable(
    tx: Tx,
    deciderId: string,
    requestId: string,
  ): Promise<{ request: ApprovalRequest; change: AccountRestrictionChange; memberId: string }> {
    const found = await this.ofRestriction(tx, requestId);
    const { request, memberId } = found;
    if (memberId === deciderId) throw refused('own');
    if (request.requestedBy === deciderId) throw approvalNotAllowed('requester');
    if (request.status === 'retracted') throw approvalNotAllowed('retracted');
    if (request.status !== 'pending') throw approvalNotAllowed('decided');
    return found;
  }

  /**
   * A request of #139 (NOT_FOUND otherwise), what it asks and the member it is about — an
   * `apply`'s target, or the member of the restriction a change names.
   */
  private async ofRestriction(
    tx: Tx,
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
    return { request, change, memberId };
  }

  /**
   * Whether an admin could decide a request `requesterId` makes about `memberId` (owner decision
   * 2026-10-23, ADR-0085): one who is neither — the requester decides nothing of theirs
   * (ADR-0056 decision 4) and the member nothing about themselves (`own`). MODERATION_NOT_ALLOWED
   * `no_decider` when there is none, so no request waits for a decider who does not exist. Read
   * under the admin-roles lock the caller took first (shared), so a grant or a revoke in flight is
   * waited for. A decider revoked after the request leaves it to wait, for the one who asked to
   * retract or for an admin granted since.
   */
  private async assertDecider(tx: Tx, requesterId: string, memberId: string): Promise<void> {
    const [decider] = await tx
      .select({ userId: schema.profiles.userId })
      .from(schema.profiles)
      .where(
        and(
          eq(schema.profiles.role, 'admin'),
          notInArray(schema.profiles.userId, [requesterId, memberId]),
        ),
      )
      .limit(1);
    if (!decider) throw refused('no_decider');
  }

  /**
   * The profiles an approval locks, before any other row of it (see `approve`; ADR-0085 7-17): the
   * deciding admin's FOR SHARE — the lock migration 0021's `approval_requests_keep_record` takes on
   * it when the decision is written, which then finds it held — and, for an `apply`, the member's
   * FOR UPDATE (`ModerationService.lockOpenProfile`: NOT_FOUND for no such member, `closed` for one
   * who closed the account since — #140, owner decision 2026-10-23 (2차) 1: the closure rejects
   * every `apply` about the member still waiting and no new one is taken, so none should be left
   * to approve — asked all the same, under the lock the closure takes first), the two in
   * account-id order. Taken as they came (the member's here, the decider's by the trigger), two
   * approvals whose deciders are each other's members — A approving a request about B while B
   * approves one about A — would each hold the profile the other's trigger waits for: a deadlock,
   * one of them a 500. A 감경, a lift or a cancellation locks no member's profile (it only opens what
   * the restriction closed), so its approval takes the decider's alone, still before the
   * restriction's row: every approval takes its profiles first, in that one order.
   */
  private async lockProfiles(tx: Tx, deciderId: string, memberId: string | null): Promise<void> {
    const locks: { userId: string; member: boolean }[] = [{ userId: deciderId, member: false }];
    if (memberId !== null) locks.push({ userId: memberId, member: true });
    locks.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    for (const { userId, member } of locks) {
      if (member) {
        await this.moderation.lockOpenProfile(tx, userId);
      } else {
        await tx
          .select({ userId: schema.profiles.userId })
          .from(schema.profiles)
          .where(eq(schema.profiles.userId, userId))
          .for('share');
      }
    }
  }

  /**
   * What an `apply`'s approval waits on after the profiles (`lockProfiles` — the member's FOR
   * UPDATE among them), before its decision (see `approve`): its subject (re-checked: the
   * member's) — after the member's profile, the order an edit of it takes them in.
   */
  private async lockApply(
    tx: Tx,
    request: ApprovalRequest,
    memberId: string,
  ): Promise<LockedApply> {
    const payload = this.payloadOf(applyPayloadSchema, request);
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
   * operator's, its reason, the approval) — migration 0042's triggers hold that the change and the
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
