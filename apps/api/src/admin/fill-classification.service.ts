import { Inject, Injectable } from '@nestjs/common';
import {
  applyFillClassification,
  assertFillClassificationAdmin,
  assertFillClassificationCurrent,
  lockClassifiableFill,
  lockFillClassificationDecision,
  FillClassificationError,
  FILL_CLASSIFICATION_KIND,
  schema,
  TransactionBusyError,
  withTransactionRetry,
  type Db,
} from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  decodeTupleCursor,
  encodeTupleCursor,
  fillClassificationPayloadSchema,
  type CursorQuery,
  type FillClassification,
  type FillClassificationRequest,
  type FillClassificationListQuery,
  type FillClassificationWrite,
  type AdminClassifiableFill,
  type RequestFillClassificationBody,
} from '@buddha/shared';
import { and, desc, eq, isNull, lt, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  ApprovalService,
  approvalNotAllowed,
  type ApprovalRequest,
} from '../approvals/approval.service.js';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import type { Page } from '../wallet/wallet.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Pick<Db, 'select'>;
const {
  approvalRequests: requests,
  fillClassifications: classifications,
  profiles,
  fills,
  markets,
} = schema;
const requester = alias(profiles, 'fill_classification_requester');
const decider = alias(profiles, 'fill_classification_decider');
const kind = () =>
  and(eq(requests.kind, FILL_CLASSIFICATION_KIND), eq(requests.targetType, 'fill'));

