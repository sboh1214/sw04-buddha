import type { FillClassificationAction } from '@buddha/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import {
  applyFillClassification,
  lockFillClassificationDecision,
  readFillClassification,
} from '../fill-classification.js';
import { adminActions, approvalRequests, markets, reports } from '../schema/index.js';
import { clockTimestamp, lockAdminRoles, lockMarket } from '../tx-helpers.js';
import { createApprovalRequest, createModerationAction, createUser } from './factories.js';

/*
 * Fixtures of the records the observation metrics read (#96, ADR-0169), each written as the real
 * path writes it but at a chosen instant: role changes (`writeRole`), fill classifications (the
 * two-admin flow — migration 0075 refuses a raw insert), a payout (`markets.settled_at`), and the
 * closings of reports (`dismiss()`, `resolveReports`).
 */

type RoleChange = 'admin_grant' | 'admin_revoke';

async function writeRoleChangeAt(
  db: Db,
  type: RoleChange,
  userId: string,
  at: Date,
  actorId: string,
): Promise<string> {
  // `adminRoleChangeTimestamp`'s invariant: every role change is strictly later than the last one
  // of any account, so a test never ties two records of an account on random ids.
  const [last] = (
    await db.execute<{ at: string | null }>(sql`
      SELECT (extract(epoch FROM max(created_at)) * 1000)::bigint::text AS at
        FROM admin_actions WHERE type IN ('admin_grant', 'admin_revoke')`)
  ).rows;
  if (last?.at != null && at.getTime() <= Number(last.at)) {
    throw new Error(
      `${type} at ${at.toISOString()} is not later than the last role change ` +
        new Date(Number(last.at)).toISOString(),
    );
  }
  const [record] = await db
    .insert(adminActions)
    .values({
      adminId: actorId,
      type,
      targetType: 'user',
      targetId: userId,
      payload: { reason: type === 'admin_grant' ? '관리자 지정' : '관리자 해제' },
      createdAt: at,
    })
    .returning({ id: adminActions.id });
  return record!.id;
}

/**
 * An `admin_grant` record of `userId` at `at` by `actorId` (default the account itself), as
 * `writeRole` writes it. `profiles.role` is left as it is: the metrics read the records only.
 * Throws unless `at` is later than every role change already recorded.
 */
export function grantAdminAt(
  db: Db,
  userId: string,
  at: Date,
  actorId: string = userId,
): Promise<string> {
  return writeRoleChangeAt(db, 'admin_grant', userId, at, actorId);
}

/** An `admin_revoke` record, likewise (`profiles.role` untouched). */
export function revokeAdminAt(
  db: Db,
  userId: string,
  at: Date,
  actorId: string = userId,
): Promise<string> {
  return writeRoleChangeAt(db, 'admin_revoke', userId, at, actorId);
}

/**
 * An admin with its grant record: `createUser({ role: 'admin' })` and an `admin_grant` at `at`,
 * so no admin of a test is an account without a record (ADR-0169: the records alone say who was
 * admin). Its id.
 */
export async function createAdminAt(db: Db, input: { at: Date }): Promise<string> {
  const id = (await createUser(db, { role: 'admin' })).user.id;
  await grantAdminAt(db, id, input.at);
  return id;
}

export interface FillClassificationRequestInput {
  fillId: number;
  marketId: string;
  action: FillClassificationAction;
  /** The admin who asks. */
  askerId: string;
}

/** A pending `fill_classification` request (#132) against the fill's current revision. */
export async function requestFillClassification(db: Db, input: FillClassificationRequestInput) {
  const current = await readFillClassification(db, input.fillId);
  return createApprovalRequest(db, {
    kind: 'fill_classification',
    targetType: 'fill',
    targetId: String(input.fillId),
    requestedBy: input.askerId,
    reason: '확인된 인위적 거래량에 대한 운영 근거',
    payload: {
      fillId: String(input.fillId),
      marketId: input.marketId,
      action: input.action,
      baseRevision: String(current?.revision ?? 0n),
    },
  });
}

/**
 * Another admin's approval of a classification request and its execution, in one transaction
 * with the locks the approval takes (market, roles, the classification clock).
 */
export async function approveFillClassification(
  db: Db,
  input: { approvalId: string; marketId: string; deciderId: string },
) {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, input.approvalId));
    await lockMarket(tx, input.marketId);
    await lockAdminRoles(tx, 'shared');
    await lockFillClassificationDecision(
      tx,
      request!.payload as {
        fillId: string;
        marketId: string;
        action: FillClassificationAction;
        baseRevision: string;
      },
    );
    await tx
      .update(approvalRequests)
      .set({
        status: 'approved',
        decidedBy: input.deciderId,
        decisionReason: '독립 검토 완료',
        decidedAt: await clockTimestamp(tx),
      })
      .where(eq(approvalRequests.id, input.approvalId));
    return applyFillClassification(tx, input.approvalId);
  });
}

