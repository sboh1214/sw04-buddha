import { Inject, Injectable } from '@nestjs/common';
import {
  adminActionEventKey,
  createNotifications,
  hasUnconflictedMarketAdmin,
  judgementCompensationNotificationInputs,
  judgementCompensationTargets,
  ledgerHeldMarketIds,
  lockAdminRoles,
  notifiedUserIds,
  payJudgementCompensation,
  prepareJudgementCompensationPayout,
  readJudgementCompensationRequests,
  readMarketJudgementIncident,
  schema,
  type Db,
  type MarketJudgementIncidentRow,
} from '@buddha/db';
import {
  MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND,
  MARKET_JUDGEMENT_COMPENSATION_REFUSALS,
  judgementCompensationRequestPayload,
  judgementIncidentDecisionRefusal,
  notificationEvent,
  type AdminJudgementCompensationRecipient,
  type AdminMarket,
  type ApproveJudgementCompensationBody,
  type CursorQuery,
  type MarketJudgementCompensationApproveActionPayload,
  type MarketJudgementCompensationRejectActionPayload,
  type MarketJudgementCompensationRequestActionPayload,
  type MarketJudgementCompensationRetractActionPayload,
  type RejectJudgementCompensationBody,
  type RequestJudgementCompensationBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { and, eq } from 'drizzle-orm';
import { ApprovalService, approvalNotAllowed } from '../approvals/approval.service.js';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { balanceEvent, type Page } from '../wallet/wallet.service.js';
import { MarketAdminService, decisionInstant } from './market-admin.service.js';
import { assertMarketDecisionEligibility, assertNoMarketConflict } from './market-conflicts.js';
import { fieldError, lockedMarketRow, type Tx } from './market-item-rules.js';
import {
  compensationPayloadOf,
  judgementCompensationRequestOf,
  listJudgementCompensationRecipients,
  type JudgementCompensationRequest,
} from './market-judgement-compensation.js';
import { lockMarket } from './market-lock.js';
import { readMarketSources } from './market-sources.js';
import { marketTagNames, type MarketRow } from './market.service.js';

type Refusals = typeof MARKET_JUDGEMENT_COMPENSATION_REFUSALS;
type RefusalPath = keyof Refusals;

/** The top-level message of each refusal MARKET_JUDGEMENT_COMPENSATION_REFUSALS keys. */
const REFUSAL_MESSAGES: {
  readonly [P in RefusalPath]: Readonly<Record<keyof Refusals[P], string>>;
} = {
  incident: { missing: 'The market has no confirmed judgement incident to compensate' },
  market: { held: 'The market is held by the ledger reconciliation' },
  compensation: {
    pending: 'A compensation request of the incident is waiting for its approval',
    paid: 'The incident’s compensation was approved and paid already',
  },
  recipients: {
    none: 'The correction owes no account anything',
    stale: 'The accounts owed differ from the request’s list',
    blocked: 'A listed account’s balance record left its ledger',
  },
  decider: {
    registrant: 'The registrant of the paid judgement does not approve its compensation',
  },
  requestId: { unknown: 'Not a judgement compensation request of this market' },
};

/**
 * VALIDATION_ERROR naming `path` with its MARKET_JUDGEMENT_COMPENSATION_REFUSALS message for
 * `refusal`; `message` replaces the top-level one (the blocked count, 144-16).
 */
function refused<P extends RefusalPath>(
  path: P,
  refusal: keyof Refusals[P],
  message?: string,
): AppError {
  const detail = MARKET_JUDGEMENT_COMPENSATION_REFUSALS[path][refusal] as string;
  return fieldError(path, message ?? REFUSAL_MESSAGES[path][refusal], detail);
}

/** What the approval's transaction leaves for after COMMIT. */
interface Approved {
  market: AdminMarket;
  balances: { userId: string; event: ReturnType<typeof balanceEvent> }[];
  notified: string[];
  at: Date;
}

/**
 * 판정 오류 보상 (#144 part 2, ADR-0166; owner answers 144-1·144-2·144-4·144-6·144-7·144-10·144-12
 * and 144-15·144-16·144-18; ADR-0107 decision 2 #73 items 1·3·7·8·9; ADR-0120 decisions 5·6;
 * judgement-compensation.ts in @buddha/shared and @buddha/db) — one approval kind,
 * `market_judgement_compensation`:
 *
 * - 요청: once a market's 판정 오류 사건 is confirmed (SETTLED alone, 144-13), any admin without a
 *   conflict on it (#143, ADR-0166 T19 — the paid version's registrant included, 144-4) asks with
 *   an internal reason and the members' reason (144-12). The server computes the list
 *   (`judgementCompensationTargets`, 144-1) and freezes it in the request with its count and total
 *   (#171), writing `market_judgement_compensation_request` with counts and totals only (never an
 *   account, ADR-0064).
 * - 승인: an admin who is neither the requester (#171), nor the paid version's registrant (144-4,
 *   `decider` 'registrant'), nor conflicted — the requester re-checked too (#143) — approves it and
 *   the same transaction pays every listed account once (`payJudgementCompensation`, 144-2): every
 *   lock (the recipients' profiles, their balance rows) is taken and every check made
 *   (`prepareJudgementCompensationPayout`: the #93 hold, the frozen list against the live one,
 *   144-16's ledger check) BEFORE the decision, whose instant every entry, row, admin action and
 *   notice takes (ADR-0166 T20). The notices (52-20, 144-18) are the transaction's last write
 *   (ADR-0157 decision 4); after COMMIT each payee's `user:balance` and `user:notification`.
 * - 반려: any admin but the requester, with a reason — a 정리 목적 반려 (ADR-0120 decision 5): no
 *   registrant, eligibility or conflict check; another request may follow.
 * - 철회: the requester's, before a decision; a self-declared conflict retracts the declarer's own
 *   waiting request (`retractOwnPendingForConflict`, ADR-0120 decision 6, T19).
 *
 * Every write is one transaction with its `admin_actions` row, under MarketAdminService's lock
 * order (the market lock, the market row FOR UPDATE, then the shared admin-roles lock and the
 * request row) and, after COMMIT, republishes the market's unchanged `market:status` (the settled
 * status, the paid result, the same key — ADR-0165 decision 2) so open pages refetch the public
 * 판정 정정, whose compensation status each write moves (144-15). Nothing here touches the market
 * row, its judgements, its settlement records, the positions or the collateral, and nothing takes
 * Coin from anyone (N03 §7). The service refuses everything migration 0081's triggers would refuse
 * first, so none surfaces as INTERNAL.
 */
@Injectable()
export class MarketJudgementCompensationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly markets: MarketAdminService,
    private readonly approvals: ApprovalService,
    private readonly publisher: MarketPublisher,
  ) {}

  /**
   * 보상 요청 (144-1, 144-2, 144-12): the requester's eligibility (#143: FORBIDDEN
   * `market_conflict`, VALIDATION `noConflictConfirmed`), then in this order `incident` 'not
   * confirmed', `market` 'held', `compensation` 'pending' and 'paid', `recipients` 'none' and
   * APPROVAL_NOT_ALLOWED `no_decider` — no admin but the requester and the paid version's
   * registrant without a conflict could approve it.
   */
  async request(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<RequestJudgementCompensationBody>,
  ): Promise<AdminMarket> {
    const market = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      // The class's lock order: the admin roles after the market's rows.
      await assertMarketDecisionEligibility(tx, id, adminId, body.noConflictConfirmed);
      const incident = await readMarketJudgementIncident(tx, id);
      if (incident === null) throw refused('incident', 'missing');
      if ((await ledgerHeldMarketIds(tx, [id])).has(id)) throw refused('market', 'held');
      const requests = await readJudgementCompensationRequests(tx, id);
      if (requests.some((request) => request.status === 'pending')) {
        throw refused('compensation', 'pending');
      }
      if (requests.some((request) => request.status === 'approved')) {
        throw refused('compensation', 'paid');
      }
      const targets = await judgementCompensationTargets(tx, id, incident.correctedResult);
      if (targets.length === 0) throw refused('recipients', 'none');
      if (!(await hasUnconflictedMarketAdmin(tx, id, [adminId, incident.paidRegisteredBy]))) {
        throw approvalNotAllowed('no_decider');
      }
      const payload = judgementCompensationRequestPayload({
        incidentId: incident.id,
        correctedResult: incident.correctedResult,
        owed: targets.map(({ userId, amountCoin }) => ({ userId, amountCoin })),
        userReason: body.userReason,
      });
      const request = await this.approvals.request(
        {
          kind: MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND,
          targetType: 'market',
          targetId: id,
          payload: { ...payload },
          requestedBy: adminId,
          reason: body.reason,
        },
        tx,
      );
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_judgement_compensation_request',
        targetType: 'market',
        targetId: id,
        // Counts and totals only: the list stays in the request (ADR-0064, ADR-0159 12-12).
        payload: {
          approvalId: request.id,
          incidentId: incident.id,
          reason: request.requestReason,
          accountCount: payload.accountCount,
          totalCoin: payload.totalCoin,
          closedCount: targets.filter((target) => target.closed).length,
          userReason: payload.userReason,
        } satisfies MarketJudgementCompensationRequestActionPayload,
        createdAt: request.requestedAt,
      });
      return this.answer(tx, current);
    });
    await this.markets.publishStatus(market);
    return market;
  }

  /**
   * 보상 승인 and its payout (144-2, 144-4, 144-7, 144-16): refused, in this order, `requestId`
   * 'unknown', APPROVAL_NOT_ALLOWED `retracted`, `decided` or `requester`, `decider` 'registrant',
   * the approver's eligibility and the requester's conflict (#143), `market` 'held', `recipients`
   * 'stale' and `recipients` 'blocked' (the whole approval, with the count in the message —
   * never which account). Then the decision, the payout at its instant, the admin action and, last,
   * the payees' notices; after COMMIT their balances, their notices and the market's status.
   */
  async approve(
    adminId: string,
    id: string,
    requestId: string,
    body: WithoutExpectedAccount<ApproveJudgementCompensationBody>,
  ): Promise<AdminMarket> {
    const done = await this.db.transaction(async (tx): Promise<Approved> => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.requestOf(tx, id, requestId, true);
      await this.decidable(tx, adminId, request);
      const incident = await this.incidentOf(tx, id);
      if (judgementIncidentDecisionRefusal(adminId, incident.paidRegisteredBy) !== null) {
        throw refused('decider', 'registrant');
      }
      await assertMarketDecisionEligibility(tx, id, adminId, body.noConflictConfirmed);
      await assertNoMarketConflict(tx, id, request.requestedBy);
      const payload = compensationPayloadOf(request);
      const check = await prepareJudgementCompensationPayout(tx, {
        marketId: id,
        incident,
        payload,
      });
      if (check.outcome === 'refused') {
        if (check.reason === 'blocked') {
          throw refused(
            'recipients',
            'blocked',
            `${check.blockedCount} listed account(s) need a ledger check before the payout`,
          );
        }
        throw check.reason === 'held' ? refused('market', 'held') : refused('recipients', 'stale');
      }
      const decided = await this.approvals.approve(adminId, request.id, body.reason, tx);
      const at = decisionInstant(decided);
      const result = await payJudgementCompensation(tx, {
        marketId: id,
        marketTitle: current.title,
        incident,
        request: decided,
        recipients: check.recipients,
      });
      const [action] = await tx
        .insert(schema.adminActions)
        .values({
          adminId,
          type: 'market_judgement_compensation_approve',
          targetType: 'market',
          targetId: id,
          payload: {
            approvalId: request.id,
            incidentId: incident.id,
            reason: decided.decisionReason ?? body.reason,
            paidCount: result.paid.length,
            paidCoin: result.paidCoin.toString(),
            closedCount: result.closed.length,
          } satisfies MarketJudgementCompensationApproveActionPayload,
          createdAt: result.at,
        })
        // 52-20: the payout's notices are keyed by this row (`admin_action:<id>`, ADR-0160).
        .returning({ id: schema.adminActions.id });
      if (!action)
        throw new AppError('INTERNAL', { message: 'Compensation approval insert failed' });
      const market = await this.answer(tx, current);
      // ADR-0157 decision 4: the transaction's one notification call, last — the payees alone
      // (52-20, 144-18: none to a closed account, an over-paid holder or a watcher).
      const notices = judgementCompensationNotificationInputs(result.paid, current, {
        originalResult: incident.originalResult,
        correctedResult: incident.correctedResult,
        eventKey: adminActionEventKey(action.id),
        occurredAt: result.at,
      });
      return {
        market,
        balances: result.paid.map((paid) => ({
          userId: paid.userId,
          event: balanceEvent(paid.balance, paid.entry),
        })),
        notified: notifiedUserIds(await createNotifications(tx, notices)),
        at,
      };
    });
    // Outside the transaction, as the settlement's payout publishes: a refetch must find the
    // committed rows.
    await Promise.all([
      this.markets.publishStatus(done.market),
      ...done.balances.map(({ userId, event }) => this.publisher.publishUser(userId, event)),
      ...done.notified.map((userId) =>
        this.publisher.publishUser(userId, notificationEvent(done.at)),
      ),
    ]);
    return done.market;
  }

  /**
   * 보상 반려 (a 정리 목적 반려, ADR-0120 decision 5): refused `requestId` 'unknown', then
   * APPROVAL_NOT_ALLOWED `retracted`, `decided` or `requester` alone. Writes
   * `market_judgement_compensation_reject` at the decision's instant; nothing is paid, and another
   * request may follow.
   */
  async reject(
    adminId: string,
    id: string,
    requestId: string,
    body: WithoutExpectedAccount<RejectJudgementCompensationBody>,
  ): Promise<AdminMarket> {
    const market = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.requestOf(tx, id, requestId);
      await this.decidable(tx, adminId, request);
      const payload = compensationPayloadOf(request);
      const decided = await this.approvals.reject(adminId, request.id, body.reason, tx);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_judgement_compensation_reject',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          incidentId: payload.incidentId,
          reason: decided.decisionReason ?? body.reason,
        } satisfies MarketJudgementCompensationRejectActionPayload,
        createdAt: decisionInstant(decided),
      });
      return this.answer(tx, current);
    });
    await this.markets.publishStatus(market);
    return market;
  }

  /**
   * 철회: the requester ends the waiting request `requestId` before anyone decides it. Refused:
   * `requestId` 'unknown', then ApprovalService's APPROVAL_NOT_ALLOWED `not_requester`, `retracted`
   * or `decided`. Writes `market_judgement_compensation_retract` at the retraction's instant.
   */
  async retract(adminId: string, id: string, requestId: string): Promise<AdminMarket> {
    const market = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.requestOf(tx, id, requestId);
      await this.retractRequest(tx, adminId, id, request);
      return this.answer(tx, current);
    });
    await this.markets.publishStatus(market);
    return market;
  }

  /**
   * A self-declared conflict (#143, ADR-0120 decision 6; ADR-0166 T19) retracts the declarer's
   * own waiting compensation request of the market in the declaration's transaction — under its
   * market lock and admin roles — each `market_judgement_compensation_retract` naming the
   * declaration. Answers the requests it retracted; the caller answers the market and, when the
   * list is non-empty, repeats the same-key `market:status` after COMMIT so open pages follow the
   * public status it moves back to 'preparing' (decision 6 — see MarketConflictsService.declare).
   */
  async retractOwnPendingForConflict(
    tx: Tx,
    adminId: string,
    marketId: string,
    declarationId: string,
  ): Promise<string[]> {
    const pending = await tx
      .select({
        id: schema.approvalRequests.id,
        requestedBy: schema.approvalRequests.requestedBy,
        requestReason: schema.approvalRequests.requestReason,
        requestedAt: schema.approvalRequests.requestedAt,
        status: schema.approvalRequests.status,
        payload: schema.approvalRequests.payload,
      })
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.kind, MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND),
          eq(schema.approvalRequests.targetType, 'market'),
          eq(schema.approvalRequests.targetId, marketId),
          eq(schema.approvalRequests.requestedBy, adminId),
          eq(schema.approvalRequests.status, 'pending'),
        ),
      );
    for (const request of pending) {
      await this.retractRequest(tx, adminId, marketId, request, declarationId);
    }
    return pending.map((request) => request.id);
  }

  /** The recipients list (admins only): see `listJudgementCompensationRecipients`. */
  recipients(
    marketId: string,
    query: CursorQuery,
  ): Promise<Page<AdminJudgementCompensationRecipient>> {
    return listJudgementCompensationRecipients(this.db, marketId, query);
  }

  /** The retraction (ApprovalService) and its admin action, at the retraction's instant. */
  private async retractRequest(
    tx: Tx,
    adminId: string,
    marketId: string,
    request: JudgementCompensationRequest,
    conflictDeclarationId?: string,
  ): Promise<void> {
    const payload = compensationPayloadOf(request);
    const retracted = await this.approvals.retract(adminId, request.id, tx);
    const at = retracted.retractedAt;
    if (at === null) {
      throw new AppError('INTERNAL', { message: 'Approval retraction has no instant' });
    }
    await tx.insert(schema.adminActions).values({
      adminId,
      type: 'market_judgement_compensation_retract',
      targetType: 'market',
      targetId: marketId,
      payload: {
        ...(conflictDeclarationId === undefined ? {} : { conflictDeclarationId }),
        approvalId: request.id,
        incidentId: payload.incidentId,
      } satisfies MarketJudgementCompensationRetractActionPayload,
      createdAt: at,
    });
  }

  /**
   * The approval engine's own refusals, asked first under the shared admin-roles lock (the
   * class's lock order, after the market's rows and the request): `retracted`, `decided`, then
   * `requester` (#171). ApprovalService asks them again when it decides.
   */
  private async decidable(
    tx: Tx,
    adminId: string,
    request: JudgementCompensationRequest,
  ): Promise<void> {
    await lockAdminRoles(tx, 'shared');
    if (request.status === 'retracted') throw approvalNotAllowed('retracted');
    if (request.status !== 'pending') throw approvalNotAllowed('decided');
    if (request.requestedBy === adminId) throw approvalNotAllowed('requester');
  }

  /**
   * The market's confirmed incident: a compensation request is asked of one alone, and the
   * incident is permanent (migration 0080) — none is a broken invariant.
   */
  private async incidentOf(tx: Tx, id: string): Promise<MarketJudgementIncidentRow> {
    const incident = await readMarketJudgementIncident(tx, id);
    if (incident === null) {
      throw new AppError('INTERNAL', { message: `Market ${id} has no confirmed incident` });
    }
    return incident;
  }

  /**
   * The market's compensation request `requestId` (FOR UPDATE when `forUpdate`), or
   * VALIDATION_ERROR naming `requestId` 'unknown'.
   */
  private async requestOf(
    tx: Tx,
    marketId: string,
    requestId: string,
    forUpdate = false,
  ): Promise<JudgementCompensationRequest> {
    const request = await judgementCompensationRequestOf(tx, marketId, requestId, forUpdate);
    if (!request) throw refused('requestId', 'unknown');
    return request;
  }

  /** The admin detail as the write left it (the market row itself never moves here). */
  private async answer(tx: Tx, current: MarketRow): Promise<AdminMarket> {
    return this.markets.toAdminMarket(
      tx,
      current,
      await marketTagNames(tx, current.id),
      await readMarketSources(tx, current.id),
    );
  }
}
