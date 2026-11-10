import { Inject, Injectable } from '@nestjs/common';
import {
  lockAdminRoles,
  lockLedgerAccounts,
  mintTreasury,
  MintTreasuryError,
  schema,
  type Db,
} from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  TREASURY_ISSUE_APPROVAL_KIND,
  treasuryIssuePayloadSchema,
  type AdminTreasury,
  type CursorQuery,
  type RequestTreasuryIssueBody,
  type TreasuryIssuance,
  type TreasuryIssueRequest,
  type TreasuryIssueRequestsQuery,
  type TreasuryIssueWrite,
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
import { DB } from '../infra/db/db.provider.js';
import { fieldError, type Executor, type Tx } from '../markets/market-item-rules.js';
import type { Page } from '../wallet/wallet.service.js';

const { approvalRequests: requests, treasuryIssuances: issuances } = schema;
const requester = alias(schema.profiles, 'treasury_requester');
const decider = alias(schema.profiles, 'treasury_decider');
const ownKind = () =>
  and(
    eq(requests.kind, TREASURY_ISSUE_APPROVAL_KIND),
    eq(requests.targetType, 'treasury'),
    eq(requests.targetId, 'treasury'),
  );

/** Explicit two-person issuance, never an automatic response to a market's funding shortage. */
@Injectable()
export class TreasuryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly approvals: ApprovalService,
  ) {}

  getTreasury(): Promise<AdminTreasury> {
    return this.db.transaction((tx) => this.snapshot(tx), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }

  async listRequests(query: TreasuryIssueRequestsQuery): Promise<Page<TreasuryIssueRequest>> {
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.readRequests(
      this.db,
      and(
        query.status === 'pending' ? eq(requests.status, 'pending') : undefined,
        cursor ? keysetPredicate(requests.requestedAt, requests.id, cursor, 'uuid') : undefined,
      ),
      query.limit + 1,
    );
    return this.page(rows, query.limit, (row) => ({
      id: row.id,
      createdAt: new Date(row.requestedAt),
    }));
  }

  async getRequest(id: string): Promise<TreasuryIssueRequest> {
    return this.requestDto(this.db, id);
  }

  async history(query: CursorQuery): Promise<Page<TreasuryIssuance>> {
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.db
      .select({
        issuance: issuances,
        request: requests,
        requesterNickname: requester.nickname,
        deciderNickname: decider.nickname,
      })
      .from(issuances)
      .innerJoin(requests, eq(requests.id, issuances.approvalId))
      .leftJoin(requester, eq(requester.userId, issuances.requestedBy))
      .leftJoin(decider, eq(decider.userId, issuances.approvedBy))
      .where(
        cursor
          ? keysetPredicate(issuances.createdAt, issuances.approvalId, cursor, 'uuid')
          : undefined,
      )
      .orderBy(desc(issuances.createdAt), desc(issuances.approvalId))
      .limit(query.limit + 1);
    const items: TreasuryIssuance[] = rows.map(
      ({ issuance, request, requesterNickname, deciderNickname }) => ({
        id: issuance.approvalId,
        approvalId: issuance.approvalId,
        amountCoin: issuance.amountCoin.toString(),
        ledgerEntryId: String(issuance.ledgerEntryId),
        issuedAt: issuance.createdAt.toISOString(),
        requestedBy: { id: issuance.requestedBy, nickname: requesterNickname },
        approvedBy: { id: issuance.approvedBy, nickname: deciderNickname },
        requestReason: request.requestReason,
        approvalReason: request.decisionReason ?? '',
      }),
    );
    return this.page(items, query.limit, (row) => ({
      id: row.id,
      createdAt: new Date(row.issuedAt),
    }));
  }

  request(adminId: string, body: RequestTreasuryIssueBody): Promise<TreasuryIssueWrite> {
    return this.db.transaction(async (tx) => {
      await this.currentAdmin(tx, adminId);
      if (!(await this.approvals.hasDecider([adminId], tx))) throw approvalNotAllowed('no_decider');
      const request = await this.approvals.request(
        {
          kind: TREASURY_ISSUE_APPROVAL_KIND,
          targetType: 'treasury',
          targetId: 'treasury',
          requestedBy: adminId,
          reason: body.reason,
          payload: { amountCoin: body.amountCoin.toString() },
        },
        tx,
      );
      await this.audit(tx, adminId, 'treasury_issue_request', request, request.requestedAt);
      return this.writeSnapshot(tx, request.id);
    });
  }

  approve(adminId: string, id: string, reason: string): Promise<TreasuryIssueWrite> {
    return this.mapped(() =>
      this.db.transaction(async (tx) => {
        await this.currentAdmin(tx, adminId);
        const request = await this.ownRequest(tx, id);
        const [requesterProfile] = await tx
          .select({ role: schema.profiles.role, closedAt: schema.profiles.closedAt })
          .from(schema.profiles)
          .where(eq(schema.profiles.userId, request.requestedBy));
        if (requesterProfile?.role !== 'admin' || requesterProfile.closedAt !== null)
          throw fieldError(
            'treasuryIssue',
            'The requesting administrator is no longer eligible',
            'requester',
          );
        // A mint's account may be born here; every subsequent failure rolls that creation back too.
        await lockLedgerAccounts(tx, [{ kind: 'treasury' }]);
        const approved = await this.approvals.approve(adminId, id, reason, tx);
        await mintTreasury(tx, { approvalId: id });
        await this.audit(tx, adminId, 'treasury_issue_approve', approved, approved.decidedAt!);
        return this.writeSnapshot(tx, id);
      }),
    );
  }

  reject(adminId: string, id: string, reason: string): Promise<TreasuryIssueWrite> {
    return this.endRequest(adminId, id, reason);
  }

  retract(adminId: string, id: string): Promise<TreasuryIssueWrite> {
    return this.endRequest(adminId, id);
  }

  private endRequest(adminId: string, id: string, reason?: string): Promise<TreasuryIssueWrite> {
    return this.db.transaction(async (tx) => {
      await this.currentAdmin(tx, adminId);
      await this.ownRequest(tx, id);
      // Cleanup never acquires or requires valid treasury assets.
      const request =
        reason === undefined
          ? await this.approvals.retract(adminId, id, tx)
          : await this.approvals.reject(adminId, id, reason, tx);
      await this.audit(
        tx,
        adminId,
        reason === undefined ? 'treasury_issue_retract' : 'treasury_issue_reject',
        request,
        (request.retractedAt ?? request.decidedAt)!,
      );
      return this.writeSnapshot(tx, id);
    });
  }

  private async currentAdmin(tx: Tx, id: string): Promise<void> {
    await lockAdminRoles(tx, 'shared');
    const [profile] = await tx
      .select({ role: schema.profiles.role, closedAt: schema.profiles.closedAt })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, id));
    if (profile?.role !== 'admin' || profile.closedAt !== null)
      throw new AppError('FORBIDDEN', { message: 'Admin only' });
  }

  private async ownRequest(tx: Tx, id: string): Promise<ApprovalRequest> {
    const [request] = await tx
      .select()
      .from(requests)
      .where(and(ownKind(), eq(requests.id, id)));
    if (!request) throw new AppError('NOT_FOUND', { message: 'Treasury issue request not found' });
    this.payload(request);
    return request;
  }

  private payload(request: Pick<ApprovalRequest, 'id' | 'payload'>) {
    const parsed = treasuryIssuePayloadSchema.safeParse(request.payload);
    if (!parsed.success)
      throw new AppError('INTERNAL', { message: `Malformed treasury issue request ${request.id}` });
    return parsed.data;
  }

  private async snapshot(executor: Executor): Promise<AdminTreasury> {
    // One statement snapshot even during a cleanup write: another market may allocate Coin,
    // but must not make two separately-read snapshots appear to be a bookkeeping mismatch.
    const { rows } = await executor.execute<{
      accountId: string | null;
      available: string | null;
      locked: string | null;
      ledger: string | null;
      latest: string | null;
      total: string | null;
      issued: string;
    }>(sql`SELECT a.id::text AS "accountId", b.available_coin::text AS available,
      b.locked_coin::text AS locked, b.ledger_coin::text AS ledger,
      CASE WHEN a.id IS NULL THEN NULL ELSE public.ledger_account_last_after(a.id)::text END AS latest,
      CASE WHEN a.id IS NULL THEN NULL ELSE
        (SELECT COALESCE(SUM(CASE WHEN e.to_account_id=a.id THEN e.amount_coin ELSE 0 END),0)
         - COALESCE(SUM(CASE WHEN e.from_account_id=a.id THEN e.amount_coin ELSE 0 END),0)
         FROM ledger_entries e WHERE e.to_account_id=a.id OR e.from_account_id=a.id)::text END AS total,
      (SELECT COALESCE(SUM(amount_coin),0)::text FROM ledger_entries WHERE type='TREASURY_MINT') AS issued
      FROM (SELECT 1) seed LEFT JOIN ledger_accounts a ON a.kind='treasury'
      LEFT JOIN balances b ON b.account_id=a.id`);
    const row = rows[0]!;
    const consistent =
      row.available !== null &&
      row.locked === '0' &&
      row.available === row.ledger &&
      row.ledger === row.latest &&
      row.latest === row.total;
    return {
      accountId: row.accountId,
      status: row.accountId === null ? 'uninitialized' : consistent ? 'ready' : 'inconsistent',
      availableCoin: row.available,
      lockedCoin: row.locked,
      ledgerCoin: row.ledger,
      issuedCoin: row.issued,
    };
  }

  private async readRequests(
    executor: Executor,
    where?: SQL,
    limit?: number,
  ): Promise<TreasuryIssueRequest[]> {
    const query = executor
      .select({
        request: requests,
        requesterNickname: requester.nickname,
        deciderNickname: decider.nickname,
        ledgerEntryId: issuances.ledgerEntryId,
      })
      .from(requests)
      .leftJoin(issuances, eq(issuances.approvalId, requests.id))
      .leftJoin(requester, eq(requester.userId, requests.requestedBy))
      .leftJoin(decider, eq(decider.userId, requests.decidedBy))
      .where(and(ownKind(), where))
      .orderBy(desc(requests.requestedAt), desc(requests.id));
    const rows = await (limit === undefined ? query : query.limit(limit));
    return rows.map(({ request, requesterNickname, deciderNickname, ledgerEntryId }) => ({
      id: request.id,
      amountCoin: this.payload(request).amountCoin,
      requestedBy: { id: request.requestedBy, nickname: requesterNickname },
      reason: request.requestReason,
      requestedAt: request.requestedAt.toISOString(),
      status: request.status,
      decidedBy:
        request.decidedBy === null ? null : { id: request.decidedBy, nickname: deciderNickname },
      decisionReason: request.decisionReason,
      decidedAt: request.decidedAt?.toISOString() ?? null,
      retractedAt: request.retractedAt?.toISOString() ?? null,
      ledgerEntryId: ledgerEntryId === null ? null : String(ledgerEntryId),
    }));
  }

  private async requestDto(executor: Executor, id: string): Promise<TreasuryIssueRequest> {
    const [request] = await this.readRequests(executor, eq(requests.id, id), 1);
    if (!request) throw new AppError('NOT_FOUND', { message: 'Treasury issue request not found' });
    return request;
  }

  private async writeSnapshot(tx: Tx, id: string): Promise<TreasuryIssueWrite> {
    return { request: await this.requestDto(tx, id), treasury: await this.snapshot(tx) };
  }

  private async audit(
    tx: Tx,
    adminId: string,
    type:
      | 'treasury_issue_request'
      | 'treasury_issue_approve'
      | 'treasury_issue_reject'
      | 'treasury_issue_retract',
    request: ApprovalRequest,
    at: Date,
  ): Promise<void> {
    await tx.insert(schema.adminActions).values({
      adminId,
      type,
      targetType: 'treasury',
      targetId: 'treasury',
      payload: {
        approvalId: request.id,
        ...this.payload(request),
        reason: request.decisionReason ?? request.requestReason,
      },
      createdAt: at,
    });
  }

  private page<T>(
    rows: T[],
    limit: number,
    key: (item: T) => { id: string; createdAt: Date },
  ): Page<T> {
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last !== undefined ? encodeKeyset(key(last)) : null,
    };
  }

  private async mapped<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof MintTreasuryError)) throw error;
      if (error.code === 'not_found')
        throw new AppError('NOT_FOUND', { message: 'Treasury issue request not found' });
      throw fieldError('treasuryIssue', 'Treasury issuance is not available', error.code);
    }
  }
}
