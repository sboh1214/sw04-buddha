import { Inject, Injectable } from '@nestjs/common';
import {
  applyMarketMakerControl,
  assertMarketMakerControlAdmin,
  lockMarket,
  lockMarketMakerControl,
  MarketMakerControlError,
  prepareMarketMakerControlRequest,
  schema,
  TransactionBusyError,
  withTransactionRetry,
  type Db,
  type MarketMakerControlRow,
} from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  MARKET_MAKER_CONTROL_KIND,
  marketMakerControlPayloadSchema,
  type CursorQuery,
  type MarketMakerControlExecution,
  type MarketMakerControlRequest,
  type MarketMakerControlRequestsQuery,
  type MarketMakerControlWrite,
  type RequestMarketMakerControlBody,
} from '@buddha/shared';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  ApprovalService,
  approvalNotAllowed,
  type ApprovalRequest,
} from '../approvals/approval.service.js';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import type { Page } from '../wallet/wallet.service.js';
import { AdminMarketMakerService } from './market-maker.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Pick<Db, 'select'>;
const { approvalRequests: requests, marketMakerControls: controls, profiles } = schema;
const requester = alias(profiles, 'maker_control_requester');
const decider = alias(profiles, 'maker_control_decider');
const kind = () =>
  and(eq(requests.kind, MARKET_MAKER_CONTROL_KIND), eq(requests.targetType, 'market'));
function executionDto(row: MarketMakerControlRow): MarketMakerControlExecution {
  return {
    approvalId: row.approvalId,
    marketId: row.marketId,
    action: row.action,
    beforeVersion: row.beforeVersion,
    afterVersion: row.afterVersion,
    beforeControlGeneration: String(row.beforeControlGeneration),
    afterControlGeneration: String(row.afterControlGeneration),
    beforeDesiredEnabled: row.beforeDesiredEnabled,
    afterDesiredEnabled: row.afterDesiredEnabled,
    additionalCoin: row.additionalCoin?.toString() ?? null,
    ledgerEntryId: row.ledgerEntryId === null ? null : String(row.ledgerEntryId),
    performedAt: row.performedAt.toISOString(),
  };
}

