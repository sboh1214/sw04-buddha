import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { approvalReasonSchema } from './approvals.js';
import { type MarketStatus, approvalStatusSchema, marketStatusSchema } from './enums.js';
import {
  type ExpectedAccountBody,
  expectedAccountBodySchema,
  expectedAccountIdSchema,
} from './expected-account.js';
import { storableInstantSchema } from './market-rules.js';

/**
 * 거래 일시 중단·재개·조기 마감 (#114, ADR-0102; ADR-0093 decision 1 #173 items 1–4·13, decision 2
 * #172 item 14, decision 3 '#114 조기 결과의 공개 시각', and the owner's answers of 2026-11-02):
 *
 * - 일시 중단 (OPEN → PAUSED, `POST /admin/markets/:id/pause`): one admin, at once (#173 item 2),
 *   with one of MARKET_PAUSE_REASONS — these three only (#173 item 3) — and a note saying what
 *   happened; for `early_result` also the publication instant the operator confirmed, kept in UTC
 *   (decision 3). Refused once the close has come, by the clock too. One `market_pauses` row
 *   (@buddha/db) per pause; a market may pause again after a resume. The pending orders are
 *   cancelled at the pause (#173 item 3), which M9 adds in the same place (#119, #178).
 * - 재개 (PAUSED → OPEN) or 조기 마감 (PAUSED → CLOSED): one admin asks for the next path
 *   (`POST /admin/markets/:id/pause-decisions`, MARKET_PAUSE_PATHS), a `basis_change` pause with
 *   its review result (MARKET_PAUSE_REVIEW_RESULTS), which opens a `market_pause_decision` approval
 *   request (#171, approvals.ts); an admin other than the requester approves it (#173 item 2) — the
 *   admin who paused may ask or approve. One waits per market at a time. 판정 불가 leaves the early
 *   close alone: no reopening on rules that cannot judge the market, and VOID is the judgement's,
 *   after the close (#173 item 4, #152). 판정 가능, and a pause for either other reason, leaves the
 *   operator the choice (Q1); a schedule moved earlier, the result still unknown, is a
 *   `basis_change` pause reviewed 판정 가능 and closed early (Q2).
 * - The close at `close_at` still comes while PAUSED, on schedule and never later (#173 items 1·3):
 *   the worker closes the market and ends its pause (`closed_at_close`). A decision still waiting
 *   is moot then — its approval is refused, while its 반려 (an admin other than the requester) and
 *   its 철회 (the requester) end it in any status. An early close keeps `close_at`, the scheduled
 *   close (a rule-version item, #80); the `closed` event's `closedAt` is the actual close.
 *
 * The pause and the approval write a market event (`paused`; `resumed` or `closed`, enums.ts), and
 * every step an `admin_actions` row (`market_pause`, `market_pause_decision_request` …). Admins
 * alone read the pauses for now: the public judging record shows the reason and the pause and
 * resume times (#173 item 13) from #24, which reads `market_pauses`; neither the note nor the
 * publication instant is promised public.
 */

/** `approval_requests.kind` of a paused market's next path (#171: lower-case words, `_`). */
export const MARKET_PAUSE_DECISION_APPROVAL_KIND = 'market_pause_decision';

// ---- reasons, review results, paths, ends ---------------------------------------------
/**
 * 일시 중단 사유 (ADR-0093 decision 1 #173 item 3: these three only), `market_pauses.reason`:
 * - `early_result`: 사건 선공개 — the result became known before the close (N03 §3, 조기 결과).
 *   The pause records when it was published (`resultPublishedAt`, decision 3);
 * - `ledger_failure`: 담보·원장 장애 (N03 §3); its orders are cancelled after the recovery (M9);
 * - `basis_change`: 실질 기준 변경 (N03 §4) — what the market asks changed in substance, or the
 *   event's schedule moved earlier with the result still unknown (Q2). Its next path carries a
 *   review result (`pauseReasonNeedsReview`).
 */
export const MARKET_PAUSE_REASONS = ['early_result', 'ledger_failure', 'basis_change'] as const;
export type MarketPauseReason = (typeof MARKET_PAUSE_REASONS)[number];
export const marketPauseReasonSchema = z
  .enum(MARKET_PAUSE_REASONS)
  .meta({ id: 'MarketPauseReason' });

/** Whether a pause for `reason` records the result's publication instant: `early_result` alone. */
export function pauseReasonNeedsPublishedAt(reason: MarketPauseReason): boolean {
  return reason === 'early_result';
}

