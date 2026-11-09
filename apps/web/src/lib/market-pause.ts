import {
  APPROVAL_REFUSALS,
  type ApprovalRefusal,
  type ApprovalStatus,
  MARKET_PAUSE_PATHS,
  MARKET_PAUSE_REASONS,
  MARKET_PAUSE_REFUSALS,
  MARKET_PAUSE_REVIEW_RESULTS,
  type MarketPauseDecisionRefusal,
  type MarketPauseEndKind,
  type MarketPausePath,
  type MarketPauseReason,
  type MarketPauseReviewResult,
  type MarketStatus,
  STORABLE_INSTANT_MIN,
  pauseDecisionRefusal,
  pauseReasonNeedsPublishedAt,
  pauseReasonNeedsReview,
} from '@buddha/shared';
import { copy } from '@/copy';
import { nicknameShown } from './account-closure';
import {
  type AdminMarket,
  type AdminMarketPause,
  type MarketPauseDecisionLogEntry,
  type MarketPauseDecisionPending,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';
import { kstLocalToIso } from './datetime';
import { type EventRow, PAUSE_REASON_LABEL, PAUSE_REVIEW_RESULT_LABEL } from './market-admin';
import { reviewReasonDraft } from './market-review';

/**
 * The pure half of the 거래 일시 중단 screens (#114, ADR-0102; ADR-0093 decision 1 #173 items 1–4·13,
 * decision 2 #172 items 14·15, decision 3 '#114 조기 결과의 공개 시각', and the owner's answers Q1·Q2
 * of 2026-11-02): whether the admin detail offers a pause or a next-path request and why not, the
 * pause a 의미 변경 반려 suggests, who on screen may decide the request waiting and whether it can be
 * approved, the 일시 중단 기록's rows, what each write may send and what a refusal says. The panel
 * and its dialogs (app/admin/markets/[id]/market-pause-*.tsx) and the 일시 중단 결정 대기 queue draw
 * them. Admin-only (excluded-features.test.ts): the note, the publication instant and the operators
 * are never a member's (#24 decides what the public judging record shows). The reason and review
 * result names are lib/market-admin.ts's, which the 이벤트 로그 reads too.
 */

/** 중단 사유's line under its choice in the pause dialog (`basis_change`'s says Q2's case). */
export const PAUSE_REASON_HINT: Record<MarketPauseReason, string> = {
  early_result: copy.pauseReasonEarlyResultHint,
  ledger_failure: copy.pauseReasonLedgerFailureHint,
  basis_change: copy.pauseReasonBasisChangeHint,
};

/** 검토 결과's line under its choice in the request dialog (Q1; 판정 불가 is 조기 마감 alone). */
export const PAUSE_REVIEW_RESULT_HINT: Record<MarketPauseReviewResult, string> = {
  judgeable: copy.pauseReviewJudgeableHint,
  not_judgeable: copy.pauseReviewNotJudgeableHint,
};

/** 다음 경로 (#173 items 2·4): 재개 or 조기 마감. */
export const PAUSE_PATH_LABEL: Record<MarketPausePath, string> = {
  resume: copy.pausePathResume,
  early_close: copy.pausePathEarlyClose,
};

/** How a pause ended, the 일시 중단 기록's badge; one still lasting is 진행 중 (`pauseEndLabel`). */
export const PAUSE_END_KIND_LABEL: Record<MarketPauseEndKind, string> = {
  resumed: copy.pauseEndResumed,
  early_closed: copy.pauseEndEarlyClosed,
  closed_at_close: copy.pauseEndClosedAtClose,
};

/** A pause's badge in the 일시 중단 기록: how it ended, or 진행 중. */
export function pauseEndLabel(pause: Pick<AdminMarketPause, 'endKind'>): string {
  return pause.endKind === null ? copy.pauseOngoing : PAUSE_END_KIND_LABEL[pause.endKind];
}

/** How a next-path request ended, its badge (`approval_requests.status`). */
export const PAUSE_DECISION_STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: copy.pauseDecisionStatusPending,
  approved: copy.pauseDecisionStatusApproved,
  rejected: copy.pauseDecisionStatusRejected,
  retracted: copy.pauseDecisionStatusRetracted,
};

/**
 * Whether the admin detail draws the 거래 일시 중단 panel: on a market OPEN (to pause it) or PAUSED,
 * and on any that has a pause or a request — a closed market keeps its history, and a request still
 * waiting at the close is shown for its 반려 or 철회. Not before the open: nothing trades yet.
 */
