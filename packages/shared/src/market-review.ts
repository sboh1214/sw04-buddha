import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { uuidSchema } from './api/uuid.js';
import { type ApprovalRefusal, approvalReasonSchema } from './approvals.js';
import { type MarketEventType, type MarketStatus, marketStatusSchema } from './enums.js';
import { expectedAccountIdSchema } from './expected-account.js';
import { storableInstantSchema } from './market-rules.js';

/**
 * 개설 검수 (#78, ADR-0099; ADR-0093 decision 1 #173 items 1·12, decision 2 #172 items 4·5·6·12·13,
 * decision 3 '#78 수정 기록의 사유' and '#21 앞당긴 개장'):
 *
 * - 검수 제출 (DRAFT → REVIEW, `POST /admin/markets/:id/submit`, the body of the close,
 *   `expectedAccountBodySchema`): any admin, once the open-items check (`missingOpenItems`) passes
 *   and the close is still ahead. It opens a `market_review` approval request (#171, approvals.ts)
 *   and locks the content (#172 item 6 (a)): nothing of a market in REVIEW or SCHEDULED is edited.
 * - 승인 (REVIEW → SCHEDULED) and 반려 (REVIEW → DRAFT, #173 item 1: no end state of its own): an
 *   admin other than the creator, anyone who edited the market's content before, and the submitter
 *   (MARKET_REVIEW_EXCLUSIONS, #172 item 5), the open-items check passing again. An approval
 *   confirms every MARKET_REVIEW_CHECKLIST item with a reason; a 반려 names one of
 *   MARKET_REJECT_REASONS with a description. An approval at or past the scheduled open also opens
 *   the market in the same transaction (SCHEDULED → OPEN, #21, ADR-0100; #172 item 6); otherwise
 *   the worker opens it at that time.
 * - 되돌리기 (REVIEW or SCHEDULED → DRAFT): any admin, with a reason, to edit the market and have it
 *   reviewed again (#172 item 6) — the only way on for a SCHEDULED market whose close has passed,
 *   which never opens (#21).
 * - 예정 개장 시각 변경 (SCHEDULED, no status change): any admin, with a reason, without a new review;
 *   the order rule is checked again (#172 item 6, ADR-0093 decision 3 '#21 앞당긴 개장'). A time
 *   that has already come opens the market at once, in the same transaction (#21): to open early,
 *   move the scheduled open earlier — there is no other early open.
 *
 * Every one writes a `market_events` row of MARKET_REVIEW_EVENT_TYPES and an `admin_actions` row
 * (`market_submit` … `market_reschedule`, enums.ts), and the admin detail shows them back as the
 * 검수 기록 (`AdminMarket.review.log`); an approval or a reschedule that opens the market also
 * writes its own `opened` event, outside the 검수 기록, and no admin action. The bot budget and the
 * config version are #72's: neither the check nor the checklist names them until #72 adds them.
 */

/** `approval_requests.kind` of a review (#171: lower-case words joined by `_`); target `market`. */
export const MARKET_REVIEW_APPROVAL_KIND = 'market_review';

/**
 * `approval_requests.request_reason` of a review (NOT NULL and non-blank): the submission takes no
 * reason of its own, so the request names what it asks for.
 */
export const MARKET_REVIEW_REQUEST_REASON = '시장 개설 검수';

/**
 * 검수 체크리스트 (ADR-0093 decision 2 #172 item 4), in the screen's order: the plan's three bans —
 * a question whose result is already known (`knownResult`), an ambiguous criterion (`ambiguity`),
 * the same conditions as an unfinished market (`duplicate`, MARKET_REVIEW_UNFINISHED_STATUSES) —
 * then the required items (`requiredItems`), the order of the times, the minimum trading period and
 * the gaps between them (`timeOrder`, #172 item 12: the reviewer's), the lead close (`leadClose`,
 * #172 item 13: the gap before the announcement, '없음' only for an event with no scheduled release,
 * a match closing before it starts and an election before the polls close) and independent
 * judgement (`independence`, #172 item 3: no market's result is a judgement condition). An approval
 * confirms every one (`isCompleteReviewChecklist`). The bot budget and the config version join it
 * with #72.
 */
