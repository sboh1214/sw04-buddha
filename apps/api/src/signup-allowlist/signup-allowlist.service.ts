import { Inject, Injectable } from '@nestjs/common';
import { lockAdminRoles, lockSignupAllowlist, schema, type Db } from '@buddha/db';
import {
  SIGNUP_ALLOWLIST_CLEAR_APPROVAL_KIND,
  signupAllowlistClearPayloadSchema,
  type SignupAllowlist,
  type SignupAllowlistAddBody,
  type SignupAllowlistAddResult,
  type SignupAllowlistClearRequest,
  type SignupAllowlistClearWrite,
  type SignupAllowlistNotAllowedDetails,
  type SignupAllowlistRemoveBody,
} from '@buddha/shared';
import { and, count, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  ApprovalService,
  approvalNotAllowed,
  type ApprovalRequest,
} from '../approvals/approval.service.js';
import { AppError } from '../common/errors/app-error.js';
import { PhoneHasher } from '../identity/phone-hash.js';
import { DB } from '../infra/db/db.provider.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Db | Tx;

const { signupAllowlist: entries, approvalRequests: requests } = schema;
const requester = alias(schema.profiles, 'allowlist_requester');
const decider = alias(schema.profiles, 'allowlist_decider');

/** admin_actions.target_type of every record of the list's writes. */
const TARGET = 'signup_allowlist';

const ownKind = () =>
  and(
    eq(requests.kind, SIGNUP_ALLOWLIST_CLEAR_APPROVAL_KIND),
    eq(requests.targetType, TARGET),
    eq(requests.targetId, TARGET),
  );

export function signupAllowlistNotAllowed(details: SignupAllowlistNotAllowedDetails): AppError {
  const messages = {
    last_entry: 'The last entry is removed only by an approved clear',
    empty: 'The list has no entry to clear',
    clear_pending: 'A clear of the list waits for its decision already',
  } as const satisfies Record<SignupAllowlistNotAllowedDetails['reason'], string>;
  return new AppError('SIGNUP_ALLOWLIST_NOT_ALLOWED', {
    message: messages[details.reason],
    details,
  });
}

/**
 * 가입 허용 목록 (#330, ADR-0174; owner answers 330-1…330-12), the admins' side. The confirmation
 * that reads the list is PhoneVerificationService's (`signupAllowlistRefuses`).
 *
 * - An add and a removal are one admin's, each with a reason, recorded in the same transaction
 *   (330-1: `signup_allowlist_add`, `signup_allowlist_remove`). Numbers arrive as digits
 *   (`phoneSchema`) and are stored as their keyed hash alone (330-8, ADR-0071); the records name
 *   entry ids and counts, never a number.
 * - Emptying the list — public launch, which opens the signup to everyone — is a
 *   `signup_allowlist_clear` request with a reason and the typed confirmation, then another admin's
 *   approval, which deletes every entry in the same transaction (330-2, 330-4), or their 반려, or
 *   its requester's retraction. One waits at a time, refused when no other admin could decide it
 *   (`no_decider`). A requester who lost the role leaves the request to be decided or rejected by
 *   the others: the two persons were both admins when they acted.
 * - The last entry is never removed one by one (I2: `last_entry`), and every write takes the
 *   list's lock first (`lockSignupAllowlist`, after the admin-roles lock), so two removals of the
 *   last two entries cannot empty it between them: only the approved clear empties it.
 * - Every write re-reads the actor's role under the admin-roles lock (a revoke in flight is waited
 *   for; FORBIDDEN after it), as the treasury's do.
 *
 * The summary #149 checks (330-9) is computed here when asked: the open accounts whose verified
 * number's keyed hash is not on the list, members and admins apart. The number never leaves this
 * service; only the counts do.
 */
