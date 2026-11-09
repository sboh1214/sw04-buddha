import { Inject, Injectable } from '@nestjs/common';
import {
  isHumanAccountTypeSql,
  lockAdminRoles,
  lockMarket,
  lockReconciliationHold,
  recoverReconciliationHold,
  ReconciliationError,
  runAccountReconciliation,
  runMarketReconciliation,
  runSupplyReconciliation,
  schema,
  type Db,
} from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  RECONCILIATION_RECOVERY_APPROVAL_KIND,
  reconciliationRecoveryPayloadSchema,
  type ReconciliationHold,
  type ReconciliationHoldDetail,
  type ReconciliationHoldsQuery,
  type ReconciliationResult,
  type ReconciliationResultsQuery,
  type ReconciliationRun,
  type ReconciliationTarget,
} from '@buddha/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  ApprovalService,
  approvalNotAllowed,
  type ApprovalRequest,
} from '../approvals/approval.service.js';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import {
  fieldError,
  lockedMarketRow,
  type Executor,
  type Tx,
} from '../markets/market-item-rules.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { type Page } from '../wallet/wallet.service.js';

const {
  reconciliationResults: results,
  reconciliationHolds: holds,
  approvalRequests: requests,
} = schema;
type ResultRow = typeof results.$inferSelect;
type HoldRow = typeof holds.$inferSelect;
const requester = alias(schema.profiles, 'recovery_requester');
const decider = alias(schema.profiles, 'recovery_decider');

export function reconciliationResultOf(row: ResultRow): ReconciliationResult {
  return {
    id: String(row.id),
    scope: row.scope,
    targetKey: row.targetKey,
    marketId: row.marketId,
    accountId: row.accountId === null ? null : String(row.accountId),
    userId: row.userId,
    source: row.source,
    passed: row.passed,
    checkedAt: row.checkedAt.toISOString(),
    ledgerCursor: String(row.ledgerCursor),
    findings: row.findings,
    facts: row.facts,
  };
}

function holdOf(row: HoldRow): ReconciliationHold {
  return {
    id: row.id,
    scope: row.scope,
    targetKey: row.targetKey,
    marketId: row.marketId,
    userId: row.userId,
    failureResultId: row.failureResultId === null ? null : String(row.failureResultId),
    legacyPauseId: row.legacyPauseId,
    startedAt: row.startedAt.toISOString(),
    recoveredAt: row.recoveredAt?.toISOString() ?? null,
  };
}

function requestTarget(holdId: string) {
  return and(
    eq(requests.kind, RECONCILIATION_RECOVERY_APPROVAL_KIND),
    eq(requests.targetType, 'reconciliation_hold'),
    eq(requests.targetId, holdId),
  );
}

function refusal(code: string): AppError {
  return fieldError('reconciliation', 'Reconciliation recovery is not available', code);
}

