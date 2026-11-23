import * as z from 'zod';
import { pageEnvelope } from './api/envelope.js';
import { cursorQuerySchema } from './api/pagination.js';
import { approvalReasonSchema } from './approvals.js';
import { settlementStepStatusSchema } from './enums.js';
import { expectedAccountIdSchema } from './expected-account.js';

/*
 * 운영 대기열 (#145 part 1, ADR-0163): `/admin/operations`'s three lists — 마감 예정 (145-1),
 * 판정 대기·지연 (145-2, 145-11, 145-17) and 정산 실패 with 처리 멈춤 and 봇 자금 회수 실패 in the same
 * list (145-4, 145-8, 145-15) — and the one operator action on that screen, 정산 다시 시도 (145-7,
 * 145-14). Every value here is a code constant, never a release setting (145-1 "선택지는 코드에
 * 두며 출시 설정이 아니다", 145-4 "30분은 코드 고정값이다"). The lists only read (AC 3): the readers
 * are @buddha/db `operations-queues.ts`, each in a READ ONLY transaction. Admin-only fields carry
 * names the PRIVATE_DATA item `operation-records` refuses in any public or owner shape
 * (#171, AC 8).
 */

// ---- 마감 예정 (145-1) ----------------------------------------------------------------
/** The windows an operator picks for 마감 예정, in screen order (145-1: 24시간·3일·7일). */
export const OPERATIONS_CLOSING_WINDOWS = ['24h', '3d', '7d'] as const;
export type OperationsClosingWindow = (typeof OPERATIONS_CLOSING_WINDOWS)[number];

/**
 * Each window as hours from now: N × 24 hours, an addition of instants as `longDelayDeadline`
 * adds days — no calendar math, so a DST change in any zone moves nothing.
 */
export const OPERATIONS_CLOSING_WINDOW_HOURS: Readonly<Record<OperationsClosingWindow, number>> = {
  '24h': 24,
  '3d': 72,
  '7d': 168,
};

/** 145-1 "처음 값은 24시간이다". */
export const OPERATIONS_CLOSING_WINDOW_DEFAULT: OperationsClosingWindow = '24h';

// ---- 처리 멈춤 (145-4) ----------------------------------------------------------------
/**
 * 145-4: a market whose automatic transition (거래 마감·결과 확정·지급 시작·지급 완료) should have
 * happened this many minutes ago and did not is listed as 처리 멈춤. A code value (145-4).
 */
export const OPERATIONS_STUCK_AFTER_MINUTES = 30;

/** The four automatic transitions 145-4 names, in the order the list labels them. */
export const OPERATIONS_STUCK_STAGES = ['close', 'confirm', 'start', 'complete'] as const;
export type OperationsStuckStage = (typeof OPERATIONS_STUCK_STAGES)[number];

// ---- 판정 대기·지연 (145-2, 145-11) ----------------------------------------------------
/** 145-2's '지연만' filter: `all` lists every row, `delayed` those that read '판정 지연'. */
export const OPERATIONS_JUDGEMENT_FILTERS = ['all', 'delayed'] as const;
export type OperationsJudgementFilter = (typeof OPERATIONS_JUDGEMENT_FILTERS)[number];

/**
 * Where a listed market stands (145-2 단계, 145-11 "판정 등록 전, 승인 대기, 이의·정정 대기"): a
 * CLOSED market with no waiting registration, one whose registration waits for another admin's
 * approval, and a PROVISIONAL market a dispute or a correction holds past its 이의 기한.
 */
export const OPERATIONS_JUDGEMENT_STAGES = [
  'unregistered',
  'awaiting_approval',
  'dispute_or_correction',
] as const;
export type OperationsJudgementStage = (typeof OPERATIONS_JUDGEMENT_STAGES)[number];

// ---- 정산 실패 (145-4, 145-6, 145-8, 145-15) -------------------------------------------
/**
 * The kinds of the 정산 실패 list, in their tie-break order (`kindOrder` = the index): a payout
 * that failed or waits on a ledger hold (the public '지급 지연', ADR-0121), a transition that did
 * not come (145-4), a bot recall that failed (145-8; failed only, 145-15).
 */
export const OPERATIONS_FAILURE_KINDS = ['settlement_failed', 'stuck', 'recall_failed'] as const;
export type OperationsFailureKind = (typeof OPERATIONS_FAILURE_KINDS)[number];

/**
 * The failed recall's codes (#181, ADR-0125 "알려진 코드만 표시"; the CHECK of
 * `market_maker_recall_attempts`): 145-15 lists failures only, never the waiting
 * `ledger_hold`·`treasury_capacity`.
 */
export const OPERATIONS_RECALL_FAILURE_REASONS = [
  'books_inconsistent',
  'recall_inconsistent',
  'execution_failed',
] as const;
export type OperationsRecallFailureReason = (typeof OPERATIONS_RECALL_FAILURE_REASONS)[number];

