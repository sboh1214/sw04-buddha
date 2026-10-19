import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  canMoveProposal,
  decodeKeyset,
  encodeKeyset,
  proposalDraftCloseAt,
  type AdminProposal,
  type AdminProposalListQuery,
  type AdoptProposalBody,
  type AdminActionType,
  type ProposalStatus,
  type RejectProposalBody,
} from '@buddha/shared';
import { and, desc, eq } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketAdminService } from '../markets/market-admin.service.js';
import { type Page } from '../wallet/wallet.service.js';
import { adminProposalQuery, toAdminProposal, type Executor } from './proposal-rows.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type ProposalRecord = typeof schema.marketProposals.$inferSelect;

const { marketProposals } = schema;

function fieldError(path: string[], message: string, detail: string): AppError {
  return new AppError('VALIDATION_ERROR', { message, details: [{ path, message: detail }] });
}

/**
 * 시장 제안 (#77), the operators' side: the review list and detail, 검토 시작, 채택, 반려 and the
 * internal memo. Owner decisions (ADR-0069 decision 4 #77): 접수 → 검토 → 채택·반려, 접수 → 반려
 * directly; 채택 and 반려 are never undone; a 반려 picks a reason and explains it to the proposer
 * (a 중복 names the existing market); a 채택 may carry a memo for the proposer and may make a
 * market draft from the proposal or link an existing market — and grants nothing and opens nothing
 * (the draft opens through the market's own steps, #78 later). Who started the review, who decided
 * and when are kept on the row and in `admin_actions`, which the admin screen shows (검토 흐름·기록).
 *
 * Every move is one transaction: the proposal FOR UPDATE, its status checked against
 * PROPOSAL_TRANSITIONS (a move it does not allow is VALIDATION_ERROR naming `status`, as a market's
 * wrong status is — two operators racing for one proposal are ordered by the lock, and the second
 * finds the first's status), the database clock read after the lock, the row moved, and its
 * `admin_actions` row (`proposal_review`, `proposal_adopt`, `proposal_reject`) written with it. A
 * draft made by a 채택 is the market service's own `createIn` in the same transaction, with its
 * `created` event and `market_create` record. The proposer's 철회 takes the same row lock
 * (ProposalsService.retract), so it and a review start cannot both win.
 */
