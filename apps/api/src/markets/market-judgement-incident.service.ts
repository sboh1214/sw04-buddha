import { Inject, Injectable } from '@nestjs/common';
import {
  MarketConflictError,
  currentMarketJudgement,
  hasUnconflictedMarketAdmin,
  lockAdminRoles,
  readMarketJudgementIncident,
  recordMarketJudgementIncident,
  schema,
  type Db,
  type MarketJudgementRow,
} from '@buddha/db';
import {
  MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND,
  MARKET_JUDGEMENT_INCIDENT_REFUSALS,
  judgementIncidentDecisionRefusal,
  judgementIncidentStatusRefusal,
  type AdminMarket,
  type AdminMarketJudgementIncidentQueueItem,
  type ConfirmJudgementIncidentBody,
  type CursorQuery,
  type DismissJudgementIncidentBody,
  type MarketJudgementIncidentConfirmActionPayload,
  type MarketJudgementIncidentDismissActionPayload,
  type MarketJudgementIncidentRegisterActionPayload,
  type MarketJudgementIncidentRequestPayload,
  type MarketJudgementIncidentRetractActionPayload,
  type MarketStatus,
  type RegisterJudgementIncidentBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { and, eq } from 'drizzle-orm';
import { ApprovalService, approvalNotAllowed } from '../approvals/approval.service.js';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';
import { MarketAdminService, decisionInstant } from './market-admin.service.js';
import { assertMarketDecisionEligibility, assertNoMarketConflict } from './market-conflicts.js';
import { fieldError, lockedMarketRow, type Tx } from './market-item-rules.js';
import {
  hasPendingJudgementIncident,
  incidentPayloadOf,
  judgementIncidentRequestOf,
  listMarketJudgementIncidents,
  type JudgementIncidentRequest,
} from './market-judgement-incident.js';
import { lockMarket } from './market-lock.js';
import { readMarketSources } from './market-sources.js';
import { marketTagNames, type MarketRow } from './market.service.js';

type Refusals = typeof MARKET_JUDGEMENT_INCIDENT_REFUSALS;
type RefusalPath = keyof Refusals;

/**
 * The top-level message of each refusal MARKET_JUDGEMENT_INCIDENT_REFUSALS keys by its path and
 * case (the duplicate link is the body's, which the pipe answers).
 */
const REFUSAL_MESSAGES: {
  readonly [P in RefusalPath]: Readonly<Record<keyof Refusals[P], string>>;
} = {
  status: {
    notResultConfirmed:
      'A judgement incident is registered and dismissed once the market’s result is confirmed',
    notSettled: 'A judgement incident is confirmed once the market is settled',
  },
  judgement: { legacy: 'The market has no judgement version to correct' },
  correctedResult: { sameResult: 'The corrected result is the paid result' },
  evidence: {
    duplicateLink: 'An evidence link is given twice',
    collectedAfterNow: 'The evidence cannot have been collected after its registration',
  },
  incident: {
    confirmed: 'A judgement incident of the market is confirmed already',
    pending: 'Another judgement incident of the market is waiting for its review',
  },
  decider: {
    registrant: 'The registrant of the paid judgement does not review its incidents',
  },
  requestId: { unknown: 'Not a judgement incident registration of this market' },
};

/**
 * VALIDATION_ERROR naming `path` — or `field` inside it (`evidence.collectedAt` 'after now') —
 * with its MARKET_JUDGEMENT_INCIDENT_REFUSALS message for `refusal`.
 */
function refused<P extends RefusalPath>(
  path: P,
  refusal: keyof Refusals[P],
  field?: string,
): AppError {
  const detail = MARKET_JUDGEMENT_INCIDENT_REFUSALS[path][refusal] as string;
  const message = REFUSAL_MESSAGES[path][refusal];
  if (field === undefined) return fieldError(path, message, detail);
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [{ path: [path, field], message: detail }],
  });
}

/** `status` as `judgementIncidentStatusRefusal` answers it for `action`, or null. */
function statusRefused(
  status: MarketStatus,
  action: 'register' | 'confirm' | 'dismiss',
): AppError | null {
  const refusal = judgementIncidentStatusRefusal(status, action);
  if (refusal === null) return null;
  return refused(
    'status',
    refusal === MARKET_JUDGEMENT_INCIDENT_REFUSALS.status.notSettled
      ? 'notSettled'
      : 'notResultConfirmed',
  );
}

/** FORBIDDEN `market_conflict`, as `assertNoMarketConflict` answers it. */
function conflictRefused(): AppError {
  return new AppError('FORBIDDEN', {
    message: 'An interested administrator cannot decide this market',
    details: [{ path: ['conflict'], message: 'market_conflict' }],
  });
}

