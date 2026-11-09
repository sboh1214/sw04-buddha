import { Inject, Injectable } from '@nestjs/common';
import {
  cancelledMarketIds,
  currentMarketPause,
  endMarketPause,
  lockAdminRoles,
  lockMarketOrders,
  pauseMarket,
  schema,
  type Db,
  type EndPauseSkipReason,
  type MarketPauseRow,
  type PauseSkipReason,
} from '@buddha/db';
import {
  MARKET_PAUSE_DECISION_APPROVAL_KIND,
  MARKET_PAUSE_REFUSALS,
  pauseDecisionRefusal,
  type AdminMarket,
  type AdminMarketPauseDecisionItem,
  type ApprovePauseDecisionBody,
  type CursorQuery,
  type MarketPauseActionPayload,
  type MarketPauseDecisionApproveActionPayload,
  type MarketPauseDecisionRefusal,
  type MarketPauseDecisionRejectActionPayload,
  type MarketPauseDecisionRequestActionPayload,
  type MarketPauseDecisionRequestPayload,
  type MarketPauseDecisionRetractActionPayload,
  type PauseMarketBody,
  type RejectPauseDecisionBody,
  type RequestPauseDecisionBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { ApprovalService, approvalNotAllowed } from '../approvals/approval.service.js';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { type Page } from '../wallet/wallet.service.js';
import { MarketAdminService, decisionInstant, snapshot } from './market-admin.service.js';
import { fieldError, lockedMarketRow, type Tx } from './market-item-rules.js';
import { lockMarket } from './market-lock.js';
import {
  hasPendingPauseDecision,
  listMarketPauseDecisions,
  pauseDecisionPayloadOf,
  pauseDecisionRequestOf,
  type PauseDecisionRequest,
} from './market-pause.js';
import { readMarketSources } from './market-sources.js';
import { marketTagNames, type MarketRow } from './market.service.js';

type Refusals = typeof MARKET_PAUSE_REFUSALS;
type RefusalPath = keyof Refusals;

/**
 * The top-level message of each refusal MARKET_PAUSE_REFUSALS keys by its path and case (the
 * publication instant's `required` and `earlyResultOnly` are the body's, which the pipe answers).
 */
const REFUSAL_MESSAGES: {
  readonly [P in RefusalPath]: Readonly<Record<keyof Refusals[P], string>>;
} = {
  status: {
    notOpen: 'A pause needs an open market',
    notPaused: 'The market is not paused: its pause has no next path to decide',
  },
  closeAt: { closed: 'The market has closed: its close came, and it closes on schedule' },
  pause: {
    pending: 'Another next path of the market’s pause is waiting for its decision',
    stale: 'The request decides a pause that is not the market’s current one',
  },
  reviewResult: {
    required: 'A basis_change pause’s next path is asked with its review result',
    basisChangeOnly: 'Only a basis_change pause’s next path carries a review result',
  },
  path: {
    earlyCloseOnly: 'A market its rules cannot judge closes early: it is not resumed',
  },
  resultPublishedAt: {
    required: 'An early_result pause records when the result was published',
    earlyResultOnly: 'Only an early_result pause records when the result was published',
    afterPause: 'The result cannot have been published after the pause',
  },
};

/** VALIDATION_ERROR naming `path` with its MARKET_PAUSE_REFUSALS message for `refusal`. */
function refused<P extends RefusalPath>(path: P, refusal: keyof Refusals[P]): AppError {
  const detail = MARKET_PAUSE_REFUSALS[path][refusal] as string;
  return fieldError(path, REFUSAL_MESSAGES[path][refusal], detail);
}

/** A next path the pause's reason refuses (`pauseDecisionRefusal`), with its message. */
function decisionRefused(refusal: MarketPauseDecisionRefusal): AppError {
  return refusal.path === 'path'
    ? refused('path', 'earlyCloseOnly')
    : refused(
        'reviewResult',
        refusal.message === MARKET_PAUSE_REFUSALS.reviewResult.required
          ? 'required'
          : 'basisChangeOnly',
      );
}

/** Why `pauseMarket` paused nothing, as the route answers it. */
const PAUSE_SKIPS: Readonly<Record<PauseSkipReason, () => AppError>> = {
  not_open: () => refused('status', 'notOpen'),
  close_passed: () => refused('closeAt', 'closed'),
  published_after_pause: () => refused('resultPublishedAt', 'afterPause'),
};

/** Why `endMarketPause` ended nothing, as the approval answers it. */
const END_SKIPS: Readonly<Record<EndPauseSkipReason, () => AppError>> = {
  not_paused: () => refused('status', 'notPaused'),
  close_passed: () => refused('closeAt', 'closed'),
  stale: () => refused('pause', 'stale'),
};

/**
 * 거래 일시 중단·재개·조기 마감 (#114, ADR-0102; ADR-0093 decision 1 #173 items 1–4, decision 3
 * '#114 조기 결과의 공개 시각', the owner's answers Q1·Q2 of 2026-11-02; market-pause.ts in
 * @buddha/shared and @buddha/db):
 *
 * - 일시 중단 (OPEN → PAUSED): one admin, at once (#173 item 2), with one of the three reasons, a
 *   note and — for `early_result` — the result's publication instant (`pauseMarket`: the `paused`
 *   event and the `market_pauses` row) and `market_pause`. After COMMIT `market:status`. The
 *   close job stays: the close still comes at `close_at`, on schedule (#173 item 3), and the
 *   worker closes a PAUSED market and ends its pause (`closed_at_close`).
 * - 재개 (PAUSED → OPEN) and 조기 마감 (PAUSED → CLOSED): one admin asks for the next path of the
 *   pause they saw, refused once it is not the lasting one ('stale') — a `basis_change` pause
 *   with its review result, `not_judgeable` the early close alone — which opens a
 *   `market_pause_decision` approval request (#171, ApprovalService) on the market, payload
 *   `{pauseId, path, reviewResult}`, and changes nothing; an admin other than the
 *   requester approves it (`endMarketPause`: the `resumed` or `closed` event and the pause's end,
 *   in the approval's transaction — for an early close of a market with no fill a person's account
 *   is on, the `cancelled` event instead, PAUSED → CANCELLED with the result type empty, #20,
 *   ADR-0117), and after COMMIT `market:status` and, for an early close, the close job cancelled
 *   (hygiene: the worker would skip a closed or cancelled market). A 반려 by another admin
 *   or the requester's 철회 ends it in any status, writing nothing but the record, as #80's
 *   supplements (ADR-0101). One request waits per market at a time; the admin who paused may ask
 *   or approve (only the requester decides nothing of theirs).
 *
 * Every write here is one transaction with its `admin_actions` row (`market_pause`,
 * `market_pause_decision_request|approve|reject|retract`), under MarketAdminService's lock order:
 * the market lock (`lockMarket`), the market row FOR UPDATE, then the shared admin-roles lock and
 * the request row (ApprovalService). So a pause write serialises with the worker's close and with
 * every other writer of the market — of two approvals at once the second finds the request decided
 * (APPROVAL_NOT_ALLOWED `decided`) — and the instant each records is the database clock's after
 * every lock: the pause's read after the market's, a request step's ApprovalService's (the
 * request's, the decision's, the retraction's). The close by the clock (#173 item 3: never
 * extended) refuses a pause, a request and an approval once `close_at` has come, before the worker
 * ran too, as #80's 'closed' (ADR-0101 9-9).
 *
 * A requester who loses the admin role while the request waits, as #80's and #139's: the request
 * stays waiting for another admin's decision, and they cannot retract it. The request's
 * `no_decider` check counts every admin but the requester (`ApprovalService.hasDecider`).
 *
 * Orders (#178, ADR-0113): the pause cancels the market's resting orders — people's and the 운영
 * 마켓메이커's — as 취소 완료(일시 중단) at its instant, their locks given back, in its transaction
 * (`pauseMarket`; ADR-0107 결정 5 '#119 일시 중단 때 대기 주문'). A `ledger_failure` pause cancels
 * none: they keep their locks (an owner's cancel is refused, MARKET_NOT_OPEN) until the approval
 * of its 재개 or 조기 마감 — the recovery — cancels them the same way at the decision's instant,
 * before the status changes (`endMarketPause`, 결정 4 #178 rows). Both take the market's orders and
 * their owners' Coin accounts (`lockMarketOrders`) before the clock, so balance rows come last: the
 * pause right after the market row (it takes no admin-roles lock), the decision's approval after
 * the row and `decidable`'s shared admin-roles lock. A refusal rolls every cancel back. After
 * COMMIT, when it cancelled or expired any (a non-held 조기 마감's expiry, #120), `market:book`
 * beside `market:status` (#179, ADR-0114: the public book changed); a `ledger_failure` pause
 * cancels none and publishes the status alone (a lock change alone has no event). The intake (#119)
 * refuses new orders on a paused market as 일시 중단 (ADR-0112 10-13). The 조기 마감 of a market not held
 * gets the close's processing (#120, ADR-0115): an order still live then — none since #178's pause,
 * a leftover from before it — ends 만료 after the transition, as at `close_at`.
 */
@Injectable()
export class MarketPauseService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly markets: MarketAdminService,
    private readonly approvals: ApprovalService,
    private readonly jobs: MarketJobs,
    private readonly publisher: MarketPublisher,
  ) {}

  /**
   * 일시 중단 (#173 items 2·3): any admin pauses an OPEN market whose close is ahead, by the clock,
   * with a reason, a note and, for `early_result`, the result's publication instant (the body's own
   * rule: required for it, refused otherwise). Refused, in this order: `status` 'not open' (a
   * PAUSED market included), `closeAt` 'closed', `resultPublishedAt` 'after the pause' (the
   * database clock's instant, read after the market lock, is the pause's). `pauseMarket` writes the
   * `paused` event (the admin its actor, payload `{pauseId, reason, resultPublishedAt}`) and the
   * pause row, then cancels the market's resting orders (the class's Orders); `market_pause`
   * records the pause, the note and the market before and after. After COMMIT `market:status`
   * (paused, the event's key) and, when it cancelled any order, `market:book` (#179).
   */
  async pause(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<PauseMarketBody>,
  ): Promise<AdminMarket> {
    const { market, book } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      // Its resting orders and their owners' Coin accounts, before the clock (#178): the pause
      // cancels them at its instant (but for `ledger_failure`, whose orders wait for the recovery).
      const orders = await lockMarketOrders(tx, id);
      // After the market lock (clock.ts): the pause sorts after whatever committed on the market
      // while this transaction queued — the worker's close among them.
      const now = await clockTimestamp(tx);
      const result = await pauseMarket(tx, {
        market: current,
        orders,
        now,
        actorId: adminId,
        reason: body.reason,
        note: body.note,
        resultPublishedAt: body.resultPublishedAt == null ? null : new Date(body.resultPublishedAt),
      });
      if (!result.paused) throw PAUSE_SKIPS[result.reason]();
      const tags = await marketTagNames(tx, id);
      const sources = await readMarketSources(tx, id);
      const { pause } = result;
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_pause',
        targetType: 'market',
        targetId: id,
        payload: {
          pauseId: pause.id,
          reason: pause.reason,
          note: pause.note,
          resultPublishedAt: pause.resultPublishedAt?.toISOString() ?? null,
          before: snapshot(current, tags, sources),
          after: snapshot(result.market, tags, sources),
        } satisfies MarketPauseActionPayload,
        createdAt: now,
      });
      return {
        market: await this.markets.toAdminMarket(tx, result.market, tags, sources),
        book: { marketIds: cancelledMarketIds(result.cancelled), at: now },
      };
    });
    // Outside the transaction, as every market write publishes: a subscriber answers
    // `market:status` with a REFETCH, which must find the committed row.
    await Promise.all([
      this.markets.publishStatus(market),
      this.publisher.publishBook(book.marketIds, book.at),
    ]);
    return market;
  }

  /**
   * 다음 경로 요청 (#173 items 2·4, Q1·Q2): any admin, on a PAUSED market whose close is ahead, asks
   * for 재개 or 조기 마감 of its current pause — the one the body names, the pause its author saw
   * (as #80's supplements name their base version) — with a reason. Refused, in this order:
   * `status` 'not paused', `closeAt` 'closed', `pause` 'stale' (the body's pause is not the lasting
   * one: it ended and the market paused again since, so what the author weighed was another
   * pause's), `pause` 'pending' (one waits at a time, so a request never overwrites another),
   * APPROVAL_NOT_ALLOWED `no_decider` (no admin but the requester to decide it), then what the
   * pause's reason allows (`pauseDecisionRefusal`): `reviewResult` 'required' (a `basis_change`
   * pause's) or 'only for basis_change', then `path` 'early close only' (재개 with
   * `not_judgeable`). Opens the `market_pause_decision` request — payload `{pauseId, path,
   * reviewResult}`, the reason as its reason — and writes `market_pause_decision_request`. No
   * market event and nothing published: nothing changed yet.
   */
  async request(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<RequestPauseDecisionBody>,
  ): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      // The class's lock order: the admin roles after the market's rows. `no_decider` reads the
      // roles under it, and the request row is written after it.
      await lockAdminRoles(tx, 'shared');
      const now = await clockTimestamp(tx);
      if (current.status !== 'paused') throw refused('status', 'notPaused');
      if (current.closeAt.getTime() <= now.getTime()) throw refused('closeAt', 'closed');
      // The pause its author saw, read under the market lock that every pause and end holds: one
      // resumed since, the market paused again, is not the pause asked about.
      const pause = await lastingPause(tx, current);
      if (pause.id !== body.pauseId) throw refused('pause', 'stale');
      if (await hasPendingPauseDecision(tx, id)) throw refused('pause', 'pending');
      if (!(await this.approvals.hasDecider([adminId], tx))) {
        throw approvalNotAllowed('no_decider');
      }
      const decision = { path: body.path, reviewResult: body.reviewResult ?? null };
      const refusal = pauseDecisionRefusal(pause.reason, decision);
      if (refusal !== null) throw decisionRefused(refusal);
      const request = await this.approvals.request(
        {
          kind: MARKET_PAUSE_DECISION_APPROVAL_KIND,
          targetType: 'market',
          targetId: id,
          payload: { pauseId: pause.id, ...decision } satisfies MarketPauseDecisionRequestPayload,
          requestedBy: adminId,
          reason: body.reason,
        },
        tx,
      );
      // The request's instant, read after every lock: a close reached since `now` is refused as
      // one reached before, and the refusal rolls the request back.
      if (current.closeAt.getTime() <= request.requestedAt.getTime()) {
        throw refused('closeAt', 'closed');
      }
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_pause_decision_request',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          pauseId: pause.id,
          ...decision,
          reason: request.requestReason,
        } satisfies MarketPauseDecisionRequestActionPayload,
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
   * 승인 (#173 item 2): an admin other than the requester approves the market's waiting request
   * `requestId` with a reason. Refused: `requestId` 'unknown' (no next-path request of this
   * market), then APPROVAL_NOT_ALLOWED `retracted` or `decided` (no longer waiting) and
   * `requester`; then, at the decision, `status` 'not paused' (the worker closed it at its close —
   * a request waiting then is moot, ended by a 반려 or a 철회 alone), `closeAt` 'closed' (its close
   * has come, by the clock too) and `pause` 'stale' (the request's pause is not the current one).
   *
   * Then `endMarketPause` at the decision's instant, the approver its actor: for a 재개, and for
   * the 조기 마감 of a market held for a ledger failure (its approval is the recovery, ADR-0107 결정
   * 4 #178), first the market's live orders cancelled 일시 중단 (the class's Orders), then 재개 —
   * the `resumed` event, payload `{pauseId, approvalId, requestedBy, reviewResult}`, the market
   * OPEN again with its `open_at` kept; 조기 마감 — the `closed` event, payload `{closedAt, source:
   * 'early_close', …}`, the market CLOSED with `close_at` kept as the scheduled close (#80's
   * rule-version item) — or, with no fill a person's account is on, the `cancelled` event, payload
   * `{cancelledAt, source: 'early_close', reason, …}` with the system sentence, the market
   * CANCELLED with its result type empty and no judgement to follow (#20, ADR-0117; ADR-0107 결정
   * 4 '#120·#20') — and the close's own processing after it: a live order left on a market not
   * held ends 만료 at that instant (#120, ADR-0107 결정 5 '#120 조기 마감과 CLOSED 뒤 재개' — the
   * pause cancelled every order, so only a row from before #178 reaches it); and the pause's end
   * with the review result. `market_pause_decision_approve` records the request, the approver's
   * reason and the market before and after (`after.status` closed or cancelled for an early
   * close). After COMMIT `market:status` (open, closed or cancelled, the event's key),
   * `market:book` when the end cancelled or expired any order (#179) and, for an early close, the
   * close job under `close_at` cancelled. No `user:` event: the end only moves locks (ADR-0113
   * 12-11).
   */
  async approve(
    adminId: string,
    id: string,
    requestId: string,
    body: WithoutExpectedAccount<ApprovePauseDecisionBody>,
  ): Promise<AdminMarket> {
    const { market, book, cancelCloseAt } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.decidable(tx, adminId, id, requestId);
      // The market's live orders and their owners' Coin accounts, last before the clock (#178):
      // the end cancels them at the decision's instant, before the status changes.
      const orders = await lockMarketOrders(tx, id);
      const now = await clockTimestamp(tx);
      const payload = pauseDecisionPayloadOf(request);
      if (current.status !== 'paused') throw refused('status', 'notPaused');
      if (current.closeAt.getTime() <= now.getTime()) throw refused('closeAt', 'closed');
      const pause = await currentMarketPause(tx, id);
      if (pause?.id !== payload.pauseId) throw refused('pause', 'stale');
      const decided = await this.approvals.approve(adminId, request.id, body.reason, tx);
      const at = decisionInstant(decided);
      // At the decision's instant, after every lock: a close reached since `now` is refused as one
      // reached before (`endMarketPause` judges it again), rolling the decision back.
      const result = await endMarketPause(tx, {
        market: current,
        orders,
        pause: { id: payload.pauseId },
        now: at,
        approverId: adminId,
        path: payload.path,
        reviewResult: payload.reviewResult,
        approvalId: request.id,
        requestedBy: request.requestedBy,
      });
      if (!result.ended) throw END_SKIPS[result.reason]();
      const tags = await marketTagNames(tx, id);
      const sources = await readMarketSources(tx, id);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_pause_decision_approve',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          pauseId: payload.pauseId,
          path: payload.path,
          reviewResult: payload.reviewResult,
          reason: decided.decisionReason ?? body.reason,
          before: snapshot(current, tags, sources),
          after: snapshot(result.market, tags, sources),
        } satisfies MarketPauseDecisionApproveActionPayload,
        createdAt: at,
      });
      return {
        market: await this.markets.toAdminMarket(tx, result.market, tags, sources),
        // The early close's expiry is this market's alone; `publishBook` names it once.
        book: {
          marketIds: [
            ...cancelledMarketIds(result.cancelled),
            ...(result.expired.expired.length > 0 ? [id] : []),
          ],
          at,
        },
        // The delayed close job is keyed by market AND instant (marketCloseJobId); the early close
        // keeps `close_at`, so the job under it is the one to cancel.
        cancelCloseAt: payload.path === 'early_close' ? current.closeAt : null,
      };
    });
    await Promise.all([
      this.markets.publishStatus(market),
      this.publisher.publishBook(book.marketIds, book.at),
      cancelCloseAt ? this.jobs.cancelClose(market.id, cancelCloseAt) : undefined,
    ]);
    return market;
  }

  /**
   * 반려: an admin other than the requester ends the market's waiting request `requestId` with a
   * reason, in any status — so a request still waiting at the close ends too. Refused as the
   * approval is up to its decision: `requestId` 'unknown', APPROVAL_NOT_ALLOWED `retracted`,
   * `decided` or `requester`. Writes `market_pause_decision_reject`; the market and its pause are
   * unchanged, and nothing is published.
   */
  async reject(
    adminId: string,
    id: string,
    requestId: string,
    body: WithoutExpectedAccount<RejectPauseDecisionBody>,
  ): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.decidable(tx, adminId, id, requestId);
      const payload = pauseDecisionPayloadOf(request);
      const decided = await this.approvals.reject(adminId, request.id, body.reason, tx);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_pause_decision_reject',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          pauseId: payload.pauseId,
          path: payload.path,
          reason: decided.decisionReason ?? body.reason,
        } satisfies MarketPauseDecisionRejectActionPayload,
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
   * 철회: the requester ends the market's waiting request `requestId` before anyone decides it, in
   * any status. Refused: `requestId` 'unknown', then ApprovalService's APPROVAL_NOT_ALLOWED
   * `not_requester`, `retracted` or `decided`. Writes `market_pause_decision_retract` at the
   * retraction's instant; nothing else changes, and nothing is published.
   */
  async retract(adminId: string, id: string, requestId: string): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.requestOf(tx, id, requestId);
      const payload = pauseDecisionPayloadOf(request);
      const retracted = await this.approvals.retract(adminId, request.id, tx);
      if (retracted.retractedAt === null) {
        throw new AppError('INTERNAL', { message: 'Approval retraction has no instant' });
      }
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_pause_decision_retract',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          pauseId: payload.pauseId,
          path: payload.path,
        } satisfies MarketPauseDecisionRetractActionPayload,
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

  /** `GET /admin/market-pause-decisions` (일시 중단 결정 대기): the oldest request first. */
  list(query: CursorQuery): Promise<Page<AdminMarketPauseDecisionItem>> {
    return listMarketPauseDecisions(this.db, query);
  }

  /**
   * The market's next-path request `requestId`, or VALIDATION_ERROR naming `requestId` 'unknown'
   * — another market's, another kind's or none (as #80's supplement requests).
   */
  private async requestOf(
    tx: Tx,
    marketId: string,
    requestId: string,
  ): Promise<PauseDecisionRequest> {
    const request = await pauseDecisionRequestOf(tx, marketId, requestId);
    if (!request) {
      throw fieldError('requestId', 'Not a pause decision request of this market', 'unknown');
    }
    return request;
  }

  /**
   * The request a decision names (`requestOf`), still waiting and not the deciding admin's, under
   * the shared admin-roles lock the decision takes (the class's lock order, so the clock read after
   * it follows every lock): APPROVAL_NOT_ALLOWED `retracted` or `decided` for one no longer
   * waiting, then `requester` — as #80's decisions (MarketSupplementService).
   */
  private async decidable(
    tx: Tx,
    adminId: string,
    marketId: string,
    requestId: string,
  ): Promise<PauseDecisionRequest> {
    const request = await this.requestOf(tx, marketId, requestId);
    await lockAdminRoles(tx, 'shared');
    if (request.status === 'retracted') throw approvalNotAllowed('retracted');
    if (request.status !== 'pending') throw approvalNotAllowed('decided');
    if (request.requestedBy === adminId) throw approvalNotAllowed('requester');
    return request;
  }
}

/**
 * A PAUSED market's lasting pause, read under the market lock: exactly one while it is PAUSED,
 * which `pauseMarket` and `endMarketPause` keep (both hold that lock), so none is a broken
 * invariant — INTERNAL, never an answer.
 */
async function lastingPause(tx: Tx, market: MarketRow): Promise<MarketPauseRow> {
  const pause = await currentMarketPause(tx, market.id);
  if (!pause) {
    throw new AppError('INTERNAL', { message: `Paused market ${market.id} has no lasting pause` });
  }
  return pause;
}