export const MARKET_REVIEW_CHECKLIST = [
  'knownResult',
  'ambiguity',
  'duplicate',
  'requiredItems',
  'timeOrder',
  'leadClose',
  'independence',
] as const;
export type MarketReviewChecklistItem = (typeof MARKET_REVIEW_CHECKLIST)[number];
export const marketReviewChecklistItemSchema = z
  .enum(MARKET_REVIEW_CHECKLIST)
  .meta({ id: 'MarketReviewChecklistItem' });

/**
 * 반려 사유 (#172 item 4: one reason from a list and a description): the checklist item the market
 * fails, or `other`. The creator reads it, with the description, in the 검수 기록 (no notification).
 */
export const MARKET_REJECT_REASONS = [...MARKET_REVIEW_CHECKLIST, 'other'] as const;
export type MarketRejectReason = (typeof MARKET_REJECT_REASONS)[number];
export const marketRejectReasonSchema = z
  .enum(MARKET_REJECT_REASONS)
  .meta({ id: 'MarketRejectReason' });

/**
 * The statuses of an unfinished market, the window of the checklist's 중복 (#172 item 4: "검수
 * 중부터 판정 확정 전까지"): from REVIEW until the result is confirmed. The admin detail lists the
 * markets in them with the same YES condition and event deadline (`sameCondition`) as an aid; the
 * reviewer still decides.
 */
export const MARKET_REVIEW_UNFINISHED_STATUSES = [
  'review',
  'scheduled',
  'open',
  'paused',
  'closed',
  'provisional',
] as const satisfies readonly MarketStatus[];
export type MarketReviewUnfinishedStatus = (typeof MARKET_REVIEW_UNFINISHED_STATUSES)[number];

/**
 * Who may not approve or reject a review (#172 item 5, issue #78), in the precedence a refusal
 * names them by (APPROVAL_NOT_ALLOWED, one of APPROVAL_REFUSALS):
 * - `creator`: the market's creator (`markets.created_by`; a proposal's adopter, ADR-0089);
 * - `editor`: an admin who edited its content before (a `market_update` or `market_reschedule`
 *   record on it — the scheduled open is content, #172 item 7 — at any time, every review cycle
 *   included);
 * - `requester`: the submitter, whom the two-person rule refuses anyway (approvals.ts).
 * A 되돌리기 is open to every admin, the creator included (#172 item 6).
 */
export const MARKET_REVIEW_EXCLUSIONS = [
  'creator',
  'editor',
  'requester',
] as const satisfies readonly ApprovalRefusal[];
export type MarketReviewExclusion = (typeof MARKET_REVIEW_EXCLUSIONS)[number];

/** The people a review's exclusions name, by account id. */
export interface MarketReviewParties {
  /** The market's creator. */
  createdBy: string;
  /** Every admin with a `market_update` or `market_reschedule` record on it. */
  editorIds: readonly string[];
  /** The submitter of the pending request; null when none is pending. */
  requestedBy: string | null;
}

/**
 * Why `adminId` may not approve or reject the review — the first of MARKET_REVIEW_EXCLUSIONS that
 * holds — or null when they may. The server refuses with it; the screen disables the buttons by it.
 */
export function marketReviewExclusion(
  adminId: string,
  parties: MarketReviewParties,
): MarketReviewExclusion | null {
  if (adminId === parties.createdBy) return 'creator';
  if (parties.editorIds.includes(adminId)) return 'editor';
  if (adminId === parties.requestedBy) return 'requester';
  return null;
}

/** Whether a checklist confirms every MARKET_REVIEW_CHECKLIST item, each exactly once. */
export function isCompleteReviewChecklist(checklist: readonly string[]): boolean {
  const confirmed = new Set(checklist);
  return (
    checklist.length === MARKET_REVIEW_CHECKLIST.length &&
    confirmed.size === checklist.length &&
    MARKET_REVIEW_CHECKLIST.every((item) => confirmed.has(item))
  );
}

/** The refusal of an incomplete checklist, on `checklist` (VALIDATION_ERROR). */
export const REVIEW_CHECKLIST_INCOMPLETE = 'every item must be confirmed';