export function showsPausePanel(market: Pick<AdminMarket, 'status' | 'pause'>): boolean {
  return (
    market.status === 'open' ||
    market.status === 'paused' ||
    market.pause.history.length > 0 ||
    market.pause.log.length > 0
  );
}

/** The pause lasting now: the newest, while it has no end (at most one has none). */
export function currentPause(market: Pick<AdminMarket, 'pause'>): AdminMarketPause | null {
  const [latest] = market.pause.history;
  return latest !== undefined && latest.endedAt === null ? latest : null;
}

/** Whether a market's close has come by `at` (ms): an unreadable close counts as come. */
function closeHasCome(closeAt: string, at: number): boolean {
  const close = new Date(closeAt).getTime();
  return Number.isNaN(close) || close <= at;
}

/**
 * Why 거래 일시 중단 is not offered, in the order the API checks it (MARKET_PAUSE_REFUSALS): `status`
 * — the market is not OPEN (a PAUSED one shows its pause instead); `closed` — its close has come by
 * `readAt`, the instant the row was read (a market stays OPEN past its close until the worker
 * closes it, and the API refuses a pause then by its clock). `null` when it is offered.
 */
export type PauseUnavailable = 'status' | 'closed';

export function pauseUnavailable(
  market: Pick<AdminMarket, 'status' | 'closeAt'>,
  readAt: number,
): PauseUnavailable | null {
  if (market.status !== 'open') return 'status';
  return closeHasCome(market.closeAt, readAt) ? 'closed' : null;
}

/**
 * Why 재개·조기 마감 요청 is not offered, in the API's order: `status` — not PAUSED (or no pause
 * lasting); `closed` — its close has come by `readAt` (the worker closes it on schedule, #173 item
 * 3); `pending` — one waits already (one at a time), which the panel shows instead. `null` when it
 * is offered.
 */
export type PauseDecisionUnavailable = 'status' | 'closed' | 'pending';

export function pauseDecisionUnavailable(
  market: Pick<AdminMarket, 'status' | 'closeAt' | 'pause'>,
  readAt: number,
): PauseDecisionUnavailable | null {
  if (market.status !== 'paused' || currentPause(market) === null) return 'status';
  if (closeHasCome(market.closeAt, readAt)) return 'closed';
  return market.pause.pending === null ? null : 'pending';
}

/**
 * Why the waiting request cannot be approved as the row read at `readAt` stands, or `null` when it
 * can (the approval checks each again at its own instant):
 * - `closed`: the market is no longer PAUSED — the worker closed it at its close — or its close has
 *   come (the worker is about to): the request is moot;
 * - `stale`: the request decides a pause that is not the current one.
 * Either way its 반려 or its 철회 ends it, which any status takes.
 */
export type PauseDecisionUnapprovable = 'closed' | 'stale';

export function pauseDecisionUnapprovable(
  market: Pick<AdminMarket, 'status' | 'closeAt' | 'pause'>,
  pending: Pick<MarketPauseDecisionPending, 'pauseId'>,
  readAt: number,
): PauseDecisionUnapprovable | null {
  if (market.status !== 'paused' || closeHasCome(market.closeAt, readAt)) return 'closed';
  return currentPause(market)?.id === pending.pauseId ? null : 'stale';
}

/** What the waiting request says above its 승인, turned off (`pauseDecisionUnapprovable`). */
export const PAUSE_DECISION_UNAPPROVABLE_NOTE: Record<PauseDecisionUnapprovable, string> = {
  closed: copy.adminMarketPausePendingClosed,
  stale: copy.adminMarketPausePendingStale,
};

/**
 * Whether the admin on screen asked for the waiting request — who may not approve or reject it and
 * alone may retract it (approvals.ts `requester`, `not_requester`) — or `undefined` until `GET /me`
 * has said who is on screen (`useOperatorId`): the panel offers no decision until then. The admin
 * who paused is not excluded (#173 item 2: only the requester is).
 */
export function isPauseDecisionRequester(
  pending: Pick<MarketPauseDecisionPending, 'requestedBy'>,
  operatorId: string | undefined,
): boolean | undefined {
  return operatorId === undefined ? undefined : pending.requestedBy.id === operatorId;
}