/** Whether the next path of a pause for `reason` carries a review result: `basis_change` alone. */
export function pauseReasonNeedsReview(reason: MarketPauseReason): boolean {
  return reason === 'basis_change';
}

/**
 * 검토 결과 of a `basis_change` pause (owner answer Q1, 2026-11-02), given with the next-path
 * request and kept on the pause once approved (`market_pauses.review_result`):
 * - `judgeable`: 기존 규칙으로 판정 가능 — the operator picks 재개 or 조기 마감;
 * - `not_judgeable`: 판정 불가 — 조기 마감 only, and the judgement then applies the VOID rule
 *   (#152; #173 item 4: no VOID before the close).
 */
export const MARKET_PAUSE_REVIEW_RESULTS = ['judgeable', 'not_judgeable'] as const;
export type MarketPauseReviewResult = (typeof MARKET_PAUSE_REVIEW_RESULTS)[number];
export const marketPauseReviewResultSchema = z
  .enum(MARKET_PAUSE_REVIEW_RESULTS)
  .meta({ id: 'MarketPauseReviewResult' });

/** 다음 경로 of a paused market (#173 items 2·4): 재개 or 조기 마감, each another admin's approval. */
export const MARKET_PAUSE_PATHS = ['resume', 'early_close'] as const;
export type MarketPausePath = (typeof MARKET_PAUSE_PATHS)[number];
export const marketPausePathSchema = z.enum(MARKET_PAUSE_PATHS).meta({ id: 'MarketPausePath' });

/** The status each path takes a PAUSED market to (MARKET_LIFECYCLE_TRANSITIONS' paused edges). */
export const MARKET_PAUSE_PATH_STATUSES = {
  resume: 'open',
  early_close: 'closed',
} as const satisfies Record<MarketPausePath, MarketStatus>;

/**
 * How a pause ended (`market_pauses.end_kind`, null while it lasts): `resumed` and `early_closed`
 * by an approved next path (MARKET_PAUSE_PATH_END_KINDS), `closed_at_close` by the worker's close
 * at `close_at` — no review and no approval (#173 items 1·3).
 */
export const MARKET_PAUSE_END_KINDS = ['resumed', 'early_closed', 'closed_at_close'] as const;
export type MarketPauseEndKind = (typeof MARKET_PAUSE_END_KINDS)[number];
export const marketPauseEndKindSchema = z
  .enum(MARKET_PAUSE_END_KINDS)
  .meta({ id: 'MarketPauseEndKind' });

/** The end an approved path gives the pause. */
export const MARKET_PAUSE_PATH_END_KINDS = {
  resume: 'resumed',
  early_close: 'early_closed',
} as const satisfies Record<MarketPausePath, MarketPauseEndKind>;

// ---- refusals -------------------------------------------------------------------------
/**
 * The refusal details of a pause and of a next-path request or approval (VALIDATION_ERROR, the
 * API's), each message under the path it names:
 * - `status`: a pause of a market that is not OPEN (`notOpen` — a PAUSED one included); a request
 *   or an approval on one that is not PAUSED (`notPaused` — closed at its close, or the other
 *   path approved);
 * - `closeAt`: its close has come — by the clock too, since a market stays OPEN or PAUSED past its
 *   close until the worker closes it (ADR-0101's `closed`);
 * - `pause`: the request's pause is not the market's current one (`stale` — at the request, the
 *   pause the body names; at the approval, the pause the request named); another request of the
 *   market is waiting (`pending`, at the request — one at a time);
 * - `reviewResult`: a `basis_change` pause's request without one (`required`), another reason's
 *   with one (`basisChangeOnly`);
 * - `path`: 재개 asked with `not_judgeable` (`earlyCloseOnly`);
 * - `resultPublishedAt`: an `early_result` pause without it (`required`), another reason's with
 *   one (`earlyResultOnly`) — both the body's own (`pauseMarketBodySchema`) — or an instant after
 *   the pause's (`afterPause`, the database clock's).
 */
export const MARKET_PAUSE_REFUSALS = {
  status: { notOpen: 'not open', notPaused: 'not paused' },
  closeAt: { closed: 'closed' },
  pause: { pending: 'pending', stale: 'stale' },
  reviewResult: { required: 'required', basisChangeOnly: 'only for basis_change' },
  path: { earlyCloseOnly: 'early close only' },
  resultPublishedAt: {
    required: 'required',
    earlyResultOnly: 'only for early_result',
    afterPause: 'after the pause',
  },
} as const;

