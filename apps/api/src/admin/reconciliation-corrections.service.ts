import { Inject, Injectable } from '@nestjs/common';
import {
  applyReconciliationCorrection,
  lockAdminRoles,
  lockMarket,
  lockReconciliationCorrection,
  previewReconciliationCorrections,
  ReconciliationCorrectionError,
  runAccountReconciliation,
  runMarketReconciliation,
  schema,
  type Db,
} from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  RECONCILIATION_CORRECTION_APPROVAL_KIND,
  reconciliationCorrectionPayloadSchema,
  serializeCoinAmount,
  type ReconciliationCorrectionDetail,
  type ReconciliationCorrectionPayload,
  type ReconciliationCorrectionRequest,
  type ReconciliationCorrectionRequestsQuery,
  type RequestReconciliationCorrectionBody,
} from '@buddha/shared';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
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
import { reconciliationResultOf } from './reconciliation.service.js';

const { reconciliationResults: results, approvalRequests: requests } = schema;
const requester = alias(schema.profiles, 'correction_requester');
const decider = alias(schema.profiles, 'correction_decider');
type ResultRow = typeof results.$inferSelect;
const correctionKind = () =>
  and(
    eq(requests.kind, RECONCILIATION_CORRECTION_APPROVAL_KIND),
    eq(requests.targetType, 'ledger_account'),
  );
const resultRequests = (resultId: number) =>
  sql`${requests.payload}->>'failureResultId' = ${String(resultId)}`;

function refusal(code: string): AppError {
  return fieldError('reconciliationCorrection', 'Reconciliation correction is not available', code);
}