/** Who did a step: the nickname, '탈퇴한 사용자' for an account gone since, 시스템 for the worker. */
export function pauseActorName(actor: { nickname: string | null } | null): string {
  return actor === null ? copy.eventSystem : nicknameShown(actor.nickname);
}

/** What the pause dialog opens with: the reason picked and the note typed. */
export interface PausePreset {
  reason: MarketPauseReason;
  note: string;
}

/**
 * The pause a 의미 변경 반려 suggests (#172 item 15, ADR-0101 결정 6: the 반려 does not pause the
 * market; the pause is one admin's, urgent): on a market that may be paused now
 * (`pauseUnavailable`), whose newest supplement request was rejected as 의미 변경 and which has not
 * paused since — 실질 기준 변경 with the 반려's 설명 as the note. `null` otherwise: a newer request, a
 * pause lasting at the 반려 or made after it (the 반려 came while a pause's next path was still to
 * decide, and whoever decided it knew of the 반려), or a market past its close or not OPEN.
 */
export function pauseOffer(
  market: Pick<AdminMarket, 'status' | 'closeAt' | 'pause' | 'supplement'>,
  readAt: number,
): PausePreset | null {
  if (pauseUnavailable(market, readAt) !== null) return null;
  const [latest] = market.supplement.log;
  if (
    latest?.status !== 'rejected' ||
    latest.rejectReason !== 'meaning_change' ||
    latest.decidedAt === null
  ) {
    return null;
  }
  const [lastPause] = market.pause.history;
  if (
    lastPause !== undefined &&
    (lastPause.endedAt === null || Date.parse(lastPause.endedAt) >= Date.parse(latest.decidedAt))
  ) {
    return null;
  }
  return { reason: 'basis_change', note: latest.decisionReason ?? '' };
}

// ---- rows ------------------------------------------------------------------------------------

/**
 * One pause of the 일시 중단 기록 (`AdminMarket.pause.history`) as rows below its badge: the reason,
 * the note, the publication instant of an early result, who paused it and when; then the review
 * result, when it ended and who approved its end — each absent where it has none (the worker's
 * close at `close_at` has no approver). `time` renders an instant (the admin's KST).
 */
export function pauseRows(pause: AdminMarketPause, time: (iso: string) => string): EventRow[] {
  const rows: EventRow[] = [
    { label: copy.adminMarketPauseReason, value: PAUSE_REASON_LABEL[pause.reason] },
    { label: copy.adminMarketPauseNote, value: pause.note },
  ];
  if (pause.resultPublishedAt !== null) {
    rows.push({
      label: copy.adminMarketPauseResultPublishedAt,
      value: time(pause.resultPublishedAt),
    });
  }
  rows.push(
    { label: copy.adminMarketPausedBy, value: pauseActorName(pause.pausedBy) },
    { label: copy.adminMarketPausedAt, value: time(pause.pausedAt) },
  );
  if (pause.reviewResult !== null) {
    rows.push({
      label: copy.pauseLogReviewResult,
      value: PAUSE_REVIEW_RESULT_LABEL[pause.reviewResult],
    });
  }
  if (pause.endedAt !== null)
    rows.push({ label: copy.pauseLogEndedAt, value: time(pause.endedAt) });
  if (pause.endedBy !== null) {
    rows.push({ label: copy.pauseLogEndedBy, value: pauseActorName(pause.endedBy) });
  }
  return rows;
}

/**
 * One next-path request of the 일시 중단 기록 (`AdminMarket.pause.log`) as rows below its status,
 * requester and time: the path, the review result, the reason; then how it ended — the decider, the
 * decision's instant and reason, the 철회's instant. Each absent where it has none.
 */
export function pauseDecisionLogRows(
  entry: MarketPauseDecisionLogEntry,
  time: (iso: string) => string,
): EventRow[] {
  const rows: EventRow[] = [{ label: copy.pauseLogPath, value: PAUSE_PATH_LABEL[entry.path] }];
  if (entry.reviewResult !== null) {
    rows.push({
      label: copy.pauseLogReviewResult,
      value: PAUSE_REVIEW_RESULT_LABEL[entry.reviewResult],
    });
  }
  rows.push({ label: copy.adminMarketPauseRequestReason, value: entry.reason });
  if (entry.decidedBy !== null) {
    rows.push({ label: copy.pauseLogDecidedBy, value: pauseActorName(entry.decidedBy) });
  }
  if (entry.decidedAt !== null) {
    rows.push({ label: copy.pauseLogDecidedAt, value: time(entry.decidedAt) });
  }
  if (entry.decisionReason !== null) {
    rows.push({ label: copy.pauseLogDecisionReason, value: entry.decisionReason });
  }
  if (entry.retractedAt !== null) {
    rows.push({ label: copy.pauseLogRetractedAt, value: time(entry.retractedAt) });
  }
  return rows;
}

