import { Inject, Injectable } from '@nestjs/common';
import {
  cancelScheduledMarket,
  lockAdminRoles,
  lockMarketOrders,
  schema,
  type CancelScheduledSkipReason,
  type Db,
} from '@buddha/db';
import {
  MARKET_CANCEL_APPROVAL_KIND,
  MARKET_CANCEL_REFUSALS,
  type AdminMarket,
  type AdminMarketCancelItem,
  type ApproveMarketCancelBody,
  type CursorQuery,
  type MarketCancelApproveActionPayload,
  type MarketCancelRejectActionPayload,
  type MarketCancelRequestActionPayload,
  type MarketCancelRequestPayload,
  type MarketCancelRetractActionPayload,
  type RejectMarketCancelBody,
  type RequestMarketCancelBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { ApprovalService, approvalNotAllowed } from '../approvals/approval.service.js';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { type Page } from '../wallet/wallet.service.js';
import { MarketAdminService, decisionInstant, snapshot } from './market-admin.service.js';
import {
  hasPendingMarketCancel,
  listMarketCancelRequests,
  marketCancelPayloadOf,
  marketCancelRequestOf,
  type MarketCancelRequestRow,
} from './market-cancel.js';
import { fieldError, lockedMarketRow, type Tx } from './market-item-rules.js';
import { lockMarket } from './market-lock.js';
import { readMarketSources } from './market-sources.js';
import { marketTagNames } from './market.service.js';

type Refusals = typeof MARKET_CANCEL_REFUSALS;
type RefusalPath = keyof Refusals;

/** The top-level message of each refusal MARKET_CANCEL_REFUSALS keys by its path and case. */
const REFUSAL_MESSAGES: {
  readonly [P in RefusalPath]: Readonly<Record<keyof Refusals[P], string>>;
} = {
  status: { notScheduled: 'Only a scheduled market is cancelled by an operator' },
  cancel: {
    pending: 'Another cancel request of the market is waiting for its decision',
    stale: 'The market was sent back and approved again since the request',
  },
};

/** VALIDATION_ERROR naming `path` with its MARKET_CANCEL_REFUSALS message for `refusal`. */
function refused<P extends RefusalPath>(path: P, refusal: keyof Refusals[P]): AppError {
  const detail = MARKET_CANCEL_REFUSALS[path][refusal] as string;
  return fieldError(path, REFUSAL_MESSAGES[path][refusal], detail);
}

/** Why `cancelScheduledMarket` cancelled nothing, as the approval answers it. */
const CANCEL_SKIPS: Readonly<Record<CancelScheduledSkipReason, () => AppError>> = {
  not_scheduled: () => refused('status', 'notScheduled'),
  stale: () => refused('cancel', 'stale'),
};

/**
 * 시장 취소 of a SCHEDULED market (#20, ADR-0117; ADR-0107 결정 5 '#20 운영자의 취소 경로';
 * ADR-0093 decision 1 #173 items 2·10, decision 2 #172 item 6; market-cancel.ts in @buddha/shared
 * and @buddha/db): one admin asks to cancel a market approved for opening, with a reason — the
 * cancel's public reason, which the public judging record shows from #24 — which opens a
 * `market_cancel` approval request (#171, ApprovalService) on the market, payload
 * `{statusEventId}` (the SCHEDULED state it was asked in), and changes nothing; an admin other
 * than the requester approves it (`cancelScheduledMarket`: the `cancelled` event, the approver its
 * actor, the result type left empty), and after COMMIT `market:status` (cancelled) and the
 * approval's delayed open and close jobs removed. A 반려 by another admin or the requester's 철회
 * ends it in any status, writing nothing but the record, as #114's next-path requests
 * (MarketPauseService). One request waits per market at a time. No operator path leaves OPEN,
 * PAUSED or CLOSED for CANCELLED: an OPEN market ends by its close, or by a pause and its approved
 * early close, either cancelling it when nobody traded (the worker's close, `endMarketPause`).
 *
 * A waiting request does not hold the automatic open: once the worker opened the market, its
 * approval is refused (`status`), and the request stays until its 반려 or 철회. A 되돌리기 to a
 * draft (MarketAdminService.revert) does not end it either: the approval is refused by the status
 * and, after a new approval, by the pinned status event (`cancel` 'stale'), as ADR-0102 결정 5.
 *
 * Every write here is one transaction with its `admin_actions` row (`market_cancel_request|
 * approve|reject|retract`), under MarketAdminService's lock order: the market lock (`lockMarket`),
 * the market row FOR UPDATE, then the shared admin-roles lock and the request row
 * (ApprovalService), and for the approval the market's orders and their owners' Coin accounts
 * (`lockMarketOrders`) last before the clock. So a cancel serialises with the worker's open and
 * close and with every other writer of the market — of two approvals at once the second finds the
 * request decided (APPROVAL_NOT_ALLOWED `decided`) — and the instant each records is the
 * database clock's after every lock (the request's, the decision's, the retraction's).
 *
 * A requester who loses the admin role while the request waits, as #114's: the request stays
 * waiting for another admin's decision, and they cannot retract it. The request's `no_decider`
 * check counts every admin but the requester (`ApprovalService.hasDecider`).
 */
@Injectable()
export class MarketCancelService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly markets: MarketAdminService,
    private readonly approvals: ApprovalService,
    private readonly jobs: MarketJobs,
    private readonly publisher: MarketPublisher,
  ) {}

  /**
   * 취소 요청: any admin asks to cancel a SCHEDULED market with a reason (whatever its scheduled
   * open or close: no time is checked). Refused, in this order: `status` 'not scheduled',
   * `cancel` 'pending' (one waits at a time), APPROVAL_NOT_ALLOWED `no_decider` (no admin but the
   * requester to decide it). Opens the `market_cancel` request — payload `{statusEventId}`, the
   * reason as its reason — and writes `market_cancel_request`. No market event and nothing
   * published: nothing changed yet.
   */
  async request(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<RequestMarketCancelBody>,
  ): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      // The class's lock order: the admin roles after the market's rows. `no_decider` reads the
      // roles under it, and the request row is written after it.
      await lockAdminRoles(tx, 'shared');
      if (current.status !== 'scheduled') throw refused('status', 'notScheduled');
      if (current.statusEventId === null) {
        throw new AppError('INTERNAL', { message: `Scheduled market ${id} has no status event` });
      }
      if (await hasPendingMarketCancel(tx, id)) throw refused('cancel', 'pending');
      if (!(await this.approvals.hasDecider([adminId], tx))) {
        throw approvalNotAllowed('no_decider');
      }
      const payload = {
        statusEventId: current.statusEventId,
      } satisfies MarketCancelRequestPayload;
      const request = await this.approvals.request(
        {
          kind: MARKET_CANCEL_APPROVAL_KIND,
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
        type: 'market_cancel_request',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          statusEventId: payload.statusEventId,
          reason: request.requestReason,
        } satisfies MarketCancelRequestActionPayload,
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
   * 승인: an admin other than the requester approves the market's waiting request `requestId`
   * with a reason. Refused: `requestId` 'unknown' (no cancel request of this market), then
   * APPROVAL_NOT_ALLOWED `retracted` or `decided` (no longer waiting) and `requester`; then, at the
   * decision, `status` 'not scheduled' (opened, sent back or cancelled since) and `cancel` 'stale'
   * (SCHEDULED again, but not in the state the request was asked in).
   *
   * Then `cancelScheduledMarket` at the decision's instant: the `cancelled` event — the approver,
   * payload `{cancelledAt, source: 'operator', reason, approvalId, requestedBy}` with the
   * request's reason — the market CANCELLED with its result type null, and every live order 만료
   * (none: a SCHEDULED market takes no order). `market_cancel_approve` records the request, the
   * approver's reason and the market before and after. After COMMIT `market:status` (cancelled,
   * the event's key), `market:book` only if an order expired, and the delayed `market.open` (at
   * the scheduled open) and `market.close` (at the close) removed — hygiene, as a 되돌리기's: both
   * jobs find a cancelled market under the market lock and skip it.
   */
  async approve(
    adminId: string,
    id: string,
    requestId: string,
    body: WithoutExpectedAccount<ApproveMarketCancelBody>,
  ): Promise<AdminMarket> {
    const { market, book, registered } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.decidable(tx, adminId, id, requestId);
      // The market's live orders and their owners' Coin accounts, last before the clock: every
      // entry into CANCELLED ends what is live (none here, a SCHEDULED market takes no order).
      const orders = await lockMarketOrders(tx, id);
      const payload = marketCancelPayloadOf(request);
      if (current.status !== 'scheduled') throw refused('status', 'notScheduled');
      if (current.statusEventId !== payload.statusEventId) throw refused('cancel', 'stale');
      const decided = await this.approvals.approve(adminId, request.id, body.reason, tx);
      const at = decisionInstant(decided);
      const result = await cancelScheduledMarket(tx, {
        market: current,
        orders,
        now: at,
        approverId: adminId,
        approvalId: request.id,
        requestedBy: request.requestedBy,
        reason: request.requestReason,
        statusEventId: payload.statusEventId,
      });
      // Checked above under the same lock, so a skip is a broken invariant; it rolls back.
      if (!result.cancelled) throw CANCEL_SKIPS[result.reason]();
      const tags = await marketTagNames(tx, id);
      const sources = await readMarketSources(tx, id);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_cancel_approve',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          reason: decided.decisionReason ?? body.reason,
          before: snapshot(current, tags, sources),
          after: snapshot(result.market, tags, sources),
        } satisfies MarketCancelApproveActionPayload,
        createdAt: at,
      });
      return {
        market: await this.markets.toAdminMarket(tx, result.market, tags, sources),
        book: { marketIds: result.expired.expired.length > 0 ? [id] : [], at },
        // The instants the approval (or a reschedule) registered the jobs under.
        registered: { scheduledOpenAt: current.scheduledOpenAt, closeAt: current.closeAt },
      };
    });
    // Outside the transaction, as every market write publishes: a subscriber answers
    // `market:status` with a REFETCH, which must find the committed row.
    await Promise.all([
      this.markets.publishStatus(market),
      this.publisher.publishBook(book.marketIds, book.at),
      registered.scheduledOpenAt ? this.jobs.cancelOpen(id, registered.scheduledOpenAt) : undefined,
      this.jobs.cancelClose(id, registered.closeAt),
    ]);
    return market;
  }

  /**
   * 반려: an admin other than the requester ends the market's waiting request `requestId` with a
   * reason, in any status — so a request still waiting after the open ends too. Refused as the
   * approval is up to its decision: `requestId` 'unknown', APPROVAL_NOT_ALLOWED `retracted`,
   * `decided` or `requester`. Writes `market_cancel_reject`; the market is unchanged, and nothing
   * is published.
   */
  async reject(
    adminId: string,
    id: string,
    requestId: string,
    body: WithoutExpectedAccount<RejectMarketCancelBody>,
  ): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.decidable(tx, adminId, id, requestId);
      const decided = await this.approvals.reject(adminId, request.id, body.reason, tx);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_cancel_reject',
        targetType: 'market',
        targetId: id,
        payload: {
          approvalId: request.id,
          reason: decided.decisionReason ?? body.reason,
        } satisfies MarketCancelRejectActionPayload,
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
   * `not_requester`, `retracted` or `decided`. Writes `market_cancel_retract` at the retraction's
   * instant; nothing else changes, and nothing is published.
   */
  async retract(adminId: string, id: string, requestId: string): Promise<AdminMarket> {
    return this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      const request = await this.requestOf(tx, id, requestId);
      const retracted = await this.approvals.retract(adminId, request.id, tx);
      if (retracted.retractedAt === null) {
        throw new AppError('INTERNAL', { message: 'Approval retraction has no instant' });
      }
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_cancel_retract',
        targetType: 'market',
        targetId: id,
        payload: { approvalId: request.id } satisfies MarketCancelRetractActionPayload,
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

  /** `GET /admin/market-cancel-requests` (시장 취소 대기): the oldest request first. */
  list(query: CursorQuery): Promise<Page<AdminMarketCancelItem>> {
    return listMarketCancelRequests(this.db, query);
  }

  /**
   * The market's cancel request `requestId`, or VALIDATION_ERROR naming `requestId` 'unknown' —
   * another market's, another kind's or none (as #114's next-path requests).
   */
  private async requestOf(
    tx: Tx,
    marketId: string,
    requestId: string,
  ): Promise<MarketCancelRequestRow> {
    const request = await marketCancelRequestOf(tx, marketId, requestId);
    if (!request) {
      throw fieldError('requestId', 'Not a cancel request of this market', 'unknown');
    }
    return request;
  }

  /**
   * The request a decision names (`requestOf`), still waiting and not the deciding admin's, under
   * the shared admin-roles lock the decision takes (the class's lock order, so the clock read after
   * it follows every lock): APPROVAL_NOT_ALLOWED `retracted` or `decided` for one no longer
   * waiting, then `requester` — as #114's decisions (MarketPauseService).
   */
  private async decidable(
    tx: Tx,
    adminId: string,
    marketId: string,
    requestId: string,
  ): Promise<MarketCancelRequestRow> {
    const request = await this.requestOf(tx, marketId, requestId);
    await lockAdminRoles(tx, 'shared');
    if (request.status === 'retracted') throw approvalNotAllowed('retracted');
    if (request.status !== 'pending') throw approvalNotAllowed('decided');
    if (request.requestedBy === adminId) throw approvalNotAllowed('requester');
    return request;
  }
}