/** What a decision's paths read: the locked market, the waiting request and the paid version. */
interface Decision {
  current: MarketRow;
  request: JudgementIncidentRequest;
  registration: MarketJudgementIncidentRequestPayload;
  paid: MarketJudgementRow;
}

/**
 * 판정 오류 사건 (#144 part 1, ADR-0165; owner answers 144-3·144-4·144-5·144-8·144-13·144-14;
 * ADR-0093 decision 1 #173 items 8·12·13·15; ADR-0120 범위·decisions 5·6; market-judgement-
 * incident.ts in @buddha/shared and @buddha/db) — one approval kind, `market_judgement_incident`:
 *
 * - 등록 (RESOLVED, SETTLING or SETTLED — 144-8, no deadline): any admin without a conflict on the
 *   market (#143) writes the correct result, 오류 내용 (the request's reason) and the evidence. It
 *   opens the request — its payload frozen: the conflict confirmation, the paid judgement version
 *   and result as the market holds them, the corrected result and the evidence (the instant as ISO
 *   milliseconds, as migration 0080 compares it) — and writes `market_judgement_incident_register`.
 *   Nothing else moves and nothing is published: a waiting incident is not public.
 * - 오류 확인 (SETTLED alone, 144-13) and 기각 (from RESOLVED on), both with a reason, by an admin
 *   who is neither the registrant (#171, ApprovalService `requester`), nor the paid version's
 *   registrant (144-4, `decider` 'registrant' — `judgementIncidentDecisionRefusal`, which the admin
 *   buttons share), nor conflicted, the registrant re-checked too (#143, ADR-0120 decision 5). A
 *   confirmation writes the permanent `market_judgement_incidents` row
 *   (`recordMarketJudgementIncident`, @buddha/db) at the decision's instant and, after COMMIT,
 *   republishes the market's unchanged `market:status` (the settled status, the paid result, the
 *   same key — ADR-0165 decision 2), so open pages refetch the 판정 정정. The market row, its
 *   judgements and settlement records never move. No notice at the confirmation (144-18).
 * - 철회: the registrant, in any status, before a decision; a self-declared conflict retracts the
 *   declarer's own waiting incident (`retractOwnPendingForConflict`, ADR-0120 decision 6).
 *
 * Every write is one transaction with its `admin_actions` row, under MarketAdminService's lock
 * order: the market lock (`lockMarket`), the market row FOR UPDATE, then the shared admin-roles
 * lock and the request row (ApprovalService); every instant recorded is the database clock's after
 * every lock — ApprovalService's for the request, the decision and the retraction, which the
 * incident row and the admin action take as they are (migration 0080 requires `confirmed_at` =
 * `decided_at`). The service refuses everything migration 0080's triggers would refuse first, so
 * none surfaces as INTERNAL.
 */