// ---- what each write may send ----------------------------------------------------------------

/** A choice as its control holds it ('' for none picked), or null. */
function choiceOf<T extends string>(choices: readonly T[], value: string): T | null {
  return choices.find((choice) => choice === value) ?? null;
}

/**
 * 거래 일시 중단 as the dialog holds it (`pauseMarketBodySchema`): the reason picked, the note typed
 * (`approvalReasonSchema`'s 1..500 trimmed) and, for an early result alone, the publication instant
 * as a KST `datetime-local` (ADR-0093 decision 3: entered in KST, sent in UTC):
 * - `resultPublishedAt`: the instant typed, or null — for any other reason always, which the API
 *   requires (`resultPublishedAt` 'only for early_result');
 * - `publishedAtError`: what is said under the field as soon as it is wrong — an unreadable or
 *   unstorable date, or an instant after `now` (the API refuses one after the pause's own instant,
 *   'after the pause', by its clock); a blank one says nothing, the confirm stays off;
 * - `ready`: a reason, a note and, for an early result, a good instant.
 * `now` is read in render through the default, as `isClosingSoon` is: the admin screens never
 * render on the server, so there is no hydration to mismatch. Nothing else re-renders the dialog
 * as the clock moves, so while 'after now' is said the dialog waits `publishedAtWait` and draws
 * again: the sentence goes and the confirm comes on once the minute typed has come.
 */
export function pauseDraft(
  value: string,
  noteText: string,
  publishedLocal: string,
  now: number = Date.now(),
): {
  ready: boolean;
  reason: MarketPauseReason | null;
  note: string;
  resultPublishedAt: string | null;
  publishedAtError: string | null;
} {
  const reason = choiceOf(MARKET_PAUSE_REASONS, value);
  const note = reviewReasonDraft(noteText);
  const needsInstant = reason !== null && pauseReasonNeedsPublishedAt(reason);
  const typed = needsInstant ? kstLocalToIso(publishedLocal) : null;
  let publishedAtError: string | null = null;
  if (needsInstant && publishedLocal !== '') {
    if (typed === null || Date.parse(typed) < Date.parse(STORABLE_INSTANT_MIN)) {
      publishedAtError = copy.errMarketPausePublishedAtTime;
    } else if (Date.parse(typed) > now) {
      publishedAtError = copy.errMarketPausePublishedAtAfter;
    }
  }
  const resultPublishedAt = publishedAtError === null ? typed : null;
  return {
    ready: reason !== null && note.error === null && (!needsInstant || resultPublishedAt !== null),
    reason,
    note: note.reason,
    resultPublishedAt,
    publishedAtError,
  };
}

/** How far past the instant typed the pause dialog draws again: a timer may fire a little early. */
const PUBLISHED_AT_WAIT_MARGIN_MS = 1_000;

/**
 * The longest the pause dialog waits at once — a day: `setTimeout` takes no more than about 24.8
 * days, and a longer wait is waited again from the draw it ends in.
 */
const PUBLISHED_AT_WAIT_MAX_MS = 24 * 60 * 60 * 1_000;

/**
 * How long from `now` until the publication instant typed (`publishedLocal`, the KST
 * `datetime-local`) is no longer after now — `pauseDraft`'s 'after now' lifted — with a second's
 * margin and at most a day; `null` when it is not after now, or is unreadable. The pause dialog
 * waits this long while that sentence is said and then draws again, since `pauseDraft` reads the
 * clock only when the dialog draws.
 */
export function publishedAtWait(publishedLocal: string, now: number): number | null {
  const typed = kstLocalToIso(publishedLocal);
  if (typed === null) return null;
  const wait = Date.parse(typed) - now;
  return wait > 0 ? Math.min(wait + PUBLISHED_AT_WAIT_MARGIN_MS, PUBLISHED_AT_WAIT_MAX_MS) : null;
}

