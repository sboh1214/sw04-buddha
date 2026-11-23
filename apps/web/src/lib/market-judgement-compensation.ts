import {
  APPROVAL_REFUSALS,
  type ApprovalRefusal,
  type ApprovalStatus,
  type JudgementCompensationRecipientState,
  MARKET_JUDGEMENT_COMPENSATION_REFUSALS,
  type MarketJudgementIncidentQueueKind,
  judgementIncidentDecisionRefusal,
} from '@buddha/shared';
import { copy } from '@/copy';
import {
  type AdminMarket,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';
import { paidRegistrantOf } from './market-judgement-incident';
import { reviewReasonDraft } from './market-review';

/**
 * The pure half of the admin detail's 판정 오류 보상 (#144 part 2, ADR-0166; owner answers 144-1,
 * 144-2, 144-4, 144-6, 144-7, 144-12, 144-15, 144-16, 144-19; ADR-0120 decision 5): whether the
 * panel is drawn, why a 보상 요청 is not taken now, who on screen may approve or reject the waiting
 * request and why not, what the request's form may send, what each decision's dialog says, how a
 * recipient's state and a request's end are named, and what a refusal says. The panel, its
 * dialogs and the recipients list (app/admin/markets/[id]/market-judgement-compensation-*.tsx) and
 * the 판정 오류 사건 검토 대기 queue's 보상 승인 rows draw them. Admin-only: the public figures are
 * `Market.judgingRecord.correction.compensation`, counts and totals alone (144-6), worded by
 * lib/judgement-correction.ts.
 */

/** The compensation state of the market's confirmed incident, or null while none is confirmed. */
export type CompensationState = NonNullable<AdminMarket['judgementIncident']['compensation']>;

/** Whether the admin detail draws the 판정 오류 보상 panel: once an incident is confirmed. */
export function showsJudgementCompensationPanel(
  market: Pick<AdminMarket, 'judgementIncident'>,
): boolean {
  return market.judgementIncident.compensation !== null;
}

/** '대상 계정 {n}개 · 총 {coin}', `coin` already worded ('1,250 Coin'). */
export function compensationSummaryText(accountCount: number, coin: string): string {
  return copy.adminMarketJudgementCompensationSummary
    .replace('{n}', accountCount.toLocaleString('ko-KR'))
    .replace('{coin}', coin);
}

/** A count template's `{n}` filled in Korean grouping. */
export function countText(template: string, n: number): string {
  return template.replace('{n}', n.toLocaleString('ko-KR'));
}

/**
 * Why the market takes no 보상 요청 now, in the order the server refuses: a #93 ledger hold
 * (`held`), a request waiting (`pending` — one at a time), one approved (`paid` — once per
 * incident, 144-2), no account owed anything (`none` — public 보상 대상 없음, 144-15). Null when one
 * is taken (the server checks every one again).
 */
export type CompensationUnrequestable = 'held' | 'pending' | 'paid' | 'none';

export function compensationUnrequestable(
  compensation: CompensationState,
): CompensationUnrequestable | null {
  if (compensation.held) return 'held';
  if (compensation.pending !== null) return 'pending';
  if (compensation.paid !== null) return 'paid';
  if (compensation.preview === null || compensation.preview.accountCount === 0) return 'none';
  return null;
}

const UNREQUESTABLE_NOTE: Readonly<Record<CompensationUnrequestable, string | null>> = {
  held: copy.adminMarketJudgementCompensationHeld,
  pending: copy.adminMarketJudgementCompensationUnrequestable,
  // Once paid the panel shows the payout itself; the button goes.
  paid: null,
  none: copy.adminMarketJudgementCompensationNone,
};

/** What the panel says under 보상 요청 while none is taken, or null when it says nothing. */
export function compensationUnrequestableNote(reason: CompensationUnrequestable): string | null {
  return UNREQUESTABLE_NOTE[reason];
}

/** The two decisions another admin makes on the waiting request. */
export type CompensationReview = 'approve' | 'reject';

/**
 * Why the admin on screen may not press 보상 승인 or 보상 반려 on the waiting request, or null when
 * they may — the server refuses each again:
 * - `operator`: `GET /me` has not said who is on screen yet (ADR-0092);
 * - `own`: they asked for it (#171, the approval engine's `requester`);
 * - `registrant` (보상 승인 only): they registered the paid judgement version (144-4, the shared
 *   `judgementIncidentDecisionRefusal`, `decider` 'registrant') — a 반려 is a 정리 목적의 반려
 *   (ADR-0120 decision 5) they may make;
 * - `held` (보상 승인 only): the market is ledger-held (#93);
 * - `blocked` (보상 승인 only): an open listed account's balance record left its ledger — the whole
 *   approval waits (144-16) until a 대사 정정 fixes it.
 * A conflict on the market is #143's, which the approval's confirmation and the server check (a
 * 반려 asks none).
 */
export type CompensationReviewUnavailable = 'operator' | 'own' | 'registrant' | 'held' | 'blocked';

export function compensationReviewUnavailable(
  market: Pick<AdminMarket, 'judgement' | 'judgementIncident'>,
  kind: CompensationReview,
  operatorId: string | undefined,
): CompensationReviewUnavailable | null {
  const compensation = market.judgementIncident.compensation;
  if (operatorId === undefined) return 'operator';
  if (compensation?.pending?.requestedBy.id === operatorId) return 'own';
  if (kind === 'reject') return null;
  const paid = paidRegistrantOf(market);
  if (paid !== null && judgementIncidentDecisionRefusal(operatorId, paid) !== null) {
    return 'registrant';
  }
  if (compensation?.held === true) return 'held';
  if ((compensation?.preview?.blockedCount ?? 0) > 0) return 'blocked';
  return null;
}

/** How a 보상 요청 ended, its badge in the 보상 요청 기록 (`approval_requests.status`). */
export const COMPENSATION_STATUS_LABEL: Readonly<Record<ApprovalStatus, string>> = {
  pending: copy.adminMarketJudgementCompensationStatusPending,
  approved: copy.adminMarketJudgementCompensationStatusApproved,
  rejected: copy.adminMarketJudgementCompensationStatusRejected,
  retracted: copy.adminMarketJudgementCompensationStatusRetracted,
};

/**
 * Where a listed account stands, in 144-19's words: 지급 대기 (payable), 원장 확인 필요 (144-16),
 * 탈퇴로 지급 못 함 (144-7), 지급 완료.
 */
export const COMPENSATION_RECIPIENT_STATE_LABEL: Readonly<
  Record<JudgementCompensationRecipientState, string>
> = {
  pending: copy.adminMarketJudgementCompensationStatePending,
  blocked: copy.adminMarketJudgementCompensationStateBlocked,
  closed: copy.adminMarketJudgementCompensationStateClosed,
  paid: copy.adminMarketJudgementCompensationStatePaid,
};

/** What a row of 판정 오류 사건 검토 대기 waits for (ADR-0166 T13). */
export const COMPENSATION_QUEUE_KIND_LABEL: Readonly<
  Record<MarketJudgementIncidentQueueKind, string>
> = {
  incident: copy.adminMarketJudgementCompensationQueueKindIncident,
  compensation: copy.adminMarketJudgementCompensationQueueKindCompensation,
};

// ---- the request -----------------------------------------------------------------------------

/** 보상 요청 as its dialog holds it: the two reasons as typed. */
export interface CompensationRequestValues {
  reason: string;
  userReason: string;
}

/**
 * 보상 요청 as the dialog holds it (`requestJudgementCompensationBodySchema`'s rules, which the API
 * checks again): the internal reason and the members' reason (144-12), each trimmed 1..500. No
 * account and no amount (144-1). `request` is what is sent once both hold.
 */
export function compensationRequestDraft(values: CompensationRequestValues): {
  request: CompensationRequestValues | null;
  errors: { reason: string | null; userReason: string | null };
} {
  const reason = reviewReasonDraft(values.reason);
  const userReason = reviewReasonDraft(values.userReason);
  const errors = {
    reason: reason.error === null ? null : copy.errMarketJudgementCompensationReason,
    userReason: userReason.error === null ? null : copy.errMarketJudgementCompensationUserReason,
  };
  return {
    request:
      errors.reason === null && errors.userReason === null
        ? { reason: reason.reason, userReason: userReason.reason }
        : null,
    errors,
  };
}

// ---- the decisions ---------------------------------------------------------------------------

/** A decision on the waiting request: its 보상 승인, its 보상 반려, or its requester's 철회. */
export type CompensationDecision = CompensationReview | 'retract';

/** What a decision's dialog is called, says, confirms with and toasts once it went through. */
export interface CompensationDecisionTexts {
  title: string;
  body: string;
  confirm: string;
  done: string;
}

export const COMPENSATION_DECISION_TEXTS: Readonly<
  Record<CompensationDecision, CompensationDecisionTexts>
> = {
  approve: {
    title: copy.adminMarketJudgementCompensationApproveTitle,
    body: copy.adminMarketJudgementCompensationApproveBody,
    confirm: copy.adminMarketJudgementCompensationApprove,
    done: copy.adminMarketJudgementCompensationApproved,
  },
  reject: {
    title: copy.adminMarketJudgementCompensationRejectTitle,
    body: copy.adminMarketJudgementCompensationRejectBody,
    confirm: copy.adminMarketJudgementCompensationReject,
    done: copy.adminMarketJudgementCompensationRejected,
  },
  retract: {
    title: copy.adminMarketJudgementCompensationRetractTitle,
    body: copy.adminMarketJudgementCompensationRetractBody,
    confirm: copy.adminMarketJudgementCompensationRetract,
    done: copy.adminMarketJudgementCompensationRetracted,
  },
};

// ---- what a refusal says ---------------------------------------------------------------------

/**
 * The approval engine's refusals as a compensation says them: its requester's in its own words,
 * and `no_decider` naming every admin a request leaves out — the requester, the paid version's
 * registrant (144-4) and the conflicted (#143).
 */
const COMPENSATION_APPROVAL_REFUSAL: Readonly<Record<ApprovalRefusal, string>> = {
  requester: copy.errMarketJudgementCompensationRequester,
  decided: copy.errApprovalDecided,
  retracted: copy.errApprovalRetracted,
  not_requester: copy.errApprovalNotRequester,
  creator: copy.errApprovalCreator,
  editor: copy.errApprovalEditor,
  no_decider: copy.errMarketJudgementCompensationNoDecider,
};

/** The fields a refusal can land under: the request's two reasons, or a decision's reason. */
export type CompensationField = 'reason' | 'userReason';

/**
 * Where a refused compensation write is said:
 * - `field`: under the reason it is about — the internal one (a request's or a decision's) or the
 *   members' (144-12);
 * - `alert`: in the dialog, which stays — no confirmed incident, a #93 ledger hold, a request
 *   waiting or one paid (144-2), no account owed, a list that changed since it was frozen
 *   (`stale`), an account whose balance record left its ledger (`blocked`, 144-16 — the whole
 *   approval), the paid version's registrant as the approver (144-4), an unknown request, the
 *   approval engine's refusals, a conflict (#143) or a revoked role, the market gone, a session
 *   ended, a request that never reached the API or an internal error. `refresh` when the screen
 *   behind is out of date;
 * - `toast`: the cookie of another account (ADR-0092): nothing was done, the dialog closes.
 */
export type CompensationFailure =
  | { kind: 'field'; field: CompensationField; message: string }
  | { kind: 'alert'; message: string; refresh: boolean }
  | { kind: 'toast'; message: string };

export function compensationFailure(error: unknown): CompensationFailure {
  const alert = (message: string, refresh = false): CompensationFailure => ({
    kind: 'alert',
    message,
    refresh,
  });
  if (isForAnotherAccount(error)) return { kind: 'toast', message: copy.sessionChanged };
  if (isApiError(error, 'UNAUTHENTICATED')) return alert(copy.errUnauthenticated);
  if (isApiError(error, 'FORBIDDEN')) {
    const conflict = validationMessage(error) === 'market_conflict';
    return alert(conflict ? copy.marketConflictRefused : copy.adminOnly, conflict);
  }
  if (isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'noConflictConfirmed') {
    return alert(copy.marketConflictConfirmRequired);
  }
  if (isApiError(error, 'APPROVAL_NOT_ALLOWED')) {
    const refusal = APPROVAL_REFUSALS.find((reason) => reason === validationMessage(error));
    return alert(
      refusal === undefined ? copy.errUnknown : COMPENSATION_APPROVAL_REFUSAL[refusal],
      true,
    );
  }
  if (isApiError(error, 'NOT_FOUND')) return alert(copy.adminMarketNotFound, true);
  if (!isApiError(error, 'VALIDATION_ERROR')) {
    return alert(isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown);
  }
  const message = validationMessage(error);
  const refused = MARKET_JUDGEMENT_COMPENSATION_REFUSALS;
  switch (validationField(error)) {
    case 'incident':
      return alert(copy.errMarketJudgementCompensationIncident, true);
    case 'market':
      return alert(copy.errMarketJudgementCompensationHeld, true);
    case 'compensation':
      return alert(
        message === refused.compensation.paid
          ? copy.errMarketJudgementCompensationPaid
          : copy.errMarketJudgementCompensationPending,
        true,
      );
    case 'recipients':
      return alert(
        message === refused.recipients.blocked
          ? copy.errMarketJudgementCompensationBlocked
          : message === refused.recipients.stale
            ? copy.errMarketJudgementCompensationStale
            : copy.errMarketJudgementCompensationNone,
        true,
      );
    case 'decider':
      return alert(copy.errMarketJudgementCompensationRegistrant, true);
    case 'requestId':
      return alert(copy.errMarketJudgementCompensationUnknown, true);
    case 'reason':
      return { kind: 'field', field: 'reason', message: copy.errMarketJudgementCompensationReason };
    case 'userReason':
      return {
        kind: 'field',
        field: 'userReason',
        message: copy.errMarketJudgementCompensationUserReason,
      };
    default:
      return alert(copy.errMarketInvalid);
  }
}