type ReviewResultRefusals = (typeof MARKET_PAUSE_REFUSALS)['reviewResult'];

/** A next path refused for the pause's reason: the path the detail names and its message. */
export type MarketPauseDecisionRefusal =
  | { path: 'reviewResult'; message: ReviewResultRefusals[keyof ReviewResultRefusals] }
  | { path: 'path'; message: typeof MARKET_PAUSE_REFUSALS.path.earlyCloseOnly };

/**
 * Why a next path is refused for a pause of `reason` — the review result first, then the path —
 * or null when it may be asked for (Q1, #173 item 4). The request refuses with it once the market
 * passed the status, close, pause (stale, pending) and decider checks; the screen disables 재개 by
 * it.
 */
export function pauseDecisionRefusal(
  reason: MarketPauseReason,
  decision: { path: MarketPausePath; reviewResult?: MarketPauseReviewResult | null },
): MarketPauseDecisionRefusal | null {
  const reviewResult = decision.reviewResult ?? null;
  if (pauseReasonNeedsReview(reason) && reviewResult === null) {
    return { path: 'reviewResult', message: MARKET_PAUSE_REFUSALS.reviewResult.required };
  }
  if (!pauseReasonNeedsReview(reason) && reviewResult !== null) {
    return { path: 'reviewResult', message: MARKET_PAUSE_REFUSALS.reviewResult.basisChangeOnly };
  }
  if (reviewResult === 'not_judgeable' && decision.path === 'resume') {
    return { path: 'path', message: MARKET_PAUSE_REFUSALS.path.earlyCloseOnly };
  }
  return null;
}

// ---- bodies ---------------------------------------------------------------------------
/**
 * `POST /admin/markets/:id/pause` (one admin, OPEN → PAUSED): the reason, the note saying what
 * happened (required and trimmed, approvals.ts; admins only), the result's publication instant —
 * required for `early_result` and refused for any other reason (null or left out), from
 * STORABLE_INSTANT_MIN on, not after the pause (the service's) — and the admin on screen
 * (ADR-0092).
 */
export const pauseMarketBodySchema = z
  .object({
    reason: marketPauseReasonSchema,
    note: approvalReasonSchema,
    resultPublishedAt: storableInstantSchema.nullish(),
    expectedAccountId: expectedAccountIdSchema,
  })
  .superRefine((body, ctx) => {
    const given = body.resultPublishedAt != null;
    if (pauseReasonNeedsPublishedAt(body.reason) && !given) {
      ctx.addIssue({
        code: 'custom',
        path: ['resultPublishedAt'],
        message: MARKET_PAUSE_REFUSALS.resultPublishedAt.required,
      });
    } else if (!pauseReasonNeedsPublishedAt(body.reason) && given) {
      ctx.addIssue({
        code: 'custom',
        path: ['resultPublishedAt'],
        message: MARKET_PAUSE_REFUSALS.resultPublishedAt.earlyResultOnly,
      });
    }
  })
  .meta({ id: 'PauseMarketBody' });
export type PauseMarketBody = z.infer<typeof pauseMarketBodySchema>;

/**
 * `POST /admin/markets/:id/pause-decisions` (PAUSED): the pause the request is about — the one its
 * author saw (`AdminMarket.pause.history[0]`), as #80's supplements name their base version — the
 * next path, the review result (null or left out but for a `basis_change` pause), why (`reason`,
 * the request's reason, required and trimmed) and the admin on screen. A pause that is not the
 * market's lasting one is refused (`pause` 'stale'): a request asked on a pause since resumed, the
 * market paused again, decides nothing of the new pause, whose reason may allow other paths. The
 * body checks shapes alone: whether its pause is the lasting one and what that pause's reason
 * allows (`pauseDecisionRefusal`) are the service's, which reads the pause.
 */
export const requestPauseDecisionBodySchema = z
  .object({
    pauseId: z.uuid(),
    path: marketPausePathSchema,
    reviewResult: marketPauseReviewResultSchema.nullish(),
    reason: approvalReasonSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'RequestPauseDecisionBody' });
export type RequestPauseDecisionBody = z.infer<typeof requestPauseDecisionBodySchema>;

/**
 * `POST /admin/markets/:id/pause-decisions/:requestId/approve`: the approving admin's reason (the
 * request's decision reason, required and trimmed) and the admin on screen.
 */
