import {
  APPROVAL_REASON_MAX_LENGTH,
  APPROVAL_REFUSALS,
  type ApprovalRefusal,
  MARKET_REJECT_REASONS,
  MARKET_REVIEW_CHECKLIST,
  MARKET_REVIEW_EXCLUSIONS,
  type MarketRejectReason,
  type MarketReviewChecklistItem,
  type MarketReviewExclusion,
  type MarketStatus,
  TIME_RULE_MESSAGES,
  type TimeRuleInput,
  isCompleteReviewChecklist,
  marketReviewExclusion,
  timeRuleViolations,
} from '@buddha/shared';
import { copy } from '@/copy';
import { nicknameShown } from './account-closure';
import {
  type AdminMarketReview,
  type MarketReviewLogEntry,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';
import { kstLocalToIso } from './datetime';
import { type EventRow, openItemsRefused, reviewDetailRows } from './market-admin';

/**
 * The pure half of the 개설 검수 screens (#78, ADR-0099; ADR-0093 decision 2 #172 items 4·5·6): who
 * on screen may decide a review, the 승인할 수 없는 관리자 list, the 검수 기록's rows, what each
 * dialog may send, what a refusal says, what a write that went through says (#21, ADR-0100) and
 * whether a 개장 예정 market's close has passed before it opened. The admin detail's panel and dialogs
 * (app/admin/markets/[id]/market-review-*.tsx) draw them; the names of the checklist items and of
 * the 반려 사유 are lib/market-admin.ts's, which the 이벤트 로그 reads too.
 */

/**
 * What to confirm for each checklist item, one line under its name in the approval dialog (#172
 * item 4): the three bans, the required items, the order of the times with the trading period and
 * the gaps (item 12: the reviewer's), the lead close with '없음' and the match and election
 * principle (item 13), and independent judgement (item 3).
 */
export const REVIEW_CHECK_HINT: Record<MarketReviewChecklistItem, string> = {
  knownResult: copy.reviewCheckKnownResultHint,
  ambiguity: copy.reviewCheckAmbiguityHint,
  duplicate: copy.reviewCheckDuplicateHint,
  requiredItems: copy.reviewCheckRequiredItemsHint,
  timeOrder: copy.reviewCheckTimeOrderHint,
  leadClose: copy.reviewCheckLeadCloseHint,
  independence: copy.reviewCheckIndependenceHint,
};

/**
 * Why the admin on screen may not approve or reject (#172 item 5), the notice above the disabled
 * buttons — and the review's APPROVAL_NOT_ALLOWED, which names the same reason.
 */
export const REVIEW_EXCLUSION_NOTE: Record<MarketReviewExclusion, string> = {
  creator: copy.adminMarketReviewExcludedCreator,
  editor: copy.adminMarketReviewExcludedEditor,
  requester: copy.adminMarketReviewExcludedRequester,
};

/** Each exclusion's place, as the 승인·반려할 수 없는 관리자 list names it. */
const REVIEW_ROLE_LABEL: Record<MarketReviewExclusion, string> = {
  creator: copy.adminMarketReviewRoleCreator,
  editor: copy.adminMarketReviewRoleEditor,
  requester: copy.adminMarketReviewRoleRequester,
};

/** The parts of `AdminMarket.review` that say who decides nothing. */
export type ReviewParties = Pick<AdminMarketReview, 'createdBy' | 'editors' | 'pending'>;

/**
 * Why the admin on screen may not approve or reject (`marketReviewExclusion`, the server's own
 * precedence: creator → editor → requester), `null` when they may, `undefined` until `GET /me` has
 * said who is on screen (`useOperatorId`): the screen offers no decision until it knows.
 */
export function reviewExclusion(
  review: ReviewParties,
  operatorId: string | undefined,
): MarketReviewExclusion | null | undefined {
  if (operatorId === undefined) return undefined;
  return marketReviewExclusion(operatorId, {
    createdBy: review.createdBy.id,
    editorIds: review.editors.map((editor) => editor.id),
    requestedBy: review.pending?.requestedBy.id ?? null,
  });
}

/** One account of the 승인·반려할 수 없는 관리자 list. */
export interface ExcludedAdmin {
  id: string;
  /** The nickname, or '탈퇴한 사용자' for an account closed since (`nicknameShown`). */
  name: string;
  /** Every place that excludes it, in MARKET_REVIEW_EXCLUSIONS order: '만든 관리자 · 수정한 관리자'. */
  roles: string;
  /** The admin on screen: the row ends '(나)'. */
  viewer: boolean;
}

/**
 * Who may not approve or reject (#172 item 5): the creator, every admin who edited the content (the
 * first edit first) and the submitter while a request is pending — one row per account, the places
 * it holds joined, in the order an account first appears there.
 */
export function excludedAdmins(
  review: ReviewParties,
  operatorId: string | undefined,
): ExcludedAdmin[] {
  const rows = new Map<string, { name: string; roles: Set<MarketReviewExclusion> }>();
  const add = (actor: { id: string; nickname: string | null }, role: MarketReviewExclusion) => {
    const row = rows.get(actor.id) ?? { name: nicknameShown(actor.nickname), roles: new Set() };
    row.roles.add(role);
    rows.set(actor.id, row);
  };
  add(review.createdBy, 'creator');
  for (const editor of review.editors) add(editor, 'editor');
  if (review.pending !== null) add(review.pending.requestedBy, 'requester');
  return [...rows].map(([id, row]) => ({
    id,
    name: row.name,
    roles: MARKET_REVIEW_EXCLUSIONS.filter((role) => row.roles.has(role))
      .map((role) => REVIEW_ROLE_LABEL[role])
      .join(' · '),
    viewer: id === operatorId,
  }));
}

/**
 * Whether the 승인·반려할 수 없는 관리자 list says anything to act on: while the market is a draft (who
 * will not be able to decide it once submitted) or in review (who may not decide it now). Past the
 * decision the 검수 기록 says who decided.
 */
export function showsExcludedAdmins(status: MarketStatus): boolean {
  return status === 'draft' || status === 'review';
}

/**
 * One 검수 기록 entry's rows (#78): its status change as the badges name the statuses ('검수 중 →
 * 초안'; none for a reschedule, which changes none), then what the record says
 * (`reviewDetailRows`: a 반려's reason and 설명, an approval's checklist and reason, a reschedule's
 * times and reason, a 되돌리기's reason). `statusLabel` is the badges' MARKET_STATUS_LABEL and
 * `time` renders a reschedule's instants — the panel's `formatKst`, as every admin time.
 */
export function reviewLogRows(
  entry: MarketReviewLogEntry,
  statusLabel: Readonly<Record<MarketStatus, string>>,
  time: (iso: string) => string,
): EventRow[] {
  const change =
    entry.fromStatus !== null && entry.toStatus !== null
      ? [
          {
            label: copy.reviewLogStatus,
            value: `${statusLabel[entry.fromStatus]} → ${statusLabel[entry.toStatus]}`,
          },
        ]
      : [];
  return [
    ...change,
    ...reviewDetailRows(
      {
        type: entry.type,
        rejectReason: entry.rejectReason,
        checklist: entry.checklist,
        scheduledOpenBefore: entry.scheduledOpenBefore,
        scheduledOpenAfter: entry.scheduledOpenAfter,
        reason: entry.reason,
      },
      time,
    ),
  ];
}

/** Who wrote a 검수 기록 entry: the nickname, '탈퇴한 사용자' for an account gone since. */
export function reviewActorName(actor: MarketReviewLogEntry['actor']): string {
  return nicknameShown(actor?.nickname ?? null);
}

/**
 * A 개장 예정 market whose close has come before it opened (#21, ADR-0100; ADR-0093 decision 2 #172
 * item 6): the worker opens a SCHEDULED market only while its close is ahead, so this one stays
 * 개장 예정 — public as such — until an admin sends it back to a draft to fix its times; the
 * reschedule is refused too (a close already passed). The panel warns in place of its note.
 *
 * Judged at `readAt`, the instant the row was read (the admin query's `dataUpdatedAt`), not at the
 * instant it is drawn: a row read before the close says nothing of what the worker did since — it
 * may have opened the market, and the close job closed it — so only the server's own answer from
 * after the close, still 개장 예정, is a market that will not open (Codex review on #21). The
 * detail re-reads a SCHEDULED market at its close for that answer (`scheduledMarketPollDelay` in
 * market-admin.ts). At the close itself, as the open's rule reads it (`close_at > now` to open), on
 * the browser's clock — as the browser received the row, so a clock running ahead of the
 * database's, or an answer crossing the close in flight, can call lapsed a row the server read a
 * moment before (ADR-0100 7-13).
 */
export function scheduledCloseLapsed(
  market: { status: MarketStatus; closeAt: string },
  readAt: number,
): boolean {
  if (market.status !== 'scheduled') return false;
  const closeAt = new Date(market.closeAt).getTime();
  return !Number.isNaN(closeAt) && closeAt <= readAt;
}

// ---- what each dialog may send ---------------------------------------------------------------

/**
 * A reason as typed: trimmed, and why it cannot be sent (blank, or past APPROVAL_REASON_MAX_LENGTH
 * — `approvalReasonSchema`, the one every review write takes), or null when it can.
 */
export function reviewReasonDraft(text: string): { reason: string; error: string | null } {
  const reason = text.trim();
  const ok = reason.length >= 1 && reason.length <= APPROVAL_REASON_MAX_LENGTH;
  return { reason, error: ok ? null : copy.errMarketReviewReason };
}

/**
 * 승인 (#172 item 4): ready only once every checklist item is confirmed (`isCompleteReviewChecklist`,
 * the server's own rule) and a reason is typed. The checklist goes in the checklist's order.
 */
export function approveDraft(
  checked: readonly MarketReviewChecklistItem[],
  reasonText: string,
): { ready: boolean; checklist: MarketReviewChecklistItem[]; reason: string } {
  const checklist = MARKET_REVIEW_CHECKLIST.filter((item) => checked.includes(item));
  const { reason, error } = reviewReasonDraft(reasonText);
  return { ready: isCompleteReviewChecklist(checklist) && error === null, checklist, reason };
}

/** A 반려 사유 as the select holds it ('' for none picked), or null. */
export function rejectReasonOf(value: string): MarketRejectReason | null {
  return MARKET_REJECT_REASONS.find((reason) => reason === value) ?? null;
}

/** 반려 (#172 item 4): ready once a reason is picked from the list and the 설명 is typed. */
export function rejectDraft(
  value: string,
  descriptionText: string,
): { ready: boolean; rejectReason: MarketRejectReason | null; reason: string } {
  const rejectReason = rejectReasonOf(value);
  const { reason, error } = reviewReasonDraft(descriptionText);
  return { ready: rejectReason !== null && error === null, rejectReason, reason };
}

/** 되돌리기 (#172 item 6): ready once its reason is typed. */
export function revertDraft(reasonText: string): { ready: boolean; reason: string } {
  const { reason, error } = reviewReasonDraft(reasonText);
  return { ready: error === null, reason };
}

/** The times the reschedule's order rule reads: the market's, the new scheduled open in them. */
export type RescheduleMarket = TimeRuleInput & { leadCloseGapMinutes: number | null };

/**
 * 예정 개장 시각 변경 (#172 item 6, ADR-0093 decision 3 '#21 앞당긴 개장'), from the dialog's KST
 * `datetime-local` and its reason:
 * - `scheduledOpenAt`: the instant typed, or null while it is blank or unreadable;
 * - `atError`: what is said under the field — an unreadable date, or the order rule the server
 *   checks again on the merged times (`timeRuleViolations` at the market's gap: of the rules only
 *   openBeforeClose can move, in whole minutes). A past instant is allowed, and opens the market
 *   at once (#21, ADR-0100: `reviewWriteSuccess`);
 * - `unchanged`: the instant the market holds already, which the server refuses ('unchanged') — not
 *   said, since the field opens on it: the confirm stays off until it moves;
 * - `ready`: a new, ordered instant and a reason.
 */
export function rescheduleDraft(
  local: string,
  reasonText: string,
  market: RescheduleMarket,
): {
  ready: boolean;
  scheduledOpenAt: string | null;
  atError: string | null;
  unchanged: boolean;
  reason: string;
} {
  const { reason, error } = reviewReasonDraft(reasonText);
  const scheduledOpenAt = kstLocalToIso(local);
  let atError: string | null = null;
  if (local !== '' && scheduledOpenAt === null) atError = copy.errMarketReviewRescheduleTime;
  else if (
    scheduledOpenAt !== null &&
    timeRuleViolations({ ...market, scheduledOpenAt }, market.leadCloseGapMinutes).some(
      (violation) => violation.rule === 'openBeforeClose',
    )
  ) {
    atError = copy.errMarketTimeOpenBeforeClose;
  }
  const stored = market.scheduledOpenAt === null ? null : new Date(market.scheduledOpenAt);
  const unchanged =
    scheduledOpenAt !== null &&
    stored !== null &&
    !Number.isNaN(stored.getTime()) &&
    stored.toISOString() === scheduledOpenAt;
  return {
    ready: scheduledOpenAt !== null && atError === null && !unchanged && error === null,
    scheduledOpenAt,
    atError,
    unchanged,
    reason,
  };
}

// ---- what a write that went through says -----------------------------------------------------

/** The two review writes that can open the market (#21): 승인 and 예정 개장 시각 변경. */
export type OpeningReviewWrite = 'approve' | 'reschedule';

/**
 * The toast of a 승인 or an 예정 개장 시각 변경 that went through (#21, ADR-0100), from the status of
 * the market the write answered with. `open` when the scheduled open had come by the write's own
 * instant, so the same transaction opened the market (an approval past the scheduled open opens at
 * once, ADR-0093 decision 2 #172 item 6; a scheduled open moved to now or earlier opens it,
 * decision 3 '#21 앞당긴 개장'): the toast says it opened. Otherwise the market is 개장 예정, which
 * the worker opens at its scheduled open, and the toast is the write's own.
 */
export function reviewWriteSuccess(write: OpeningReviewWrite, status: MarketStatus): string {
  const opened = status === 'open';
  if (write === 'approve') {
    return opened ? copy.adminMarketReviewApprovedOpened : copy.adminMarketReviewApproved;
  }
  return opened ? copy.adminMarketReviewRescheduledOpened : copy.adminMarketReviewRescheduled;
}

// ---- what a refusal says ---------------------------------------------------------------------

/**
 * The two-person rule's refusals as the review says them: its exclusions in their own words.
 * `no_decider` is a supplement request's (#80), which no review meets.
 */
const REVIEW_REFUSAL_MESSAGES: Readonly<Record<ApprovalRefusal, string>> = {
  ...REVIEW_EXCLUSION_NOTE,
  decided: copy.errApprovalDecided,
  retracted: copy.errApprovalRetracted,
  not_requester: copy.errApprovalNotRequester,
  no_decider: copy.errApprovalNoDecider,
};

/** The fields of the review dialogs a refusal can land under. */
export type ReviewField = 'reason' | 'rejectReason' | 'scheduledOpenAt' | 'checklist';

/**
 * Where a refused review write is said (#78):
 * - `field`: under the input it is about — the reason (or a 반려's 설명), the 반려 사유, the checklist,
 *   the new scheduled open ('unchanged', or the order rule: TIME_RULE_MESSAGES.openBeforeClose).
 *   `refresh` on 'unchanged': the time on screen was another admin's before, so the detail — and
 *   the dialog's 현재 line — is read again;
 * - `alert`: in the dialog, which stays — APPROVAL_NOT_ALLOWED by its reason (the exclusions in the
 *   panel's words), OPEN_ITEMS_MISSING at the approval ('…초안으로 되돌려 고쳐 주세요: 카테고리'), a
 *   close already passed, a status another admin moved, the market gone, a session ended or a role
 *   revoked, a request that never reached the API. `refresh` when the screen behind is out of date:
 *   the caller reads the detail again;
 * - `toast`: the cookie of another account (ADR-0092): nothing was done, the dialog closes — the
 *   page drops it once the session names the admin really signed in — and the session is asked
 *   again.
 */
export type ReviewFailure =
  | { kind: 'field'; field: ReviewField; message: string; refresh: boolean }
  | { kind: 'alert'; message: string; refresh: boolean }
  | { kind: 'toast'; message: string };

export function reviewFailure(error: unknown): ReviewFailure {
  const alert = (message: string, refresh = false): ReviewFailure => ({
    kind: 'alert',
    message,
    refresh,
  });
  const field = (name: ReviewField, message: string, refresh = false): ReviewFailure => ({
    kind: 'field',
    field: name,
    message,
    refresh,
  });
  if (isForAnotherAccount(error)) return { kind: 'toast', message: copy.sessionChanged };
  if (isApiError(error, 'UNAUTHENTICATED')) return alert(copy.errUnauthenticated);
  // Not the account check above: AdminGuard's, once another admin revoked this one's role.
  if (isApiError(error, 'FORBIDDEN')) return alert(copy.adminOnly);
  if (isApiError(error, 'APPROVAL_NOT_ALLOWED')) {
    const refusal = APPROVAL_REFUSALS.find((reason) => reason === validationMessage(error));
    return alert(refusal === undefined ? copy.errUnknown : REVIEW_REFUSAL_MESSAGES[refusal], true);
  }
  if (isApiError(error, 'OPEN_ITEMS_MISSING')) {
    const items = openItemsRefused(error);
    return alert(
      items === ''
        ? `${copy.errMarketReviewOpenItems}.`
        : `${copy.errMarketReviewOpenItems}: ${items}`,
      true,
    );
  }
  if (isApiError(error, 'NOT_FOUND')) return alert(copy.adminMarketNotFound, true);
  if (isApiError(error, 'VALIDATION_ERROR')) {
    switch (validationField(error)) {
      case 'status':
        return alert(copy.errMarketStatus, true);
      case 'closeAt':
        return alert(copy.errMarketReviewCloseAtPassed, true);
      case 'checklist':
        return field('checklist', copy.errMarketReviewChecklist);
      case 'reason':
        return field('reason', copy.errMarketReviewReason);
      case 'rejectReason':
        return field('rejectReason', copy.errMarketReviewRejectReason);
      case 'scheduledOpenAt': {
        const message = validationMessage(error);
        if (message === 'unchanged') {
          return field('scheduledOpenAt', copy.errMarketReviewRescheduleUnchanged, true);
        }
        return field(
          'scheduledOpenAt',
          message === TIME_RULE_MESSAGES.openBeforeClose.scheduledOpenAt
            ? copy.errMarketTimeOpenBeforeClose
            : copy.errMarketReviewRescheduleTime,
        );
      }
      default:
        return alert(copy.errMarketInvalid);
    }
  }
  return alert(isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown);
}
