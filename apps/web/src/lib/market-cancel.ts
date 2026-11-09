import { APPROVAL_REFUSALS, type ApprovalRefusal, MARKET_CANCEL_REFUSALS } from '@buddha/shared';
import { copy } from '@/copy';
import {
  type AdminMarket,
  type MarketCancelLogEntry,
  type MarketCancelRequest,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';
import { type EventRow } from './market-admin';
import { pauseActorName } from './market-pause';

/**
 * The pure half of the 시장 취소 screens (#20, ADR-0117; ADR-0107 결정 5 '#20 운영자의 취소 경로'):
 * whether the admin detail offers a cancel request, who on screen may decide the request waiting
 * and whether it can be approved, the 시장 취소 기록's rows and what a refusal says. The panel and
 * its dialogs (app/admin/markets/[id]/market-cancel-*.tsx) and the 시장 취소 대기 queue draw them.
 * The operator cancels a SCHEDULED market alone; a market that traded ends by its close or a
 * pause's early close, which cancel it by themselves when no person's account filled. The words
 * the request shares with the pause's next-path request (승인, 반려, 철회, the log's labels) are
 * lib/market-pause.ts's.
 */

/**
 * Whether the admin detail draws the 시장 취소 panel: on a SCHEDULED market (to ask) and on any
 * that has a cancel request — a market opened or sent back since keeps its waiting request for its
 * 반려 or 철회, and a cancelled one its record.
 */
export function showsCancelPanel(market: Pick<AdminMarket, 'status' | 'cancel'>): boolean {
  return market.status === 'scheduled' || market.cancel.log.length > 0;
}

/**
 * Whether 시장 취소 요청 is offered: a SCHEDULED market with no request waiting (one at a time; the
 * waiting one is shown instead).
 */
export function cancelRequestOffered(market: Pick<AdminMarket, 'status' | 'cancel'>): boolean {
  return market.status === 'scheduled' && market.cancel.pending === null;
}

/**
 * Whether the waiting request can be approved as the row stands: the market is still SCHEDULED
 * (the approval checks it again, and that it is still the SCHEDULED state the request was asked in,
 * `cancel` 'stale'). Otherwise its 반려 or its 철회 ends it, which any status takes.
 */
export function cancelRequestApprovable(market: Pick<AdminMarket, 'status'>): boolean {
  return market.status === 'scheduled';
}

/**
 * Whether the admin on screen asked for the waiting request — who may not approve or reject it and
 * alone may retract it — or `undefined` until `GET /me` has said who is on screen.
 */
export function isCancelRequester(
  pending: Pick<MarketCancelRequest, 'requestedBy'>,
  operatorId: string | undefined,
): boolean | undefined {
  return operatorId === undefined ? undefined : pending.requestedBy.id === operatorId;
}

/**
 * One request of the 시장 취소 기록 (`AdminMarket.cancel.log`) as rows below its status, requester
 * and time: the reason, then how it ended — the decider, the decision's instant and reason, the
 * 철회's instant. Each absent where it has none.
 */
export function cancelLogRows(
  entry: MarketCancelLogEntry,
  time: (iso: string) => string,
): EventRow[] {
  const rows: EventRow[] = [{ label: copy.adminMarketCancelReason, value: entry.reason }];
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

// ---- what a refusal says ---------------------------------------------------------------------

/** The two-person rule's refusals as the cancel request says them. */
const CANCEL_REFUSAL_MESSAGES: Readonly<Record<ApprovalRefusal, string>> = {
  requester: copy.adminMarketPauseExcludedRequester,
  decided: copy.errApprovalDecided,
  retracted: copy.errApprovalRetracted,
  not_requester: copy.errApprovalNotRequester,
  creator: copy.errApprovalCreator,
  editor: copy.errApprovalEditor,
  no_decider: copy.errApprovalNoDecider,
};

/** The write a refusal answers: the request, or a decision of it (승인, 반려, 철회). */
export type CancelWrite = 'request' | 'decision';

/**
 * Where a refused cancel write is said (#20):
 * - `field`: under the reason — the one input of every dialog;
 * - `alert`: in the dialog, which stays — the market not SCHEDULED, another request waiting, the
 *   SCHEDULED state the request was asked in gone ('stale'), an unknown request,
 *   APPROVAL_NOT_ALLOWED by its reason, the market gone, a session ended or a role revoked, a
 *   request that never reached the API. `refresh` when the screen behind is out of date;
 * - `toast`: the cookie of another account (ADR-0092): the dialog closes.
 */
export type CancelFailure =
  | { kind: 'field'; message: string }
  | { kind: 'alert'; message: string; refresh: boolean }
  | { kind: 'toast'; message: string };

export function cancelFailure(error: unknown, write: CancelWrite): CancelFailure {
  const alert = (message: string, refresh = false): CancelFailure => ({
    kind: 'alert',
    message,
    refresh,
  });
  if (isForAnotherAccount(error)) return { kind: 'toast', message: copy.sessionChanged };
  if (isApiError(error, 'UNAUTHENTICATED')) return alert(copy.errUnauthenticated);
  if (isApiError(error, 'FORBIDDEN')) return alert(copy.adminOnly);
  if (isApiError(error, 'APPROVAL_NOT_ALLOWED')) {
    const refusal = APPROVAL_REFUSALS.find((reason) => reason === validationMessage(error));
    return alert(refusal === undefined ? copy.errUnknown : CANCEL_REFUSAL_MESSAGES[refusal], true);
  }
  if (isApiError(error, 'NOT_FOUND')) return alert(copy.adminMarketNotFound, true);
  if (!isApiError(error, 'VALIDATION_ERROR')) {
    return alert(isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown);
  }
  switch (validationField(error)) {
    case 'status':
      return alert(copy.errMarketCancelStatus, true);
    case 'cancel':
      return alert(
        validationMessage(error) === MARKET_CANCEL_REFUSALS.cancel.stale && write === 'decision'
          ? copy.errMarketCancelStale
          : copy.errMarketCancelPending,
        true,
      );
    case 'requestId':
      return alert(copy.errMarketCancelUnknown, true);
    case 'reason':
      return { kind: 'field', message: copy.errMarketReviewReason };
    default:
      return alert(copy.errMarketInvalid);
  }
}