// ---- queries -------------------------------------------------------------------------
/** `GET /admin/operations/closing`: a cursor page of one window (default 24h, 145-1). */
export const adminOperationsClosingQuerySchema = cursorQuerySchema.extend({
  within: z.enum(OPERATIONS_CLOSING_WINDOWS).default(OPERATIONS_CLOSING_WINDOW_DEFAULT),
});
export type AdminOperationsClosingQuery = z.infer<typeof adminOperationsClosingQuerySchema>;

/** `GET /admin/operations/judgements`: a cursor page, every row or the delayed ones (145-2). */
export const adminOperationsJudgementsQuerySchema = cursorQuerySchema.extend({
  filter: z.enum(OPERATIONS_JUDGEMENT_FILTERS).default('all'),
});
export type AdminOperationsJudgementsQuery = z.infer<typeof adminOperationsJudgementsQuerySchema>;

/** `GET /admin/operations/failures`: a cursor page, the oldest problem first. */
export const adminOperationsFailuresQuerySchema = cursorQuerySchema;
export type AdminOperationsFailuresQuery = z.infer<typeof adminOperationsFailuresQuerySchema>;

// ---- rows ----------------------------------------------------------------------------
/**
 * One row of 마감 예정 (145-1): an OPEN or PAUSED market whose scheduled close is within the window,
 * the nearest first. `overdue`: the close time has passed and the close has not run yet ('마감
 * 시각 지남', 145-18 — the row stays until the close and is also 처리 멈춤 after 30 minutes).
 */
export const adminClosingMarketSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    title: z.string(),
    status: z.enum(['open', 'paused']),
    closeAt: z.iso.datetime(),
    scheduledJudgementAt: z.iso.datetime().nullable(),
    overdue: z.boolean(),
  })
  .meta({ id: 'AdminClosingMarket' });
export type AdminClosingMarket = z.infer<typeof adminClosingMarketSchema>;

/**
 * The current episode's 판정 지연 기록 of a listed market (ADR-0106 결정 10-2): its public sentence,
 * next review time and record time. Who recorded it is in the market's records, not here.
 */
export const adminOperationsJudgementDelaySchema = z
  .object({
    reason: z.string(),
    nextReviewAt: z.iso.datetime(),
    recordedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminOperationsJudgementDelay' });
export type AdminOperationsJudgementDelay = z.infer<typeof adminOperationsJudgementDelaySchema>;

/**
 * One row of 판정 대기·지연 (145-2): every CLOSED market, and a PROVISIONAL one a dispute or a
 * correction holds past its 이의 기한 (always '판정 지연'), by scheduled judgement (none last).
 * - `judgementRequestId`: the waiting `market_judgement` request (a registration, or on PROVISIONAL
 *   a correction), else null;
 * - `holdingDisputes`: the current version's pending or accepted disputes (0 on CLOSED);
 * - `delay`: the current episode's record or null; `reviewOverdue` its 다음 검토 passed (갱신 대기);
 * - `longDelayDeadline`: 예정 판정 + N × 24 h (`longDelayDeadline`, one function's instant —
 *   ADR-0098 13), on every row; `longDelayReached` on CLOSED rows only (145-17);
 * - `delayed`: the row reads '판정 지연' (`isJudgementDelayed`), what '지연만' keeps.
 */
export const adminAwaitingJudgementMarketSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    title: z.string(),
    status: z.enum(['closed', 'provisional']),
    stage: z.enum(OPERATIONS_JUDGEMENT_STAGES),
    closeAt: z.iso.datetime(),
    scheduledJudgementAt: z.iso.datetime().nullable(),
    disputeDeadline: z.iso.datetime().nullable(),
    judgementRequestId: z.uuid().nullable(),
    holdingDisputes: z.number().int().min(0),
    correctionPending: z.boolean(),
    delay: adminOperationsJudgementDelaySchema.nullable(),
    reviewOverdue: z.boolean(),
    longDelayDeadline: z.iso.datetime().nullable(),
    longDelayReached: z.boolean(),
    delayed: z.boolean(),
  })
  .meta({ id: 'AdminAwaitingJudgementMarket' });
export type AdminAwaitingJudgementMarket = z.infer<typeof adminAwaitingJudgementMarketSchema>;

/** What every 정산 실패 row says of its market and when its problem began (`since`). */
const failureBase = {
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  status: z.enum(['open', 'paused', 'provisional', 'resolved', 'settling', 'settled', 'cancelled']),
  since: z.iso.datetime(),
};

/**
 * The payout's step as the admin detail shows it (ADR-0118 결정 8; 145-6 "시도 횟수와 마지막
 * 오류"): the step's status (null with no row), its attempts, its stored error as written (≤ 1 000
 * characters, 145-18 "저장된 글 그대로"), its last update, and whether a ledger hold blocks it.
 */
export const adminOperationsSettlementSchema = z
  .object({
    stepStatus: settlementStepStatusSchema.nullable(),
    settlementAttempts: z.number().int().min(0),
    settlementLastError: z.string().nullable(),
    lastAttemptAt: z.iso.datetime().nullable(),
    ledgerHeld: z.boolean(),
  })
  .meta({ id: 'AdminOperationsSettlement' });