/** The database owns monetary invariants; this service owns the current admin and decision flow. */
@Injectable()
export class ReconciliationCorrectionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly approvals: ApprovalService,
    private readonly publisher: MarketPublisher,
  ) {}

  getDetail(resultId: number): Promise<ReconciliationCorrectionDetail> {
    return this.mapped(() =>
      this.db.transaction((tx) => this.detail(tx, resultId), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      }),
    );
  }

  async listRequests(
    query: ReconciliationCorrectionRequestsQuery,
  ): Promise<Page<ReconciliationCorrectionRequest>> {
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.readRequests(
      this.db,
      and(
        query.status === 'pending' ? eq(requests.status, 'pending') : undefined,
        cursor ? keysetPredicate(requests.requestedAt, requests.id, cursor, 'uuid') : undefined,
      ),
      query.limit + 1,
    );
    const kept = rows.slice(0, query.limit);
    const last = kept.at(-1);
    return {
      items: kept,
      nextCursor:
        rows.length > query.limit && last
          ? encodeKeyset({ createdAt: new Date(last.requestedAt), id: last.id })
          : null,
    };
  }

  request(
    adminId: string,
    resultId: number,
    body: RequestReconciliationCorrectionBody,
  ): Promise<ReconciliationCorrectionDetail> {
    return this.mapped(() =>
      this.db.transaction(async (tx) => {
        await this.lockTarget(tx, resultId, Number(body.accountId), adminId);
        const candidates = await previewReconciliationCorrections(tx, resultId);
        const candidate = candidates.find(
          (item) =>
            item.accountId === body.accountId &&
            item.mode === body.mode &&
            item.amountCoin === body.amountCoin &&
            item.snapshotKey === body.snapshotKey,
        );
        if (!candidate) throw refusal('stale');
        if (candidate.userId !== null && body.userReason === null)
          throw fieldError('userReason', 'A separate member-facing reason is required', 'required');
        if (candidate.userId === null && body.userReason !== null)
          throw fieldError(
            'userReason',
            'System accounts have no member-facing reason',
            'not_applicable',
          );
        const [pending] = await tx
          .select({ id: requests.id })
          .from(requests)
          .where(
            and(
              correctionKind(),
              eq(requests.targetId, candidate.accountId),
              eq(requests.status, 'pending'),
            ),
          )
          .limit(1);
        if (pending) throw refusal('pending');
        if (!(await this.approvals.hasDecider([adminId], tx)))
          throw approvalNotAllowed('no_decider');
        const payload: ReconciliationCorrectionPayload = {
          failureResultId: String(resultId),
          candidate,
          userReason: body.userReason,
        };
        const request = await this.approvals.request(
          {
            kind: RECONCILIATION_CORRECTION_APPROVAL_KIND,
            targetType: 'ledger_account',
            targetId: candidate.accountId,
            requestedBy: adminId,
            reason: body.reason,
            payload,
          },
          tx,
        );
        await this.audit(
          tx,
          adminId,
          'reconciliation_correction_request',
          request,
          request.requestedAt,
        );
        return this.detail(tx, resultId);
      }),
    );
  }

  async approve(
    adminId: string,
    resultId: number,
    requestId: string,
    reason: string,
  ): Promise<ReconciliationCorrectionDetail> {
    const done = await this.mapped(() =>
      this.db.transaction(async (tx) => {
        const request = await this.ownRequest(tx, resultId, requestId);
        const payload = this.payload(request);
        const result = await this.lockTarget(
          tx,
          resultId,
          Number(payload.candidate.accountId),
          adminId,
        );
        const approved = await this.approvals.approve(adminId, requestId, reason, tx);
        const applied = await applyReconciliationCorrection(tx, {
          approvalId: requestId,
          requestedBy: request.requestedBy,
          approverId: adminId,
        });
        // Observing the repaired books does not release the existing hold. Recovery stays an
        // explicit, separate two-person decision, including the existing paused-market path.
        const options = { source: 'manual' as const, actorId: adminId };
        const checked =
          result.marketId === null
            ? await runAccountReconciliation(
                tx,
                { accountId: Number(payload.candidate.accountId) },
                options,
              )
            : await runMarketReconciliation(tx, result.marketId, options);
        await this.audit(
          tx,
          adminId,
          'reconciliation_correction_approve',
          approved,
          approved.decidedAt ?? (await clockTimestamp(tx)),
        );
        return { detail: await this.detail(tx, resultId), applied, checked };
      }),
    );
    const events: Promise<void>[] = [];
    if (done.applied.outcome === 'recorded' && done.applied.correction.userId !== null) {
      events.push(
        this.publisher.publishUser(done.applied.correction.userId, {
          type: 'user:balance',
          availableCoin: serializeCoinAmount(done.applied.balance.availableCoin),
          lockedCoin: serializeCoinAmount(done.applied.balance.lockedCoin),
          ledgerEntryId: String(done.applied.eventId),
          ts: done.applied.correction.createdAt.toISOString(),
        }),
      );
    }
    if (done.checked.statusEvent !== null)
      events.push(
        this.publisher.publishMarket(done.checked.statusEvent.marketId, done.checked.statusEvent),
      );
    await Promise.all(events);
    return done.detail;
  }

  reject(
    adminId: string,
    resultId: number,
    requestId: string,
    reason: string,
  ): Promise<ReconciliationCorrectionDetail> {
    return this.endRequest(adminId, resultId, requestId, reason);
  }

  retract(
    adminId: string,
    resultId: number,
    requestId: string,
  ): Promise<ReconciliationCorrectionDetail> {
    return this.endRequest(adminId, resultId, requestId);
  }

  private endRequest(
    adminId: string,
    resultId: number,
    requestId: string,
    reason?: string,
  ): Promise<ReconciliationCorrectionDetail> {
    return this.mapped(() =>
      this.db.transaction(async (tx) => {
        await this.lockIdentityAndAdmin(tx, resultId, adminId);
        await this.ownRequest(tx, resultId, requestId);
        // Cleaning up a stale request must not depend on still-valid monetary evidence.
        const request =
          reason === undefined
            ? await this.approvals.retract(adminId, requestId, tx)
            : await this.approvals.reject(adminId, requestId, reason, tx);
        await this.audit(
          tx,
          adminId,
          reason === undefined
            ? 'reconciliation_correction_retract'
            : 'reconciliation_correction_reject',
          request,
          request.retractedAt ?? request.decidedAt ?? (await clockTimestamp(tx)),
        );
        return this.detail(tx, resultId);
      }),
    );
  }

  /** Immutable market identity → current admin roles → account/treasury locks → approval row. */
  private async lockTarget(
    tx: Tx,
    resultId: number,
    accountId: number,
    adminId: string,
  ): Promise<ResultRow> {
    const result = await this.lockIdentityAndAdmin(tx, resultId, adminId);
    const [account] = await tx
      .select()
      .from(schema.ledgerAccounts)
      .where(eq(schema.ledgerAccounts.id, accountId));
    const sameTarget =
      account !== undefined &&
      (result.scope === 'market'
        ? result.marketId !== null && account.marketId === result.marketId
        : result.scope === 'account' &&
          (result.accountId === account.id ||
            (result.userId !== null && account.ownerId === result.userId)));
    if (!sameTarget) throw refusal('unsupported');
    await lockReconciliationCorrection(tx, resultId, accountId);
    return result;
  }

  private async lockIdentityAndAdmin(
    tx: Tx,
    resultId: number,
    adminId: string,
  ): Promise<ResultRow> {
    const result = await this.result(tx, resultId);
    if (result.marketId !== null) {
      await lockMarket(tx, result.marketId);
      await lockedMarketRow(tx, result.marketId);
    }
    await lockAdminRoles(tx, 'shared');
    const [profile] = await tx
      .select({ role: schema.profiles.role })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, adminId));
    if (profile?.role !== 'admin') throw new AppError('FORBIDDEN', { message: 'Admin only' });
    return result;
  }

  private async result(executor: Executor, resultId: number): Promise<ResultRow> {
    const [result] = await executor.select().from(results).where(eq(results.id, resultId));
    if (!result) throw new AppError('NOT_FOUND', { message: 'Reconciliation result not found' });
    return result;
  }

  private async ownRequest(tx: Tx, resultId: number, requestId: string): Promise<ApprovalRequest> {
    const [request] = await tx
      .select()
      .from(requests)
      .where(and(correctionKind(), eq(requests.id, requestId), resultRequests(resultId)));
    if (!request || request.targetId !== this.payload(request).candidate.accountId)
      throw new AppError('NOT_FOUND', { message: 'Correction request not found' });
    return request;
  }

  private payload(
    request: Pick<ApprovalRequest, 'id' | 'payload'>,
  ): ReconciliationCorrectionPayload {
    const parsed = reconciliationCorrectionPayloadSchema.safeParse(request.payload);
    if (!parsed.success)
      throw new AppError('INTERNAL', { message: `Malformed correction request ${request.id}` });
    return parsed.data;
  }

  private async detail(tx: Tx, resultId: number): Promise<ReconciliationCorrectionDetail> {
    const result = await this.result(tx, resultId);
    return {
      result: reconciliationResultOf(result),
      candidates: await previewReconciliationCorrections(tx, resultId),
      requests: await this.readRequests(tx, resultRequests(resultId)),
    };
  }

  private async readRequests(
    executor: Executor,
    where?: SQL,
    limit?: number,
  ): Promise<ReconciliationCorrectionRequest[]> {
    const query = executor
      .select({
        request: requests,
        requesterNickname: requester.nickname,
        deciderNickname: decider.nickname,
      })
      .from(requests)
      .leftJoin(requester, eq(requester.userId, requests.requestedBy))
      .leftJoin(decider, eq(decider.userId, requests.decidedBy))
      .where(and(correctionKind(), where))
      .orderBy(desc(requests.requestedAt), desc(requests.id));
    const rows = await (limit === undefined ? query : query.limit(limit));
    return rows.map(({ request, requesterNickname, deciderNickname }) => {
      const payload = this.payload(request);
      return {
        id: request.id,
        resultId: payload.failureResultId,
        candidate: payload.candidate,
        requestedBy: { id: request.requestedBy, nickname: requesterNickname },
        reason: request.requestReason,
        userReason: payload.userReason,
        requestedAt: request.requestedAt.toISOString(),
        status: request.status,
        decidedBy:
          request.decidedBy === null ? null : { id: request.decidedBy, nickname: deciderNickname },
        decisionReason: request.decisionReason,
        decidedAt: request.decidedAt?.toISOString() ?? null,
        retractedAt: request.retractedAt?.toISOString() ?? null,
      };
    });
  }

  private async audit(
    tx: Tx,
    adminId: string,
    type:
      | 'reconciliation_correction_request'
      | 'reconciliation_correction_approve'
      | 'reconciliation_correction_reject'
      | 'reconciliation_correction_retract',
    request: ApprovalRequest,
    at: Date,
  ): Promise<void> {
    const payload = this.payload(request);
    await tx.insert(schema.adminActions).values({
      adminId,
      type,
      targetType: 'ledger_account',
      targetId: payload.candidate.accountId,
      payload: {
        approvalId: request.id,
        ...payload,
        reason: request.decisionReason ?? request.requestReason,
      },
      createdAt: at,
    });
  }

  private async mapped<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ReconciliationCorrectionError)) throw error;
      if (error.code === 'not_found')
        throw new AppError('NOT_FOUND', { message: 'Reconciliation correction target not found' });
      throw refusal(error.code);
    }
  }
}
