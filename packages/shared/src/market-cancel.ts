import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { approvalReasonSchema } from './approvals.js';
import { approvalStatusSchema, marketStatusSchema } from './enums.js';
import {
  type ExpectedAccountBody,
  expectedAccountBodySchema,
  expectedAccountIdSchema,
} from './expected-account.js';
import { marketPauseReviewResultSchema } from './market-pause.js';

/**
 * 거래 없는 시장의 취소 (#20, ADR-0117; ADR-0107 결정 5 '#20·#120 거래가 전혀 없던과 자동
 * CANCELLED', '#20 운영자의 취소 경로', '#20 CANCELLED 시장의 결과 유형', '#20 CANCELLED의
 * 라벨·공개·필터', 결정 4 '#120·#20'; ADR-0093 decision 1 #173 items 1·2·10·13). A market ends
 * CANCELLED by three paths, each the `cancelled` market event (enums.ts) with a `source`:
 *
 * - `job`: the worker's close at `close_at` (`closeMarketAtClose`, @buddha/db) finds no fill with a
 *   person's account on either side — OPEN or PAUSED → CANCELLED instead of CLOSED, actor NULL;
 * - `early_close`: the approved 조기 마감 of a PAUSED market (`endMarketPause`, #114) finds the same
 *   — PAUSED → CANCELLED instead of CLOSED, the approver the actor;
 * - `operator`: one admin asks to cancel a SCHEDULED market with a reason (`market_cancel`, the
 *   two-person rule, approvals.ts) and an admin other than the requester approves it —
 *   SCHEDULED → CANCELLED, the approver the actor. No operator path leaves OPEN, PAUSED or CLOSED
 *   for CANCELLED: an OPEN market ends by its close or by a pause and its approved early close.
 *
 * The judgement is the fills' (`marketHasHumanFill`, @buddha/db: every fill with a person's
 * account on either side, abnormal or not — #177 13·14항), read in the close's transaction under
 * the market lock — never `trader_count`. A pair mint is one fill; bot preparation and orders that
 * never filled are not trading. CANCELLED is terminal: its result type stays empty (never VOID),
 * and no judgement, 판정 이의 or payout follows. Every remaining order ends 만료 in the same
 * transaction, the 운영 마켓메이커's too, but a market held for a ledger failure keeps its orders
 * locked until #93's recovery (결정 4 #178). Its reason — the system sentence for the automatic two,
 * the request's reason for the operator's — is stored in the event's payload for the public
 * judging record (#24); admins alone read it for now.
 */

/** `approval_requests.kind` of a SCHEDULED market's cancel (#171: lower-case words, `_`). */
export const MARKET_CANCEL_APPROVAL_KIND = 'market_cancel';

/**
 * The reason every automatic CANCELLED stores (`job` and `early_close` alike), as text, so a later
 * copy change never rewrites a record: the public judging record shows it (#24, ADR-0107 결정 5
 * '#20 CANCELLED의 라벨·공개·필터' — a system sentence). It says no '사용자': a public sentence must
 * not hint that accounts other than people's trade.
 */
export const MARKET_NO_FILL_CANCEL_REASON =
  '거래가 끝날 때까지 체결이 한 건도 없어 결과를 정하지 않고 시장을 취소했습니다.';

/** Which path cancelled the market: the `cancelled` event's payload `source`. */
export const MARKET_CANCEL_SOURCES = ['job', 'early_close', 'operator'] as const;
export type MarketCancelSource = (typeof MARKET_CANCEL_SOURCES)[number];

// ---- the event ------------------------------------------------------------------------
const cancelledBase = { cancelledAt: z.iso.datetime(), reason: z.string() };

/**
 * `cancelled`'s payload (enums.ts), by its source. Each carries the cancel's instant (ISO) and its
 * reason:
 * - `job`: the system sentence; the actor is NULL (the worker);
 * - `early_close`: the system sentence and `MarketEarlyClosedPayload`'s fields — the pause it
 *   ended, the approved `market_pause_decision` request, its requester and the review result; the
 *   actor is the approver;
 * - `operator`: the request's reason (the public one — the decision reasons stay with admins,
 *   결정 4 '#24 싣지 않는 기록'), the approved `market_cancel` request and its requester; the actor
 *   is the approver.
 */