export const approvePauseDecisionBodySchema = z
  .object({ reason: approvalReasonSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'ApprovePauseDecisionBody' });
export type ApprovePauseDecisionBody = z.infer<typeof approvePauseDecisionBodySchema>;

/**
 * `POST /admin/markets/:id/pause-decisions/:requestId/reject` (반려, an admin other than the
 * requester, in any status): the reason (the decision reason, required) and the admin on screen.
 */
export const rejectPauseDecisionBodySchema = z
  .object({ reason: approvalReasonSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'RejectPauseDecisionBody' });
export type RejectPauseDecisionBody = z.infer<typeof rejectPauseDecisionBodySchema>;

/**
 * `POST /admin/markets/:id/pause-decisions/:requestId/retract` (철회, the requester's, in any
 * status): the admin on screen and nothing else — `expectedAccountBodySchema` itself.
 */
export const retractPauseDecisionBodySchema = expectedAccountBodySchema;
export type RetractPauseDecisionBody = ExpectedAccountBody;

// ---- records --------------------------------------------------------------------------
/**
 * `approval_requests.payload` of a next-path request (frozen at the insert, migration 0021): the
 * pause it decides, the path and the review result (null but for `basis_change`); the request
 * reason is the request's `reason`. No `.meta`: no route answers it as is.
 */
export const marketPauseDecisionRequestPayloadSchema = z.object({
  pauseId: z.uuid(),
  path: marketPausePathSchema,
  reviewResult: marketPauseReviewResultSchema.nullable(),
});
export type MarketPauseDecisionRequestPayload = z.infer<
  typeof marketPauseDecisionRequestPayloadSchema
>;

/**
 * `paused`'s payload (enums.ts): the pause row, its reason and the publication instant (ISO; null
 * but for `early_result`). The event's actor is the admin who paused; the note is the pause row's
 * and `market_pause`'s alone.
 */
export interface MarketPausedPayload {
  pauseId: string;
  reason: MarketPauseReason;
  resultPublishedAt: string | null;
}

/**
 * `resumed`'s payload: the pause it ended, the approved request, its requester's id and the review
 * result (null but for `basis_change`). The event's actor is the approver.
 */
export interface MarketResumedPayload {
  pauseId: string;
  approvalId: string;
  requestedBy: string;
  reviewResult: MarketPauseReviewResult | null;
}

/**
 * `closed`'s payload for an approved early close (`source: 'early_close'`): the actual close
 * instant (ISO; `close_at` keeps the scheduled one) and `resumed`'s fields. The event's actor is
 * the approver. The worker's close at `close_at` writes `{closedAt, source: 'job'}`, a PAUSED
 * market's too.
 */
export interface MarketEarlyClosedPayload {
  closedAt: string;
  source: 'early_close';
  pauseId: string;
  approvalId: string;
  requestedBy: string;
  reviewResult: MarketPauseReviewResult | null;
}

/**
 * `market_pause`'s payload (admin_actions, target `market`): the pause row and what the body gave,
 * with `market_update`'s snapshot of the market before and after.
 */
export interface MarketPauseActionPayload {
  pauseId: string;
  reason: MarketPauseReason;
  note: string;
  resultPublishedAt: string | null;
  before: unknown;
  after: unknown;
}

/** `market_pause_decision_request`'s payload: the request it opened and what it asks for. */
export interface MarketPauseDecisionRequestActionPayload {
  approvalId: string;
  pauseId: string;
  path: MarketPausePath;
  reviewResult: MarketPauseReviewResult | null;
  reason: string;
}

/**
 * `market_pause_decision_approve`'s payload: the request's fields, the approver's reason and
 * `market_update`'s snapshot before and after.
 */
export interface MarketPauseDecisionApproveActionPayload {
  approvalId: string;
  pauseId: string;
  path: MarketPausePath;
  reviewResult: MarketPauseReviewResult | null;
  reason: string;
  before: unknown;
  after: unknown;
}

/** `market_pause_decision_reject`'s payload: the request and the rejecting admin's reason. */
export interface MarketPauseDecisionRejectActionPayload {
  approvalId: string;
  pauseId: string;
  path: MarketPausePath;
  reason: string;
}

/** `market_pause_decision_retract`'s payload: the request its requester retracted. */
export interface MarketPauseDecisionRetractActionPayload {
  approvalId: string;
  pauseId: string;
  path: MarketPausePath;
}

