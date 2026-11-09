import { Inject, Injectable } from '@nestjs/common';
import {
  approveMarketJudgement,
  confirmationHold,
  correctMarketJudgement,
  currentMarketJudgement,
  hasUnconflictedMarketAdmin,
  lockAdminRoles,
  reopenAcceptedDisputes,
  schema,
  setCorrectionPending,
  type Db,
  type MarketJudgementRow,
} from '@buddha/db';
import {
  MARKET_JUDGEMENT_APPROVAL_KIND,
  MARKET_JUDGEMENT_REFUSALS,
  isBeforeScheduledJudgement,
  judgementStatusRefusal,
  judgementVoidOnly,
  sameJudgementGrounds,
  type AdminMarket,
  type AdminMarketJudgementQueueItem,
  type ApproveJudgementBody,
  type CursorQuery,
  type JudgementGrounds,
  type MarketJudgementApproveActionPayload,
  type MarketJudgementCorrection,
  type MarketJudgementRejectActionPayload,
  type MarketJudgementRequestActionPayload,
  type MarketJudgementRequestPayload,
  type MarketJudgementRetractActionPayload,
  type MarketStatus,
  type RegisterJudgementBody,
  type RejectJudgementBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import {
  ApprovalService,
  approvalNotAllowed,
  type ApprovalRequest,
} from '../approvals/approval.service.js';
import { and, eq } from 'drizzle-orm';
import { assertMarketDecisionEligibility, assertNoMarketConflict } from './market-conflicts.js';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { type Page } from '../wallet/wallet.service.js';
import { MarketAdminService, decisionInstant, snapshot } from './market-admin.service.js';
import { fieldError, lockedMarketRow, type Tx } from './market-item-rules.js';
import {
  acceptedDisputeIdsOf,
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
import { marketTagNames, type MarketRow } from './market.service.js';

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
  status: {
    notClosed: 'A first judgement is registered and approved on a closed market alone',
    notProvisional: 'A correction is registered and approved on a provisional market alone',
  },
  correction: {
    stale: 'The correction was not written against the market’s current judgement version',
    unchanged: 'The correction changes neither the result nor its grounds',
  },
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

/**
 * VALIDATION_ERROR naming `path` — or `field` inside it, as the pipe names
 * `evidence.links.<index>` (`evidence.collectedAt` 'after now', `correction.baseVersion` 'stale')
 * — with its MARKET_JUDGEMENT_REFUSALS message for `refusal`.
 */
function refused<P extends RefusalPath>(
  path: P,
  refusal: keyof Refusals[P],
  field?: string,
): AppError {
  const detail = MARKET_JUDGEMENT_REFUSALS[path][refusal] as string;
  const message = REFUSAL_MESSAGES[path][refusal];
  if (field === undefined) return fieldError(path, message, detail);
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [{ path: [path, field], message: detail }],
  });
}

/**
 * `status` as `judgementStatusRefusal` answers it, or null when the status takes the write (#173
 * item 8): 'not closed' for a first judgement off CLOSED, 'not provisional' for a correction off
 * PROVISIONAL — the registration's `correction` tells the two apart, never the status (#176).
 */
function statusRefused(status: MarketStatus, correction: object | null): AppError | null {
  if (judgementStatusRefusal(status, correction !== null) === null) return null;
  return refused('status', correction === null ? 'notClosed' : 'notProvisional');
}

/**
 * `correction.baseVersion` 'stale' (#176): the correction was written against a version that is
 * not the market's current one, as #80's supplement against its rule version.
 */
const staleCorrection = () => refused('correction', 'stale', 'baseVersion');

/** A judgement version's grounds (`market_judgements`) as `sameJudgementGrounds` compares them. */
function groundsOf(judgement: MarketJudgementRow): JudgementGrounds {
  return {
    result: judgement.result,
    source: judgement.sourcePriority === null ? null : { priority: judgement.sourcePriority },
    fallbackReason: judgement.fallbackReason,
    voidReason: judgement.voidReason,
    evidence: { links: judgement.evidenceLinks, collectedAt: judgement.collectedAt },
    description: judgement.evidenceDescription,
  };
}