export interface ClassifyFillInput extends FillClassificationRequestInput {
  /** The other admin who approves. */
  deciderId: string;
}

/** A fill marked or cleared through the two-admin flow (#132, ADR-0131): request, then approve. */
export async function classifyFill(db: Db, input: ClassifyFillInput) {
  const request = await requestFillClassification(db, input);
  return approveFillClassification(db, {
    approvalId: request.id,
    marketId: input.marketId,
    deciderId: input.deciderId,
  });
}

/**
 * A market paid out at `at`: SETTLED with `settled_at` (the SETTLED transition's two columns,
 * the 정산 후 재참여 start), written straight to the row. Its settlement records are the
 * caller's (`createSettlementRecord` on the SETTLING market, or `settleMarketPositions`).
 */
export async function settleMarketAt(db: Db, marketId: string, at: Date): Promise<void> {
  await db
    .update(markets)
    .set({ status: 'settled', settledAt: at })
    .where(eq(markets.id, marketId));
}

export interface DismissReportsAtInput {
  adminId: string;
  reportIds: string[];
  at: Date;
  /** Default '기각 사유'. */
  reason?: string;
}

/**
 * A dismissal (기각) as `dismiss()` writes it: the reports `dismissed` at `at` by `adminId` with
 * the reason, and one `report_dismiss` record naming them (`payload {reportIds, reason}`, no
 * target) whose own `created_at` is the column default — never `at`, as the transaction start
 * is not the reports' clock.
 */
export async function dismissReportsAt(db: Db, input: DismissReportsAtInput): Promise<string> {
  const reason = input.reason ?? '기각 사유';
  return db.transaction(async (tx) => {
    await tx
      .update(reports)
      .set({
        status: 'dismissed',
        resolvedAt: input.at,
        resolvedBy: input.adminId,
        dismissalReason: reason,
      })
      .where(inArray(reports.id, input.reportIds));
    const [record] = await tx
      .insert(adminActions)
      .values({
        adminId: input.adminId,
        type: 'report_dismiss',
        targetType: null,
        targetId: null,
        payload: { reportIds: input.reportIds, reason },
      })
      .returning({ id: adminActions.id });
    return record!.id;
  });
}

export interface ActionReportsAtInput {
  /** The acting admin (an account restriction's requester). */
  adminId: string;
  /** The member acted on: the reported item's author or the profile's member. */
  userId: string;
  /** The target: a post, a comment, or neither — the member's profile. */
  postId?: string;
  commentId?: string;
  at: Date;
  /**
   * An account restriction approved by this other admin (#139): its `moderation_actions` row
   * with the approval, the reports resolved by the requester.
   */
  approvedBy?: string;
}

/**
 * An action on one target as the moderation routes leave the reports (`resolveReports`): the
 * `moderation_actions` row (a hiding of the post or comment, a warning of a profile, or an
 * account restriction with `approvedBy`) at `at`, and every pending report on the target
 * `actioned` with its id at `at`, resolved by `adminId`. The action and the resolved reports' ids.
 */
export async function actionReportsAt(db: Db, input: ActionReportsAtInput) {
  const restriction = input.approvedBy !== undefined;
  const action = await createModerationAction(db, {
    userId: input.userId,
    createdBy: input.adminId,
    type: restriction
      ? 'account_restriction'
      : input.postId || input.commentId
        ? 'hide'
        : 'warning',
    ...(input.postId === undefined ? {} : { postId: input.postId }),
    ...(input.commentId === undefined ? {} : { commentId: input.commentId }),
    ...(restriction ? { reason: 'spam' as const, approvedBy: input.approvedBy! } : {}),
    createdAt: input.at,
  });
  const targetType = input.postId ? 'post' : input.commentId ? 'comment' : 'profile';
  const targetKey = input.postId ?? input.commentId ?? input.userId;
  const resolved = await db
    .update(reports)
    .set({
      status: 'actioned',
      resolvedAt: input.at,
      resolvedBy: input.adminId,
      actionId: action.id,
    })
    .where(
      and(
        eq(reports.status, 'pending'),
        eq(reports.targetType, targetType),
        eq(reports.targetKey, targetKey),
      ),
    )
    .returning({ id: reports.id });
  return { actionId: action.id, reportIds: resolved.map((row) => row.id) };
}