@Injectable()
export class MarketMakerControlService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly approvals: ApprovalService,
    private readonly maker: AdminMarketMakerService,
    private readonly jobs: MarketJobs,
    private readonly publisher: MarketPublisher,
  ) {}

  async list(
    query: MarketMakerControlRequestsQuery,
    marketId?: string,
  ): Promise<Page<MarketMakerControlRequest>> {
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.read(
      this.db,
      and(
        marketId ? eq(requests.targetId, marketId) : undefined,
        query.status === 'pending' ? eq(requests.status, 'pending') : undefined,
        cursor ? keysetPredicate(requests.requestedAt, requests.id, cursor, 'uuid') : undefined,
      ),
      query.limit + 1,
    );
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encodeKeyset({ id: last.id, createdAt: new Date(last.requestedAt) })
          : null,
    };
  }
  get(marketId: string, id: string): Promise<MarketMakerControlWrite> {
    return this.db.transaction((tx) => this.snapshot(tx, marketId, id), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }
  async history(marketId: string, query: CursorQuery): Promise<Page<MarketMakerControlExecution>> {
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.db
      .select()
      .from(controls)
      .where(
        and(
          eq(controls.marketId, marketId),
          cursor
            ? keysetPredicate(controls.performedAt, controls.approvalId, cursor, 'uuid')
            : undefined,
        ),
      )
      .orderBy(desc(controls.performedAt), desc(controls.approvalId))
      .limit(query.limit + 1);
    const selected = rows.slice(0, query.limit);
    const last = selected.at(-1);
    return {
      items: selected.map(executionDto),
      nextCursor:
        rows.length > query.limit && last
          ? encodeKeyset({ id: last.approvalId, createdAt: last.performedAt })
          : null,
    };
  }
  request(
    adminId: string,
    marketId: string,
    body: RequestMarketMakerControlBody,
  ): Promise<MarketMakerControlWrite> {
    return this.mapped(() =>
      withTransactionRetry(this.db, async (tx) => {
        await lockMarket(tx, marketId);
        await this.current(tx, adminId);
        const payload = await prepareMarketMakerControlRequest(tx, marketId, adminId, body);
        if (!(await this.approvals.hasDecider([adminId], tx)))
          throw approvalNotAllowed('no_decider');
        const request = await this.approvals.request(
          {
            kind: MARKET_MAKER_CONTROL_KIND,
            targetType: 'market',
            targetId: marketId,
            requestedBy: adminId,
            reason: body.reason,
            payload,
          },
          tx,
        );
        await this.audit(tx, adminId, 'market_maker_control_request', request, request.requestedAt);
        return this.snapshot(tx, marketId, request.id);
      }),
    );
  }
  async approve(
    adminId: string,
    marketId: string,
    id: string,
    reason: string,
  ): Promise<MarketMakerControlWrite> {
    const committed = await this.mapped(() =>
      withTransactionRetry(this.db, async (tx) => {
        await lockMarket(tx, marketId);
        await this.current(tx, adminId);
        const request = await this.ownRequest(tx, marketId, id);
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
        if (!actor) throw new MarketMakerControlError('requester');
        if (request.requestedBy === adminId) throw approvalNotAllowed('requester');
        // The domain locks every asset before ApprovalService takes the request row.
        await lockMarketMakerControl(
          tx,
          marketId,
          marketMakerControlPayloadSchema.parse(request.payload),
        );
        const approval = await this.approvals.approve(adminId, id, reason, tx);
        const result = await applyMarketMakerControl(tx, { approvalId: id });
        await this.audit(
          tx,
          adminId,
          'market_maker_control_approve',
          approval,
          approval.decidedAt!,
        );
        return { result, snapshot: await this.snapshot(tx, marketId, id) };
      }),
    );
    // The durable runtime generation repairs a missed enqueue; rollback never emits anything.
    await Promise.all([
      committed.result.bookChanged
        ? this.publisher.publishBook([marketId], committed.result.execution.performedAt)
        : undefined,
      committed.result.refreshRequested
        ? this.jobs.refreshMarketMaker(marketId, committed.result.generation)
        : undefined,
    ]);
    return committed.snapshot;
  }
  reject(adminId: string, marketId: string, id: string, reason: string) {
    return this.end(adminId, marketId, id, reason);
  }
  retract(adminId: string, marketId: string, id: string) {
    return this.end(adminId, marketId, id);
  }
  private end(
    adminId: string,
    marketId: string,
    id: string,
    reason?: string,
  ): Promise<MarketMakerControlWrite> {
    return this.mapped(() =>
      withTransactionRetry(this.db, async (tx) => {
        await lockMarket(tx, marketId);
        await this.current(tx, adminId);
        await this.ownRequest(tx, marketId, id);
        const request =
          reason === undefined
            ? await this.approvals.retract(adminId, id, tx)
            : await this.approvals.reject(adminId, id, reason, tx);
        await this.audit(
          tx,
          adminId,
          reason === undefined ? 'market_maker_control_retract' : 'market_maker_control_reject',
          request,
          (request.retractedAt ?? request.decidedAt)!,
        );
        return this.snapshot(tx, marketId, id);
      }),
    );
  }
  private async current(tx: Tx, adminId: string) {
    try {
      await assertMarketMakerControlAdmin(tx, adminId);
    } catch (error) {
      if (error instanceof MarketMakerControlError) throw new AppError('FORBIDDEN');
      throw error;
    }
  }
  private async ownRequest(reader: Reader, marketId: string, id: string) {
    const [request] = await reader
      .select()
      .from(requests)
      .where(and(kind(), eq(requests.id, id), eq(requests.targetId, marketId)));
    if (!request) throw new AppError('NOT_FOUND');
    return request;
  }
  private async read(reader: Reader, where?: SQL, limit = 1): Promise<MarketMakerControlRequest[]> {
    const rows = await reader
      .select({
        request: requests,
        execution: controls,
        requesterNickname: requester.nickname,
        deciderNickname: decider.nickname,
      })
      .from(requests)
      .leftJoin(controls, eq(controls.approvalId, requests.id))
      .leftJoin(requester, eq(requester.userId, requests.requestedBy))
      .leftJoin(decider, eq(decider.userId, requests.decidedBy))
      .where(and(kind(), where))
      .orderBy(desc(requests.requestedAt), desc(requests.id))
      .limit(limit);
    return rows.map(({ request: r, execution, requesterNickname, deciderNickname }) => ({
      id: r.id,
      marketId: r.targetId!,
      payload: marketMakerControlPayloadSchema.parse(r.payload),
      requestedBy: { id: r.requestedBy, nickname: requesterNickname },
      reason: r.requestReason,
      requestedAt: r.requestedAt.toISOString(),
      status: r.status,
      decidedBy: r.decidedBy === null ? null : { id: r.decidedBy, nickname: deciderNickname },
      decisionReason: r.decisionReason,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      retractedAt: r.retractedAt?.toISOString() ?? null,
      execution: execution === null ? null : executionDto(execution),
    }));
  }
  private async snapshot(tx: Tx, marketId: string, id: string): Promise<MarketMakerControlWrite> {
    const [request] = await this.read(
      tx,
      and(eq(requests.id, id), eq(requests.targetId, marketId)),
    );
    if (!request) throw new AppError('NOT_FOUND');
    return { request, marketMaker: await this.maker.readIn(tx, marketId) };
  }
  private async audit(
    tx: Tx,
    actor: string,
    type:
      | 'market_maker_control_request'
      | 'market_maker_control_approve'
      | 'market_maker_control_reject'
      | 'market_maker_control_retract',
    request: ApprovalRequest,
    at: Date,
  ) {
    await tx.insert(schema.adminActions).values({
      adminId: actor,
      type,
      targetType: 'market',
      targetId: request.targetId,
      payload: {
        approvalId: request.id,
        action: marketMakerControlPayloadSchema.parse(request.payload).change.action,
        reason: request.decisionReason ?? request.requestReason,
      },
      createdAt: at,
    });
  }
  private async mapped<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof MarketMakerControlError)
        throw new AppError('MARKET_MAKER_CONTROL_NOT_ALLOWED', { details: { reason: error.code } });
      if (error instanceof TransactionBusyError) throw new AppError('TRANSACTION_BUSY');
      throw error;
    }
  }
}