@Injectable()
export class MarketJudgementIncidentService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly markets: MarketAdminService,
    private readonly approvals: ApprovalService,
  ) {}

  /**
   * 등록 (144-3, 144-8): the body's own rules first (`registerJudgementIncidentBodySchema`). Then
   * the registrant's eligibility (#143: FORBIDDEN `market_conflict`, VALIDATION
   * `noConflictConfirmed`) and, in this order: `status` 'not result confirmed', `judgement`
   * 'legacy' (no judgement version, D4), `correctedResult` 'same result', `evidence.collectedAt`
   * 'after now' (the database clock's, read after every lock), `incident` 'confirmed' (144-14) and
   * 'pending', then APPROVAL_NOT_ALLOWED `no_decider` — no admin but the registrant and the paid
   * version's registrant without a conflict could decide it.
   */
  async register(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<RegisterJudgementIncidentBody>,
  ): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      // The class's lock order: the admin roles after the market's rows.
      await assertMarketDecisionEligibility(tx, id, adminId, body.noConflictConfirmed);
      const now = await clockTimestamp(tx);
      const status = statusRefused(current.status, 'register');
      if (status !== null) throw status;
      // The paid version (`market_judgements` at `markets.judgement_version`): a market judged by
      // the interim route before #152 has none (D4), nor one a factory left without its row.
      const paid = await currentMarketJudgement(tx, id);
      if (current.judgementVersion === null || current.resolvedResult === null || paid === null) {
        throw refused('judgement', 'legacy');
      }
      if (body.correctedResult === current.resolvedResult) {
        throw refused('correctedResult', 'sameResult');
      }
      // No lower bound (144-8 "결과 확정 뒤 언제든": the evidence may predate the close).
      const collectedAt = new Date(body.evidence.collectedAt);
      if (collectedAt.getTime() > now.getTime()) {
        throw refused('evidence', 'collectedAfterNow', 'collectedAt');
      }
      if ((await readMarketJudgementIncident(tx, id)) !== null) {
        throw refused('incident', 'confirmed');
      }
      if (await hasPendingJudgementIncident(tx, id)) throw refused('incident', 'pending');
      if (!(await hasUnconflictedMarketAdmin(tx, id, [adminId, paid.registeredBy]))) {
        throw approvalNotAllowed('no_decider');
      }
      const payload: MarketJudgementIncidentRequestPayload = {
        noConflictConfirmed: true,
        judgementVersion: current.judgementVersion,
        originalResult: current.resolvedResult,
        correctedResult: body.correctedResult,
        // Milliseconds, as migration 0080 compares the instant (timestamptz(3)).
        evidence: { links: body.evidence.links, collectedAt: collectedAt.toISOString() },
      };
      const request = await this.approvals.request(
        {
          kind: MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND,
          targetType: 'market',
          targetId: id,
          payload: { ...payload },
          requestedBy: adminId,
          reason: body.description,
        },
        tx,
      );
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_judgement_incident_register',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          judgementVersion: payload.judgementVersion,
          originalResult: payload.originalResult,
          correctedResult: payload.correctedResult,
          description: request.requestReason,
          evidence: payload.evidence,
        } satisfies MarketJudgementIncidentRegisterActionPayload,
        createdAt: request.requestedAt,
      });
      return this.answer(tx, current);
    });
  }

  /**
   * 오류 확인 (144-3, 144-13): refused, in this order, `requestId` 'unknown', APPROVAL_NOT_ALLOWED
   * `retracted`, `decided` or `requester`, `decider` 'registrant' (144-4), the decider's
   * eligibility and the registrant's conflict (#143), `status` (SETTLED alone) and `incident`
   * 'confirmed' (144-14). Then the decision at its instant, the incident row at that instant and
   * `market_judgement_incident_confirm`; after COMMIT the unchanged `market:status`.
   */
  async confirm(
    adminId: string,
    id: string,
    requestId: string,
    body: WithoutExpectedAccount<ConfirmJudgementIncidentBody>,
  ): Promise<AdminMarket> {
    const market = await this.db.transaction(async (tx) => {
      const { current, request, registration, paid } = await this.reviewable(
        tx,
        adminId,
        id,
        requestId,
        body.noConflictConfirmed,
      );
      const status = statusRefused(current.status, 'confirm');
      if (status !== null) throw status;
      if ((await readMarketJudgementIncident(tx, id)) !== null) {
        throw refused('incident', 'confirmed');
      }
      const decided = await this.approvals.approve(adminId, request.id, body.reason, tx);
      const at = decisionInstant(decided);
      let incident;
      try {
        incident = await recordMarketJudgementIncident(tx, {
          marketId: id,
          request: decided,
          paidRegisteredBy: paid.registeredBy,
        });
      } catch (error) {
        // Both were asked above under the same locks; kept as the judgement's approval maps it.
        if (error instanceof MarketConflictError) throw conflictRefused();
        throw error;
      }
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_judgement_incident_confirm',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          incidentId: incident.id,
          correctedResult: registration.correctedResult,
          reason: decided.decisionReason ?? body.reason,
        } satisfies MarketJudgementIncidentConfirmActionPayload,
        createdAt: at,
      });
      return this.answer(tx, current);
    });
    // Outside the transaction, as every market write publishes: the same key and the paid result
    // (ADR-0165 decision 2 — a corrected one would rewrite cards and holdings), so a subscriber
    // drops it as not newer and refetches the detail, the judging record and the theme results.
    await this.markets.publishStatus(market);
    return market;
  }

  /**
   * 기각 (144-3 "기각도 그 검토자가 사유와 함께 한다"): a review decision as a confirmation is (144-4
   * names both), so the same refusals up to the conflict checks, then `status` — from RESOLVED on,
   * so one waiting while the payout runs ends too. Writes `market_judgement_incident_dismiss` at
   * the decision's instant; nothing public moves, nothing is published, and another may be
   * registered.
   */
  async dismiss(
    adminId: string,
    id: string,
    requestId: string,
    body: WithoutExpectedAccount<DismissJudgementIncidentBody>,
  ): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      const { current, request, registration } = await this.reviewable(
        tx,
        adminId,
        id,
        requestId,
        body.noConflictConfirmed,
      );
      const status = statusRefused(current.status, 'dismiss');
      if (status !== null) throw status;
      const decided = await this.approvals.reject(adminId, request.id, body.reason, tx);
      const at = decisionInstant(decided);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_judgement_incident_dismiss',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          correctedResult: registration.correctedResult,
          reason: decided.decisionReason ?? body.reason,
        } satisfies MarketJudgementIncidentDismissActionPayload,
        createdAt: at,
      });
      return this.answer(tx, current);
    });
  }

  /**
   * 철회: the registrant ends the waiting registration `requestId` before anyone decides it, in any
   * status. Refused: `requestId` 'unknown', then ApprovalService's APPROVAL_NOT_ALLOWED
   * `not_requester`, `retracted` or `decided`. Writes `market_judgement_incident_retract` at the
   * retraction's instant; nothing else moves.
   */
  async retract(adminId: string, id: string, requestId: string): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.requestOf(tx, id, requestId);
      await this.retractRequest(tx, adminId, id, request);
      return this.answer(tx, current);
    });
  }

  /**
   * A self-declared conflict (#143, ADR-0120 decision 6) retracts the declarer's own waiting
   * incident of the market in the declaration's transaction — under its market lock and admin
   * roles — each `market_judgement_incident_retract` naming the declaration. Answers the requests
   * it retracted; the caller answers the market.
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
          eq(schema.approvalRequests.kind, MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND),
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

  /** `GET /admin/market-judgement-incidents` (판정 오류 사건 검토 대기): the oldest first. */
  list(query: CursorQuery): Promise<Page<AdminMarketJudgementIncidentQueueItem>> {
    return listMarketJudgementIncidents(this.db, query);
  }

  /** The retraction (ApprovalService) and its admin action, at the retraction's instant. */
  private async retractRequest(
    tx: Tx,
    adminId: string,
    marketId: string,
    request: JudgementIncidentRequest,
    conflictDeclarationId?: string,
  ): Promise<void> {
    const registration = incidentPayloadOf(request);
    const retracted = await this.approvals.retract(adminId, request.id, tx);
    const at = retracted.retractedAt;
    if (at === null) {
      throw new AppError('INTERNAL', { message: 'Approval retraction has no instant' });
    }
    await tx.insert(schema.adminActions).values({
      adminId,
      type: 'market_judgement_incident_retract',
      targetType: 'market',
      targetId: marketId,
      payload: {
        ...(conflictDeclarationId === undefined ? {} : { conflictDeclarationId }),
        approvalId: request.id,
        correctedResult: registration.correctedResult,
      } satisfies MarketJudgementIncidentRetractActionPayload,
      createdAt: at,
    });
  }

  /**
   * What a review decision (오류 확인 or 기각) asks before its own checks, in the class's lock
   * order: the market lock and row, the request (`requestId` 'unknown'), the shared admin-roles
   * lock and APPROVAL_NOT_ALLOWED `retracted`, `decided`, `requester`; then `decider` 'registrant'
   * (144-4 — the paid version's registrant, `market_judgements.registered_by` at the market's
   * version), the decider's eligibility (#143) and the registrant's conflict (ADR-0120 decision 5).
   */
  private async reviewable(
    tx: Tx,
    adminId: string,
    id: string,
    requestId: string,
    noConflictConfirmed: boolean,
  ): Promise<Decision> {
    await lockMarket(tx, id);
    const current = await lockedMarketRow(tx, id);
    const request = await this.requestOf(tx, id, requestId);
    await lockAdminRoles(tx, 'shared');
    if (request.status === 'retracted') throw approvalNotAllowed('retracted');
    if (request.status !== 'pending') throw approvalNotAllowed('decided');
    if (request.requestedBy === adminId) throw approvalNotAllowed('requester');
    const registration = incidentPayloadOf(request);
    const paid = await currentMarketJudgement(tx, id);
    if (paid === null) {
      // A registration needs the paid version (`legacy`), and nothing moves it after RESOLVED.
      throw new AppError('INTERNAL', { message: `Market ${id} has no current judgement` });
    }
    if (judgementIncidentDecisionRefusal(adminId, paid.registeredBy) !== null) {
      throw refused('decider', 'registrant');
    }
    await assertMarketDecisionEligibility(tx, id, adminId, noConflictConfirmed);
    await assertNoMarketConflict(tx, id, request.requestedBy);
    return { current, request, registration, paid };
  }

  /**
   * The market's registration `requestId`, or VALIDATION_ERROR naming `requestId` 'unknown' —
   * another market's, another kind's or none.
   */
  private async requestOf(
    tx: Tx,
    marketId: string,
    requestId: string,
  ): Promise<JudgementIncidentRequest> {
    const request = await judgementIncidentRequestOf(tx, marketId, requestId);
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