@Injectable()
export class AdminProposalsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly markets: MarketAdminService,
  ) {}

  /** `GET /admin/proposals`: newest first, every status or one, keyset-paginated. */
  async list(query: AdminProposalListQuery): Promise<Page<AdminProposal>> {
    const keyset = decodeKeyset(query.cursor, 'uuid');
    const rows = await adminProposalQuery(this.db)
      .where(
        and(
          query.status ? eq(marketProposals.status, query.status) : undefined,
          keyset
            ? keysetPredicate(marketProposals.createdAt, marketProposals.id, keyset, 'uuid')
            : undefined,
        ),
      )
      .orderBy(desc(marketProposals.createdAt), desc(marketProposals.id))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map(toAdminProposal),
      nextCursor:
        hasMore && last
          ? encodeKeyset({ createdAt: last.proposal.createdAt, id: last.proposal.id })
          : null,
    };
  }

  /** `GET /admin/proposals/:id`. */
  get(id: string): Promise<AdminProposal> {
    return this.read(this.db, id);
  }

  /** `POST /admin/proposals/:id/review`: 접수 → 검토, recording who and when. */
  async startReview(adminId: string, id: string): Promise<AdminProposal> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockedMove(tx, id, 'reviewing');
      const now = await clockTimestamp(tx);
      await tx
        .update(marketProposals)
        .set({ status: 'reviewing', reviewStartedAt: now, reviewStartedBy: adminId })
        .where(eq(marketProposals.id, id));
      await this.audit(tx, adminId, 'proposal_review', id, now, {
        from: current.status,
        to: 'reviewing',
      });
      return this.read(tx, id);
    });
  }

  /**
   * `POST /admin/proposals/:id/adopt`: 검토 → 채택, with the memo the proposer reads and the market
   * it led to, if any — a draft made here from the proposal (`proposalAdoptionMarketSchema`: the
   * question as its title, the YES condition as its rules, the sources as its resolution source,
   * the background as its description; the category and close time given, else the proposal's
   * category and `proposalDraftCloseAt`) or an existing market in any status. A draft that cannot
   * be made — no category, or a close time not in the future — is VALIDATION_ERROR naming the
   * field under `market`, and nothing is adopted.
   *
   * The proposal's category stands in only where the market form would file a market: a leaf, or
   * a parent with no active leaves (ADR-0041, markets sit on leaves). A wish for a parent that has
   * leaves — the proposal form offers either level — is refused as no category ('required'), so
   * a draft never lands on such a parent without the operator choosing it. A category the
   * operator gives is taken at any level, as the market API takes it (ADR-0041).
   */
  async adopt(adminId: string, id: string, body: AdoptProposalBody): Promise<AdminProposal> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockedMove(tx, id, 'adopted');
      let marketId: string | null = null;
      let marketCreated = false;
      const market = body.market ?? null;
      if (market?.type === 'existing') {
        await this.requireMarket(tx, market.marketId, ['market', 'marketId']);
        marketId = market.marketId;
      } else if (market?.type === 'draft') {
        const categoryId = market.categoryId ?? current.categoryId;
        if (categoryId === null) {
          throw fieldError(
            ['market', 'categoryId'],
            'A draft needs a category: the proposal names none',
            'required',
          );
        }
        const closeAt = market.closeAt
          ? new Date(market.closeAt)
          : proposalDraftCloseAt(current.deadline);
        // Checked here so the refusal names the adoption's own fields; the market service checks
        // the same again (its paths are the market body's).
        const clock = await clockTimestamp(tx);
        if (closeAt.getTime() <= clock.getTime()) {
          throw fieldError(
            ['market', 'closeAt'],
            'The draft would close in the past: give a close time',
            'must be in the future',
          );
        }
        await this.requireActiveCategory(tx, categoryId);
        if (market.categoryId === undefined) await this.requireLeafFallback(tx, categoryId);
        const draft = await this.markets.createIn(tx, adminId, {
          title: current.question,
          description: current.background,
          rules: current.yesCondition,
          resolutionSource: current.expectedSources,
          categoryId,
          closeAt: closeAt.toISOString(),
        });
        marketId = draft.id;
        marketCreated = true;
      }
      const memo = body.memo?.trim() ? body.memo : null;
      // After the draft, whose own rows read the clock first: the 채택 sorts after them.
      const now = await clockTimestamp(tx);
      await tx
        .update(marketProposals)
        .set({
          status: 'adopted',
          decidedAt: now,
          decidedBy: adminId,
          adoptionMemo: memo,
          marketId,
        })
        .where(eq(marketProposals.id, id));
      await this.audit(tx, adminId, 'proposal_adopt', id, now, {
        from: current.status,
        to: 'adopted',
        marketId,
        marketCreated,
        memo,
      });
      return this.read(tx, id);
    });
  }

  /**
   * `POST /admin/proposals/:id/reject`: 접수 or 검토 → 반려, with the reason, the explanation the
   * proposer reads and, for a 중복, the existing market (any status; the proposer sees its link
   * only while it is public). An unknown market is NOT_FOUND naming `duplicateMarketId`.
   */
  async reject(adminId: string, id: string, body: RejectProposalBody): Promise<AdminProposal> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockedMove(tx, id, 'rejected');
      const duplicateMarketId =
        body.reason === 'duplicate' ? (body.duplicateMarketId ?? null) : null;
      if (duplicateMarketId !== null) {
        await this.requireMarket(tx, duplicateMarketId, ['duplicateMarketId']);
      }
      const now = await clockTimestamp(tx);
      await tx
        .update(marketProposals)
        .set({
          status: 'rejected',
          decidedAt: now,
          decidedBy: adminId,
          rejectionReason: body.reason,
          rejectionExplanation: body.explanation,
          duplicateMarketId,
        })
        .where(eq(marketProposals.id, id));
      await this.audit(tx, adminId, 'proposal_reject', id, now, {
        from: current.status,
        to: 'rejected',
        reason: body.reason,
        explanation: body.explanation,
        duplicateMarketId,
      });
      return this.read(tx, id);
    });
  }

  /**
   * `PUT /admin/proposals/:id/internal-memo`: the operators' memo, in any status (empty clears
   * it). Recorded (`proposal_memo`, before and after) only when it changed, as a link is only when
   * it changed (ADR-0068).
   */
  async setInternalMemo(adminId: string, id: string, memo: string | null): Promise<AdminProposal> {
    const after = memo?.trim() ? memo : null;
    return this.db.transaction(async (tx) => {
      const current = await this.lockedRow(tx, id);
      if (current.internalMemo !== after) {
        const now = await clockTimestamp(tx);
        await tx
          .update(marketProposals)
          .set({ internalMemo: after })
          .where(eq(marketProposals.id, id));
        await this.audit(tx, adminId, 'proposal_memo', id, now, {
          before: current.internalMemo,
          after,
        });
      }
      return this.read(tx, id);
    });
  }

  private async read(executor: Executor, id: string): Promise<AdminProposal> {
    const [row] = await adminProposalQuery(executor).where(eq(marketProposals.id, id)).limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Proposal not found' });
    return toAdminProposal(row);
  }

  private async lockedRow(tx: Tx, id: string): Promise<ProposalRecord> {
    const [row] = await tx
      .select()
      .from(marketProposals)
      .where(eq(marketProposals.id, id))
      .limit(1)
      .for('update');
    if (!row) throw new AppError('NOT_FOUND', { message: 'Proposal not found' });
    return row;
  }

  /** The row under the lock, if its status may move to `to`; VALIDATION_ERROR naming `status`. */
  private async lockedMove(tx: Tx, id: string, to: ProposalStatus): Promise<ProposalRecord> {
    const row = await this.lockedRow(tx, id);
    if (!canMoveProposal(row.status, to)) {
      throw fieldError(['status'], `Proposal is ${row.status}`, `proposal is ${row.status}`);
    }
    return row;
  }

  /** NOT_FOUND naming the field unless the market exists, in any status. */
  private async requireMarket(tx: Tx, marketId: string, path: string[]): Promise<void> {
    const [market] = await tx
      .select({ id: schema.markets.id })
      .from(schema.markets)
      .where(eq(schema.markets.id, marketId))
      .limit(1);
    if (!market) {
      throw new AppError('NOT_FOUND', {
        message: 'Market not found',
        details: [{ path, message: 'not found' }],
      });
    }
  }

  /**
   * The draft's category, refused as the market service would but naming the adoption's field:
   * unknown is NOT_FOUND, retired is VALIDATION_ERROR.
   */
  private async requireActiveCategory(tx: Tx, categoryId: number): Promise<void> {
    const [category] = await tx
      .select({ isActive: schema.categories.isActive })
      .from(schema.categories)
      .where(eq(schema.categories.id, categoryId))
      .limit(1)
      .for('key share');
    if (!category) {
      throw new AppError('NOT_FOUND', {
        message: 'Category not found',
        details: [{ path: ['market', 'categoryId'], message: 'not found' }],
      });
    }
    if (!category.isActive) {
      throw fieldError(['market', 'categoryId'], 'This category is disabled', 'inactive');
    }
  }

  /**
   * The proposal's own category as the draft's, when the operator gave none: refused while it has
   * an active leaf, which is where the market form would make the operator file it instead.
   * Stricter than the market API on purpose — the operator never chose this category; the
   * proposer wished for it.
   */
  private async requireLeafFallback(tx: Tx, categoryId: number): Promise<void> {
    const [leaf] = await tx
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(and(eq(schema.categories.parentId, categoryId), eq(schema.categories.isActive, true)))
      .limit(1);
    if (leaf) {
      throw fieldError(
        ['market', 'categoryId'],
        'A draft needs a sub-category: the proposal names a category that has some',
        'required',
      );
    }
  }

  private async audit(
    tx: Tx,
    adminId: string,
    type: Extract<AdminActionType, `proposal_${string}`>,
    proposalId: string,
    now: Date,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(schema.adminActions).values({
      adminId,
      type,
      targetType: 'market_proposal',
      targetId: proposalId,
      payload,
      createdAt: now,
    });
  }
}