@Injectable()
export class SignupAllowlistService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly approvals: ApprovalService,
    private readonly hasher: PhoneHasher,
  ) {}

  /** The entries, the summary and the clear that waits, from one snapshot. */
  get(): Promise<SignupAllowlist> {
    return this.db.transaction((tx) => this.read(tx), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }

  add(adminId: string, body: SignupAllowlistAddBody): Promise<SignupAllowlistAddResult> {
    return this.db.transaction(async (tx) => {
      await this.currentAdmin(tx, adminId);
      await lockSignupAllowlist(tx);
      const hashes = [...new Set(body.phones.map((phone) => this.hasher.hash(phone)))];
      const added = await tx
        .insert(entries)
        .values(hashes.map((phoneHash) => ({ phoneHash })))
        .onConflictDoNothing({ target: entries.phoneHash })
        .returning({ id: entries.id });
      const addedCount = added.length;
      const skippedCount = body.phones.length - addedCount;
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'signup_allowlist_add',
        targetType: TARGET,
        targetId: null,
        payload: {
          entryIds: added.map((row) => row.id),
          addedCount,
          skippedCount,
          reason: body.reason,
        },
      });
      return { addedCount, skippedCount, allowlist: await this.read(tx) };
    });
  }

  remove(adminId: string, body: SignupAllowlistRemoveBody): Promise<SignupAllowlist> {
    return this.db.transaction(async (tx) => {
      await this.currentAdmin(tx, adminId);
      await lockSignupAllowlist(tx);
      const [entry] = await tx
        .select({ id: entries.id })
        .from(entries)
        .where(eq(entries.phoneHash, this.hasher.hash(body.phone)));
      if (!entry) throw new AppError('NOT_FOUND', { message: 'The number is not on the list' });
      if ((await this.entryCount(tx)) <= 1) {
        throw signupAllowlistNotAllowed({ reason: 'last_entry' });
      }
      await tx.delete(entries).where(eq(entries.id, entry.id));
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'signup_allowlist_remove',
        targetType: TARGET,
        targetId: entry.id,
        payload: { reason: body.reason },
      });
      return this.read(tx);
    });
  }

  requestClear(adminId: string, reason: string): Promise<SignupAllowlistClearWrite> {
    return this.db.transaction(async (tx) => {
      await this.currentAdmin(tx, adminId);
      await lockSignupAllowlist(tx);
      const entryCount = await this.entryCount(tx);
      if (entryCount === 0) throw signupAllowlistNotAllowed({ reason: 'empty' });
      if ((await this.pendingClear(tx)) !== null) {
        throw signupAllowlistNotAllowed({ reason: 'clear_pending' });
      }
      if (!(await this.approvals.hasDecider([adminId], tx))) throw approvalNotAllowed('no_decider');
      const request = await this.approvals.request(
        {
          kind: SIGNUP_ALLOWLIST_CLEAR_APPROVAL_KIND,
          targetType: TARGET,
          targetId: TARGET,
          requestedBy: adminId,
          reason,
          payload: { entryCount },
        },
        tx,
      );
      await this.audit(tx, adminId, 'signup_allowlist_clear_request', request.requestedAt, {
        approvalId: request.id,
        entryCount,
        reason: request.requestReason,
      });
      return this.clearWrite(tx, request.id);
    });
  }

  /** Another admin's approval: every entry goes in the same transaction (330-2, 330-4). */
  approveClear(adminId: string, id: string, reason: string): Promise<SignupAllowlistClearWrite> {
    return this.db.transaction(async (tx) => {
      await this.currentAdmin(tx, adminId);
      await lockSignupAllowlist(tx);
      await this.ownRequest(tx, id);
      const approved = await this.approvals.approve(adminId, id, reason, tx);
      const deleted = await tx.delete(entries).returning({ id: entries.id });
      await this.audit(tx, adminId, 'signup_allowlist_clear_approve', approved.decidedAt!, {
        approvalId: id,
        entryCount: deleted.length,
        reason: approved.decisionReason,
      });
      return this.clearWrite(tx, id);
    });
  }

  rejectClear(adminId: string, id: string, reason: string): Promise<SignupAllowlistClearWrite> {
    return this.db.transaction(async (tx) => {
      await this.currentAdmin(tx, adminId);
      await lockSignupAllowlist(tx);
      await this.ownRequest(tx, id);
      const rejected = await this.approvals.reject(adminId, id, reason, tx);
      await this.audit(tx, adminId, 'signup_allowlist_clear_reject', rejected.decidedAt!, {
        approvalId: id,
        reason: rejected.decisionReason,
      });
      return this.clearWrite(tx, id);
    });
  }

  retractClear(adminId: string, id: string): Promise<SignupAllowlistClearWrite> {
    return this.db.transaction(async (tx) => {
      await this.currentAdmin(tx, adminId);
      await lockSignupAllowlist(tx);
      await this.ownRequest(tx, id);
      const retracted = await this.approvals.retract(adminId, id, tx);
      await this.audit(tx, adminId, 'signup_allowlist_clear_retract', retracted.retractedAt!, {
        approvalId: id,
      });
      return this.clearWrite(tx, id);
    });
  }

  private async read(reader: Reader): Promise<SignupAllowlist> {
    const rows = await reader
      .select({ id: entries.id, phoneHash: entries.phoneHash, createdAt: entries.createdAt })
      .from(entries)
      .orderBy(desc(entries.createdAt), desc(entries.id));
    const listed = new Set(rows.map((row) => row.phoneHash));
    // Open accounts only: a withdrawal deletes the 본인확인 record (#140).
    const verified = await reader
      .select({ phone: schema.phoneVerifications.phone, role: schema.profiles.role })
      .from(schema.phoneVerifications)
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.phoneVerifications.userId));
    let outsideVerifiedMembers = 0;
    let outsideVerifiedAdmins = 0;
    for (const { phone, role } of verified) {
      if (listed.has(this.hasher.hash(phone))) continue;
      if (role === 'admin') outsideVerifiedAdmins += 1;
      else outsideVerifiedMembers += 1;
    }
    return {
      entries: rows.map((row) => ({ id: row.id, createdAt: row.createdAt.toISOString() })),
      summary: { entryCount: rows.length, outsideVerifiedMembers, outsideVerifiedAdmins },
      pendingClear: await this.pendingClear(reader),
    };
  }

  private async entryCount(tx: Tx): Promise<number> {
    const [row] = await tx.select({ n: count() }).from(entries);
    return row?.n ?? 0;
  }

  private async pendingClear(reader: Reader): Promise<SignupAllowlistClearRequest | null> {
    const [request] = await this.readRequests(reader, eq(requests.status, 'pending'));
    return request ?? null;
  }

  private async readRequests(
    reader: Reader,
    where: ReturnType<typeof eq>,
  ): Promise<SignupAllowlistClearRequest[]> {
    const rows = await reader
      .select({
        request: requests,
        requesterNickname: requester.nickname,
        deciderNickname: decider.nickname,
      })
      .from(requests)
      .leftJoin(requester, eq(requester.userId, requests.requestedBy))
      .leftJoin(decider, eq(decider.userId, requests.decidedBy))
      .where(and(ownKind(), where))
      .orderBy(desc(requests.requestedAt), desc(requests.id));
    return rows.map(({ request, requesterNickname, deciderNickname }) => ({
      id: request.id,
      requestedBy: { id: request.requestedBy, nickname: requesterNickname },
      reason: request.requestReason,
      requestedAt: request.requestedAt.toISOString(),
      status: request.status,
      decidedBy:
        request.decidedBy === null ? null : { id: request.decidedBy, nickname: deciderNickname },
      decisionReason: request.decisionReason,
      decidedAt: request.decidedAt?.toISOString() ?? null,
      retractedAt: request.retractedAt?.toISOString() ?? null,
    }));
  }

  private async clearWrite(tx: Tx, id: string): Promise<SignupAllowlistClearWrite> {
    const [request] = await this.readRequests(tx, eq(requests.id, id));
    if (!request) throw new AppError('NOT_FOUND', { message: 'Clear request not found' });
    return { request, allowlist: await this.read(tx) };
  }

  /** A `signup_allowlist_clear` request, or NOT_FOUND (another kind's id included). */
  private async ownRequest(tx: Tx, id: string): Promise<ApprovalRequest> {
    const [request] = await tx
      .select()
      .from(requests)
      .where(and(ownKind(), eq(requests.id, id)));
    if (!request) throw new AppError('NOT_FOUND', { message: 'Clear request not found' });
    if (!signupAllowlistClearPayloadSchema.safeParse(request.payload).success) {
      throw new AppError('INTERNAL', { message: `Malformed clear request ${request.id}` });
    }
    return request;
  }

  private async currentAdmin(tx: Tx, id: string): Promise<void> {
    await lockAdminRoles(tx, 'shared');
    const [profile] = await tx
      .select({ role: schema.profiles.role, closedAt: schema.profiles.closedAt })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, id));
    if (profile?.role !== 'admin' || profile.closedAt !== null) {
      throw new AppError('FORBIDDEN', { message: 'Admin only' });
    }
  }

  private async audit(
    tx: Tx,
    adminId: string,
    type:
      | 'signup_allowlist_clear_request'
      | 'signup_allowlist_clear_approve'
      | 'signup_allowlist_clear_reject'
      | 'signup_allowlist_clear_retract',
    at: Date,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(schema.adminActions).values({
      adminId,
      type,
      targetType: TARGET,
      targetId: TARGET,
      payload,
      createdAt: at,
    });
  }
}
