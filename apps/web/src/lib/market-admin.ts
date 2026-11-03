import {
  AUDIT_FAILURE_KINDS,
  type AdminSettlementStep,
  type AuditFailureKind,
  COIN_UNIT,
  LEAD_CLOSE_GAP_UNDECIDED,
  LEAD_CLOSE_GAP_UNDECIDED_MESSAGE,
  MARKET_REVIEW_CHECKLIST,
  MARKET_SUPPLEMENT_STATUSES,
  MINUS_SIGN,
  type MarketEventType,
  type MarketPauseReason,
  type MarketPauseReviewResult,
  type MarketRejectReason,
  type MarketResult,
  type MarketReviewChecklistItem,
  type MarketReviewEventType,
  type MarketSource,
  type MarketStatus,
  OPEN_ITEMS,
  type OpenItem,
  type PaymentStatus,
  RULES_EDITED_ITEMS,
  RULE_VERSION_ITEMS,
  type RuleItem,
  type RuleVersionItem,
  type RulesEditedItem,
  type RulesEditedValues,
  SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED,
  SUPPLEMENT_ONLY_WHILE_OPEN,
  type SettlementStep,
  type SettlementStepStatus,
  TIME_RULES,
  TIME_RULE_MESSAGES,
  type TimeOrderRule,
  type TimeRelationItem,
  type TimeRule,
  type TimeRuleField,
  type TimeRuleInput,
  type TimeRuleViolation,
  formatCoin,
  isCompleteSource,
  marketPauseReasonSchema,
  marketPauseReviewResultSchema,
  marketRejectReasonSchema,
  marketResultSchema,
  coinAmountSchema,
  parseCoinAmount,
  ruleItemSchema,
  ruleVersionItemSchema,
  rulesEditedItemSchema,
  timeRuleViolations,
  uuidParamSchema,
} from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';
import {
  type ApiError,
  type MarketRuleContent,
  isApiError,
  isForAnotherAccount,
  validationField,
  validationMessage,
  validationPath,
} from './api';
import { formatKst } from './datetime';
import { ruleVersionName } from './rule-versions';

/**
 * Pure helpers behind the market screens: status and event labels, the list badges (PLAN 12),
 * the admin's settlement-step rows (ADR-0046), and the number formats the public cards and the
 * detail header share with the admin screens. No domain maths lives here — prices and Coin come
 * from the API and @buddha/shared (PLAN 11.5).
 */

/**
 * The status badge's words (ADR-0093 decision 1, item 12): the user labels as the owner gave them,
 * and 초안·검수 중 for the two statuses only an admin sees (검수 중 is #174's choice).
 */
export const MARKET_STATUS_LABEL: Record<MarketStatus, string> = {
  draft: copy.marketStatusDraft,
  review: copy.marketStatusReview,
  scheduled: copy.marketStatusScheduled,
  open: copy.marketStatusOpen,
  paused: copy.marketStatusPaused,
  closed: copy.marketStatusClosed,
  provisional: copy.marketStatusProvisional,
  resolved: copy.marketStatusResolved,
  settling: copy.marketStatusSettling,
  settled: copy.marketStatusSettled,
  cancelled: copy.marketStatusCancelled,
};

/**
 * Chakra colorPalette per status, never the state alone (the label is always beside it, PLAN
 * 11.2). ADR-0093 sets no colours, so these keep the old meanings (#174's choice):
 * - `brand` while it trades: OPEN alone.
 * - `orange` while it waits for something to happen to it — a time (SCHEDULED opens, PAUSED still
 *   closes on schedule, PROVISIONAL is confirmed at its dispute deadline, #152), the admins (CLOSED
 *   waits for the 판정 and another admin's approval) or the worker (RESOLVED and SETTLING for the
 *   payout).
 * - `gray` when nothing is coming: over (SETTLED, CANCELLED), or not public yet (DRAFT, REVIEW),
 *   which is where a draft always was.
 *
 * `no` is left to a refusal or a failure (a failed settlement step, a failed payment): VOID is a
 * result now, not a status, and a cancelled market is ended, not failed.
 */
export const MARKET_STATUS_PALETTE: Record<MarketStatus, 'brand' | 'gray' | 'orange'> = {
  draft: 'gray',
  review: 'gray',
  scheduled: 'orange',
  open: 'brand',
  paused: 'orange',
  closed: 'orange',
  provisional: 'orange',
  resolved: 'orange',
  settling: 'orange',
  settled: 'gray',
  cancelled: 'gray',
};

/**
 * A judgement's result in words (ADR-0093 decision 1, item 12): the contracts' 예·아니오 for YES
 * and NO, 무효 for VOID. Every screen that names a result reads it here — the detail's 결과, 내
 * 포지션, MY's 정산 이력, the admin detail and its event log, a theme's results — so none can
 * mistake VOID for NO. A missing result (`null`: before a judgement, or a cancelled market) is the
 * caller's '—'.
 */
export const MARKET_RESULT_LABEL: Record<MarketResult, string> = {
  YES: copy.yes,
  NO: copy.no,
  VOID: copy.marketResultVoid,
};

/**
 * Each market event's name in the admin's 이벤트 로그; the five of the 개설 검수 (#78, ADR-0099) are the
 * 검수 기록's names too (lib/market-review.ts). 규칙 수정 is a draft's since #80; after the open the
 * rules change by an approved supplement alone, which writes 규칙 보충 (ADR-0101). 일시 중단 and 재개
 * are #114's (ADR-0102); its approved early close is a `closed` event, named by `marketEventLabel`.
 * 잠정 결과 공개 and 결과 확정 are #152's (ADR-0103): the approved judgement's CLOSED → PROVISIONAL, and
 * the worker's PROVISIONAL → RESOLVED at the dispute deadline — named, as the payout's two, by the
 * status each leads to; a `resolved` row written before #152 is the one-admin 판정, final at once.
 */
export const MARKET_EVENT_LABEL: Record<MarketEventType, string> = {
  created: copy.eventCreated,
  submitted: copy.eventSubmitted,
  approved: copy.eventApproved,
  rejected: copy.eventRejected,
  reverted: copy.eventReverted,
  open_rescheduled: copy.eventOpenRescheduled,
  opened: copy.eventOpened,
  closed: copy.eventClosed,
  provisional: copy.eventProvisional,
  resolved: copy.eventResolved,
  settling: copy.eventSettling,
  finalized: copy.eventFinalized,
  rules_edited: copy.eventRulesEdited,
  rules_supplemented: copy.eventRulesSupplemented,
  paused: copy.eventPaused,
  resumed: copy.eventResumed,
};

/**
 * An event's name in the 이벤트 로그: MARKET_EVENT_LABEL's, but 조기 마감 for the `closed` an
 * approved early close writes (`source: 'early_close'`, #114, ADR-0102) — the worker's close at
 * `close_at` (`source: 'job'`) and older rows stay 마감.
 */
export function marketEventLabel(type: MarketEventType, payload: unknown): string {
  if (type === 'closed' && EARLY_CLOSED_PAYLOAD.safeParse(payload).success) {
    return copy.eventEarlyClosed;
  }
  return MARKET_EVENT_LABEL[type];
}

/**
 * 일시 중단 사유 (#114, ADR-0102; ADR-0093 decision 1 #173 item 3: these three only), in the words
 * the pause dialog, the panel, the queue and the 이벤트 로그's `paused` rows share. Here rather than
 * in the pause's own lib (lib/market-pause.ts, the admin's alone), since the 이벤트 로그's rows are
 * this file's.
 */
export const PAUSE_REASON_LABEL: Record<MarketPauseReason, string> = {
  early_result: copy.pauseReasonEarlyResult,
  ledger_failure: copy.pauseReasonLedgerFailure,
  basis_change: copy.pauseReasonBasisChange,
};

/** 검토 결과 of a 실질 기준 변경 pause (owner answer Q1, 2026-11-02), as PAUSE_REASON_LABEL. */
export const PAUSE_REVIEW_RESULT_LABEL: Record<MarketPauseReviewResult, string> = {
  judgeable: copy.pauseReviewJudgeable,
  not_judgeable: copy.pauseReviewNotJudgeable,
};

export const SETTLEMENT_STEP_LABEL: Record<SettlementStep, string> = {
  coin: copy.settlementStepCoin,
};

export const SETTLEMENT_STEP_STATUS_LABEL: Record<SettlementStepStatus, string> = {
  pending: copy.settlementStepStatusPending,
  done: copy.settlementStepStatusDone,
  failed: copy.settlementStepStatusFailed,
};

/**
 * Orange while the step waits for the worker (the same "needs attention" the 정산 대기 badge
 * carries), gray once done, `no` once its last attempt rolled back. Never colour alone: every
 * badge shows `SETTLEMENT_STEP_STATUS_LABEL` beside it (PLAN 11.2).
 */
export const SETTLEMENT_STEP_STATUS_PALETTE: Record<
  SettlementStepStatus,
  'gray' | 'orange' | 'no'
> = {
  pending: 'orange',
  done: 'gray',
  failed: 'no',
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: copy.paymentStatusPending,
  succeeded: copy.paymentStatusSucceeded,
  failed: copy.paymentStatusFailed,
  cancelled: copy.paymentStatusCancelled,
  refunding: copy.paymentStatusRefunding,
  refunded: copy.paymentStatusRefunded,
};