/**
 * 재개·조기 마감 요청 as the dialog holds it, for a pause of `pauseReason`: the path, the review
 * result — asked for a 실질 기준 변경 pause alone (`pauseReasonNeedsReview`), null otherwise — and the
 * reason. `refusal` is what the API would refuse the pair for (`pauseDecisionRefusal`: no review
 * result where one is needed, 재개 with 판정 불가); `resumeOff` while 판정 불가 is picked — 재개 is off
 * then, and the dialog says the judgement applies the VOID rule after the close (#173 item 4).
 * `ready` once a path is picked that the pause's reason allows and a reason is typed.
 */
export function pauseDecisionDraft(
  pauseReason: MarketPauseReason,
  pathValue: string,
  reviewValue: string,
  reasonText: string,
): {
  ready: boolean;
  path: MarketPausePath | null;
  reviewResult: MarketPauseReviewResult | null;
  reason: string;
  refusal: MarketPauseDecisionRefusal | null;
  resumeOff: boolean;
} {
  const path = choiceOf(MARKET_PAUSE_PATHS, pathValue);
  const reviewResult = pauseReasonNeedsReview(pauseReason)
    ? choiceOf(MARKET_PAUSE_REVIEW_RESULTS, reviewValue)
    : null;
  const refusal = path === null ? null : pauseDecisionRefusal(pauseReason, { path, reviewResult });
  const { reason, error } = reviewReasonDraft(reasonText);
  return {
    ready: path !== null && refusal === null && error === null,
    path,
    reviewResult,
    reason,
    refusal,
    resumeOff: reviewResult === 'not_judgeable',
  };
}

/**
 * The toast of an approval that went through, from the status the market was answered in: 재개, or
 * an early close — CANCELLED when no person's account had filled (#20, ADR-0117).
 */
export function pauseApprovalSuccess(status: MarketStatus): string {
  if (status === 'open') return copy.adminMarketPauseResumed;
  return status === 'cancelled'
    ? copy.adminMarketPauseEarlyCancelled
    : copy.adminMarketPauseEarlyClosed;
}

// ---- what a refusal says ---------------------------------------------------------------------

/**
 * The two-person rule's refusals as the pause's next path says them: the requester's in its own
 * words, the rest as every approval screen says them (`creator` and `editor` are the review's,
 * which no pause meets).
 */
const PAUSE_REFUSAL_MESSAGES: Readonly<Record<ApprovalRefusal, string>> = {
  requester: copy.adminMarketPauseExcludedRequester,
  decided: copy.errApprovalDecided,
  retracted: copy.errApprovalRetracted,
  not_requester: copy.errApprovalNotRequester,
  creator: copy.errApprovalCreator,
  editor: copy.errApprovalEditor,
  no_decider: copy.errApprovalNoDecider,
};

/**
 * The write a refusal answers: the pause (`POST …/pause`, whose `reason` is the 중단 사유), the
 * next-path request (`POST …/pause-decisions`, which names the pause it was asked on) or a
 * decision of it (its approval, 반려 or 철회) — the last two's `reason` is the text. The request
 * and its approval each meet `pause` 'stale', and say it in their own words.
 */
export type PauseWrite = 'pause' | 'request' | 'decision';

/**
 * The fields of the pause's dialogs a refusal can land under. Not the review result: both its
 * refusals are said above the buttons (`pauseFailure`), and the request dialog's draft keeps the
 * confirm off until the pair is one the pause's reason allows (`pauseDecisionDraft`).
 */
export type PauseField =
  'pauseReason' | 'note' | 'publicNoteConfirmed' | 'resultPublishedAt' | 'path' | 'reason';

/**
 * Where a refused pause write is said (#114):
 * - `field`: under the input it is about — the 중단 사유, the note, the publication instant
 *   (required, only an early result's, after the pause, unreadable), the path (재개 with 판정
 *   불가), the reason;
 * - `alert`: in the dialog, which stays — the market's state (not OPEN for a pause, not PAUSED for
 *   a request or an approval, its close come by the clock, another request waiting), the pause
 *   no longer the current one (the request's own — the screen's pause was resumed and another
 *   made, before or after the dialog opened — or, at the approval, the one the request named), a
 *   review result refused either way (required, or one the pause's reason takes none of: the
 *   dialog's draft checks the same rules for the pause it names, so only a client other than the
 *   dialog gets there — no input is to blame), an unknown request, APPROVAL_NOT_ALLOWED by its
 *   reason (the requester, decided, retracted, no other admin to decide), the market gone, a
 *   session ended or a role revoked, a request that never reached the API. `refresh` when the
 *   screen behind is out of date: the caller reads the detail again;
 * - `toast`: the cookie of another account (ADR-0092): nothing was done, the dialog closes and the
 *   session is asked again.
 */