export const marketCancelledPayloadSchema = z.discriminatedUnion('source', [
  z.object({ ...cancelledBase, source: z.literal('job') }),
  z.object({
    ...cancelledBase,
    source: z.literal('early_close'),
    pauseId: z.uuid(),
    approvalId: z.uuid(),
    requestedBy: z.string(),
    reviewResult: marketPauseReviewResultSchema.nullable(),
  }),
  z.object({
    ...cancelledBase,
    source: z.literal('operator'),
    approvalId: z.uuid(),
    requestedBy: z.string(),
  }),
]);
export type MarketCancelledPayload = z.infer<typeof marketCancelledPayloadSchema>;

/** `cancelled`'s payload by the worker's close at `close_at`. */
export type MarketCancelledByJobPayload = Extract<MarketCancelledPayload, { source: 'job' }>;

/** `cancelled`'s payload by an approved early close (`MarketEarlyClosedPayload`'s fields). */
export type MarketCancelledEarlyPayload = Extract<
  MarketCancelledPayload,
  { source: 'early_close' }
>;

/** `cancelled`'s payload by an approved operator's cancel of a SCHEDULED market. */
export type MarketCancelledByOperatorPayload = Extract<
  MarketCancelledPayload,
  { source: 'operator' }
>;

// ---- refusals -------------------------------------------------------------------------
/**
 * The refusal details of a cancel request and of its approval (VALIDATION_ERROR, the API's), each
 * message under the path it names:
 * - `status`: the market is not SCHEDULED (`notScheduled` — at the request; at the approval, one
 *   opened, sent back to a draft or cancelled since);
 * - `cancel`: another request of the market is waiting (`pending`, at the request — one at a
 *   time); the market left the SCHEDULED state the request was asked in (`stale`, at the
 *   approval: sent back to a draft and approved again since — `statusEventId` moved).
 */
export const MARKET_CANCEL_REFUSALS = {
  status: { notScheduled: 'not scheduled' },
  cancel: { pending: 'pending', stale: 'stale' },
} as const;

// ---- bodies ---------------------------------------------------------------------------
/**
 * `POST /admin/markets/:id/cancel-requests` (SCHEDULED): why (`reason`, the request's reason —
 * the cancel's public reason, which the public judging record shows from #24; required and
 * trimmed) and the admin on screen (ADR-0092).
 */
export const requestMarketCancelBodySchema = z
  .object({ reason: approvalReasonSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'RequestMarketCancelBody' });
export type RequestMarketCancelBody = z.infer<typeof requestMarketCancelBodySchema>;

/**
 * `POST /admin/markets/:id/cancel-requests/:requestId/approve`: the approving admin's reason (the
 * decision reason, admins only) and the admin on screen.
 */
export const approveMarketCancelBodySchema = z
  .object({ reason: approvalReasonSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'ApproveMarketCancelBody' });
export type ApproveMarketCancelBody = z.infer<typeof approveMarketCancelBodySchema>;

/**
 * `POST /admin/markets/:id/cancel-requests/:requestId/reject` (반려, an admin other than the
 * requester, in any status): the reason and the admin on screen.
 */
export const rejectMarketCancelBodySchema = z
  .object({ reason: approvalReasonSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'RejectMarketCancelBody' });
export type RejectMarketCancelBody = z.infer<typeof rejectMarketCancelBodySchema>;

/**
 * `POST /admin/markets/:id/cancel-requests/:requestId/retract` (철회, the requester's, in any
 * status): the admin on screen and nothing else.
 */
export const retractMarketCancelBodySchema = expectedAccountBodySchema;
export type RetractMarketCancelBody = ExpectedAccountBody;