@Injectable()
export class FillClassificationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly approvals: ApprovalService,
    private readonly publisher: MarketPublisher,
  ) {}

  async list(
    query: FillClassificationListQuery,
    fillId?: string,
  ): Promise<Page<FillClassificationRequest>> {
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.read(
      this.db,
      and(
        fillId ? eq(requests.targetId, fillId) : undefined,
        query.status === 'pending' ? eq(requests.status, 'pending') : undefined,
        cursor ? keysetPredicate(requests.requestedAt, requests.id, cursor, 'uuid') : undefined,
      ),
      query.limit + 1,
    );
    const items = rows.slice(0, query.limit),
      last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encodeKeyset({ id: last.id, createdAt: new Date(last.requestedAt) })
          : null,
    };
  }
  get(fillId: string, id: string): Promise<FillClassificationWrite> {
    return this.db.transaction((tx) => this.snapshot(tx, fillId, id), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }
  fill(fillId: string): Promise<AdminClassifiableFill> {
    return this.db.transaction((tx) => this.readFill(tx, fillId), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }
  async history(fillId: string, query: CursorQuery): Promise<Page<FillClassification>> {
    const cursor = decodeTupleCursor(query.cursor, ['int'], 'uuid');
    const rows = await this.read(
      this.db,
      and(
        eq(requests.targetId, fillId),
        eq(requests.status, 'approved'),
        cursor ? lt(classifications.revision, BigInt(cursor.values[0]!)) : undefined,
      ),
      query.limit + 1,
      true,
    );
    const items = rows.slice(0, query.limit),
      last = items.at(-1);
    return {
      items: items.map((r) => {
        if (!r.execution) throw new AppError('INTERNAL');
        return r.execution;
      }),
      nextCursor:
        rows.length > query.limit && last?.execution
          ? encodeTupleCursor([last.execution.revision], last.id)
          : null,
    };
  }
  request(
    adminId: string,
    fillId: string,
    body: RequestFillClassificationBody,
  ): Promise<FillClassificationWrite> {
    return this.mapped(() =>
      withTransactionRetry(this.db, async (tx) => {
        const fill = await lockClassifiableFill(tx, Number(fillId));
        await this.current(tx, adminId);
        const payload = {
          fillId,
          marketId: fill.marketId,
          action: body.action,
          baseRevision: body.baseRevision,
        };
        await assertFillClassificationCurrent(tx, payload);
        if (!(await this.approvals.hasDecider([adminId], tx)))
          throw approvalNotAllowed('no_decider');
        const request = await this.approvals.request(
          {
            kind: FILL_CLASSIFICATION_KIND,
            targetType: 'fill',
            targetId: fillId,
            requestedBy: adminId,
            reason: body.reason,
            payload,
          },
          tx,
        );
        await this.audit(tx, adminId, 'fill_classification_request', request, request.requestedAt);
        return this.snapshot(tx, fillId, request.id);
      }),
    );
  }
  async approve(
    adminId: string,
    fillId: string,
    id: string,
    reason: string,
  ): Promise<FillClassificationWrite> {
    const committed = await this.mapped(() =>
      withTransactionRetry(this.db, async (tx) => {
        await lockClassifiableFill(tx, Number(fillId));
        await this.current(tx, adminId);
        const request = await this.ownRequest(tx, fillId, id);
        const [actor] = await tx
          .select({ id: profiles.userId })
          .from(profiles)
          .where(
            and(
              eq(profiles.userId, request.requestedBy),
              eq(profiles.role, 'admin'),
              isNull(profiles.closedAt),
            ),
          );
        if (!actor) throw new FillClassificationError('requester');
        if (request.requestedBy === adminId) throw approvalNotAllowed('requester');
        await lockFillClassificationDecision(
          tx,
          fillClassificationPayloadSchema.parse(request.payload),
        );
        const approval = await this.approvals.approve(adminId, id, reason, tx);
        const result = await applyFillClassification(tx, id);
        await this.audit(tx, adminId, 'fill_classification_approve', approval, approval.decidedAt!);
        return { result, snapshot: await this.snapshot(tx, fillId, id) };
      }),
    );
    if (committed.result.stats)
      await this.publisher.publishMarket(committed.result.stats.marketId, {
        type: 'market:stats',
        ...committed.result.stats,
      });
    return committed.snapshot;
  }
  reject(adminId: string, fillId: string, id: string, reason: string) {
    return this.end(adminId, fillId, id, reason);
  }
  retract(adminId: string, fillId: string, id: string) {
    return this.end(adminId, fillId, id);
  }
  private end(
    adminId: string,
    fillId: string,
    id: string,
    reason?: string,
  ): Promise<FillClassificationWrite> {
    return this.mapped(() =>
      withTransactionRetry(this.db, async (tx) => {
        await lockClassifiableFill(tx, Number(fillId));
        await this.current(tx, adminId);
        await this.ownRequest(tx, fillId, id);
        const request =
          reason === undefined
            ? await this.approvals.retract(adminId, id, tx)
            : await this.approvals.reject(adminId, id, reason, tx);
        await this.audit(
          tx,
          adminId,
          reason === undefined ? 'fill_classification_retract' : 'fill_classification_reject',
          request,
          (request.retractedAt ?? request.decidedAt)!,
        );
        return this.snapshot(tx, fillId, id);
      }),
    );
  }
  private async current(tx: Tx, adminId: string) {
    try {
      await assertFillClassificationAdmin(tx, adminId);
    } catch (error) {
      if (error instanceof FillClassificationError) throw new AppError('FORBIDDEN');
      throw error;
    }
  }
  private async ownRequest(reader: Reader, fillId: string, id: string) {
    const [request] = await reader
      .select()
      .from(requests)
      .where(and(kind(), eq(requests.id, id), eq(requests.targetId, fillId)));
    if (!request) throw new AppError('NOT_FOUND');
    return request;
  }
  private async read(
    reader: Reader,
    where?: SQL,
    limit = 1,
    history = false,
  ): Promise<FillClassificationRequest[]> {
    const rows = await reader
      .select({
        request: requests,
        execution: classifications,
        requesterNickname: requester.nickname,
        deciderNickname: decider.nickname,
      })
      .from(requests)
      .leftJoin(classifications, eq(classifications.approvalId, requests.id))
      .leftJoin(requester, eq(requester.userId, requests.requestedBy))
      .leftJoin(decider, eq(decider.userId, requests.decidedBy))
      .where(and(kind(), where))
      .orderBy(
        ...(history
          ? [desc(classifications.revision)]
          : [desc(requests.requestedAt), desc(requests.id)]),
      )
      .limit(limit);
    return rows.map(({ request: r, execution: c, requesterNickname, deciderNickname }) => {
      const requestedBy = { id: r.requestedBy, nickname: requesterNickname };
      const decidedBy =
        r.decidedBy === null ? null : { id: r.decidedBy, nickname: deciderNickname };
      return {
        id: r.id,
        payload: fillClassificationPayloadSchema.parse(r.payload),
        requestedBy,
        reason: r.requestReason,
        requestedAt: r.requestedAt.toISOString(),
        status: r.status,
        decidedBy,
        decisionReason: r.decisionReason,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        retractedAt: r.retractedAt?.toISOString() ?? null,
        execution:
          c === null
            ? null
            : {
                revision: c.revision.toString(),
                approvalId: c.approvalId,
                fillId: String(c.fillId),
                marketId: c.marketId,
                action: c.action,
                requestedBy,
                approvedBy: decidedBy!,
                reason: r.requestReason,
                decisionReason: r.decisionReason!,
                performedAt: c.performedAt.toISOString(),
              },
      };
    });
  }
  private async readFill(reader: Reader, fillId: string): Promise<AdminClassifiableFill> {
    const [row] = await reader
      .select({ fill: fills, title: markets.title })
      .from(fills)
      .innerJoin(markets, eq(markets.id, fills.marketId))
      .where(eq(fills.id, Number(fillId)));
    if (!row) throw new AppError('NOT_FOUND');
    const [latest] = await reader
      .select({ approvalId: classifications.approvalId })
      .from(classifications)
      .where(eq(classifications.fillId, Number(fillId)))
      .orderBy(desc(classifications.revision))
      .limit(1);
    const [request] = latest ? await this.read(reader, eq(requests.id, latest.approvalId)) : [];
    if (latest && !request?.execution) throw new AppError('INTERNAL');
    const classification = request?.execution ?? null;
    const f = row.fill;
    return {
      id: String(f.id),
      marketId: f.marketId,
      marketTitle: row.title,
      outcome: f.outcome,
      priceCoin: f.priceCoin,
      qty: f.qty,
      amountCoin: f.amountCoin.toString(),
      createdAt: f.createdAt.toISOString(),
      classificationRevision: classification?.revision ?? '0',
      excluded: classification?.action === 'mark',
      classification,
    };
  }
  private async snapshot(tx: Tx, fillId: string, id: string): Promise<FillClassificationWrite> {
    const [request] = await this.read(tx, and(eq(requests.id, id), eq(requests.targetId, fillId)));
    if (!request) throw new AppError('NOT_FOUND');
    return { request, fill: await this.readFill(tx, fillId) };
  }
  private async audit(
    tx: Tx,
    adminId: string,
    type:
      | 'fill_classification_request'
      | 'fill_classification_approve'
      | 'fill_classification_reject'
      | 'fill_classification_retract',
    request: ApprovalRequest,
    at: Date,
  ) {
    await tx.insert(schema.adminActions).values({
      adminId,
      type,
      targetType: 'fill',
      targetId: request.targetId,
      payload: {
        approvalId: request.id,
        action: fillClassificationPayloadSchema.parse(request.payload).action,
        reason: request.decisionReason ?? request.requestReason,
      },
      createdAt: at,
    });
  }
  private async mapped<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof FillClassificationError)
        throw new AppError(
          error.code === 'not_found' ? 'NOT_FOUND' : 'FILL_CLASSIFICATION_NOT_ALLOWED',
          { details: { reason: error.code } },
        );
      if (error instanceof TransactionBusyError) throw new AppError('TRANSACTION_BUSY');
      throw error;
    }
  }
}