// ---- read models ----------------------------------------------------------------------
/**
 * One pause as the admin detail shows it (`AdminMarket.pause.history`): the reason, the note, the
 * publication instant (null but for `early_result`), who paused and when, the review result (null
 * but for a `basis_change` pause ended by an approval), and how and when it ended and who approved
 * it (all null while it lasts; `endedBy` null for `closed_at_close`, the worker's). An account
 * closed since keeps its id with a null nickname.
 */
export const adminMarketPauseSchema = z
  .object({
    id: z.uuid(),
    reason: marketPauseReasonSchema,
    note: z.string(),
    resultPublishedAt: z.iso.datetime().nullable(),
    pausedAt: z.iso.datetime(),
    pausedBy: adminAccountActorSchema,
    reviewResult: marketPauseReviewResultSchema.nullable(),
    endKind: marketPauseEndKindSchema.nullable(),
    endedAt: z.iso.datetime().nullable(),
    endedBy: adminAccountActorSchema.nullable(),
  })
  .meta({ id: 'AdminMarketPause' });
export type AdminMarketPause = z.infer<typeof adminMarketPauseSchema>;

/**
 * The next-path request waiting on a market (`AdminMarket.pause.pending`): the request, the pause
 * it decides, the path, the review result, the reason, who asked and when. Its requester may not
 * decide it (approvals.ts).
 */
export const marketPauseDecisionPendingSchema = z
  .object({
    requestId: z.uuid(),
    pauseId: z.uuid(),
    path: marketPausePathSchema,
    reviewResult: marketPauseReviewResultSchema.nullable(),
    reason: z.string(),
    requestedBy: adminAccountActorSchema,
    requestedAt: z.iso.datetime(),
  })
  .meta({ id: 'MarketPauseDecisionPending' });
export type MarketPauseDecisionPending = z.infer<typeof marketPauseDecisionPendingSchema>;

/**
 * One next-path request of the admin detail's log (`AdminMarket.pause.log`): the request as
 * `marketPauseDecisionPendingSchema` and how it ended — `status` pending, approved, rejected or
 * retracted; the decider, the decision's instant and reason (null unless decided); the 철회's
 * instant (null unless retracted).
 */
export const marketPauseDecisionLogEntrySchema = marketPauseDecisionPendingSchema
  .extend({
    status: approvalStatusSchema,
    decidedBy: adminAccountActorSchema.nullable(),
    decidedAt: z.iso.datetime().nullable(),
    decisionReason: z.string().nullable(),
    retractedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'MarketPauseDecisionLogEntry' });
export type MarketPauseDecisionLogEntry = z.infer<typeof marketPauseDecisionLogEntrySchema>;

/** `AdminMarket.pause`, in every status (#114): the pauses, the waiting request, every request. */
export const adminMarketPauseStateSchema = z
  .object({
    /**
     * Every pause of the market, the newest first: the first is the current one while it has no
     * end (`endedAt` null) — at most one has none.
     */
    history: z.array(adminMarketPauseSchema),
    /** The waiting `market_pause_decision` request; null when none waits (at most one does). */
    pending: marketPauseDecisionPendingSchema.nullable(),
    /** Every next-path request of the market, the newest first, the waiting one included. */
    log: z.array(marketPauseDecisionLogEntrySchema),
  })
  .meta({ id: 'AdminMarketPauseState' });
export type AdminMarketPauseState = z.infer<typeof adminMarketPauseStateSchema>;

// ---- the queue ------------------------------------------------------------------------
/**
 * One row of `GET /admin/market-pause-decisions` (일시 중단 결정 대기, #114; query
 * `cursorQuerySchema`): a waiting next-path request and its market, the oldest request first —
 * on a market closed at its close too, which only a 반려 or a 철회 ends. `reason` is the pause's.
 */
export const adminMarketPauseDecisionItemSchema = z
  .object({
    requestId: z.uuid(),
    marketId: z.uuid(),
    slug: z.string(),
    title: z.string(),
    status: marketStatusSchema,
    closeAt: z.iso.datetime(),
    pauseId: z.uuid(),
    reason: marketPauseReasonSchema,
    path: marketPausePathSchema,
    reviewResult: marketPauseReviewResultSchema.nullable(),
    requestedBy: adminAccountActorSchema,
    requestedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminMarketPauseDecisionItem' });
export type AdminMarketPauseDecisionItem = z.infer<typeof adminMarketPauseDecisionItemSchema>;