// ---- records --------------------------------------------------------------------------
/**
 * `approval_requests.payload` of a cancel request (frozen at the insert, migration 0021): the
 * market's `status_event_id` when it was asked — the event that made this SCHEDULED state. Every
 * transition moves it, so a market sent back to a draft and approved again refuses the old
 * request (`cancel` 'stale'); a reschedule is no transition and keeps it. The request reason is
 * the request's `reason`. No `.meta`: no route answers it as is.
 */
export const marketCancelRequestPayloadSchema = z.object({
  statusEventId: z.number().int().positive(),
});
export type MarketCancelRequestPayload = z.infer<typeof marketCancelRequestPayloadSchema>;

/** `market_cancel_request`'s payload (admin_actions, target `market`): the request it opened. */
export interface MarketCancelRequestActionPayload {
  approvalId: string;
  statusEventId: number;
  reason: string;
}

/**
 * `market_cancel_approve`'s payload: the request, the approver's reason and `market_update`'s
 * snapshot before and after.
 */
export interface MarketCancelApproveActionPayload {
  approvalId: string;
  reason: string;
  before: unknown;
  after: unknown;
}

/** `market_cancel_reject`'s payload: the request and the rejecting admin's reason. */
export interface MarketCancelRejectActionPayload {
  approvalId: string;
  reason: string;
}

/** `market_cancel_retract`'s payload: the request its requester retracted. */
export interface MarketCancelRetractActionPayload {
  approvalId: string;
}

// ---- read models ----------------------------------------------------------------------
/**
 * The cancel request waiting on a market (`AdminMarket.cancel.pending`): the request, its reason
 * (the public one), who asked and when. Its requester may not decide it (approvals.ts).
 */
export const marketCancelRequestSchema = z
  .object({
    requestId: z.uuid(),
    reason: z.string(),
    requestedBy: adminAccountActorSchema,
    requestedAt: z.iso.datetime(),
  })
  .meta({ id: 'MarketCancelRequest' });
export type MarketCancelRequest = z.infer<typeof marketCancelRequestSchema>;

/**
 * One cancel request of the admin detail's log (`AdminMarket.cancel.log`): the request and how it
 * ended — `status`; the decider, the decision's instant and reason (null unless decided); the
 * 철회's instant (null unless retracted).
 */
export const marketCancelLogEntrySchema = marketCancelRequestSchema
  .extend({
    status: approvalStatusSchema,
    decidedBy: adminAccountActorSchema.nullable(),
    decidedAt: z.iso.datetime().nullable(),
    decisionReason: z.string().nullable(),
    retractedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'MarketCancelLogEntry' });
export type MarketCancelLogEntry = z.infer<typeof marketCancelLogEntrySchema>;

/** `AdminMarket.cancel`, in every status (#20): the waiting request and every request. */
export const adminMarketCancelStateSchema = z
  .object({
    /** The waiting `market_cancel` request; null when none waits (at most one does). */
    pending: marketCancelRequestSchema.nullable(),
    /** Every cancel request of the market, the newest first, the waiting one included. */
    log: z.array(marketCancelLogEntrySchema),
  })
  .meta({ id: 'AdminMarketCancelState' });
export type AdminMarketCancelState = z.infer<typeof adminMarketCancelStateSchema>;

// ---- the queue ------------------------------------------------------------------------
/**
 * One row of `GET /admin/market-cancel-requests` (시장 취소 대기, #20; query `cursorQuerySchema`):
 * a waiting cancel request and its market, the oldest request first — on a market opened or sent
 * back since too (`status`), which only a 반려 or a 철회 ends.
 */
export const adminMarketCancelItemSchema = z
  .object({
    requestId: z.uuid(),
    marketId: z.uuid(),
    slug: z.string(),
    title: z.string(),
    status: marketStatusSchema,
    scheduledOpenAt: z.iso.datetime().nullable(),
    closeAt: z.iso.datetime(),
    reason: z.string(),
    requestedBy: adminAccountActorSchema,
    requestedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminMarketCancelItem' });
export type AdminMarketCancelItem = z.infer<typeof adminMarketCancelItemSchema>;
