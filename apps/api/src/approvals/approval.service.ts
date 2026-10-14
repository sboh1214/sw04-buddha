import { Inject, Injectable } from '@nestjs/common';
import { lockAdminRoles, schema, type Db } from '@buddha/db';
import {
  APPROVAL_KIND_MAX_LENGTH,
  APPROVAL_KIND_PATTERN,
  approvalReasonSchema,
  type ApprovalRefusal,
  type ApprovalStatus,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp, strictlyAfter } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A request as stored: the request, then the decision (null while `pending`). */
export interface ApprovalRequest {
  id: string;
  kind: string;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown> | null;
  requestedBy: string;
  requestReason: string;
  requestedAt: Date;
  status: ApprovalStatus;
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: Date | null;
}

export interface ApprovalRequestInput {
  /** The work that waits (APPROVAL_KIND_PATTERN), named by its consumer. */
  kind: string;
  targetType?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
  /** The requesting account; its route's AdminGuard already made sure it is an admin. */
  requestedBy: string;
  reason: string;
}

/** Why a decision is refused; a consumer's screen picks its copy by `details[0].message`. */
export function approvalNotAllowed(reason: ApprovalRefusal): AppError {
  const messages: Record<ApprovalRefusal, string> = {
    requester: 'The requester cannot decide their own request',
    decided: 'The request was decided already',
  };
  return new AppError('APPROVAL_NOT_ALLOWED', {
    message: messages[reason],
    details: [{ path: ['request'], message: reason }],
  });
}

/** VALIDATION_ERROR naming `reason`, as the validation pipe would. */
function parseReason(reason: string): string {
  const parsed = approvalReasonSchema.safeParse(reason);
  if (parsed.success) return parsed.data;
  throw new AppError('VALIDATION_ERROR', {
    message: 'Request validation failed',
    details: parsed.error.issues.map((issue) => ({ path: ['reason'], message: issue.message })),
  });
}

/**
 * The two-person rule (#171; approvals.ts in @buddha/shared): a request, then exactly one decision
 * by an admin who is not its requester. Refused always and everywhere — no environment, flag or
 * role lets the requester decide (owner decision 2026-10-13), and migration 0021 refuses it again
 * at the database. Every step keeps who, when (the database clock) and why.
 *
 * What the shared rule leaves to each consumer (#78, #152, #144, #130, #139, …): the kinds, what
 * runs on approval, and the rest of a request's life — expiry, withdrawal, a requester who lost
 * the admin role. A consumer passes its own transaction (`executor`) so the approved work and the
 * decision commit together; the methods then run in a savepoint of it.
 */
@Injectable()
export class ApprovalService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Records a pending request. `kind` is a programming contract, so a bad one throws plainly. */
  async request(
    input: ApprovalRequestInput,
    executor: Db | Tx = this.db,
  ): Promise<ApprovalRequest> {
    if (input.kind.length > APPROVAL_KIND_MAX_LENGTH || !APPROVAL_KIND_PATTERN.test(input.kind)) {
      throw new Error(`approval kind '${input.kind}' must match ${String(APPROVAL_KIND_PATTERN)}`);
    }
    const reason = parseReason(input.reason);
    return executor.transaction(async (tx) => {
      const requestedAt = await clockTimestamp(tx);
      const [row] = await tx
        .insert(schema.approvalRequests)
        .values({
          kind: input.kind,
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          payload: input.payload ?? null,
          requestedBy: input.requestedBy,
          requestReason: reason,
          requestedAt,
        })
        .returning();
      if (!row) throw new AppError('INTERNAL', { message: 'Approval request insert failed' });
      return row;
    });
  }

  /** One request, or NOT_FOUND. */
  async get(id: string, executor: Db | Tx = this.db): Promise<ApprovalRequest> {
    const [row] = await executor
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, id))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Approval request not found' });
    return row;
  }

  /** `pending` → `approved` by `deciderId`, with a reason; see `decide`. */
  approve(
    deciderId: string,
    id: string,
    reason: string,
    executor: Db | Tx = this.db,
  ): Promise<ApprovalRequest> {
    return this.decide(deciderId, id, 'approved', reason, executor);
  }

  /** `pending` → `rejected` by `deciderId`, with a reason; see `decide`. */
  reject(
    deciderId: string,
    id: string,
    reason: string,
    executor: Db | Tx = this.db,
  ): Promise<ApprovalRequest> {
    return this.decide(deciderId, id, 'rejected', reason, executor);
  }

  /**
   * The decision, under the shared admin-roles lock so the decider's role cannot be revoked
   * between the check and the commit: FORBIDDEN unless the decider holds the admin role NOW,
   * NOT_FOUND for no such request, APPROVAL_NOT_ALLOWED `requester` when the decider requested it
   * and `decided` when it is not pending any more (the row is locked, so of two decisions at once
   * the second finds the first). The decision is timed strictly after its request.
   */
  private async decide(
    deciderId: string,
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    reason: string,
    executor: Db | Tx,
  ): Promise<ApprovalRequest> {
    const decisionReason = parseReason(reason);
    return executor.transaction(async (tx) => {
      await lockAdminRoles(tx, 'shared');
      const [decider] = await tx
        .select({ role: schema.profiles.role })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, deciderId))
        .limit(1);
      if (decider?.role !== 'admin') throw new AppError('FORBIDDEN', { message: 'Admin only' });

      const [request] = await tx
        .select()
        .from(schema.approvalRequests)
        .where(eq(schema.approvalRequests.id, id))
        .limit(1)
        .for('update');
      if (!request) throw new AppError('NOT_FOUND', { message: 'Approval request not found' });
      if (request.requestedBy === deciderId) throw approvalNotAllowed('requester');
      if (request.status !== 'pending') throw approvalNotAllowed('decided');

      // Strictly after the request, even should the clock have stepped back since it was made.
      const decidedAt = strictlyAfter(await clockTimestamp(tx), request.requestedAt);
      const [row] = await tx
        .update(schema.approvalRequests)
        .set({ status, decidedBy: deciderId, decisionReason, decidedAt })
        .where(eq(schema.approvalRequests.id, id))
        .returning();
      if (!row) throw new AppError('INTERNAL', { message: 'Approval decision update failed' });
      return row;
    });
  }
}