export type AdminOperationsSettlement = z.infer<typeof adminOperationsSettlementSchema>;

/**
 * 정산 실패 (ADR-0121's public '지급 지연'): a SETTLING market whose step failed, carries an error,
 * or waits on a ledger hold. `retryable` (145-14): always.
 */
export const adminOperationsSettlementFailureSchema = z
  .object({
    ...failureBase,
    kind: z.literal('settlement_failed'),
    retryable: z.literal(true),
    settlement: adminOperationsSettlementSchema,
  })
  .meta({ id: 'AdminOperationsSettlementFailure' });

/**
 * 처리 멈춤 (145-4): `stage`'s transition was due at `since` and has not come 30 minutes later.
 * `retryable` (145-14): only at `complete`, a SETTLING market.
 */
export const adminOperationsStuckSchema = z
  .object({
    ...failureBase,
    kind: z.literal('stuck'),
    retryable: z.boolean(),
    stage: z.enum(OPERATIONS_STUCK_STAGES),
  })
  .meta({ id: 'AdminOperationsStuck' });

/**
 * 봇 자금 회수 실패 (145-8, 145-15): a SETTLED or CANCELLED market whose recall has not completed
 * and whose last observation failed; `since` is when the market ended (its terminal event — the
 * last failure moves with each scan, so it is `recall.lastFailureAt`, not the sort key). No retry
 * here (145-8 "자동만, 연결").
 */
export const adminOperationsRecallFailureSchema = z
  .object({
    ...failureBase,
    kind: z.literal('recall_failed'),
    retryable: z.literal(false),
    recall: z.object({
      recallAttempts: z.number().int().positive(),
      recallReason: z.enum(OPERATIONS_RECALL_FAILURE_REASONS),
      lastFailureAt: z.iso.datetime().nullable(),
    }),
  })
  .meta({ id: 'AdminOperationsRecallFailure' });

/** One row of 정산 실패: oldest `since` first, then kind, then the market id. */
export const adminOperationsFailureSchema = z
  .discriminatedUnion('kind', [
    adminOperationsSettlementFailureSchema,
    adminOperationsStuckSchema,
    adminOperationsRecallFailureSchema,
  ])
  .meta({ id: 'AdminOperationsFailure' });
export type AdminOperationsFailure = z.infer<typeof adminOperationsFailureSchema>;

export const adminClosingMarketPageSchema = pageEnvelope(adminClosingMarketSchema);
export type AdminClosingMarketPage = z.infer<typeof adminClosingMarketPageSchema>;
export const adminAwaitingJudgementMarketPageSchema = pageEnvelope(
  adminAwaitingJudgementMarketSchema,
);
export type AdminAwaitingJudgementMarketPage = z.infer<
  typeof adminAwaitingJudgementMarketPageSchema
>;
export const adminOperationsFailurePageSchema = pageEnvelope(adminOperationsFailureSchema);
export type AdminOperationsFailurePage = z.infer<typeof adminOperationsFailurePageSchema>;

// ---- 정산 다시 시도 (145-7, 145-14) ----------------------------------------------------
/**
 * `POST /admin/markets/:id/settlement-retries`: the reason (145-7 "사유 필수") and the admin on
 * screen, nothing else — no amount, status, result or skip can reach the payout (145-7 "지급액이나
 * 검사를 바꾸지 못한다"; extra keys are stripped).
 */
export const adminSettlementRetryBodySchema = z
  .object({ reason: approvalReasonSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'AdminSettlementRetryBody' });
export type AdminSettlementRetryBody = z.infer<typeof adminSettlementRetryBodySchema>;

/**
 * The attempt ran (145-7 결과): `settled` with the `finalized` event's id, or `failed` with the
 * step's error and attempts read back — null when no step was written (another run settled the
 * market in between). A refused click (not SETTLING) is a 400, not an attempt.
 */
export const adminSettlementRetryResultSchema = z
  .discriminatedUnion('outcome', [
    z
      .object({ outcome: z.literal('settled'), statusEventId: z.string() })
      .meta({ id: 'AdminSettlementRetrySettled' }),
    z
      .object({
        outcome: z.literal('failed'),
        settlementLastError: z.string().nullable(),
        settlementAttempts: z.number().int().min(0).nullable(),
      })
      .meta({ id: 'AdminSettlementRetryFailed' }),
  ])
  .meta({ id: 'AdminSettlementRetryResult' });
export type AdminSettlementRetryResult = z.infer<typeof adminSettlementRetryResultSchema>;

/**
 * `market_settlement_retry`'s payload (target `market` / its id): the reason and the outcome —
 * `settled`, written in the payout's transaction before the shared core (the notices stay last)
 * and committed only with the payout; or `failed` with the error (cut to
 * SETTLEMENT_STEP_ERROR_MAX), written with the step's attempt in the failure record's own
 * transaction. No recipient, no count (ADR-0064, ADR-0159 12-12).
 */
export type MarketSettlementRetryActionPayload =
  { reason: string; outcome: 'settled' } | { reason: string; outcome: 'failed'; error: string };