/** In flight is orange, credited is brand, refused is `no`, money given back is gray. */
export const PAYMENT_STATUS_PALETTE: Record<PaymentStatus, string> = {
  pending: 'orange',
  succeeded: 'brand',
  failed: 'no',
  cancelled: 'gray',
  refunding: 'orange',
  refunded: 'gray',
};

export const AUDIT_FAILURE_KIND_LABEL: Record<AuditFailureKind, string> = {
  ledger_balance_mismatch: copy.auditKindLedgerMismatch,
};

/**
 * The audit failure's `kind` in Korean. The API types it as a plain string (the worker may
 * learn new kinds before the web does), so anything outside the shared enum shows verbatim
 * rather than as a blank.
 */
export function auditFailureKindLabel(kind: string): string {
  return (AUDIT_FAILURE_KINDS as readonly string[]).includes(kind)
    ? AUDIT_FAILURE_KIND_LABEL[kind as AuditFailureKind]
    : kind;
}

export const CLOSING_SOON_MS = 24 * 60 * 60 * 1000;

/**
 * 마감 임박 (PLAN 12): an open or paused market whose close time is within the next 24 hours —
 * a paused market still closes on schedule (ADR-0093 decision 1, item 3). A scheduled one is not
 * "closing" before it has opened. A close time already in the past is not "soon" — the market is
 * waiting for the close job, and the 판정 대기 badge takes over once it is closed.
 */
export function isClosingSoon(
  market: { status: MarketStatus; closeAt: string },
  now: number = Date.now(),
): boolean {
  if (market.status !== 'open' && market.status !== 'paused') return false;
  const closeAt = new Date(market.closeAt).getTime();
  if (Number.isNaN(closeAt)) return false;
  return closeAt > now && closeAt - now <= CLOSING_SOON_MS;
}

/**
 * 판정 대기 (ADR-0046): trading has stopped and the market waits for its 판정 — registered by one
 * admin and approved by another since #152 (ADR-0103); the detail's 판정 panel says which step it
 * waits for. A PROVISIONAL market waits for its dispute deadline instead, which that panel shows.
 */
export function isAwaitingResolution(status: MarketStatus): boolean {
  return status === 'closed';
}

/**
 * 정산 대기 (ADR-0046): the result is confirmed and the worker's settlement steps have not all
 * finished — `resolved` until the worker starts the payout, `settling` while it runs (ADR-0093
 * decision 1, items 1 and 14). The worker runs them right after it confirms the result at the
 * dispute deadline (#152), so this lasts seconds;
 * a market that keeps the badge is the operational signal that a step is failing (the detail's
 * 정산 단계 panel says which), which leaves it in `settling`.
 */
export function isAwaitingSettlement(status: MarketStatus): boolean {
  return status === 'resolved' || status === 'settling';
}

/** How often the admin detail re-reads a judged market until it is settled (ADR-0046). */
export const SETTLEMENT_POLL_INTERVAL_MS = 5_000;

/**
 * `refetchInterval` of the admin detail: every 5 s while the market is `resolved` or `settling`
 * (`isAwaitingSettlement`). Nothing else tells this screen that the worker finished or failed a
 * step — the admin query joins no realtime room, and a failed attempt publishes nothing at all —
 * so without it the 정산 단계 panel keeps the `pending` row the confirmation wrote until a
 * reload. Not budgeted like the 결제 내역 poll (payments.ts): a failing step is retried by the
 * worker's per-minute scan, and this panel is where an operator watches those attempts.
 * query-core pauses the interval while the tab is hidden, and it stops by itself at `settled`.
 */
export function settlementPollInterval(
  market: { status: MarketStatus } | undefined,
): number | false {
  return market !== undefined && isAwaitingSettlement(market.status)
    ? SETTLEMENT_POLL_INTERVAL_MS
    : false;
}

/** The longest delay a timer holds (2^31 − 1 ms, about 24.8 days); a longer one fires at once. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** How often the admin detail re-reads a 개장 예정 market past its scheduled open, until it opens. */
export const SCHEDULED_OPEN_POLL_MS = 5_000;

/**
 * The admin detail's re-read of a 개장 예정 market (#21, ADR-0100), from the row read at `readAt`
 * (`dataUpdatedAt`) and the clock `now`. Nothing else tells this screen that the worker opened it —
 * the admin query joins no realtime room — so the detail reads it again:
 * - at its scheduled open, while that is ahead;
 * - every SCHEDULED_OPEN_POLL_MS from then on, until it is no longer 개장 예정 (the job opens it at
 *   once, the per-minute scan within a minute, a stopped worker when it is back);
 * - at its close, for the answer `scheduledCloseLapsed` (market-review.ts) judges — and no more
 *   once a read from at or after the close has come back: nothing opens the market any more.
 * A row read before the close and asked after it is read again every SCHEDULED_OPEN_POLL_MS, not
 * at once: a failed read leaves `readAt` where it was (query-core moves only `errorUpdatedAt`), so
 * an immediate delay would refire on every failure — a request loop on a 401 (verification of the
 * Codex fix). False for any other status, a row read after its close, or an unreadable close. A
 * null scheduled open never comes (the open waits for one), so only the close is read. Capped at
 * MAX_TIMEOUT_MS, the next read waiting again; never 0, which query-core takes for no interval.
 */
export function scheduledMarketPollDelay(
  market: { status: MarketStatus; scheduledOpenAt: string | null; closeAt: string } | undefined,
  readAt: number,
  now: number = Date.now(),
): number | false {
  if (market?.status !== 'scheduled') return false;
  const closeAt = new Date(market.closeAt).getTime();
  if (Number.isNaN(closeAt) || closeAt <= readAt) return false;
  const untilClose = closeAt - now;
  if (untilClose <= 0) return SCHEDULED_OPEN_POLL_MS;
  const openAt =
    market.scheduledOpenAt === null ? Number.NaN : new Date(market.scheduledOpenAt).getTime();
  const untilOpen = Number.isNaN(openAt) ? untilClose : openAt - now;
  const next = untilOpen > 0 ? untilOpen : SCHEDULED_OPEN_POLL_MS;
  return Math.max(1, Math.min(next, untilClose, MAX_TIMEOUT_MS));
}

/** How often the admin detail re-reads a trading market past its close, until it is closed. */
export const TRADING_CLOSE_POLL_MS = 5_000;

/**
 * The admin detail's re-read of a market OPEN or PAUSED (#114, ADR-0102), from the clock `now`.
 * Nothing else tells this screen that the worker closed it at `close_at` — the admin query joins no
 * realtime room — and a paused market closes on schedule too (ADR-0093 decision 1 #173 items 1·3),
 * which makes a next-path request still waiting moot: its 승인 must go off without a reload. So the
 * detail reads it again at its close and every TRADING_CLOSE_POLL_MS after it until it is neither
 * (the close job closes it at once, the per-minute scan within a minute, a stopped worker when it
 * is back). Past the close the delay is the poll, never 0 — which query-core takes for no interval
 * — so a failed read does not refire at once. False for any other status or an unreadable close;
 * capped at MAX_TIMEOUT_MS, the next read waiting again.
 */
export function tradingMarketPollDelay(
  market: { status: MarketStatus; closeAt: string } | undefined,
  now: number = Date.now(),
): number | false {
  if (market?.status !== 'open' && market?.status !== 'paused') return false;
  const closeAt = new Date(market.closeAt).getTime();
  if (Number.isNaN(closeAt)) return false;
  const untilClose = closeAt - now;
  if (untilClose <= 0) return TRADING_CLOSE_POLL_MS;
  return Math.max(1, Math.min(untilClose, MAX_TIMEOUT_MS));
}

/** How often the admin detail re-reads a 잠정 결과 market past its dispute deadline until confirmed. */
export const PROVISIONAL_DEADLINE_POLL_MS = 5_000;

/**
 * The admin detail's re-read of a 잠정 결과 market (#152, ADR-0103), from the clock `now`. Nothing
 * else tells this screen that the worker confirmed it — PROVISIONAL → RESOLVED at its dispute
 * deadline (`AdminMarket.disputeDeadline`, fixed at the approval, ADR-0093 decision 1 #173 items
 * 1·5) — the admin query joins no realtime room, so the detail reads it again at the deadline and
 * every PROVISIONAL_DEADLINE_POLL_MS after it until it is no longer PROVISIONAL (the job confirms
 * it at once, the per-minute scan within a minute, a stopped worker when it is back; #175's
 * disputes and #176's corrections will hold it). Past the deadline the delay is the poll, never 0
 * — which query-core takes for no interval — so a failed read does not refire at once. False for
 * any other status or a missing or unreadable deadline; capped at MAX_TIMEOUT_MS, the next read
 * waiting again.
 */
export function provisionalMarketPollDelay(
  market: { status: MarketStatus; disputeDeadline: string | null } | undefined,
  now: number = Date.now(),
): number | false {
  if (market?.status !== 'provisional' || market.disputeDeadline === null) return false;
  const deadline = new Date(market.disputeDeadline).getTime();
  if (Number.isNaN(deadline)) return false;
  const untilDeadline = deadline - now;
  if (untilDeadline <= 0) return PROVISIONAL_DEADLINE_POLL_MS;
  return Math.max(1, Math.min(untilDeadline, MAX_TIMEOUT_MS));
}

/**
 * `refetchInterval` of the admin detail (`useAdminMarket`), from the query's state: the settlement
 * poll for a market whose result is confirmed (`settlementPollInterval`), the 개장 예정 re-reads
 * (`scheduledMarketPollDelay` at the row's `dataUpdatedAt`), the close's re-read of a market OPEN
 * or PAUSED (`tradingMarketPollDelay`, #114) and the dispute deadline's of a 잠정 결과 market
 * (`provisionalMarketPollDelay`, #152).
 */
