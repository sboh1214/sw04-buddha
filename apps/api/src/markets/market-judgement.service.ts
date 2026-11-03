import { Inject, Injectable } from '@nestjs/common';
import { approveMarketJudgement, lockAdminRoles, schema, type Db } from '@buddha/db';
import {
  MARKET_JUDGEMENT_APPROVAL_KIND,
  MARKET_JUDGEMENT_REFUSALS,
  isBeforeScheduledJudgement,
  judgementVoidOnly,
  type AdminMarket,
  type AdminMarketJudgementQueueItem,
  type ApproveJudgementBody,
  type CursorQuery,
  type MarketJudgementApproveActionPayload,
  type MarketJudgementRejectActionPayload,
  type MarketJudgementRequestActionPayload,
  type MarketJudgementRequestPayload,
  type MarketJudgementRetractActionPayload,
  type RegisterJudgementBody,
  type RejectJudgementBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { ApprovalService, approvalNotAllowed } from '../approvals/approval.service.js';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { type Page } from '../wallet/wallet.service.js';
import { MarketAdminService, decisionInstant, snapshot } from './market-admin.service.js';
import { fieldError, lockedMarketRow, type Tx } from './market-item-rules.js';
import {
  hasPendingJudgement,
  judgementPayloadOf,
  judgementRequestOf,
  judgementSourceOf,
  lastMarketPause,
  listMarketJudgements,
  type JudgementRequest,
} from './market-judgement.js';
import { lockMarket } from './market-lock.js';
import { readMarketSources } from './market-sources.js';
import { marketTagNames } from './market.service.js';

type Refusals = typeof MARKET_JUDGEMENT_REFUSALS;
type RefusalPath = keyof Refusals;

/**
 * The top-level message of each refusal MARKET_JUDGEMENT_REFUSALS keys by its path and case (the
 * source's `required`, both reasons' and the duplicate link are the body's, which the pipe
 * answers).
 */
const REFUSAL_MESSAGES: {
  readonly [P in RefusalPath]: Readonly<Record<keyof Refusals[P], string>>;
} = {
  status: { notClosed: 'A judgement is registered and approved on a closed market alone' },
  judgement: { pending: 'Another judgement of the market is waiting for its approval' },
  disputeWindow: {
    undecided: 'The dispute window (market.dispute_window) is undecided: no deadline can be fixed',
  },
  source: {
    required: 'A YES or NO judgement names a source of the rules',
    unknown: 'The market’s rules have no source of that priority',
  },
  fallbackReason: {
    required: 'A fallback source is picked with the reason the primary could not be used',
    fallbackOnly: 'Only a fallback source carries a reason',
  },
  voidReason: {
    required: 'A VOID judgement carries its reason',
    voidOnly: 'Only a VOID judgement carries a VOID reason',
  },
  result: { voidOnly: 'A market closed early as not judgeable is judged VOID' },
  evidence: {
    duplicateLink: 'An evidence link is given twice',
    collectedAfterNow: 'The evidence cannot have been collected after its registration',
  },
  eventDeadlineConfirmed: {
    required:
      'An approval before the scheduled judgement confirms the NO condition’s event deadline',
  },
  requestId: { unknown: 'Not a judgement registration of this market' },
};

/** VALIDATION_ERROR naming `path` with its MARKET_JUDGEMENT_REFUSALS message for `refusal`. */
function refused<P extends RefusalPath>(path: P, refusal: keyof Refusals[P]): AppError {
  const detail = MARKET_JUDGEMENT_REFUSALS[path][refusal] as string;
  return fieldError(path, REFUSAL_MESSAGES[path][refusal], detail);
}

/**
 * `evidence.collectedAt` 'after now': the one refusal naming a field inside the body's object, as
 * the pipe names `evidence.links.<index>`.
 */
function collectedAfterNow(): AppError {
  return new AppError('VALIDATION_ERROR', {
    message: REFUSAL_MESSAGES.evidence.collectedAfterNow,
    details: [
      {
        path: ['evidence', 'collectedAt'],
        message: MARKET_JUDGEMENT_REFUSALS.evidence.collectedAfterNow,
      },
    ],
  });
}

/**
 * 판정 등록과 별도 검토자 승인 (#152, ADR-0103; ADR-0093 decision 1 #173 items 1·4·5·9·11–13,
 * decision 3 the #152 rows '역할'·'판정 출처'·'증거'·'등록 시점'; market-judgement.ts in
 * @buddha/shared and @buddha/db):
 *
 * - 판정 등록 (CLOSED, any time after the close): any admin writes the result (YES, NO or VOID),
 *   the rule's source by its priority — copied with its name and address from the market's
 *   `market_sources` row, none for a VOID alone, a fallback with its reason — a VOID's reason, the
 *   evidence (links and the collection instant) and the description of what was confirmed. It
 *   opens a `market_judgement` approval request (#171, ApprovalService) on the market — its
 *   payload the registration and the market's rule version (ADR-0101 결과 5), its reason the
 *   description — and changes nothing: no event, nothing published (#173 item 1). One waits per
 *   market at a time; refused when no admin but the registrant could decide it (`no_decider`),
 *   while `market.dispute_window` is undecided, and as YES or NO on a market closed early as 판정
 *   불가 (ADR-0102).
 * - 승인: an admin other than the registrant ('역할', ADR-0056 decision 1-1), the market still
 *   CLOSED and the setting decided, before the scheduled judgement with the event deadline
 *   confirmed ('등록 시점'). `approveMarketJudgement` (@buddha/db) at the decision's instant: the
 *   `provisional` event, the market PROVISIONAL with its result (VOID too, #173 item 9), version
 *   and dispute deadline — the instant plus the setting read in the transaction, fixed then (#173
 *   item 5) — and the append-only `market_judgements` row. After COMMIT `market:status` and the
 *   `market.resolve` job at the deadline: the worker confirms the result then (PROVISIONAL →
 *   RESOLVED, the settlement steps, `market.finalize`), never an admin — unless a 판정 이의 holds
 *   it, when the last dismissal registers the job again (#175, MarketDisputeService).
 * - 반려 (an admin other than the registrant, with a reason) and 철회 (the registrant), in any
 *   status: the record alone, the market as it was — a CLOSED one stays CLOSED and is registered
 *   again (#173 item 1), by any admin, the rejecting one included: only a judgement's registrant
 *   decides nothing of that one.
 *
 * Every write here is one transaction with its `admin_actions` row
 * (`market_judgement_request|approve|reject|retract`), under MarketAdminService's lock order: the
 * market lock (`lockMarket`), the market row FOR UPDATE, then the shared admin-roles lock and the
 * request row (ApprovalService). So a judgement write serialises with the worker's jobs and with
 * every other writer of the market — of two approvals at once the second finds the request decided
 * (APPROVAL_NOT_ALLOWED `decided`) — and the instant each records is the database clock's after
 * every lock: a request step's ApprovalService's (the registration's, the decision's, the
 * retraction's). A registrant who loses the admin role while the registration waits, as #80's and
 * #114's requesters: it stays waiting for another admin's decision, and they cannot retract it.
 */
@Injectable()
export class MarketJudgementService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly markets: MarketAdminService,
    private readonly approvals: ApprovalService,
    private readonly jobs: MarketJobs,
  ) {}

  /**
   * 판정 등록 (decision 3 the #152 rows): any admin, on a CLOSED market, registers its judgement —
   * the body's own rules first (`registerJudgementBodySchema`: the result, the source and the two
   * reasons together, 1..5 distinct links, the description). Refused, in this order: `status` 'not
   * closed', `judgement` 'pending' (one waits at a time), APPROVAL_NOT_ALLOWED `no_decider` (no
   * admin but the registrant to approve it), `disputeWindow` 'undecided', `source` 'unknown' (the
   * rules have no source of that priority), `result` 'void only' (YES or NO on a market whose last
   * pause ended in an early close reviewed 판정 불가), then `evidence.collectedAt` 'after now' (the
   * database clock's, read after every lock). Opens the `market_judgement` request — payload
   * MarketJudgementRequestPayload, the description its reason — and writes
   * `market_judgement_request`. No market event and nothing published: nothing changed yet.
   */
  async register(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<RegisterJudgementBody>,
  ): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      // The class's lock order: the admin roles after the market's rows. `no_decider` reads the
      // roles under it, and the request row is written after it.
      await lockAdminRoles(tx, 'shared');
      const now = await clockTimestamp(tx);
      if (current.status !== 'closed') throw refused('status', 'notClosed');
      if (await hasPendingJudgement(tx, id)) throw refused('judgement', 'pending');
      if (!(await this.approvals.hasDecider([adminId], tx))) {
        throw approvalNotAllowed('no_decider');
      }
      // Refused here too, not only at the approval: a registration that no approval could publish
      // would wait for nothing (ADR-0103; the safe side, as `market.lead_close_gap` blocks a
      // review's submission, ADR-0098).
      if ((await this.markets.disputeWindowSetting(tx)) === null) {
        throw refused('disputeWindow', 'undecided');
      }
      const source =
        body.source === null ? null : await judgementSourceOf(tx, id, body.source.priority);
      if (body.source !== null && source === null) throw refused('source', 'unknown');
      if (body.result !== 'VOID' && judgementVoidOnly(await lastMarketPause(tx, id))) {
        throw refused('result', 'voidOnly');
      }
      // No lower bound: an early result's evidence can predate the close (#114).
      const collectedAt = new Date(body.evidence.collectedAt);
      if (collectedAt.getTime() > now.getTime()) throw collectedAfterNow();
      const payload: MarketJudgementRequestPayload = {
        result: body.result,
        source,
        fallbackReason: body.fallbackReason ?? null,
        voidReason: body.voidReason ?? null,
        evidence: { links: body.evidence.links, collectedAt: collectedAt.toISOString() },
        // Read under the market lock; nothing moves it after the close (ADR-0101: no supplement
        // then), and the approval checks it did not.
        ruleVersion: current.ruleVersion,
      };
      const request = await this.approvals.request(
        {
          kind: MARKET_JUDGEMENT_APPROVAL_KIND,
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
        type: 'market_judgement_request',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          ...payload,
          description: request.requestReason,
        } satisfies MarketJudgementRequestActionPayload,
        createdAt: request.requestedAt,
      });
      return this.markets.toAdminMarket(
        tx,
        current,
        await marketTagNames(tx, id),
        await readMarketSources(tx, id),
      );
    });
  }

  /**
   * 승인 (#173 item 1, decision 3 '역할'): an admin other than the registrant approves the market's
   * waiting registration `requestId` with a reason. Refused: `requestId` 'unknown' (no
   * registration of this market), then APPROVAL_NOT_ALLOWED `retracted` or `decided` (no longer
   * waiting) and `requester`; then `status` 'not closed' (PROVISIONAL since another approval — a
   * registration waiting then is moot, ended by a 반려 or a 철회 alone), `disputeWindow`
   * 'undecided', and — at the decision's instant — `eventDeadlineConfirmed` 'required' (before the
   * market's scheduled judgement without the confirmation; a market with none, opened before #22,
   * needs none). A rule version moved since the registration is a broken invariant (INTERNAL).
   *
   * Then `approveMarketJudgement` at the decision's instant, the approver its actor: the
   * `provisional` event, payload `{version, result, approvalId, requestedBy, disputeDeadline}`; the
   * market PROVISIONAL with `resolved_result`, `judgement_version` and `dispute_deadline` — the
   * instant plus the window read here, fixed (#173 item 5); the `market_judgements` row.
   * `market_judgement_approve` records the request, the version, the result, the approver's
   * reason and confirmation, the window and deadline, and the market before and after. After
   * COMMIT `market:status` (provisional with its result, the event's key) and `market.resolve`
   * delayed to the deadline.
   */
  async approve(
    adminId: string,
    id: string,
    requestId: string,
    body: WithoutExpectedAccount<ApproveJudgementBody>,
  ): Promise<AdminMarket> {
    const { market, disputeDeadline, at } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.decidable(tx, adminId, id, requestId);
      const registration = judgementPayloadOf(request);
      if (current.status !== 'closed') throw refused('status', 'notClosed');
      // Read once, in the approval's transaction: the deadline it fixes is this value's (#173
      // item 5), whatever the setting says later.
      const window = await this.markets.disputeWindowSetting(tx);
      if (window === null) throw refused('disputeWindow', 'undecided');
      const decided = await this.approvals.approve(adminId, request.id, body.reason, tx);
      const at = decisionInstant(decided);
      // At the decision's instant, after every lock (the refusal rolls the decision back).
      if (
        !body.eventDeadlineConfirmed &&
        isBeforeScheduledJudgement(current.scheduledJudgementAt, at.getTime())
      ) {
        throw refused('eventDeadlineConfirmed', 'required');
      }
      if (registration.ruleVersion !== current.ruleVersion) {
        throw new AppError('INTERNAL', {
          message:
            `Market ${id} is at rule version ${String(current.ruleVersion)}, its judgement ` +
            `${request.id} followed ${String(registration.ruleVersion)}`,
        });
      }
      const result = await approveMarketJudgement(tx, {
        market: current,
        request: decided,
        now: at,
        approverId: adminId,
        eventDeadlineConfirmed: body.eventDeadlineConfirmed,
        disputeWindowMinutes: window,
      });
      // `not_closed` was refused above under the same lock.
      if (!result.published) throw refused('status', 'notClosed');
      const { judgement } = result;
      const tags = await marketTagNames(tx, id);
      const sources = await readMarketSources(tx, id);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_judgement_approve',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          version: judgement.version,
          result: judgement.result,
          reason: decided.decisionReason ?? body.reason,
          eventDeadlineConfirmed: judgement.eventDeadlineConfirmed,
          disputeWindowMinutes: judgement.disputeWindowMinutes,
          disputeDeadline: judgement.disputeDeadline.toISOString(),
          before: snapshot(current, tags, sources),
          after: snapshot(result.market, tags, sources),
        } satisfies MarketJudgementApproveActionPayload,
        createdAt: at,
      });
      return {
        market: await this.markets.toAdminMarket(tx, result.market, tags, sources),
        disputeDeadline: judgement.disputeDeadline,
        at,
      };
    });
    // Outside the transaction, as every market write publishes: a subscriber answers
    // `market:status` with a REFETCH, which must find the committed row. The job's delay is the
    // deadline less the approval's instant, on the clock that fixed both.
    await Promise.all([
      this.markets.publishStatus(market),
      this.jobs.scheduleResolve(market.id, disputeDeadline, at),
    ]);
    return market;
  }

  /**
   * 반려 (#173 item 1): an admin other than the registrant ends the market's waiting registration
   * `requestId` with a reason, in any status — so one still waiting once the market left CLOSED
   * ends too. Refused as the approval is up to its decision: `requestId` 'unknown',
   * APPROVAL_NOT_ALLOWED `retracted`, `decided` or `requester`. Writes `market_judgement_reject`;
   * the market is unchanged — a CLOSED one is registered again — and nothing is published.
   */
  async reject(
    adminId: string,
    id: string,
    requestId: string,
    body: WithoutExpectedAccount<RejectJudgementBody>,
  ): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.decidable(tx, adminId, id, requestId);
      const registration = judgementPayloadOf(request);
      const decided = await this.approvals.reject(adminId, request.id, body.reason, tx);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_judgement_reject',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          result: registration.result,
          reason: decided.decisionReason ?? body.reason,
        } satisfies MarketJudgementRejectActionPayload,
        createdAt: decisionInstant(decided),
      });
      return this.markets.toAdminMarket(
        tx,
        current,
        await marketTagNames(tx, id),
        await readMarketSources(tx, id),
      );
    });
  }

  /**
   * 철회: the registrant ends the market's waiting registration `requestId` before anyone decides
   * it, in any status. Refused: `requestId` 'unknown', then ApprovalService's APPROVAL_NOT_ALLOWED
   * `not_requester`, `retracted` or `decided`. Writes `market_judgement_retract` at the
   * retraction's instant; nothing else changes, and nothing is published.
   */
  async retract(adminId: string, id: string, requestId: string): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.requestOf(tx, id, requestId);
      const registration = judgementPayloadOf(request);
      const retracted = await this.approvals.retract(adminId, request.id, tx);
      if (retracted.retractedAt === null) {
        throw new AppError('INTERNAL', { message: 'Approval retraction has no instant' });
      }
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_judgement_retract',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          result: registration.result,
        } satisfies MarketJudgementRetractActionPayload,
        createdAt: retracted.retractedAt,
      });
      return this.markets.toAdminMarket(
        tx,
        current,
        await marketTagNames(tx, id),
        await readMarketSources(tx, id),
      );
    });
  }

  /** `GET /admin/market-judgements` (판정 승인 대기): the oldest registration first. */
  list(query: CursorQuery): Promise<Page<AdminMarketJudgementQueueItem>> {
    return listMarketJudgements(this.db, query);
  }

  /**
   * The market's registration `requestId`, or VALIDATION_ERROR naming `requestId` 'unknown' —
   * another market's, another kind's or none (as #80's and #114's requests).
   */
  private async requestOf(tx: Tx, marketId: string, requestId: string): Promise<JudgementRequest> {
    const request = await judgementRequestOf(tx, marketId, requestId);
    if (!request) throw refused('requestId', 'unknown');
    return request;
  }

  /**
   * The registration a decision names (`requestOf`), still waiting and not the deciding admin's,
   * under the shared admin-roles lock the decision takes (the class's lock order, so the clock
   * read after it follows every lock): APPROVAL_NOT_ALLOWED `retracted` or `decided` for one no
   * longer waiting, then `requester` — that judgement's registrant decides nothing of it
   * (decision 3 '역할'), as #114's decisions (MarketPauseService).
   */
  private async decidable(
    tx: Tx,
    adminId: string,
    marketId: string,
    requestId: string,
  ): Promise<JudgementRequest> {
    const request = await this.requestOf(tx, marketId, requestId);
    await lockAdminRoles(tx, 'shared');
    if (request.status === 'retracted') throw approvalNotAllowed('retracted');
    if (request.status !== 'pending') throw approvalNotAllowed('decided');
    if (request.requestedBy === adminId) throw approvalNotAllowed('requester');
    return request;
  }
}