// ---- bodies ---------------------------------------------------------------------------
/**
 * `POST /admin/markets/:id/approve` (#78): every checklist item confirmed, each once, in any order
 * (`isCompleteReviewChecklist`, refused on `checklist` before anything is read), the approving
 * admin's reason (approvals.ts: required, trimmed) and the admin on screen (ADR-0092). The answer
 * is the market after it: SCHEDULED, or OPEN when its scheduled open had already come — the
 * approval opened it at once (#21, ADR-0100; ADR-0093 decision 2 #172 item 6).
 */
export const approveMarketReviewBodySchema = z
  .object({
    /**
     * The pending request the deciding admin reviewed (`AdminMarket.review.pending.requestId`): a
     * market sent back and submitted again since is a new request on content they never saw, so
     * the server decides nothing unless this is still the pending one (Codex review of #78).
     * Lower-cased (`uuidSchema`), as the stored id is, so the comparison holds for any casing.
     */
    requestId: uuidSchema,
    checklist: z
      .array(marketReviewChecklistItemSchema)
      .refine(isCompleteReviewChecklist, REVIEW_CHECKLIST_INCOMPLETE),
    reason: approvalReasonSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'ApproveMarketReviewBody' });
export type ApproveMarketReviewBody = z.infer<typeof approveMarketReviewBodySchema>;

/**
 * `POST /admin/markets/:id/reject` (#78, 반려): one of MARKET_REJECT_REASONS and the description
 * the creator reads (`reason`, required — the request's decision reason too), and the admin on
 * screen.
 */
export const rejectMarketReviewBodySchema = z
  .object({
    /** The pending request the deciding admin reviewed, as the approval names it. */
    requestId: uuidSchema,
    rejectReason: marketRejectReasonSchema,
    reason: approvalReasonSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'RejectMarketReviewBody' });
export type RejectMarketReviewBody = z.infer<typeof rejectMarketReviewBodySchema>;

/**
 * `POST /admin/markets/:id/revert` (#78, 되돌리기, from REVIEW or SCHEDULED): why, required — every
 * change after the submission records one (ADR-0093 decision 3 '#78 수정 기록의 사유') — and the
 * admin on screen.
 */
export const revertMarketBodySchema = z
  .object({ reason: approvalReasonSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'RevertMarketBody' });
export type RevertMarketBody = z.infer<typeof revertMarketBodySchema>;

/**
 * `POST /admin/markets/:id/reschedule` (#78, SCHEDULED only): the new 예정 개장 시각 — an instant as
 * the create and update bodies take it, required; before the close in whole minutes (the
 * service's, `timeRuleViolations`), and a past one is allowed: the reschedule then opens the market
 * at once, in the same transaction, and answers the OPEN market (#21, ADR-0100) — and why,
 * required (ADR-0093 decision 3 '#21 앞당긴 개장').
 */
export const rescheduleMarketOpenBodySchema = z
  .object({
    scheduledOpenAt: storableInstantSchema,
    reason: approvalReasonSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'RescheduleMarketOpenBody' });
export type RescheduleMarketOpenBody = z.infer<typeof rescheduleMarketOpenBodySchema>;

// ---- records --------------------------------------------------------------------------
/** The market event types the review writes (enums.ts documents each), the 검수 기록's entries. */
export const MARKET_REVIEW_EVENT_TYPES = [
  'submitted',
  'approved',
  'rejected',
  'reverted',
  'open_rescheduled',
] as const satisfies readonly MarketEventType[];
export type MarketReviewEventType = (typeof MARKET_REVIEW_EVENT_TYPES)[number];
export const marketReviewEventTypeSchema = z
  .enum(MARKET_REVIEW_EVENT_TYPES)
  .meta({ id: 'MarketReviewEventType' });

/** `submitted`'s payload: the request it opened and the lead-close gap the check used. */
export interface MarketSubmittedPayload {
  approvalId: string;
  /** Null while the release setting is undecided and no announcement needs it. */
  leadCloseGapMinutes: number | null;
}
/** `approved`'s payload (and `market_approve`'s). */
export interface MarketApprovedPayload {
  approvalId: string;
  checklist: MarketReviewChecklistItem[];
  reason: string;
}
/** `rejected`'s payload (and `market_reject`'s). */
export interface MarketRejectedPayload {
  approvalId: string;
  rejectReason: MarketRejectReason;
  reason: string;
}
/** `reverted`'s payload; `market_revert` adds `from`, the status it left. */
export interface MarketRevertedPayload {
  approvalId: string;
  reason: string;
}
/** `open_rescheduled`'s payload (and `market_reschedule`'s): ISO instants. */
export interface MarketOpenRescheduledPayload {
  before: string;
  after: string;
  reason: string;
}