export function adminMarketPollInterval(state: {
  data?: {
    status: MarketStatus;
    scheduledOpenAt: string | null;
    closeAt: string;
    disputeDeadline: string | null;
  };
  dataUpdatedAt: number;
}): number | false {
  return (
    settlementPollInterval(state.data) ||
    scheduledMarketPollDelay(state.data, state.dataUpdatedAt) ||
    tradingMarketPollDelay(state.data) ||
    provisionalMarketPollDelay(state.data)
  );
}

/**
 * Whether the edit form saves as an opened market's: OPEN or PAUSED (MARKET_SUPPLEMENT_STATUSES) —
 * the category, the tags and the image with a record, the version items (the title, the rule items
 * and the times) drawn off since they change by a supplement alone (#80, ADR-0101; ADR-0093
 * decision 2 #172 item 14, 'after the open' a pause included — #114, ADR-0102), and a save first
 * confirmed.
 */
export function editsAfterOpen(status: MarketStatus): boolean {
  return (MARKET_SUPPLEMENT_STATUSES as readonly MarketStatus[]).includes(status);
}

/**
 * Which statuses the edit form saves in (design 3.4): a draft every field; a market OPEN or PAUSED
 * its category, tags and image (`editsAfterOpen`) — its version items change by a supplement alone,
 * so the edit form draws them off (`MarketFormFields`' `versionItemsLocked`).
 */
export function isEditable(status: MarketStatus): boolean {
  return status === 'draft' || editsAfterOpen(status);
}

/** One row of the admin's 정산 단계 panel, every cell already in words. */
export interface SettlementStepView {
  step: SettlementStep;
  label: string;
  statusLabel: string;
  palette: (typeof SETTLEMENT_STEP_STATUS_PALETTE)[SettlementStepStatus];
  /** The one state that needs the admin: drawn as a solid badge, not a subtle one. */
  failed: boolean;
  attempts: string;
  /** KST, or '—' while the step has not finished. */
  completedAt: string;
  /** The last failed attempt's message (kept after a later success), or '—'. */
  lastError: string;
}

/**
 * `AdminMarket.settlementSteps` (ADR-0046) as the 정산 단계 panel reads it. The API already
 * answers in SETTLEMENT_STEPS order — the order the worker runs them in — so the rows keep it.
 * `lastError` stays on a step that later succeeded: it is the record of why the earlier attempt
 * failed, and the 완료 badge beside it says that the failure is over.
 */
export function settlementStepViews(
  steps: readonly Pick<
    AdminSettlementStep,
    'step' | 'status' | 'attempts' | 'completedAt' | 'lastError'
  >[],
): SettlementStepView[] {
  return steps.map((row) => ({
    step: row.step,
    label: SETTLEMENT_STEP_LABEL[row.step],
    statusLabel: SETTLEMENT_STEP_STATUS_LABEL[row.status],
    palette: SETTLEMENT_STEP_STATUS_PALETTE[row.status],
    failed: row.status === 'failed',
    attempts: String(row.attempts),
    // `formatKst` answers '' for an instant it cannot read; a blank cell would say less than '—'.
    completedAt: (row.completedAt === null ? '' : formatKst(row.completedAt)) || '—',
    lastError: row.lastError || '—',
  }));
}

/**
 * PLAN 11.2: never colour alone — "YES 63%". `null` is a market with no fill yet, which reads
 * 체결 없음 rather than any number (N02 §5): no initial setting is shown as a price.
 */
export function formatYesPrice(lastPrice: number | null): string {
  return lastPrice === null ? copy.noFills : `${copy.yes} ${String(lastPrice)}%`;
}

/**
 * The other side of the same reading — "NO 37%" for a 63% market. The complement is taken
 * from the same `lastPrice` (the whole percent the API sends), so YES and NO on the same card
 * always add up to 100.
 */
export function formatNoPrice(lastPrice: number): string {
  return `${copy.no} ${String(100 - lastPrice)}%`;
}