export type PauseFailure =
  | { kind: 'field'; field: PauseField; message: string }
  | { kind: 'alert'; message: string; refresh: boolean }
  | { kind: 'toast'; message: string };

export function pauseFailure(error: unknown, write: PauseWrite): PauseFailure {
  const alert = (message: string, refresh = false): PauseFailure => ({
    kind: 'alert',
    message,
    refresh,
  });
  const field = (name: PauseField, message: string): PauseFailure => ({
    kind: 'field',
    field: name,
    message,
  });
  if (isForAnotherAccount(error)) return { kind: 'toast', message: copy.sessionChanged };
  if (isApiError(error, 'UNAUTHENTICATED')) return alert(copy.errUnauthenticated);
  // Not the account check above: AdminGuard's, once another admin revoked this one's role.
  if (isApiError(error, 'FORBIDDEN')) return alert(copy.adminOnly);
  if (isApiError(error, 'APPROVAL_NOT_ALLOWED')) {
    const refusal = APPROVAL_REFUSALS.find((reason) => reason === validationMessage(error));
    return alert(refusal === undefined ? copy.errUnknown : PAUSE_REFUSAL_MESSAGES[refusal], true);
  }
  if (isApiError(error, 'NOT_FOUND')) return alert(copy.adminMarketNotFound, true);
  if (!isApiError(error, 'VALIDATION_ERROR')) {
    return alert(isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown);
  }
  const message = validationMessage(error);
  const refused = MARKET_PAUSE_REFUSALS;
  switch (validationField(error)) {
    case 'reconciliation':
      return alert(
        message === 'not_passed'
          ? copy.reconciliationNotPassed
          : message === 'stale'
            ? copy.reconciliationStale
            : copy.errUnknown,
        true,
      );
    case 'status':
      return alert(
        write === 'pause' ? copy.errMarketPauseStatus : copy.errMarketPauseDecisionStatus,
        true,
      );
    case 'closeAt':
      return alert(
        write === 'pause' ? copy.errMarketPauseClosed : copy.errMarketPauseDecisionClosed,
        true,
      );
    case 'pause':
      if (message !== refused.pause.stale) return alert(copy.errMarketPauseDecisionPending, true);
      // The pause the request names (the screen's) was resumed and the market paused again: ask
      // again on the pause now. The approval's is the request's own pause: 반려 or 철회 ends it.
      return alert(
        write === 'request' ? copy.errMarketPauseRequestStale : copy.errMarketPauseDecisionStale,
        true,
      );
    case 'requestId':
      return alert(copy.errMarketPauseUnknown, true);
    case 'reason':
      return write === 'pause'
        ? field('pauseReason', copy.errMarketPauseReason)
        : field('reason', copy.errMarketReviewReason);
    case 'note':
      return field('note', copy.errMarketPauseNote);
    case 'publicNoteConfirmed':
      return field('publicNoteConfirmed', copy.errMarketPausePublicNoteConfirm);
    case 'resultPublishedAt':
      switch (message) {
        case refused.resultPublishedAt.required:
          return field('resultPublishedAt', copy.errMarketPausePublishedAtRequired);
        case refused.resultPublishedAt.earlyResultOnly:
          return field('resultPublishedAt', copy.errMarketPausePublishedAtOnly);
        case refused.resultPublishedAt.afterPause:
          return field('resultPublishedAt', copy.errMarketPausePublishedAtAfter);
        default:
          return field('resultPublishedAt', copy.errMarketPausePublishedAtTime);
      }
    case 'path':
      return field(
        'path',
        message === refused.path.earlyCloseOnly
          ? copy.errMarketPauseEarlyCloseOnly
          : copy.errMarketPausePath,
      );
    case 'reviewResult':
      // The dialog asks for a review result exactly when the pause it opened on is 실질 기준 변경,
      // sends none otherwise, and names that pause (`pauseId`) — another pause is 'stale' first,
      // and a pause's reason never changes. So only a client other than the dialog is refused
      // here: no input of the dialog to point at.
      return alert(
        message === refused.reviewResult.basisChangeOnly
          ? copy.errMarketPauseReviewOnly
          : copy.errMarketPauseReviewRequired,
        true,
      );
    default:
      return alert(copy.errMarketInvalid);
  }
}