/**
 * One entry of the 검수 기록 (`AdminMarket.review.log`): a review event as the admin detail shows
 * it — who (null when the account behind the event's actor is gone), when, the status change (both
 * null for `open_rescheduled`) and what the event's payload says, each field null where its type
 * carries none: the reason of an approval, a 반려, a 되돌리기 or a reschedule (null for a
 * submission), a 반려's reason from the list, an approval's checklist, and a reschedule's times.
 */
export const marketReviewLogEntrySchema = z
  .object({
    type: marketReviewEventTypeSchema,
    actor: adminAccountActorSchema.nullable(),
    at: z.iso.datetime(),
    fromStatus: marketStatusSchema.nullable(),
    toStatus: marketStatusSchema.nullable(),
    reason: z.string().nullable(),
    rejectReason: marketRejectReasonSchema.nullable(),
    checklist: z.array(marketReviewChecklistItemSchema).nullable(),
    scheduledOpenBefore: z.iso.datetime().nullable(),
    scheduledOpenAfter: z.iso.datetime().nullable(),
  })
  .meta({ id: 'MarketReviewLogEntry' });
export type MarketReviewLogEntry = z.infer<typeof marketReviewLogEntrySchema>;

/** The pending review request: who submitted the market and when. */
export const marketReviewPendingSchema = z
  .object({
    requestId: z.uuid(),
    requestedBy: adminAccountActorSchema,
    requestedAt: z.iso.datetime(),
  })
  .meta({ id: 'MarketReviewPending' });
export type MarketReviewPending = z.infer<typeof marketReviewPendingSchema>;

/** An unfinished market with the same YES condition and event deadline (the 중복 aid). */
export const marketReviewSameConditionSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    title: z.string(),
    status: marketStatusSchema,
  })
  .meta({ id: 'MarketReviewSameCondition' });
export type MarketReviewSameCondition = z.infer<typeof marketReviewSameConditionSchema>;

/**
 * `AdminMarket.review`, in every status (#78): what the reviewer reads and who may not decide.
 */
export const adminMarketReviewSchema = z
  .object({
    /** The pending `market_review` request: set exactly while the market is in REVIEW. */
    pending: marketReviewPendingSchema.nullable(),
    /** The creator (`AdminMarket.createdBy` is its id). */
    createdBy: adminAccountActorSchema,
    /**
     * Every admin with a `market_update` or `market_reschedule` record on the market, the first
     * edit first — the creator too when they edited it. The exclusions' `editor`.
     */
    editors: z.array(adminAccountActorSchema),
    /**
     * The other markets in MARKET_REVIEW_UNFINISHED_STATUSES with exactly the same YES condition
     * (trimmed) and event deadline (the same instant), the checklist's 중복 aid; empty while
     * either is blank.
     */
    sameCondition: z.array(marketReviewSameConditionSchema),
    /** The 검수 기록, newest first. */
    log: z.array(marketReviewLogEntrySchema),
  })
  .meta({ id: 'AdminMarketReview' });
export type AdminMarketReview = z.infer<typeof adminMarketReviewSchema>;

// ---- the queue ------------------------------------------------------------------------
/**
 * One row of `GET /admin/market-reviews` (검수 대기, #78; query `cursorQuerySchema`): a market in
 * REVIEW and its pending request, the oldest request first. `categoryName` is the category's
 * `nameKo`.
 */
export const adminMarketReviewItemSchema = z
  .object({
    marketId: z.uuid(),
    slug: z.string(),
    title: z.string(),
    categoryName: z.string(),
    scheduledOpenAt: z.iso.datetime().nullable(),
    closeAt: z.iso.datetime(),
    requestedBy: adminAccountActorSchema,
    requestedAt: z.iso.datetime(),
    createdBy: adminAccountActorSchema,
  })
  .meta({ id: 'AdminMarketReviewItem' });
export type AdminMarketReviewItem = z.infer<typeof adminMarketReviewItemSchema>;