/**
 * What an approval wrote (#152, #176): the decision and its instant, the market as it left it, the
 * version it made and — a correction's — the version it replaced and the replaced version's
 * pending disputes it closed as 정정으로 종결.
 */
interface Approved {
  decided: ApprovalRequest;
  at: Date;
  market: MarketRow;
  judgement: MarketJudgementRow;
  previous: MarketJudgementRow | null;
  closedDisputeIds: string[];
}

/** A deadline passed with nothing holding: `market.resolve` at once, after COMMIT. */
interface Due {
  deadline: Date;
  now: Date;
}

/** What an approval's two paths read: the locked market, the waiting request and its payload. */
interface ApprovalInput {
  adminId: string;
  current: MarketRow;
  request: JudgementRequest;
  registration: MarketJudgementRequestPayload;
  body: WithoutExpectedAccount<ApproveJudgementBody>;
}

/** What a correction's 반려 or 철회 left (`endCorrection`). */
interface CorrectionEnd {
  market: MarketRow;
  reopenedDisputeIds: string[];
  due: Due | null;
}

/**
 * 판정 등록과 별도 검토자 승인 (#152, ADR-0103; ADR-0093 decision 1 #173 items 1·4·5·9·11–13,
 * decision 3 the #152 rows '역할'·'판정 출처'·'증거'·'등록 시점'; market-judgement.ts in
 * @buddha/shared and @buddha/db) and 판정 정정 (#176, ADR-0105; #173 items 2·5·7·8, decision 3
 * '#176 정정 대기', owner answer 2026-11-02) — one approval kind, `market_judgement`, the request's
 * `correction` telling them apart (null for a first judgement), never the market's status:
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
 * - 판정 정정 (PROVISIONAL, before the confirmation — after it, #144's): the same registration of
 *   the market's current version (`correction.baseVersion`) in full, with a 정정 사유, refused when
 *   it changes neither the result nor its grounds (#173 item 7: then the dispute is dismissed) —
 *   no setting read, the 판정 불가 rule kept. Its payload lists the base version's accepted
 *   disputes it answers (`correction.disputeIds`, the server's), and the market's
 *   `correction_pending` mirror is set: while it waits the worker confirms nothing (the waiting
 *   request is the hold, `confirmationHold`) and past the deadline the market reads '판정 지연'.
 * - 승인: an admin other than the registrant ('역할', ADR-0056 decision 1-1), before the scheduled
 *   judgement with the event deadline confirmed ('등록 시점'). A first judgement's: the market
 *   still CLOSED and the setting decided — `approveMarketJudgement` (@buddha/db) at the decision's
 *   instant: the `provisional` event, the market PROVISIONAL with its result (VOID too, #173 item
 *   9), version and dispute deadline — the instant plus the setting read in the transaction, fixed
 *   then (#173 item 5) — and the append-only `market_judgements` row. A correction's: the market
 *   still PROVISIONAL at its base version — `correctMarketJudgement`: the base version's pending
 *   disputes closed as 정정으로 종결, the `judgement_corrected` event, the next version with the
 *   new result and a deadline of the base version's length from the instant (#173 item 5), the
 *   market's mirrors reset and its `status_event_id` moved. After COMMIT `market:status` and the
 *   `market.resolve` job at the deadline: the worker confirms the result then (PROVISIONAL →
 *   RESOLVED, the settlement steps, `market.finalize`), never an admin — unless a 판정 이의 holds
 *   it, when the last dismissal registers the job again (#175, MarketDisputeService). An earlier
 *   deadline's job finds the later deadline and skips (`not_due`): none is cancelled.
 * - 반려 (an admin other than the registrant, with a reason) and 철회 (the registrant), in any
 *   status. A first judgement's: the record alone, the market as it was — a CLOSED one stays
 *   CLOSED and is registered again (#173 item 1), by any admin, the rejecting one included: only a
 *   judgement's registrant decides nothing of that one. A correction's (decision 3 '#176 정정
 *   대기'): the base version, its deadline and its disputes' results carry on; the accepted
 *   disputes it answered that are still accepted go back to pending (owner answer 2026-11-02 — a
 *   철회 alike, this PR's choice: the correction they waited for is gone either way), the mirror is
 *   cleared, and after COMMIT `market:status` (unchanged) and — past the deadline with nothing
 *   holding — `market.resolve` with no delay, as the last dismissal's.
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
   * 판정 등록 (decision 3 the #152 rows) or 판정 정정 (#176, `body.correction`): any admin, on a
   * CLOSED market — a PROVISIONAL one for a correction — registers its judgement, the body's own
   * rules first (`registerJudgementBodySchema`: the result, the source and the two reasons
   * together, 1..5 distinct links, the description, a correction's base version and 정정 사유).
   * Refused, in this order: `status` 'not closed' (a first judgement) or 'not provisional' (a
   * correction), `correction.baseVersion` 'stale' (not the market's current version), `judgement`
   * 'pending' (one waits at a time, a first judgement and a correction alike),
   * APPROVAL_NOT_ALLOWED `no_decider` (no admin but the registrant to approve it), `disputeWindow`
   * 'undecided' (a first judgement alone: a correction reads no setting), `correction`
   * 'unchanged' (the result and its grounds all the base version's, `sameJudgementGrounds`),
   * `source` 'unknown' (the rules have no source of that priority), `result` 'void only' (YES or
   * NO on a market whose last pause ended in an early close reviewed 판정 불가 — a correction's
   * too), then `evidence.collectedAt` 'after now' (the database clock's, read after every lock).
   * Opens the `market_judgement` request — payload MarketJudgementRequestPayload, a correction's
   * `disputeIds` the base version's accepted disputes, the oldest submission first; the
   * description its reason — and writes `market_judgement_request`. No market event. A first
   * judgement's changes nothing else and publishes nothing; a correction's sets the market's
   * `correction_pending` at the registration's instant and, after COMMIT, republishes its
   * unchanged `market:status` (its labels move past the deadline).
   */
  async register(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<RegisterJudgementBody>,
  ): Promise<AdminMarket> {
    const { correction } = body;
    const market = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      // The class's lock order: the admin roles after the market's rows. `no_decider` reads the
      // roles under it, and the request row is written after it.
      await assertMarketDecisionEligibility(tx, id, adminId, body.noConflictConfirmed);
      const now = await clockTimestamp(tx);
      const status = statusRefused(current.status, correction);
      if (status !== null) throw status;
      if (correction !== null && correction.baseVersion !== current.judgementVersion) {
        throw staleCorrection();
      }
      if (await hasPendingJudgement(tx, id)) throw refused('judgement', 'pending');
      if (!(await hasUnconflictedMarketAdmin(tx, id, [adminId]))) {
        throw approvalNotAllowed('no_decider');
      }
      if (correction === null) {
        // Refused here too, not only at the approval: a registration that no approval could
        // publish would wait for nothing (ADR-0103; the safe side, as `market.lead_close_gap`
        // blocks a review's submission, ADR-0098).
        if ((await this.markets.disputeWindowSetting(tx)) === null) {
          throw refused('disputeWindow', 'undecided');
        }
      } else {
        // The base version is the current one (above), under the market lock.
        const base = await currentMarketJudgement(tx, id);
        if (base === null) {
          throw new AppError('INTERNAL', {
            message: `Market ${id} has no judgement of version ${String(correction.baseVersion)}`,
          });
        }
        if (sameJudgementGrounds(groundsOf(base), body)) {
          throw refused('correction', 'unchanged');
        }
      }
      const source =
        body.source === null ? null : await judgementSourceOf(tx, id, body.source.priority);
      if (body.source !== null && source === null) throw refused('source', 'unknown');
      if (body.result !== 'VOID' && judgementVoidOnly(await lastMarketPause(tx, id))) {
        throw refused('result', 'voidOnly');
      }
      // No lower bound: an early result's evidence can predate the close (#114).
      const collectedAt = new Date(body.evidence.collectedAt);
      if (collectedAt.getTime() > now.getTime()) {
        throw refused('evidence', 'collectedAfterNow', 'collectedAt');
      }
      const payload: MarketJudgementRequestPayload = {
        noConflictConfirmed: true,
        result: body.result,
        source,
        fallbackReason: body.fallbackReason ?? null,
        voidReason: body.voidReason ?? null,
        evidence: { links: body.evidence.links, collectedAt: collectedAt.toISOString() },
        // Read under the market lock; nothing moves it after the close (ADR-0101: no supplement
        // then), and the approval checks it did not.
        ruleVersion: current.ruleVersion,
        // The accepted disputes it answers, the server's (the client names none): an approval
        // answers every accepted dispute of the version, and a 반려 or 철회 reopens these alone.
        correction:
          correction === null
            ? null
            : {
                baseVersion: correction.baseVersion,
                reason: correction.reason,
                disputeIds: await acceptedDisputeIdsOf(tx, id, correction.baseVersion),
              },
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
      // The mirror the labels read (the hold itself is the waiting request): '판정 지연' past
      // the deadline while it waits.
      const row =
        correction === null
          ? current
          : await setCorrectionPending(tx, {
              marketId: id,
              pending: true,
              now: request.requestedAt,
            });
      return this.markets.toAdminMarket(
        tx,
        row,
        await marketTagNames(tx, id),
        await readMarketSources(tx, id),
      );
    });
    // Outside the transaction, as every market write publishes: an open detail refetches its
    // labels (the key unchanged).
    if (correction !== null) await this.markets.publishStatus(market);
    return market;
  }

  /**
   * 승인 (#173 item 1, decision 3 '역할'): an admin other than the registrant approves the market's
   * waiting registration `requestId` with a reason. Refused: `requestId` 'unknown' (no
   * registration of this market), then APPROVAL_NOT_ALLOWED `retracted` or `decided` (no longer
   * waiting) and `requester`; then `status` — 'not closed' for a first judgement (PROVISIONAL
   * since another approval: a registration waiting then is moot, ended by a 반려 or a 철회 alone),
   * 'not provisional' for a correction (#176) — then a first judgement's `disputeWindow`
   * 'undecided' or a correction's `correction.baseVersion` 'stale', and — at the decision's
   * instant — `eventDeadlineConfirmed` 'required' (before the market's scheduled judgement
   * without the confirmation, a correction's too; a market with none, opened before #22, needs
   * none). A rule version moved since the registration is a broken invariant (INTERNAL).
   *
   * Then, at the decision's instant, the approver its actor — a first judgement's
   * `approveMarketJudgement`: the `provisional` event, payload `{version, result, approvalId,
   * requestedBy, disputeDeadline}`; the market PROVISIONAL with `resolved_result`,
   * `judgement_version` and `dispute_deadline` — the instant plus the window read here, fixed
   * (#173 item 5); the `market_judgements` row. A correction's `correctMarketJudgement` (#176):
   * the base version's pending disputes 정정으로 종결, the `judgement_corrected` event, the next
   * version — its deadline the instant plus the base version's window, never the setting (#173
   * item 5) — and the market at it, still PROVISIONAL, under the event's key.
   * `market_judgement_approve` records the request, the version, the result, the approver's
   * reason and confirmation, the window and deadline, a correction's replaced version, its
   * `correction` and the disputes it closed, and the market before and after. After COMMIT
   * `market:status` (provisional with its result, the event's key) and `market.resolve` delayed to
   * the deadline.
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
      await assertMarketDecisionEligibility(tx, id, adminId, body.noConflictConfirmed);
      await assertNoMarketConflict(tx, id, request.requestedBy);
      const registration = judgementPayloadOf(request);
      const { correction } = registration;
      const status = statusRefused(current.status, correction);
      if (status !== null) throw status;
      const input = { adminId, current, request, registration, body };
      const approved =
        correction === null
          ? await this.publishJudgement(tx, input)
          : await this.correctJudgement(tx, input, correction);
      const { decided, judgement, previous } = approved;
      const tags = await marketTagNames(tx, id);
      const sources = await readMarketSources(tx, id);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_judgement_approve',
        targetType: 'market',
        targetId: id,
        payload: {
          noConflictConfirmed: true,
          approvalId: request.id,
          version: judgement.version,
          result: judgement.result,
          reason: decided.decisionReason ?? body.reason,
          eventDeadlineConfirmed: judgement.eventDeadlineConfirmed,
          disputeWindowMinutes: judgement.disputeWindowMinutes,
          disputeDeadline: judgement.disputeDeadline.toISOString(),
          // `snapshot()` holds no judgement column, so the replaced version is recorded here.
          previous:
            previous === null
              ? null
              : {
                  version: previous.version,
                  result: previous.result,
                  disputeDeadline: previous.disputeDeadline.toISOString(),
                },
          correction,
          closedDisputeIds: approved.closedDisputeIds,
          before: snapshot(current, tags, sources),
          after: snapshot(approved.market, tags, sources),
        } satisfies MarketJudgementApproveActionPayload,
        createdAt: approved.at,
      });
      return {
        market: await this.markets.toAdminMarket(tx, approved.market, tags, sources),
        disputeDeadline: judgement.disputeDeadline,
        at: approved.at,
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
   * `requestId` with a reason, in any status — so one still waiting once the market left the
   * status it needs ends too. Refused as the approval is up to its decision: `requestId`
   * 'unknown', APPROVAL_NOT_ALLOWED `retracted`, `decided` or `requester`. Writes
   * `market_judgement_reject`. A first judgement's leaves the market unchanged — a CLOSED one is
   * registered again — and publishes nothing; a correction's ends it as `endCorrection` says
   * (#176), and after COMMIT republishes the unchanged status and, past the deadline with nothing
   * holding, registers `market.resolve` with no delay.
   */
  async reject(
    adminId: string,
    id: string,
    requestId: string,
    body: WithoutExpectedAccount<RejectJudgementBody>,
  ): Promise<AdminMarket> {
    const { market, ended } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.decidable(tx, adminId, id, requestId);
      const registration = judgementPayloadOf(request);
      const decided = await this.approvals.reject(adminId, request.id, body.reason, tx);
      const at = decisionInstant(decided);
      const ended =
        registration.correction === null
          ? null
          : await this.endCorrection(tx, current, registration.correction, at);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_judgement_reject',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          result: registration.result,
          reason: decided.decisionReason ?? body.reason,
          ...(ended === null ? {} : { reopenedDisputeIds: ended.reopenedDisputeIds }),
        } satisfies MarketJudgementRejectActionPayload,
        createdAt: at,
      });
      return {
        market: await this.markets.toAdminMarket(
          tx,
          ended?.market ?? current,
          await marketTagNames(tx, id),
          await readMarketSources(tx, id),
        ),
        ended,
      };
    });
    if (ended !== null) await this.republish(market, ended.due);
    return market;
  }

  /**
   * 철회: the registrant ends the market's waiting registration `requestId` before anyone decides
   * it, in any status. Refused: `requestId` 'unknown', then ApprovalService's APPROVAL_NOT_ALLOWED
   * `not_requester`, `retracted` or `decided`. Writes `market_judgement_retract` at the
   * retraction's instant. A first judgement's changes nothing else and publishes nothing; a
   * correction's ends it as a 반려 does (`endCorrection`, #176), with the same after COMMIT.
   */
  async retract(adminId: string, id: string, requestId: string): Promise<AdminMarket> {
    const { market, ended } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.requestOf(tx, id, requestId);
      const registration = judgementPayloadOf(request);
      const retracted = await this.approvals.retract(adminId, request.id, tx);
      const at = retracted.retractedAt;
      if (at === null) {
        throw new AppError('INTERNAL', { message: 'Approval retraction has no instant' });
      }
      const ended =
        registration.correction === null
          ? null
          : await this.endCorrection(tx, current, registration.correction, at);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_judgement_retract',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          result: registration.result,
          ...(ended === null ? {} : { reopenedDisputeIds: ended.reopenedDisputeIds }),
        } satisfies MarketJudgementRetractActionPayload,
        createdAt: at,
      });
      return {
        market: await this.markets.toAdminMarket(
          tx,
          ended?.market ?? current,
          await marketTagNames(tx, id),
          await readMarketSources(tx, id),
        ),
        ended,
      };
    });
    if (ended !== null) await this.republish(market, ended.due);
    return market;
  }

  /** A self-declaration and its own pending registrations are one atomic operation (#143). */
  async retractOwnPendingForConflict(
    tx: Tx,
    adminId: string,
    current: MarketRow,
    declarationId: string,
  ): Promise<{ market: AdminMarket; ended: CorrectionEnd | null; requestIds: string[] }> {
    const pending = await tx
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.kind, MARKET_JUDGEMENT_APPROVAL_KIND),
          eq(schema.approvalRequests.targetType, 'market'),
          eq(schema.approvalRequests.targetId, current.id),
          eq(schema.approvalRequests.requestedBy, adminId),
          eq(schema.approvalRequests.status, 'pending'),
        ),
      );
    let row = current;
    let ended: CorrectionEnd | null = null;
    for (const request of pending) {
      const registration = judgementPayloadOf(request);
      const retracted = await this.approvals.retract(adminId, request.id, tx);
      const at = retracted.retractedAt;
      if (at === null)
        throw new AppError('INTERNAL', { message: 'Approval retraction has no instant' });
      if (registration.correction !== null) {
        ended = await this.endCorrection(tx, row, registration.correction, at);
        row = ended.market;
      }
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_judgement_retract',
        targetType: 'market',
        targetId: current.id,
        payload: {
          approvalId: request.id,
          result: registration.result,
          conflictDeclarationId: declarationId,
          ...(ended === null ? {} : { reopenedDisputeIds: ended.reopenedDisputeIds }),
        } satisfies MarketJudgementRetractActionPayload,
        createdAt: at,
      });
    }
    return {
      market: await this.markets.toAdminMarket(
        tx,
        row,
        await marketTagNames(tx, row.id),
        await readMarketSources(tx, row.id),
      ),
      ended,
      requestIds: pending.map((request) => request.id),
    };
  }

  async publishConflictRetraction(done: {
    market: AdminMarket;
    ended: CorrectionEnd | null;
  }): Promise<void> {
    if (done.ended !== null) await this.republish(done.market, done.ended.due);
  }

  /** `GET /admin/market-judgements` (판정 승인 대기): the oldest registration first. */
  list(query: CursorQuery): Promise<Page<AdminMarketJudgementQueueItem>> {
    return listMarketJudgements(this.db, query);
  }

  /**
   * A first judgement's approval (#152): `disputeWindow` 'undecided' — the setting read once, in
   * the approval's transaction: the deadline it fixes is this value's (#173 item 5), whatever the
   * setting says later — then the decision (`decideApproval`) and `approveMarketJudgement`.
   */
  private async publishJudgement(tx: Tx, input: ApprovalInput): Promise<Approved> {
    const window = await this.markets.disputeWindowSetting(tx);
    if (window === null) throw refused('disputeWindow', 'undecided');
    const { decided, at } = await this.decideApproval(tx, input);
    const result = await approveMarketJudgement(tx, {
      market: input.current,
      request: decided,
      now: at,
      approverId: input.adminId,
      eventDeadlineConfirmed: input.body.eventDeadlineConfirmed,
      disputeWindowMinutes: window,
    });
    // `not_closed` was refused above under the same lock.
    if (!result.published) throw refused('status', 'notClosed');
    return {
      decided,
      at,
      market: result.market,
      judgement: result.judgement,
      previous: null,
      closedDisputeIds: [],
    };
  }

  /**
   * A correction's approval (#176): `correction.baseVersion` 'stale' — one-waiting-per-market
   * keeps it the current version, asked anyway as #80's supplement asks — then the decision
   * (`decideApproval`) and `correctMarketJudgement`, which reads no setting: the new deadline
   * takes the base version's length (#173 item 5).
   */
  private async correctJudgement(
    tx: Tx,
    input: ApprovalInput,
    correction: MarketJudgementCorrection,
  ): Promise<Approved> {
    if (correction.baseVersion !== input.current.judgementVersion) throw staleCorrection();
    const { decided, at } = await this.decideApproval(tx, input);
    const result = await correctMarketJudgement(tx, {
      market: input.current,
      request: decided,
      now: at,
      approverId: input.adminId,
      eventDeadlineConfirmed: input.body.eventDeadlineConfirmed,
    });
    // Both skips were refused above under the same lock.
    if (!result.corrected) {
      throw result.reason === 'stale' ? staleCorrection() : refused('status', 'notProvisional');
    }
    return {
      decided,
      at,
      market: result.market,
      judgement: result.judgement,
      previous: result.previous,
      closedDisputeIds: result.closedDisputes.map((dispute) => dispute.id),
    };
  }

  /**
   * The approval's decision (ApprovalService) and its instant, then what is asked at that instant,
   * after every lock (the refusal rolls the decision back): `eventDeadlineConfirmed` 'required'
   * before the market's scheduled judgement, and the rule version the registration followed —
   * nothing moves it after the close, so a moved one is INTERNAL.
   */
  private async decideApproval(
    tx: Tx,
    { adminId, current, request, registration, body }: ApprovalInput,
  ): Promise<{ decided: ApprovalRequest; at: Date }> {
    const decided = await this.approvals.approve(adminId, request.id, body.reason, tx);
    const at = decisionInstant(decided);
    if (
      !body.eventDeadlineConfirmed &&
      isBeforeScheduledJudgement(current.scheduledJudgementAt, at.getTime())
    ) {
      throw refused('eventDeadlineConfirmed', 'required');
    }
    if (registration.ruleVersion !== current.ruleVersion) {
      throw new AppError('INTERNAL', {
        message:
          `Market ${current.id} is at rule version ${String(current.ruleVersion)}, its judgement ` +
          `${request.id} followed ${String(registration.ruleVersion)}`,
      });
    }
    return { decided, at };
  }

  /**
   * A correction's 반려 or 철회 at `now` (#176; decision 3 '#176 정정 대기': the base version, its
   * deadline and its disputes' results carry on), under the market lock: the accepted disputes it
   * was registered for that are still accepted on the current version back to pending
   * (`reopenAcceptedDisputes`, owner answer 2026-11-02 — on a PROVISIONAL market alone: a waiting
   * correction holds it there), the `correction_pending` mirror cleared, and whether the
   * version's deadline has passed with nothing holding the market any more (`confirmationHold`,
   * read after both: another waiting dispute or an acceptance since the registration still
   * holds), when `market.resolve` is due at once — the dismissal's pattern (MarketDisputeService).
   */
  private async endCorrection(
    tx: Tx,
    current: MarketRow,
    correction: MarketJudgementCorrection,
    now: Date,
  ): Promise<CorrectionEnd> {
    const reopened =
      current.status === 'provisional'
        ? await reopenAcceptedDisputes(tx, {
            market: current,
            disputeIds: correction.disputeIds,
            now,
          })
        : null;
    const market = await setCorrectionPending(tx, { marketId: current.id, pending: false, now });
    const deadline = market.disputeDeadline;
    const due =
      market.status === 'provisional' &&
      deadline !== null &&
      deadline.getTime() <= now.getTime() &&
      !(await confirmationHold(tx, market))
        ? { deadline, now }
        : null;
    return {
      market,
      reopenedDisputeIds: reopened?.disputes.map((dispute) => dispute.id) ?? [],
      due,
    };
  }

  /**
   * After COMMIT of a correction's 반려 or 철회: `market:status`, unchanged — an open detail
   * refetches its labels and the reopened disputes — and, when `due`, `market.resolve` under the
   * deadline's id with no delay: the worker stays the only confirmer (ADR-0103 9-12).
   */
  private async republish(market: AdminMarket, due: Due | null): Promise<void> {
    await Promise.all([
      this.markets.publishStatus(market),
      due === null ? undefined : this.jobs.scheduleResolve(market.id, due.deadline, due.now),
    ]);
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