/** Fresh evidence and another administrator's decision are committed with the recovery. */
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly approvals: ApprovalService,
    private readonly publisher: MarketPublisher,
  ) {}

  async listResults(query: ReconciliationResultsQuery): Promise<Page<ReconciliationResult>> {
    const cursor = decodeKeyset(query.cursor, 'int');
    const rows = await this.db
      .select()
      .from(results)
      .where(
        and(
          query.targetKey === undefined ? undefined : eq(results.targetKey, query.targetKey),
          cursor ? keysetPredicate(results.checkedAt, results.id, cursor, 'bigint') : undefined,
        ),
      )
      .orderBy(desc(results.checkedAt), desc(results.id))
      .limit(query.limit + 1);
    const kept = rows.slice(0, query.limit);
    const last = kept.at(-1);
    return {
      items: kept.map(reconciliationResultOf),
      nextCursor:
        rows.length > query.limit && last
          ? encodeKeyset({ createdAt: last.checkedAt, id: String(last.id) })
          : null,
    };
  }

  async listHolds(query: ReconciliationHoldsQuery): Promise<Page<ReconciliationHoldDetail>> {
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.db
      .select()
      .from(holds)
      .where(
        and(
          query.state === 'active' ? isNull(holds.recoveredAt) : undefined,
          query.marketId === undefined ? undefined : eq(holds.marketId, query.marketId),
          query.userId === undefined ? undefined : eq(holds.userId, query.userId),
          cursor ? keysetPredicate(holds.startedAt, holds.id, cursor, 'uuid') : undefined,
        ),
      )
      .orderBy(desc(holds.startedAt), desc(holds.id))
      .limit(query.limit + 1);
    const kept = rows.slice(0, query.limit);
    const last = kept.at(-1);
    return {
      items: await Promise.all(kept.map((row) => this.detail(this.db, row))),
      nextCursor:
        rows.length > query.limit && last
          ? encodeKeyset({ createdAt: last.startedAt, id: last.id })
          : null,
    };
  }

  async getHold(holdId: string): Promise<ReconciliationHoldDetail> {
    const [hold] = await this.db.select().from(holds).where(eq(holds.id, holdId)).limit(1);
    if (!hold) throw new AppError('NOT_FOUND', { message: 'Reconciliation hold not found' });
    return this.detail(this.db, hold);
  }

  async run(adminId: string, target: ReconciliationTarget): Promise<ReconciliationRun> {
    const done = await this.mapped(() =>
      this.db.transaction(async (tx) => {
        const marketId = await this.targetMarketId(tx, target);
        if (marketId !== null) await this.lockMarketIdentity(tx, marketId);
        await this.assertAdmin(tx, adminId);
        const options = { source: 'manual' as const, actorId: adminId };
        const checked =
          target.scope === 'market'
            ? await runMarketReconciliation(tx, target.marketId, options)
            : target.scope === 'account'
              ? await runAccountReconciliation(
                  tx,
                  'userId' in target
                    ? { userId: target.userId }
                    : { accountId: Number(target.accountId) },
                  options,
                )
              : await runSupplyReconciliation(tx, options);
        await tx.insert(schema.adminActions).values({
          adminId,
          type: 'reconciliation_run',
          targetType: checked.result.scope,
          targetId: checked.result.targetKey,
          payload: { resultId: String(checked.result.id), passed: checked.result.passed },
          createdAt: checked.result.checkedAt,
        });
        return checked;
      }),
    );
    if (done.statusEvent !== null)
      await this.publisher.publishMarket(done.statusEvent.marketId, done.statusEvent);
    return {
      result: reconciliationResultOf(done.result),
      hold: done.hold === null ? null : holdOf(done.hold),
    };
  }

  async request(
    adminId: string,
    holdId: string,
    failureResultId: string | null,
    reason: string,
  ): Promise<ReconciliationHoldDetail> {
    return this.mapped(() =>
      this.db.transaction(async (tx) => {
        const hold = await this.lockHold(tx, holdId, adminId);
        await this.assertRecoverable(tx, hold, failureResultId);
        const [pending] = await tx
          .select({ id: requests.id })
          .from(requests)
          .where(and(requestTarget(holdId), eq(requests.status, 'pending')))
          .limit(1);
        if (pending) throw refusal('pending');
        if (!(await this.approvals.hasDecider([adminId], tx)))
          throw approvalNotAllowed('no_decider');
        const request = await this.approvals.request(
          {
            kind: RECONCILIATION_RECOVERY_APPROVAL_KIND,
            targetType: 'reconciliation_hold',
            targetId: holdId,
            requestedBy: adminId,
            reason,
            payload: { holdId, failureResultId },
          },
          tx,
        );
        await this.audit(
          tx,
          adminId,
          'reconciliation_recovery_request',
          request,
          holdId,
          request.requestedAt,
        );
        return this.detail(tx, hold);
      }),
    );
  }

  async approve(
    adminId: string,
    holdId: string,
    requestId: string,
    reason: string,
  ): Promise<ReconciliationHoldDetail> {
    const done = await this.mapped(() =>
      this.db.transaction(async (tx) => {
        await this.lockHold(tx, holdId, adminId);
        const request = await this.ownRequest(tx, holdId, requestId);
        const payload = this.payload(request);
        const approved = await this.approvals.approve(adminId, requestId, reason, tx);
        const recovered = await recoverReconciliationHold(tx, {
          holdId,
          failureResultId:
            payload.failureResultId === null ? null : Number(payload.failureResultId),
          approvalId: request.id,
          requestedBy: request.requestedBy,
          approverId: adminId,
        });
        if (recovered.hold === null)
          throw new AppError('INTERNAL', { message: 'Recovery did not return its hold' });
        await this.audit(
          tx,
          adminId,
          'reconciliation_recovery_approve',
          approved,
          holdId,
          approved.decidedAt ?? (await clockTimestamp(tx)),
        );
        return {
          detail: await this.detail(tx, recovered.hold),
          recovered,
          marketId: recovered.hold.marketId,
        };
      }),
    );
    const { recovered } = done;
    if (recovered.expired.expired.length > 0 && done.marketId !== null) {
      await this.publisher.publishBook([done.marketId], recovered.result.checkedAt);
    }
    return done.detail;
  }

  async reject(
    adminId: string,
    holdId: string,
    requestId: string,
    reason: string,
  ): Promise<ReconciliationHoldDetail> {
    return this.endRequest(adminId, holdId, requestId, reason);
  }

  async retract(
    adminId: string,
    holdId: string,
    requestId: string,
  ): Promise<ReconciliationHoldDetail> {
    return this.endRequest(adminId, holdId, requestId);
  }

  private async endRequest(
    adminId: string,
    holdId: string,
    requestId: string,
    reason?: string,
  ): Promise<ReconciliationHoldDetail> {
    return this.mapped(() =>
      this.db.transaction(async (tx) => {
        // Dismissing a stale request neither releases a hold nor changes assets. Damaged books
        // must not prevent cleanup; keep identity, current-role, hold and approval-row locks.
        await this.lockHoldIdentity(tx, holdId, adminId);
        const [hold] = await tx.select().from(holds).where(eq(holds.id, holdId)).for('update');
        if (!hold) throw new AppError('NOT_FOUND', { message: 'Reconciliation hold not found' });
        await this.ownRequest(tx, holdId, requestId);
        const request =
          reason === undefined
            ? await this.approvals.retract(adminId, requestId, tx)
            : await this.approvals.reject(adminId, requestId, reason, tx);
        await this.audit(
          tx,
          adminId,
          reason === undefined
            ? 'reconciliation_recovery_retract'
            : 'reconciliation_recovery_reject',
          request,
          holdId,
          request.retractedAt ?? request.decidedAt ?? (await clockTimestamp(tx)),
        );
        return this.detail(tx, hold);
      }),
    );
  }

  /** Market identity → admin roles → account audit keys/assets → hold, never assets → roles. */
  private async lockHold(tx: Tx, holdId: string, adminId: string): Promise<HoldRow> {
    await this.lockHoldIdentity(tx, holdId, adminId);
    const hold = await lockReconciliationHold(tx, holdId);
    if (!hold) throw new AppError('NOT_FOUND', { message: 'Reconciliation hold not found' });
    return hold;
  }

  private async lockHoldIdentity(tx: Tx, holdId: string, adminId: string): Promise<void> {
    const [known] = await tx
      .select({ marketId: holds.marketId })
      .from(holds)
      .where(eq(holds.id, holdId))
      .limit(1);
    if (!known) throw new AppError('NOT_FOUND', { message: 'Reconciliation hold not found' });
    if (known.marketId !== null) await this.lockMarketIdentity(tx, known.marketId);
    await this.assertAdmin(tx, adminId);
  }

  private async lockMarketIdentity(tx: Tx, marketId: string): Promise<void> {
    await lockMarket(tx, marketId);
    await lockedMarketRow(tx, marketId);
  }

  private async assertAdmin(tx: Tx, adminId: string): Promise<void> {
    await lockAdminRoles(tx, 'shared');
    const [profile] = await tx
      .select({ role: schema.profiles.role })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, adminId))
      .limit(1);
    if (profile?.role !== 'admin') throw new AppError('FORBIDDEN', { message: 'Admin only' });
  }

  /** Read immutable identity only; market-scoped ledger accounts need the market lock first. */
  private async targetMarketId(tx: Tx, target: ReconciliationTarget): Promise<string | null> {
    if (target.scope === 'supply') return null;
    const rows =
      target.scope === 'market'
        ? await tx
            .select({ id: schema.markets.id })
            .from(schema.markets)
            .where(eq(schema.markets.id, target.marketId))
            .limit(1)
        : 'userId' in target
          ? await tx
              .select({ id: schema.user.id })
              .from(schema.user)
              .where(
                and(
                  eq(schema.user.id, target.userId),
                  isHumanAccountTypeSql(schema.user.accountType),
                ),
              )
              .limit(1)
          : await tx
              .select({ id: schema.ledgerAccounts.id, marketId: schema.ledgerAccounts.marketId })
              .from(schema.ledgerAccounts)
              .where(eq(schema.ledgerAccounts.id, Number(target.accountId)))
              .limit(1);
    if (rows.length === 0)
      throw new AppError('NOT_FOUND', { message: 'Reconciliation target not found' });
    if (target.scope === 'market') return target.marketId;
    const account = rows[0];
    return account && 'marketId' in account ? account.marketId : null;
  }

  private async assertRecoverable(
    tx: Tx,
    hold: HoldRow,
    failureResultId: string | null,
  ): Promise<void> {
    if (hold.recoveredAt !== null || holdOf(hold).failureResultId !== failureResultId)
      throw refusal('stale');
    if (hold.marketId !== null) {
      const [market] = await tx
        .select({ status: schema.markets.status })
        .from(schema.markets)
        .where(eq(schema.markets.id, hold.marketId));
      if (market?.status === 'paused') throw refusal('paused');
    }
    const [latest] = await tx
      .select()
      .from(results)
      .where(eq(results.targetKey, hold.targetKey))
      .orderBy(desc(results.id))
      .limit(1);
    if (!latest?.passed) throw refusal('not_passed');
  }

  private async ownRequest(tx: Tx, holdId: string, requestId: string): Promise<ApprovalRequest> {
    const [row] = await tx
      .select()
      .from(requests)
      .where(and(requestTarget(holdId), eq(requests.id, requestId)))
      .limit(1);
    if (!row || this.payload(row).holdId !== holdId)
      throw new AppError('NOT_FOUND', { message: 'Recovery request not found' });
    return row;
  }

  private payload(request: Pick<ApprovalRequest, 'id' | 'payload'>) {
    const parsed = reconciliationRecoveryPayloadSchema.safeParse(request.payload);
    if (!parsed.success)
      throw new AppError('INTERNAL', { message: `Malformed recovery request ${request.id}` });
    return parsed.data;
  }

  private async detail(executor: Executor, hold: HoldRow): Promise<ReconciliationHoldDetail> {
    const [latest] = await executor
      .select()
      .from(results)
      .where(eq(results.targetKey, hold.targetKey))
      .orderBy(desc(results.id))
      .limit(1);
    const rows = await executor
      .select({
        request: requests,
        requesterNickname: requester.nickname,
        deciderNickname: decider.nickname,
      })
      .from(requests)
      .leftJoin(requester, eq(requester.userId, requests.requestedBy))
      .leftJoin(decider, eq(decider.userId, requests.decidedBy))
      .where(requestTarget(hold.id))
      .orderBy(desc(requests.requestedAt), desc(requests.id));
    const [market] =
      hold.marketId === null
        ? []
        : await executor
            .select({
              id: schema.markets.id,
              title: schema.markets.title,
              status: schema.markets.status,
            })
            .from(schema.markets)
            .where(eq(schema.markets.id, hold.marketId));
    const [user] =
      hold.userId === null
        ? []
        : await executor
            .select({ id: schema.profiles.userId, nickname: schema.profiles.nickname })
            .from(schema.profiles)
            .where(eq(schema.profiles.userId, hold.userId));
    return {
      hold: holdOf(hold),
      latestResult: latest ? reconciliationResultOf(latest) : null,
      market: market ?? null,
      user: user ?? (hold.userId === null ? null : { id: hold.userId, nickname: null }),
      requests: rows.map(({ request, requesterNickname, deciderNickname }) => ({
        id: request.id,
        ...this.payload(request),
        requestedBy: { id: request.requestedBy, nickname: requesterNickname },
        reason: request.requestReason,
        requestedAt: request.requestedAt.toISOString(),
        status: request.status,
        decidedBy:
          request.decidedBy === null ? null : { id: request.decidedBy, nickname: deciderNickname },
        decisionReason: request.decisionReason,
        decidedAt: request.decidedAt?.toISOString() ?? null,
        retractedAt: request.retractedAt?.toISOString() ?? null,
      })),
    };
  }

  private async audit(
    tx: Tx,
    adminId: string,
    type:
      | 'reconciliation_recovery_request'
      | 'reconciliation_recovery_approve'
      | 'reconciliation_recovery_reject'
      | 'reconciliation_recovery_retract',
    request: ApprovalRequest,
    holdId: string,
    at: Date,
  ): Promise<void> {
    await tx.insert(schema.adminActions).values({
      adminId,
      type,
      targetType: 'reconciliation_hold',
      targetId: holdId,
      payload: {
        approvalId: request.id,
        ...this.payload(request),
        reason: request.decisionReason ?? request.requestReason,
      },
      createdAt: at,
    });
  }

  private async mapped<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ReconciliationError)) throw error;
      if (error.code === 'not_found')
        throw new AppError('NOT_FOUND', { message: 'Reconciliation target not found' });
      throw refusal(error.code);
    }
  }
}