/** Basis points (0..10000) as a percentage with two decimals: 6300 → "63.00%". */
export function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`;
}

/**
 * The same basis points as what one contract costs: 6300 → "63.00 Coin" (a winner pays 100 Coin).
 * Two decimals, which `formatCoin` (integers only) cannot write, so the unit is spelled here the
 * way it spells it: one ordinary space, then `COIN_UNIT`.
 */
export function formatPricePerContract(bp: number): string {
  return `${(bp / 100).toFixed(2)} ${COIN_UNIT}`;
}

/**
 * The probability move for the delta badge (PLAN 11.4), in percentage points: "+2%p" or
 * "−2%p" with U+2212, never an ASCII hyphen — the minus then has the same width as the plus
 * and does not read as a stray dash beside the number.
 *
 * An empty string hides the badge: there is no move to report (`null`), or the move is smaller
 * than the tenth of a point shown, and 실시간은 조용하게 (PLAN 11.1-5) means a wiggle gets no
 * badge at all rather than a "+0%p" one.
 */
export function deltaLabel(deltaPoints: number | null): string {
  if (deltaPoints === null || !Number.isFinite(deltaPoints)) return '';
  const rounded = Math.round(deltaPoints * 10) / 10;
  if (rounded === 0) return '';
  return `${rounded > 0 ? '+' : MINUS_SIGN}${String(Math.abs(rounded))}%p`;
}

/**
 * The value-based identity of ONE price move — what `ProbabilityDisplay` remembers a dismissal
 * against when its caller passes no `moveId`, so the NEXT move revives the five-second badge
 * (PLAN 11.4).
 *
 * Only a fallback, and a weak one: `lastPrice` is the WHOLE percent, so a move too small to
 * change it — which `deltaLabel` still shows as +0.1%p and up — produces the same string as the
 * move before it and a badge already dismissed never comes back. The one call site passes the
 * monotone `moveId` (`recentMove`, lib/ticks.ts) for exactly that reason. Derived from values
 * alone, so a server render and the first client render produce the same string.
 */
export function deltaMoveKey(lastPrice: number | null, label: string): string {
  return `${lastPrice === null ? '' : String(lastPrice)}:${label}`;
}

/** A quantity, possibly a decimal string, trimmed to four decimals and grouped for reading. */
export function formatQuantity(q: string): string {
  const n = Number(q);
  return Number.isFinite(n)
    ? n.toLocaleString('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
    : q;
}

/** A contract count as the position, order and fill rows read it: "1,234계약". */
export function formatContracts(n: number): string {
  return `${formatQuantity(String(n))}${copy.unitContracts}`;
}

/**
 * Whether a route's `[id]` can name a market at all. The API validates the path param with
 * the same `uuidParamSchema` and answers 400 for anything else (a truncated paste, `/abc`),
 * which is not a "try again" situation: the detail screen shows 찾을 수 없습니다 without a
 * request. The refusal's issue path is `[]` (a scalar schema), so it cannot be told apart
 * from any other 400 after the fact — hence the check up front.
 *
 * The parsed value, not a boolean, and that is the point: a uuid is accepted in either case
 * and `uuidParamSchema` lower-cases it (A-M3-17), which is also the case every row the API
 * answers with carries. A screen that keys its cache on this value keys it on the same
 * string its children read back as `market.id`; one that keeps the segment as typed holds
 * two strings for one market (A-M3-29).
 */
export function marketIdParam(id: string): string | undefined {
  return uuidParamSchema.safeParse(id).data;
}

/** An event/audit payload as one compact line; `null` and `undefined` render as nothing. */
export function compactJson(payload: unknown): string {
  if (payload === null || payload === undefined) return '';
  try {
    return JSON.stringify(payload);
  } catch {
    return copy.payloadUnreadable;
  }
}

export interface EventRow {
  label: string;
  value: string;
}

/** An instant `formatKst` can render; the row would otherwise be a blank. */
const kstInstant = z.string().refine((iso) => formatKst(iso) !== '');

/**
 * The payloads the API (and the worker's `market-resolve` and `market-finalize`) write for each
 * event, as the web reads them. `.nullish()` where the writer may omit or null a field: the
 * one-admin 판정 before #152 nulled a blank note.
 */
// The rules text a `rules_edited` row written before #23 holds, before and after the edit.
const LEGACY_RULES_EDITED_PAYLOAD = z.object({ before: z.string(), after: z.string() });
const EVENT_SOURCE = z.object({ name: z.string(), url: z.string() });
/**
 * One item's value in a `rules_edited` row (#23, ADR-0097; #22, ADR-0098), as the API writes it
 * (`rulesEditedPayload`): a text, a nullable 배경, the event deadline as an instant or null, a source
 * as `{name, url}` or null, the fallbacks as their ordered list, the long-delay days or null — and
 * since #22 the announcement time as an instant or null ('없음') and the judgement time zone as its
 * name or null.
 */
const RULES_EDITED_VALUE: {
  readonly [K in RulesEditedItem]: z.ZodType<RulesEditedValues[K]>;
} = {
  description: z.string().nullable(),
  yesCondition: z.string(),
  noCondition: z.string(),
  eventDeadline: kstInstant.nullable(),
  primarySource: EVENT_SOURCE.nullable(),
  fallbackSources: z.array(EVENT_SOURCE),
  fallbackCondition: z.string(),
  longDelayDays: z.number().int().nullable(),
  delayHandling: z.string(),
  scheduledAnnouncementAt: kstInstant.nullable(),
  judgementTimeZone: z.string().nullable(),
};
/**
 * `rules_edited` since #23: the items the edit changed, in RULES_EDITED_ITEMS order — the rule
 * items, and since #22 the announcement time and the judgement time zone — and each one's value
 * before and after it. Every listed item must carry both values of its own shape, or the row is
 * not read (`compactJson` instead).
 */
const RULES_EDITED_PAYLOAD = z
  .object({
    items: z.array(rulesEditedItemSchema).min(1),
    before: z.record(z.string(), z.unknown()),
    after: z.record(z.string(), z.unknown()),
  })
  .refine(({ items, before, after }) =>
    items.every(
      (item) =>
        RULES_EDITED_VALUE[item].safeParse(before[item]).success &&
        RULES_EDITED_VALUE[item].safeParse(after[item]).success,
    ),
  );
/**
 * The open (#21, ADR-0100: scheduled → open; rows before it are the interim open's draft → open):
 * `{openAt, closeAt}`, and since #21 the `source` — `job`, `approval` or `reschedule` — which no
 * row repeats: the actor beside it says it (시스템 for the worker), and an admin's open follows the
 * 승인 or the 예정 개장 시각 변경 that made it, at the same instant.
 */
const OPENED_PAYLOAD = z.object({ openAt: kstInstant, closeAt: kstInstant });
/**
 * `rules_supplemented` (#80, ADR-0101): an approved supplement — the version it made, the version
 * items it changed (RULE_VERSION_ITEMS) and the supplement's reason; the event's actor is the
 * approver. The payload's requester is an account id, which no row of this log prints: the detail's
 * 보충 기록 shows the request whole, its requester by nickname.
 */
const RULES_SUPPLEMENTED_PAYLOAD = z.object({
  version: z.number().int().min(1),
  items: z.array(ruleVersionItemSchema).min(1),
  reason: z.string(),
});
const CLOSED_PAYLOAD = z.object({ closedAt: kstInstant });
/**
 * An approved early close (#114, ADR-0102: `closed` with `source: 'early_close'`, the actor the
 * approver): the actual close instant and the review result (null but for a 실질 기준 변경 pause).
 * The pause, the request and its requester are ids, which no row of this log prints: the detail's
 * 일시 중단 기록 shows them, the requester by nickname (ADR-0101 9-11's way).
 */
const EARLY_CLOSED_PAYLOAD = z.object({
  closedAt: kstInstant,
  source: z.literal('early_close'),
  reviewResult: marketPauseReviewResultSchema.nullable(),
});
/** 일시 중단 (#114): the reason and, for an early result, when it was published (else null). */
const PAUSED_PAYLOAD = z.object({
  reason: marketPauseReasonSchema,
  resultPublishedAt: kstInstant.nullable(),
});
/** 재개 (#114): the review result (null but for a 실질 기준 변경 pause); the ids as above. */
const RESUMED_PAYLOAD = z.object({ reviewResult: marketPauseReviewResultSchema.nullable() });

/** The review result's row, none without one. */
function reviewResultRows(reviewResult: MarketPauseReviewResult | null): EventRow[] {
  return reviewResult === null
    ? []
    : [{ label: copy.pauseLogReviewResult, value: PAUSE_REVIEW_RESULT_LABEL[reviewResult] }];
}
/** The worker's resolved → settling (#174): `{source: 'job'}`, which the 시스템 actor already says. */
const SETTLING_PAYLOAD = z.object({ source: z.string() });
/**
 * 잠정 결과 공개 (#152, ADR-0103: closed → provisional, the actor the approver): the judgement
 * version the approval published, its result and the dispute deadline it fixed. The approved
 * request and its registrant are ids, which no row of this log prints: the detail's 판정 panel
 * shows them, the registrant by nickname (ADR-0101 9-11's way).
 */
const PROVISIONAL_PAYLOAD = z.object({
  version: z.number().int().min(1),
  result: marketResultSchema,
  disputeDeadline: kstInstant,
});
/**
 * 결과 확정 since #152 (provisional → resolved, the worker at the dispute deadline): the version
 * confirmed and its result; its `source` ('deadline') is what the 시스템 actor already says.
 */
const RESOLVED_BY_DEADLINE_PAYLOAD = z.object({
  version: z.number().int().min(1),
  result: marketResultSchema,
});
/**
 * 결과 확정 before #152 (ADR-0046: the one-admin 판정, closed → resolved at once): `{result, note,
 * evidenceUrl}`, YES or NO — read as the stored result type, so a VOID reads 무효 rather than
 * falling back to JSON. Nothing writes it now; old rows keep it.
 */
const INTERIM_RESOLVED_PAYLOAD = z.object({
  result: marketResultSchema,
  note: z.string().nullish(),
  evidenceUrl: z.string().nullish(),
});
// The counts and the total are what the worker writes today; optional so an older row (or a
// leaner writer) still reads as "지급 완료 · 결과 YES" rather than falling back to JSON.
const FINALIZED_PAYLOAD = z.object({
  result: marketResultSchema,
  settledAccounts: z.number().int().nonnegative().optional(),
  paidAccounts: z.number().int().nonnegative().optional(),
  paidCoin: coinAmountSchema.optional(),
});

/** A judgement version as the rows name it ('v1', the rule versions' way). */
export function judgementVersionName(version: number): string {
  return ruleVersionName(version);
}

/** The one-admin 판정's note and evidence rows (before #152); blanks are left out. */
function interimResolveRows(detail: {
  note?: string | null;
  evidenceUrl?: string | null;
}): EventRow[] {
  return [
    ...(detail.note ? [{ label: copy.eventResolveNote, value: detail.note }] : []),
    ...(detail.evidenceUrl
      ? [{ label: copy.eventResolveEvidence, value: detail.evidenceUrl }]
      : []),
  ];
}

/**
 * An event's payload as label/value rows in Korean, for the shapes the API and the worker
 * write (design 3.4's 이벤트 로그, 5.5): the rules diff (each changed rule item since #23, the one
 * rules text before it), a supplement's approval (#80: the version, the items and the reason), the
 * open and close instants — an early close's with its review result (#114) —, a pause's reason and
 * early result's publication instant, a resume's review result (#114, ADR-0102: no account id,
 * ADR-0101 9-11), the 잠정 결과 공개 with its version, result and dispute deadline and the 결과 확정
 * with its version and result (#152) — a 결과 확정 before #152 with its note and evidence — the
 * finalize summary, the 개설 검수's records
 * (#78, `reviewDetailRows`) — and no row at all for the start of the payout, whose only field is
 * the `source` the 시스템 actor beside it already says, nor for a resume without a review result.
 * The payload is `unknown` on the wire (jsonb), so each shape is checked before it is read;
 * `created` (the whole create body) and anything that does not match are `undefined`, and the
 * screen shows those as `compactJson` instead of a half-read row.
 */
export function marketEventRows(type: MarketEventType, payload: unknown): EventRow[] | undefined {
  switch (type) {
    case 'provisional': {
      const parsed = PROVISIONAL_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      const { version, result, disputeDeadline } = parsed.data;
      return [
        { label: copy.eventJudgementVersion, value: judgementVersionName(version) },
        { label: copy.marketResolvedResult, value: MARKET_RESULT_LABEL[result] },
        { label: copy.eventDisputeDeadline, value: formatKst(disputeDeadline) },
      ];
    }
    case 'resolved': {
      const confirmed = RESOLVED_BY_DEADLINE_PAYLOAD.safeParse(payload);
      if (confirmed.success) {
        const { version, result } = confirmed.data;
        return [
          { label: copy.eventJudgementVersion, value: judgementVersionName(version) },
          { label: copy.marketResolvedResult, value: MARKET_RESULT_LABEL[result] },
        ];
      }
      // A row written before #152: the one-admin 판정.
      const interim = INTERIM_RESOLVED_PAYLOAD.safeParse(payload);
      if (!interim.success) return undefined;
      return [
        { label: copy.marketResolvedResult, value: MARKET_RESULT_LABEL[interim.data.result] },
        ...interimResolveRows(interim.data),
      ];
    }
    case 'settling':
      return SETTLING_PAYLOAD.safeParse(payload).success ? [] : undefined;
    case 'finalized': {
      const parsed = FINALIZED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      const { result, settledAccounts, paidAccounts, paidCoin } = parsed.data;
      return [
        { label: copy.marketResolvedResult, value: MARKET_RESULT_LABEL[result] },
        ...(settledAccounts === undefined
          ? []
          : [{ label: copy.eventSettledAccounts, value: String(settledAccounts) }]),
        ...(paidAccounts === undefined
          ? []
          : [{ label: copy.eventPaidAccounts, value: String(paidAccounts) }]),
        ...(paidCoin === undefined
          ? []
          : [{ label: copy.eventPaidTotal, value: formatCoin(parseCoinAmount(paidCoin)) }]),
      ];
    }
    case 'rules_edited': {
      const parsed = RULES_EDITED_PAYLOAD.safeParse(payload);
      // The event deadline and the announcement in KST, as every time in these rows.
      if (parsed.success) return rulesEditedRows(parsed.data, (iso) => formatKst(iso));
      // A row written before #23: the one rules text.
      const legacy = LEGACY_RULES_EDITED_PAYLOAD.safeParse(payload);
      if (!legacy.success) return undefined;
      return [
        { label: copy.eventRulesBefore, value: legacy.data.before || '—' },
        { label: copy.eventRulesAfter, value: legacy.data.after || '—' },
      ];
    }
    case 'rules_supplemented': {
      const parsed = RULES_SUPPLEMENTED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      const { version, items, reason } = parsed.data;
      return [
        { label: copy.eventRulesVersion, value: ruleVersionName(version) },
        { label: copy.eventRulesItems, value: ruleVersionItemList(items) },
        { label: copy.reviewLogReason, value: reason },
      ];
    }
    case 'opened': {
      const parsed = OPENED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      return [
        { label: copy.marketOpenAt, value: formatKst(parsed.data.openAt) },
        { label: copy.adminMarketCloseAtShort, value: formatKst(parsed.data.closeAt) },
      ];
    }
    case 'closed': {
      const parsed = CLOSED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      const early = EARLY_CLOSED_PAYLOAD.safeParse(payload);
      return [
        { label: copy.adminMarketCloseAtShort, value: formatKst(parsed.data.closedAt) },
        ...(early.success ? reviewResultRows(early.data.reviewResult) : []),
      ];
    }
    case 'paused': {
      const parsed = PAUSED_PAYLOAD.safeParse(payload);
      if (!parsed.success) return undefined;
      const { reason, resultPublishedAt } = parsed.data;
      return [
        { label: copy.adminMarketPauseReason, value: PAUSE_REASON_LABEL[reason] },
        ...(resultPublishedAt === null
          ? []
          : [
              {
                label: copy.adminMarketPauseResultPublishedAt,
                value: formatKst(resultPublishedAt),
              },
            ]),
      ];
    }
    case 'resumed': {
      const parsed = RESUMED_PAYLOAD.safeParse(payload);
      return parsed.success ? reviewResultRows(parsed.data.reviewResult) : undefined;
    }
    case 'submitted':
    case 'approved':
    case 'rejected':
    case 'reverted':
    case 'open_rescheduled':
      // A reschedule's times in KST, as every time in these rows.
      return reviewPayloadRows(type, payload, (iso) => formatKst(iso));
    default:
      return undefined;
  }
}

/**
 * 검수 체크리스트의 이름 (#78, ADR-0093 decision 2 #172 item 4), in MARKET_REVIEW_CHECKLIST order: the
 * plan's three bans, then 필수 항목, 시각 순서 and 선행 마감 (the open-items check's own names for the
 * last two, OPEN_ITEM_LABEL) and 독립 판정. The approval dialog draws each with its line of what to
 * confirm (lib/market-review.ts); the 반려 사유 list is these and 기타.
 */
export const REVIEW_CHECK_LABEL: Record<MarketReviewChecklistItem, string> = {
  knownResult: copy.reviewCheckKnownResult,
  ambiguity: copy.reviewCheckAmbiguity,
  duplicate: copy.reviewCheckDuplicate,
  requiredItems: copy.reviewCheckRequiredItems,
  timeOrder: copy.reviewCheckTimeOrder,
  leadClose: copy.reviewCheckLeadClose,
  independence: copy.reviewCheckIndependence,
};

/** 반려 사유 (#172 item 4): the checklist item the market fails, or 기타 (MARKET_REJECT_REASONS). */
export const REJECT_REASON_LABEL: Record<MarketRejectReason, string> = {
  ...REVIEW_CHECK_LABEL,
  other: copy.reviewRejectOther,
};

/**
 * What a review record says beyond who and when (#78), each field absent where its type carries
 * none: the gap a submission checked the lead close at, a 반려's reason from the list, an
 * approval's checklist (counted: every item is required, so the count says it was whole), a
 * reschedule's times, and the reason — a 반려's is its 설명.
 */
export interface ReviewDetail {
  type: MarketReviewEventType;
  leadCloseGapMinutes?: number | null;
  rejectReason?: MarketRejectReason | null;
  checklist?: readonly string[] | null;
  scheduledOpenBefore?: string | null;
  scheduledOpenAfter?: string | null;
  reason?: string | null;
}

/**
 * A review record's rows, shared by the 이벤트 로그 (`marketEventRows`, from the event's payload) and
 * the 검수 기록 (lib/market-review.ts, from `AdminMarket.review.log`): '반려 사유 모호한 기준', '체크리스트
 * 7/7개 항목 확인', '이전 예정 개장 …' and '이후 예정 개장 …' as `time` renders an instant (the
 * callers' KST), then '사유 …' (a 반려's '설명 …').
 */
export function reviewDetailRows(detail: ReviewDetail, time: (iso: string) => string): EventRow[] {
  const rows: EventRow[] = [];
  if (detail.type === 'submitted' && detail.leadCloseGapMinutes !== undefined) {
    const gap = detail.leadCloseGapMinutes;
    rows.push({
      label: copy.adminMarketLeadCloseGap,
      value:
        gap === null
          ? copy.adminMarketLeadCloseGapUndecided
          : `${String(gap)}${copy.adminMarketLeadCloseGapMinutes}`,
    });
  }
  if (detail.rejectReason) {
    rows.push({
      label: copy.reviewLogRejectReason,
      value: REJECT_REASON_LABEL[detail.rejectReason],
    });
  }
  if (detail.checklist) {
    const confirmed = MARKET_REVIEW_CHECKLIST.filter((item) => detail.checklist?.includes(item));
    const total = MARKET_REVIEW_CHECKLIST.length;
    rows.push({
      label: copy.reviewLogChecklist,
      value: `${String(confirmed.length)}/${String(total)}${copy.reviewLogChecklistTail}`,
    });
  }
  if (detail.type === 'open_rescheduled') {
    const at = (iso: string | null | undefined) => (iso ? time(iso) || '—' : '—');
    rows.push(
      { label: copy.reviewLogOpenBefore, value: at(detail.scheduledOpenBefore) },
      { label: copy.reviewLogOpenAfter, value: at(detail.scheduledOpenAfter) },
    );
  }
  if (detail.reason) {
    rows.push({
      label: detail.type === 'rejected' ? copy.reviewLogDescription : copy.reviewLogReason,
      value: detail.reason,
    });
  }
  return rows;
}

/**
 * The review events' payloads as the API writes them (#78; `MarketSubmittedPayload` … in
 * @buddha/shared market-review.ts): the request each names is not shown — the 검수 기록 above says who
 * and when — and a reschedule's earlier time may be null (a market made by a test factory).
 */
const REVIEW_PAYLOADS: {
  readonly [T in MarketReviewEventType]: z.ZodType<Omit<ReviewDetail, 'type'>>;
} = {
  submitted: z.object({ leadCloseGapMinutes: z.number().int().nullable() }),
  approved: z.object({ checklist: z.array(z.string()), reason: z.string() }),
  rejected: z.object({ rejectReason: marketRejectReasonSchema, reason: z.string() }),
  reverted: z.object({ reason: z.string() }),
  open_rescheduled: z
    .object({ before: kstInstant.nullable(), after: kstInstant, reason: z.string() })
    .transform(({ before, after, reason }) => ({
      scheduledOpenBefore: before,
      scheduledOpenAfter: after,
      reason,
    })),
};

/** A review event's payload as rows (`reviewDetailRows`); `undefined` when not of its shape. */
function reviewPayloadRows(
  type: MarketReviewEventType,
  payload: unknown,
  time: (iso: string) => string,
): EventRow[] | undefined {
  const parsed = REVIEW_PAYLOADS[type].safeParse(payload);
  return parsed.success ? reviewDetailRows({ type, ...parsed.data }, time) : undefined;
}

/**
 * The open-items check's names (#17), in OPEN_ITEMS order: the draft's notice and the toast of a
 * refused 검수 제출 say the same words — 질문, the rule items' names (#23, ADR-0097), the time items and
 * the two relations between them, 시각 순서 and 선행 마감 (#22, ADR-0098), 카테고리 and 태그 1~5개. A
 * rule item's name is also its name in the `rules_edited` rows, and so is the zone's.
 */
export const OPEN_ITEM_LABEL: Record<OpenItem, string> = {
  title: copy.openItemTitle,
  description: copy.openItemDescription,
  yesCondition: copy.openItemYesCondition,
  noCondition: copy.openItemNoCondition,
  eventDeadline: copy.openItemEventDeadline,
  primarySource: copy.openItemPrimarySource,
  fallbackSources: copy.openItemFallbackSources,
  fallbackCondition: copy.openItemFallbackCondition,
  longDelayDays: copy.openItemLongDelayDays,
  delayHandling: copy.openItemDelayHandling,
  scheduledOpenAt: copy.openItemScheduledOpenAt,
  closeAt: copy.openItemCloseAt,
  scheduledJudgementAt: copy.openItemScheduledJudgementAt,
  judgementTimeZone: copy.openItemJudgementTimeZone,
  timeOrder: copy.openItemTimeOrder,
  leadClose: copy.openItemLeadClose,
  category: copy.openItemCategory,
  tags: copy.openItemTags,
};

/**
 * The names of the items a `rules_edited` row lists (RULES_EDITED_ITEMS): the open-items check's
 * for the rule items and the zone, and the announcement time's own — it is no open item ('없음' is
 * a value, #172 item 13).
 */
const RULES_EDITED_LABEL: Record<RulesEditedItem, string> = {
  description: OPEN_ITEM_LABEL.description,
  yesCondition: OPEN_ITEM_LABEL.yesCondition,
  noCondition: OPEN_ITEM_LABEL.noCondition,
  eventDeadline: OPEN_ITEM_LABEL.eventDeadline,
  primarySource: OPEN_ITEM_LABEL.primarySource,
  fallbackSources: OPEN_ITEM_LABEL.fallbackSources,
  fallbackCondition: OPEN_ITEM_LABEL.fallbackCondition,
  longDelayDays: OPEN_ITEM_LABEL.longDelayDays,
  delayHandling: OPEN_ITEM_LABEL.delayHandling,
  scheduledAnnouncementAt: copy.openItemScheduledAnnouncementAt,
  judgementTimeZone: OPEN_ITEM_LABEL.judgementTimeZone,
};

/**
 * The names of the rule-version items (RULE_VERSION_ITEMS, #80, ADR-0101): the open-items check's
 * for every item it has and the announcement time's own, as RULES_EDITED_LABEL. The 규칙 보충 rows,
 * the supplement panel and the 규칙 보충 대기 queue say them.
 */
export const RULE_VERSION_ITEM_LABEL: Record<RuleVersionItem, string> = {
  title: OPEN_ITEM_LABEL.title,
  ...RULES_EDITED_LABEL,
  scheduledOpenAt: OPEN_ITEM_LABEL.scheduledOpenAt,
  closeAt: OPEN_ITEM_LABEL.closeAt,
  scheduledJudgementAt: OPEN_ITEM_LABEL.scheduledJudgementAt,
};

/** Version items as one line of their names, in RULE_VERSION_ITEMS order, each once. */
export function ruleVersionItemList(items: readonly RuleVersionItem[]): string {
  return RULE_VERSION_ITEMS.filter((item) => items.includes(item))
    .map((item) => RULE_VERSION_ITEM_LABEL[item])
    .join(' · ');
}

/**
 * A source as one line of text: 'name (url)', or whichever half it has; '—' for none, or a
 * source with both halves blank (`market_sources` refuses that one, but an event row is history).
 */
function sourceText(source: MarketSource | null): string {
  const name = source?.name.trim() ?? '';
  const url = source?.url.trim() ?? '';
  if (name !== '' && url !== '') return `${name} (${url})`;
  return name || url || '—';
}

const textOrDash = (text: string | null): string =>
  text === null || text.trim() === '' ? '—' : text;

/**
 * Each item's value as text, for the `rules_edited` rows (#23, #22): a blank text '—', the event
 * deadline as `time` renders an instant (KST, which `marketEventRows` hands it), a source as
 * `sourceText`, the fallbacks one numbered line each or '없음', the long-delay days in words, the
 * announcement time as an instant or '없음', the zone by its IANA name.
 */
const RULES_EDITED_TEXT: {
  readonly [K in RulesEditedItem]: (
    value: RulesEditedValues[K],
    time: (iso: string) => string,
  ) => string;
} = {
  description: textOrDash,
  yesCondition: textOrDash,
  noCondition: textOrDash,
  eventDeadline: (iso, time) => (iso === null ? '—' : time(iso)),
  primarySource: sourceText,
  fallbackSources: (sources) =>
    sources.length === 0
      ? copy.adminMarketFallbackNone
      : sources.map((source, index) => `${String(index + 1)}. ${sourceText(source)}`).join('\n'),
  fallbackCondition: textOrDash,
  // As the rules area words it (`longDelayText`, lib/market-detail.ts, which imports this file).
  longDelayDays: (days) =>
    days === null ? '—' : `${copy.rulesLongDelayBefore} ${String(days)}${copy.rulesLongDelayTail}`,
  delayHandling: textOrDash,
  scheduledAnnouncementAt: (iso, time) =>
    iso === null ? copy.adminMarketAnnouncementNone : time(iso),
  judgementTimeZone: textOrDash,
};

/** `raw` (checked by RULES_EDITED_PAYLOAD) as the text of `item`'s value. */
function rulesEditedText<K extends RulesEditedItem>(
  item: K,
  raw: unknown,
  time: (iso: string) => string,
): string {
  return RULES_EDITED_TEXT[item](RULES_EDITED_VALUE[item].parse(raw), time);
}

/** `value` of `item` as text (RULES_EDITED_TEXT), the type tying the two together. */
function editedItemText<K extends RulesEditedItem>(
  item: K,
  value: RulesEditedValues[K],
  time: (iso: string) => string,
): string {
  return RULES_EDITED_TEXT[item](value, time);
}

/**
 * One item of a rule version's full text (#80, ADR-0101) as text, for the admin's supplement rows:
 * the title as written, the other times as `time` renders an instant ('—' for none) and the rest as
 * a `rules_edited` row words them (RULES_EDITED_TEXT) — the admin's KST. The public detail draws
 * its own (rule-versions-section.tsx), in the viewer's zone.
 */
export function ruleVersionItemText(
  item: RuleVersionItem,
  content: MarketRuleContent,
  time: (iso: string) => string,
): string {
  switch (item) {
    case 'title':
      return textOrDash(content.title);
    case 'scheduledOpenAt':
    case 'closeAt':
    case 'scheduledJudgementAt': {
      const iso = content[item];
      return iso === null ? '—' : time(iso) || '—';
    }
    default:
      return editedItemText(item, content[item], time);
  }
}

/**
 * The rows of a `rules_edited` event since #23: '바뀐 항목 YES 조건 · 1차 출처', then each item's
 * value before and after the edit, in RULES_EDITED_ITEMS order.
 */
function rulesEditedRows(
  payload: z.infer<typeof RULES_EDITED_PAYLOAD>,
  time: (iso: string) => string,
): EventRow[] {
  const items = RULES_EDITED_ITEMS.filter((item) => payload.items.includes(item));
  return [
    {
      label: copy.eventRulesItems,
      value: items.map((item) => RULES_EDITED_LABEL[item]).join(' · '),
    },
    ...items.flatMap((item) => [
      {
        label: `${RULES_EDITED_LABEL[item]} ${copy.eventRulesBefore}`,
        value: rulesEditedText(item, payload.before[item], time),
      },
      {
        label: `${RULES_EDITED_LABEL[item]} ${copy.eventRulesAfter}`,
        value: rulesEditedText(item, payload.after[item], time),
      },
    ]),
  ];
}

/** `items` as one line of labels, in OPEN_ITEMS order whatever order they came in, each once. */
function openItemList(items: readonly OpenItem[]): string {
  return OPEN_ITEMS.filter((item) => items.includes(item))
    .map((item) => OPEN_ITEM_LABEL[item])
    .join(' · ');
}

/** What an order rule's line in the draft's notice says is wrong (#172 item 12, A1). */
const TIME_ORDER_LINE: { readonly [R in TimeOrderRule]: string } = {
  openBeforeClose: copy.openItemRuleOpenBeforeClose,
  closeByJudgement: copy.openItemRuleCloseByJudgement,
  deadlineByJudgement: copy.openItemRuleDeadlineByJudgement,
};

/** The relation item a broken time rule fails (`missingOpenItems`' own split). */
const RELATION_OF: { readonly [R in TimeRule]: TimeRelationItem } = {
  openBeforeClose: 'timeOrder',
  closeByJudgement: 'timeOrder',
  deadlineByJudgement: 'timeOrder',
  leadClose: 'leadClose',
};

/** One broken time rule as the notice's line says it, after its relation item's name. */
function timeRuleLine(violation: TimeRuleViolation, gapMinutes: number | null): string {
  if (violation.rule !== 'leadClose') return TIME_ORDER_LINE[violation.rule];
  return violation.reason === LEAD_CLOSE_GAP_UNDECIDED || gapMinutes === null
    ? copy.openItemRuleLeadCloseUndecided
    : `${copy.openItemRuleLeadCloseBefore} ${String(gapMinutes)}${copy.openItemRuleLeadCloseTail}`;
}

/**
 * The admin draft's notice (#17): '검수 제출 전에 채우거나 고칠 항목: YES 조건 · 1차 출처 · 태그
 * 1~5개' while the open-items check finds something missing (`AdminMarket.missingOpenItems`),
 * `undefined` when nothing is. A draft only — the check is what leaving the draft takes, by the
 * review's submission (#78; the interim open went with #21, ADR-0100); a market past it whose
 * category was hidden later keeps it (#172 item 1) and gets no notice — an approval meets it as a
 * refusal, and the open does not check it again.
 *
 * 시각 순서 and 선행 마감 (#22, ADR-0098) name a relation, not a field, so each adds a line per rule
 * it breaks, one under another — '시각 순서: 거래 마감 시각이 예정 판정 시각보다 늦습니다', '선행
 * 마감: 간격(출시 설정)이 미정이라 …' — recomputed from the market's times with the gap the check
 * used (`timeRuleViolations` with `leadCloseGapMinutes`, the API's own rule).
 */
export function openItemsNotice(
  market: TimeRuleInput & {
    status: MarketStatus;
    missingOpenItems: readonly OpenItem[];
    leadCloseGapMinutes: number | null;
  },
): string | undefined {
  if (market.status !== 'draft' || market.missingOpenItems.length === 0) return undefined;
  const gap = market.leadCloseGapMinutes;
  const lines = timeRuleViolations(market, gap)
    .filter((violation) => market.missingOpenItems.includes(RELATION_OF[violation.rule]))
    .map((violation) => {
      const relation = OPEN_ITEM_LABEL[RELATION_OF[violation.rule]];
      return `${relation}: ${timeRuleLine(violation, gap)}`;
    });
  const head = `${copy.adminMarketOpenItems}: ${openItemList(market.missingOpenItems)}`;
  return [head, ...lines].join('\n');
}

/**
 * The items an OPEN_ITEMS_MISSING names: one `{path: [item], message}` per missing item (for the
 * category the message is why, which the label does not repeat). Unknown paths are skipped.
 */
function missingItemsOf(error: ApiError): OpenItem[] {
  if (!Array.isArray(error.details)) return [];
  return (error.details as unknown[]).flatMap((issue) => {
    const path: unknown =
      typeof issue === 'object' && issue !== null ? (issue as { path?: unknown }).path : undefined;
    const item: unknown = Array.isArray(path) ? path[0] : undefined;
    return (OPEN_ITEMS as readonly unknown[]).includes(item) ? [item as OpenItem] : [];
  });
}

/**
 * The items an OPEN_ITEMS_MISSING names as one line of labels ('' when it names none this screen
 * knows): the review's approval says them after its own sentence (lib/market-review.ts, #78).
 */
export function openItemsRefused(error: ApiError): string {
  return openItemList(missingItemsOf(error));
}

/**
 * The toast for a refused transition (design 3.4/3.6, 5.5): OPEN_ITEMS_MISSING on the review's
 * submission (#17, #78 — '검수 제출 전에 채우거나 고칠 항목이 있습니다: …' naming what the refusal
 * names, or the line alone when it names nothing this screen knows), a close already passed naming
 * `closeAt`, VALIDATION_ERROR naming `status` for any other state-machine violation — the "refresh
 * the screen" message, since the state on screen is what is stale. There is no one-admin 판정 to
 * refuse since #152 (ADR-0103: a judgement is registered and another admin approves it, whose
 * refusals are its own — `judgementFailure`, lib/market-judgement.ts), no admin close since #114
 * (ADR-0102: an early end is a pause and another admin's approved early close, whose refusals are
 * the pause's — `pauseFailure`, lib/market-pause.ts), nor an admin open since #21 (ADR-0100): a
 * market opens from 개장 예정 by itself, or by its approval or a reschedule, whose refusals are the
 * review's (`reviewFailure`, lib/market-review.ts).
 * RULES_REQUIRED is no transition's: it is the supplement that leaves an open market without a rule
 * item it had (#23, #80), which `marketFormError` puts on that item's field.
 * NOT_FOUND is the market itself (every admin write answers 404 for an unknown id): not a "try
 * again". A NOT_FOUND naming `categoryId` never reaches here — the form callers hand it to
 * `marketFormError` first. The cookie of another account (`isForAnotherAccount` — every market
 * write names the admin on screen, ADR-0092) is `copy.sessionChanged`: nothing was done, and the
 * caller asks for the session again (`useSessionChanged`).
 */
export function transitionErrorMessage(error: unknown): string {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  if (isApiError(error, 'OPEN_ITEMS_MISSING')) {
    const items = openItemList(missingItemsOf(error));
    return items === ''
      ? `${copy.errMarketOpenItemsMissing}.`
      : `${copy.errMarketOpenItemsMissing}: ${items}`;
  }
  if (isApiError(error, 'NOT_FOUND')) return copy.adminMarketNotFound;
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'status') return copy.errMarketStatus;
    if (field === 'closeAt') return copy.errMarketCloseAt;
    return copy.errMarketInvalid;
  }
  return copy.errUnknown;
}

/**
 * Where on the market form (lib/market-form.ts) an API refusal can land, as react-hook-form names
 * it: a field, a fallback source's row, or its name or address input (`fallbackSources.1.url`,
 * #23). Spelled out rather than taken from the form's values: this file is a member screen's too
 * (lib/market-detail.ts), and the form is the admin's alone (excluded-features.test.ts).
 * `setError` checks each against the form's paths.
 */
export type MarketFormField =
  | 'title'
  | 'description'
  | 'yesCondition'
  | 'noCondition'
  | 'eventDeadline'
  | 'primarySourceName'
  | 'primarySourceUrl'
  | 'fallbackSources'
  | `fallbackSources.${number}`
  | `fallbackSources.${number}.${'name' | 'url'}`
  | 'fallbackCondition'
  | 'longDelayDays'
  | 'delayHandling'
  | 'categoryId'
  | 'tags'
  | 'imageUrl'
  | 'scheduledOpenAt'
  | 'closeAt'
  | 'scheduledAnnouncementAt'
  | 'scheduledJudgementAt'
  | 'judgementTimeZone'
  | 'slug';

/**
 * The body fields that are form fields of the same name, each with what its refusal says. The
 * times and 사건 기한 are `timeRefusal`'s: one field's refusals differ by message there.
 */
const FIELD_MESSAGE: Readonly<Record<string, string>> = {
  title: copy.errMarketTitle,
  description: copy.errMarketText,
  yesCondition: copy.errMarketText,
  noCondition: copy.errMarketText,
  longDelayDays: copy.errMarketLongDelayDays,
  delayHandling: copy.errMarketText,
  imageUrl: copy.errMarketImageUrl,
};

/**
 * The lead-close refusal's sentence (#172 item 13): the minutes of the gap the market is held to
 * between the two fragments, as copy.ts composes every number (no `{{…}}`); without them, the
 * sentence that names the gap by its name. The admin form's own rule says the same
 * (lib/market-form.ts).
 */
export function leadCloseMessage(gapMinutes: number | null | undefined): string {
  return gapMinutes === null || gapMinutes === undefined
    ? copy.errMarketLeadClose
    : `${copy.errMarketLeadCloseBefore} ${String(gapMinutes)}${copy.errMarketLeadCloseTail}`;
}

/** What each order rule's refusal says, on either of its two fields (#172 item 12, A1). */
const TIME_ORDER_MESSAGE: { readonly [R in TimeOrderRule]: string } = {
  openBeforeClose: copy.errMarketTimeOpenBeforeClose,
  closeByJudgement: copy.errMarketTimeCloseByJudgement,
  deadlineByJudgement: copy.errMarketTimeDeadlineByJudgement,
};

/** A time field's refusal when no time rule names it: its format, bound or (the close) future. */
const TIME_FIELD_MESSAGE: { readonly [F in TimeRuleField | 'judgementTimeZone']: string } = {
  scheduledOpenAt: copy.errMarketScheduledTime,
  closeAt: copy.errMarketCloseAt,
  scheduledAnnouncementAt: copy.errMarketScheduledTime,
  scheduledJudgementAt: copy.errMarketScheduledTime,
  eventDeadline: copy.errMarketEventDeadline,
  judgementTimeZone: copy.errMarketTimeZone,
};

/**
 * What a refusal naming a time field (#22, ADR-0098) or 사건 기한 says, by its detail message: a
 * broken time rule by the rule its message is (TIME_RULE_MESSAGES — an order rule one sentence on
 * both its ends, the lead close with `gapMinutes`), a supplement's earlier close ('cannot move
 * earlier while open'), close while PAUSED (SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED, #80) or lead close
 * it could not check ('lead-close gap undecided'); anything else is the field's own
 * (TIME_FIELD_MESSAGE).
 */
function timeRefusal(
  field: TimeRuleField | 'judgementTimeZone',
  message: string | undefined,
  gapMinutes: number | null | undefined,
): string {
  if (message === LEAD_CLOSE_GAP_UNDECIDED_MESSAGE) return copy.errMarketLeadCloseUndecided;
  if (message === 'cannot move earlier while open') return copy.errMarketCloseEarlier;
  if (message === SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED) return copy.errMarketSupplementClosePaused;
  const rule = TIME_RULES.find((candidate) => {
    const messages: Partial<Record<string, string>> = TIME_RULE_MESSAGES[candidate];
    return message !== undefined && messages[field] === message;
  });
  if (rule === undefined) return TIME_FIELD_MESSAGE[field];
  return rule === 'leadClose' ? leadCloseMessage(gapMinutes) : TIME_ORDER_MESSAGE[rule];
}

/** The fields `timeRefusal` speaks for. */
function isTimeField(field: unknown): field is TimeRuleField | 'judgementTimeZone' {
  return typeof field === 'string' && Object.hasOwn(TIME_FIELD_MESSAGE, field);
}

/**
 * Where an open market's RULES_REQUIRED lands (#23 — a supplement's since #80): the item's field,
 * or for a source, when the form's values do not show its blank input (`blankSourceInput`), the
 * primary's name or the fallback list itself. Each detail names one item; the first is placed, as
 * for any refusal.
 */
const RULE_ITEM_FIELD: { readonly [K in RuleItem]: MarketFormField } = {
  description: 'description',
  yesCondition: 'yesCondition',
  noCondition: 'noCondition',
  eventDeadline: 'eventDeadline',
  primarySource: 'primarySourceName',
  fallbackSources: 'fallbackSources',
  fallbackCondition: 'fallbackCondition',
  longDelayDays: 'longDelayDays',
  delayHandling: 'delayHandling',
};

/** A source's inputs on the form: its name's, its address's, and for a fallback its row. */
interface SourceInputs {
  name: MarketFormField;
  url: MarketFormField;
  row?: MarketFormField;
}

const PRIMARY_SOURCE_INPUTS: SourceInputs = { name: 'primarySourceName', url: 'primarySourceUrl' };

/**
 * Where an edit of an open market that changes a version item is refused
 * (SUPPLEMENT_ONLY_WHILE_OPEN, #80): the item's input — a rule item's as RULE_ITEM_FIELD, the title
 * and the times their own.
 */
const VERSION_ITEM_FIELD: { readonly [K in RuleVersionItem]: MarketFormField } = {
  title: 'title',
  ...RULE_ITEM_FIELD,
  scheduledOpenAt: 'scheduledOpenAt',
  closeAt: 'closeAt',
  scheduledAnnouncementAt: 'scheduledAnnouncementAt',
  scheduledJudgementAt: 'scheduledJudgementAt',
  judgementTimeZone: 'judgementTimeZone',
};

const fallbackSourceInputs = (at: number): SourceInputs => ({
  name: `fallbackSources.${at}.name`,
  url: `fallbackSources.${at}.url`,
  row: `fallbackSources.${at}`,
});

/**
 * The market form's source inputs as typed: `MarketFormValues` (lib/market-form.ts) holds them,
 * and is spelled out here for the reason `MarketFormField` is — that file is the admin's alone.
 */
export interface MarketSourceInputs {
  primarySourceName: string;
  primarySourceUrl: string;
  fallbackSources: readonly MarketSource[];
}

/**
 * The blank input of a source a supplement's RULES_REQUIRED names (#23, ADR-0097; #80), read from
 * the form's values as sent: the form's own rule puts its refusal under every blank input
 * (`missingItemPaths`, lib/market-form.ts), and this one refusal goes under the first of them in
 * the form's order — the primary's name when it is blank, alone or with the address, else its
 * address; the first fallback that is not complete (`isCompleteSource`), its name or else its
 * address. `undefined` for any other item, or when the values hold no such input (the API judged
 * other values).
 */
function blankSourceInput(item: RuleItem, values: MarketSourceInputs): MarketFormField | undefined {
  const blankOf = (source: MarketSource, inputs: SourceInputs) => {
    if (source.name.trim() === '') return inputs.name;
    return source.url.trim() === '' ? inputs.url : undefined;
  };
  if (item === 'primarySource') {
    const primary = { name: values.primarySourceName, url: values.primarySourceUrl };
    return blankOf(primary, PRIMARY_SOURCE_INPUTS);
  }
  if (item !== 'fallbackSources') return undefined;
  const at = values.fallbackSources.findIndex((source) => !isCompleteSource(source));
  const source = values.fallbackSources[at];
  return source === undefined ? undefined : blankOf(source, fallbackSourceInputs(at));
}

/**
 * A source's refusal (`marketSourceSchema`): its name or its address, on that input, or both
 * blank, on a fallback's row as the form says it. The form sends no primary source with both
 * inputs blank (that is `null`), so it has no `row`, and that refusal is the generic toast.
 */
function sourceRefusal(
  inputs: SourceInputs,
  part: unknown,
  message: string | undefined,
): { field: MarketFormField; message: string } | undefined {
  if (part === 'name') return { field: inputs.name, message: copy.errMarketSourceName };
  if (part === 'url') return { field: inputs.url, message: copy.errMarketSourceUrl };
  if (part === undefined && message === 'empty source' && inputs.row !== undefined) {
    return { field: inputs.row, message: copy.errMarketSourceEmpty };
  }
  return undefined;
}

/**
 * Where a refused create/update lands on the form: the field the API named, with the message
 * the admin can act on. `slug` is the UNIQUE collision (design 3.4), `categoryId` an unknown
 * (404) category or one a market may not be filed under, said by why (#17: hidden, under a hidden
 * parent, or holding sub-categories), `tags` (and `tags.N`) a list the API refused — a second
 * name of one tag, a malformed name, too many, or none left on an open market. The rule items
 * (#23) land on their own fields, a source's on the input the path names (`validationPath`:
 * `['fallbackSources', 1, 'url']` is `fallbackSources.1.url`), and RULES_REQUIRED — a supplement
 * that leaves an open market without a rule item it had (#80) — on the first item it names: its
 * field, or for a source the blank input `values` (the form's, as sent) shows (`blankSourceInput`),
 * as the form's own rule places it; without them, the primary's name or the fallback list. An edit
 * of an open market that changes a version item (SUPPLEMENT_ONLY_WHILE_OPEN, #80) lands on that
 * item's input. Anything else — including a VALIDATION_ERROR naming `status`, which is not a field
 * the form has — is `undefined` and goes to the generic toast.
 *
 * The times (#22, ADR-0098) land on their own inputs, and so does 사건 기한, each said by what the
 * refusal is (`timeRefusal`): a broken order rule names both its ends, the one the write sent
 * first, so the sentence goes under the input the admin changed; a lead close takes its minutes
 * from `leadCloseGapMinutes`, the gap the market is held to (`AdminMarket.leadCloseGapMinutes`). A
 * supplement's RULES_REQUIRED naming the zone — cleared — lands on its select.
 */
export function marketFormError(
  error: unknown,
  values?: MarketSourceInputs,
  leadCloseGapMinutes?: number | null,
): { field: MarketFormField; message: string } | undefined {
  if (!isApiError(error)) return undefined;
  if (isApiError(error, 'RULES_REQUIRED')) {
    if (validationField(error) === 'judgementTimeZone') {
      return { field: 'judgementTimeZone', message: copy.errMarketRulesOpen };
    }
    const item = ruleItemSchema.safeParse(validationField(error));
    if (!item.success) return undefined;
    const blank = values === undefined ? undefined : blankSourceInput(item.data, values);
    return { field: blank ?? RULE_ITEM_FIELD[item.data], message: copy.errMarketRulesOpen };
  }
  if (!isApiError(error, 'VALIDATION_ERROR') && !isApiError(error, 'NOT_FOUND')) return undefined;
  const path = validationPath(error);
  const [named, at, part] = path ?? [];
  const message = validationMessage(error);
  const versionItem = ruleVersionItemSchema.safeParse(named);
  if (message === SUPPLEMENT_ONLY_WHILE_OPEN && versionItem.success) {
    return { field: VERSION_ITEM_FIELD[versionItem.data], message: copy.errMarketSupplementOnly };
  }
  switch (named) {
    case 'slug':
      // The unique-index refusal (design 3.4) says "already exists" in its issue; the shared
      // zod rule's refusal (pattern / uuid-shaped) says how the slug is malformed.
      return {
        field: 'slug',
        message: isSlugTaken(error) ? copy.errMarketSlugTaken : copy.errMarketSlug,
      };
    case 'categoryId':
      return { field: 'categoryId', message: categoryMessage(error) };
    case 'tags':
      return { field: 'tags', message: tagsMessage(error) };
    case 'primarySource':
      return sourceRefusal(PRIMARY_SOURCE_INPUTS, at, message);
    case 'fallbackSources':
      // The list itself: more than MARKET_FALLBACK_SOURCES_MAX.
      if (at === undefined) {
        return { field: 'fallbackSources', message: copy.errMarketFallbackSourcesMax };
      }
      if (typeof at !== 'number') return undefined;
      return sourceRefusal(fallbackSourceInputs(at), part, message);
    case 'fallbackCondition':
      return {
        field: 'fallbackCondition',
        message:
          message === 'no fallback source'
            ? copy.errMarketFallbackConditionNoSource
            : copy.errMarketText,
      };
    default: {
      if (isTimeField(named)) {
        return { field: named, message: timeRefusal(named, message, leadCloseGapMinutes) };
      }
      if (typeof named !== 'string' || !Object.hasOwn(FIELD_MESSAGE, named)) return undefined;
      const text = FIELD_MESSAGE[named];
      return text === undefined ? undefined : { field: named as MarketFormField, message: text };
    }
  }
}

/**
 * Why the API refused the category (#17, ADR-0093 decision 2 #172 item 1): the VALIDATION_ERROR's
 * issue message is the reason (`CATEGORY_UNSELECTABLE_REASONS`); a 404 (unknown id) or a reason
 * this screen does not know is the plain "cannot be chosen".
 */
function categoryMessage(error: ApiError): string {
  if (!isApiError(error, 'VALIDATION_ERROR')) return copy.errMarketCategoryUnavailable;
  switch (validationMessage(error)) {
    case 'inactive':
      return copy.errMarketCategoryHidden;
    case 'parent_inactive':
      return copy.errMarketCategoryParentHidden;
    case 'subcategories':
      return copy.errMarketCategoryHasChildren;
    default:
      return copy.errMarketCategoryUnavailable;
  }
}

/**
 * Why the API refused the tags (#17): `marketTagsSchema`'s duplicate ('duplicate tag', naming the
 * second one's index), the open market left without any ('required while open', naming `tags`),
 * the list over MARKET_TAGS_MAX (naming `tags` itself), and otherwise a name `tagNameSchema`
 * refused (naming `tags.N`): zod's 'Too big' for the length, the pattern's message for the rest.
 */
function tagsMessage(error: ApiError): string {
  const message = validationMessage(error);
  if (message === 'duplicate tag') return copy.errMarketTagDuplicate;
  if (message === 'required while open') return copy.errMarketTagsOpen;
  const first: unknown = Array.isArray(error.details) ? (error.details as unknown[])[0] : undefined;
  const path: unknown =
    typeof first === 'object' && first !== null ? (first as { path?: unknown }).path : undefined;
  if (!Array.isArray(path) || path.length < 2) return copy.errMarketTagsMax;
  return message?.startsWith('Too big') ? copy.errMarketTagLength : copy.errMarketTagFormat;
}

function isSlugTaken(error: ApiError): boolean {
  if (/already taken/i.test(error.message)) return true;
  return validationMessage(error) === 'already exists';
}
