import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  canLinkProposalMarket,
  canMoveProposal,
  decodeKeyset,
  encodeKeyset,
  proposalDraftCloseAt,
  type AdminProposal,
  type AdminProposalListQuery,
  type AdoptProposalBody,
  type AdminActionType,
  type LinkProposalMarketBody,
  type ProposalAdoptionMarket,
  type ProposalStatus,
  type RejectProposalBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { and, desc, eq } from 'drizzle-orm';
import { readCategorySelectability } from '../categories/category-selectability.js';
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
 * 시장 제안 (#77), the operators' side: the review list and detail, 검토 시작, 채택, 반려, the later
 * link of a market and the internal memo. Owner decisions (ADR-0069 decision 4 #77): 접수 → 검토 →
 * 채택·반려, 접수 → 반려 directly; 채택 and 반려 are never undone; a 반려 picks a reason and explains
 * it to the proposer (a 중복 names the existing market); a 채택 may carry a memo for the proposer
 * and may make a market draft from the proposal or link an existing market — and grants nothing
 * and opens nothing (the draft opens through the market's own steps, #78 later). A 채택 made with
 * no market may take one later, once, the same two ways (owner decision 2026-10-19). Who started
 * the review, who decided, who linked a market later and when are kept on the row and in
 * `admin_actions`, which the admin screen shows (검토 흐름·기록).
 *
 * Every move is one transaction: the proposal FOR UPDATE, its status checked against
 * PROPOSAL_TRANSITIONS (a move it does not allow is VALIDATION_ERROR naming `status`, as a market's
 * wrong status is — two operators racing for one proposal are ordered by the lock, and the second
 * finds the first's status), the database clock read after the lock, the row moved, and its
 * `admin_actions` row (`proposal_review`, `proposal_adopt`, `proposal_reject`, `proposal_link`)
 * written with it. A draft made by a 채택 or a later link is the market service's own `createIn`
 * in the same transaction, with its `created` event and `market_create` record. The proposer's
 * 철회 takes the same row lock (ProposalsService.retract), so it and a review start cannot both
 * win.
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
   * question as its title, the background as its 배경, the YES condition as its YES condition, the
   * sources as its primary source's name with the address left for the operator (#23); the
   * category and close time given, else the proposal's category and `proposalDraftCloseAt`) or an
   * existing market in any status. A draft that cannot be made — no category, or a close time not
   * in the future — is VALIDATION_ERROR naming the field under `market`, and nothing is adopted.
   *
   * The proposal's category stands in only where the market form would file a market: a leaf, or
   * a parent with no active leaves (ADR-0041, markets sit on leaves). A wish for a parent that has
   * leaves — the proposal form offers either level — is refused as no category ('required'), so
   * a draft never lands on such a parent without the operator choosing it. A category the
   * operator gives is held to what the market API holds a new market's to (#17,
   * `readCategorySelectability`), naming the adoption's field.
   */
  async adopt(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<AdoptProposalBody>,
  ): Promise<AdminProposal> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockedMove(tx, id, 'adopted');
      const market = body.market ?? null;
      const { marketId, marketCreated } =
        market === null
          ? { marketId: null, marketCreated: false }
          : await this.marketFor(tx, adminId, current, market);
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
   * `POST /admin/proposals/:id/market` (owner decision 2026-10-19): a market for a 채택 that has
   * none — a draft made from the proposal or an existing market, exactly as at the 채택
   * (`marketFor`: the same defaults and refusals, naming the fields under `market`). Once: under
   * the row lock, a proposal that is not 채택 is refused naming `status`, and one that has a market
   * — from the 채택 or from a link that committed first — naming `market` ('already linked'), so of
   * two operators linking at once one wins and the other is told. The status stays 채택, the memo
   * as the 채택 left it; who linked and when are kept (`market_linked_*`) and recorded
   * (`proposal_link`). The proposer sees the market's link once it is public, as after a 채택.
   */
  async linkMarket(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<LinkProposalMarketBody>,
  ): Promise<AdminProposal> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockedRow(tx, id);
      if (!canLinkProposalMarket(current.status, current.marketId !== null)) {
        if (current.status !== 'adopted') {
          throw fieldError(
            ['status'],
            `Proposal is ${current.status}`,
            `proposal is ${current.status}`,
          );
        }
        throw fieldError(['market'], 'The proposal has a market already', 'already linked');
      }
      const { marketId, marketCreated } = await this.marketFor(tx, adminId, current, body.market);
      // After a draft, whose own rows read the clock first: the link sorts after them.
      const now = await clockTimestamp(tx);
      await tx
        .update(marketProposals)
        .set({ marketId, marketLinkedAt: now, marketLinkedBy: adminId })
        .where(eq(marketProposals.id, id));
      await this.audit(tx, adminId, 'proposal_link', id, now, { marketId, marketCreated });
      return this.read(tx, id);
    });
  }

  /**
   * `POST /admin/proposals/:id/reject`: 접수 or 검토 → 반려, with the reason, the explanation the
   * proposer reads and, for a 중복, the existing market (any status; the proposer sees its link
   * only while it is public). An unknown market is NOT_FOUND naming `duplicateMarketId`.
   */
  async reject(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<RejectProposalBody>,
  ): Promise<AdminProposal> {
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

  /**
   * The market a 채택 or a later link leads to: an existing market in any status (an unknown id is
   * NOT_FOUND naming `market.marketId`), or a draft made here from the proposal — titled with the
   * question, the background as its 배경 (`description`), the YES condition as its YES condition,
   * and the sources as its primary source's name (#23, ADR-0097; ADR-0089 decision 4: 판정 출처는
   * 예상 출처) whose address the operator fills in, so the open-items check names the primary
   * source until then; its other rule items start blank, and the proposal's date — the day the
   * result is to be known — is its close time's, never its event deadline — in the category given,
   * else the proposal's where a market may sit (`requireDraftCategory`), closing at the time given,
   * else `proposalDraftCloseAt`. A draft that cannot be made — no category, one a new market may
   * not be filed under, a close time not in the future — is VALIDATION_ERROR naming the field under
   * `market`, and nothing is written.
   */
  private async marketFor(
    tx: Tx,
    adminId: string,
    current: ProposalRecord,
    market: ProposalAdoptionMarket,
  ): Promise<{ marketId: string; marketCreated: boolean }> {
    if (market.type === 'existing') {
      await this.requireMarket(tx, market.marketId, ['market', 'marketId']);
      return { marketId: market.marketId, marketCreated: false };
    }
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
    // Checked here so the refusal names the adoption's own fields; the market service checks the
    // same again (its paths are the market body's).
    const clock = await clockTimestamp(tx);
    if (closeAt.getTime() <= clock.getTime()) {
      throw fieldError(
        ['market', 'closeAt'],
        'The draft would close in the past: give a close time',
        'must be in the future',
      );
    }
    await this.requireDraftCategory(tx, categoryId, market.categoryId === undefined);
    const draft = await this.markets.createIn(tx, adminId, {
      title: current.question,
      description: current.background,
      yesCondition: current.yesCondition,
      // Never blank (the proposal's CHECK) and within MARKET_SOURCE_MAX (PROPOSAL_SOURCES_MAX), so
      // `market_sources` takes it as a name with no address.
      primarySource: { name: current.expectedSources, url: '' },
      categoryId,
      closeAt: closeAt.toISOString(),
    });
    return { marketId: draft.id, marketCreated: true };
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
   * The draft's category, refused as the market service refuses a new market's (#17, ADR-0093
   * decision 2 #172 item 1, `readCategorySelectability`) but naming the adoption's field: unknown
   * is NOT_FOUND; otherwise VALIDATION_ERROR with the reason — `inactive`, `parent_inactive` (under
   * a hidden top-level category, which hides it too) or `subcategories` (a top-level category with
   * an active sub-category, which the market form has the operator file under instead).
   *
   * The proposal's own category, standing in when the operator gave none (`wished`), is refused
   * for the last as no category (`required`), while it has an active leaf: stricter in its words on
   * purpose — the operator never chose this category; the proposer wished for it, from a form that
   * offers either level. Read under readCategorySelectability's FOR SHARE locks, so a category
   * admin write cannot make it unpickable before the draft is written.
   */
  private async requireDraftCategory(tx: Tx, categoryId: number, wished: boolean): Promise<void> {
    const selectable = await readCategorySelectability(tx, categoryId);
    if (!selectable.found) {
      throw new AppError('NOT_FOUND', {
        message: 'Category not found',
        details: [{ path: ['market', 'categoryId'], message: 'not found' }],
      });
    }
    switch (selectable.reason) {
      case null:
        return;
      case 'inactive':
        throw fieldError(['market', 'categoryId'], 'This category is disabled', 'inactive');
      case 'parent_inactive':
        throw fieldError(
          ['market', 'categoryId'],
          'This category is under a disabled category',
          'parent_inactive',
        );
      case 'subcategories':
        throw wished
          ? fieldError(
              ['market', 'categoryId'],
              'A draft needs a sub-category: the proposal names a category that has some',
              'required',
            )
          : fieldError(
              ['market', 'categoryId'],
              'This category has sub-categories: file the market under one of them',
              'subcategories',
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
