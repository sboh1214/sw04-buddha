import {
  ADMIN_DISPUTE_LIST_STATUSES,
  type AdminDisputeListStatus,
  type DisputeDecisionRefusal,
  type MarketDisputeDecision,
  disputeDecisionRefusal,
} from '@buddha/shared';
import type { Route } from 'next';
import { copy } from '@/copy';
import { nicknameShown } from './account-closure';
import {
  type AdminMarket,
  type AdminMarketDispute,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
} from './api';
import { disputeRefusalOf } from './disputes';

/**
 * 판정 이의's operator side (#175, ADR-0104; ADR-0093 decision 1 #173 items 2·7·13·15): 이의 접수
 * (`/admin/disputes`, its two halves) and the '판정 이의' block of the admin detail's 판정 panel —
 * who on screen may dismiss or accept a dispute and why not, the halves' words, and what a refused
 * decision says. Admin-only (excluded-features.test.ts): the submitter, the links and the reason
 * of a dispute, and who decided it, are no member's (#173 item 13). The statuses' words are
 * lib/disputes.ts', which the member's screens read too.
 */

export const ADMIN_DISPUTES_PATH = '/admin/disputes' satisfies Route;

/** The query parameter naming the half: `?status=decided`, 검토 대기 without it. */
export const ADMIN_DISPUTE_QUEUE_PARAM = 'status';

/** The half a `?status=` names: `decided`, else `pending` (the default, as the API's). */
export function adminDisputeQueueOf(
  param: string | string[] | null | undefined,
): AdminDisputeListStatus {
  return ADMIN_DISPUTE_LIST_STATUSES.find((status) => status === param) ?? 'pending';
}

/** The address of a half: the bare path for 검토 대기. */
export function adminDisputeQueuePath(status: AdminDisputeListStatus): string {
  return status === 'pending'
    ? ADMIN_DISPUTES_PATH
    : `${ADMIN_DISPUTES_PATH}?${ADMIN_DISPUTE_QUEUE_PARAM}=${status}`;
}

/** Each half's name and its empty sentence. */
export const ADMIN_DISPUTE_QUEUES: readonly {
  status: AdminDisputeListStatus;
  label: string;
  empty: string;
}[] = [
  { status: 'pending', label: copy.adminDisputesPending, empty: copy.adminDisputesEmptyPending },
  { status: 'decided', label: copy.adminDisputesDecided, empty: copy.adminDisputesEmptyDecided },
];

/** The member who submitted it, or '탈퇴한 사용자' once that account closed (ADR-0069 #140). */
export function disputeSubmitterName(dispute: Pick<AdminMarketDispute, 'submitter'>): string {
  return nicknameShown(dispute.submitter.nickname);
}

/**
 * Why the admin on screen may not dismiss or accept a dispute of the market's current judgement, or
 * null when they may (`disputeDecisionRefusal`, the API's own order): it is no longer pending
 * (`retracted`, `decided`), they registered that judgement (`registrant`, #173 item 2 — its
 * approver may decide), or they submitted it (`own`). `undefined` until `GET /me` has said who is
 * on screen (`useOperatorId`), and for a market whose judgement is gone from the read: the block
 * offers no decision then.
 */
export function disputeDecisionUnavailable(
  dispute: Pick<AdminMarketDispute, 'status' | 'submitter'>,
  market: Pick<AdminMarket, 'judgement'>,
  operatorId: string | undefined,
): DisputeDecisionRefusal | null | undefined {
  const current = market.judgement.current;
  if (operatorId === undefined || current === null) return undefined;
  return disputeDecisionRefusal(dispute, operatorId, current.registeredBy.id, dispute.submitter.id);
}

/** The line '결과 확정을 기다리게 하는 이의 2건' of the block, from `AdminMarket.disputes.holding`. */
export function disputeHoldingText(holding: number): string {
  return `${copy.adminMarketDisputesHolding} ${holding.toLocaleString('ko-KR')}${copy.adminMarketDisputesHoldingUnit}`;
}

/** What each decision's dialog is called, says, confirms with and toasts once sent. */
export const DISPUTE_DECISION_DIALOG: Readonly<
  Record<MarketDisputeDecision, { title: string; body: string; confirm: string; done: string }>
> = {
  dismiss: {
    title: copy.adminMarketDisputeDismissTitle,
    body: copy.adminMarketDisputeDismissBody,
    confirm: copy.adminMarketDisputeDismiss,
    done: copy.adminMarketDisputeDismissed,
  },
  accept: {
    title: copy.adminMarketDisputeAcceptTitle,
    body: copy.adminMarketDisputeAcceptBody,
    confirm: copy.adminMarketDisputeAccept,
    done: copy.adminMarketDisputeAccepted,
  },
};

/** DISPUTE_NOT_ALLOWED's reasons a decision meets, in the operators' words. */
const DECISION_REFUSAL_TEXT: Readonly<Record<DisputeDecisionRefusal, string>> = {
  retracted: copy.errAdminDisputeRetracted,
  decided: copy.errAdminDisputeDecided,
  registrant: copy.adminMarketDisputesRegistrant,
  own: copy.adminMarketDisputesOwn,
};

/**
 * Where a refused 기각 or 수용 is said:
 * - `field`: under the reason (VALIDATION_ERROR on `reason`: none, or over 500 characters);
 * - `alert`: in the dialog, which stays — DISPUTE_NOT_ALLOWED by its reason (retracted, decided,
 *   the registrant, the submitter), the dispute or the market unknown (NOT_FOUND), a session ended
 *   or a role revoked, a request that never reached the API or anything else. `refresh` when the
 *   screen behind is out of date: the caller reads the detail again;
 * - `toast`: the cookie of another account (ADR-0092): nothing was done, the dialog closes and the
 *   session is asked again.
 */
export type DisputeDecisionFailure =
  | { kind: 'field'; message: string }
  | { kind: 'alert'; message: string; refresh: boolean }
  | { kind: 'toast'; message: string };

export function disputeDecisionFailure(error: unknown): DisputeDecisionFailure {
  if (isForAnotherAccount(error)) return { kind: 'toast', message: copy.sessionChanged };
  const refused = disputeRefusalOf(error);
  if (
    refused === 'retracted' ||
    refused === 'decided' ||
    refused === 'registrant' ||
    refused === 'own'
  ) {
    return { kind: 'alert', message: DECISION_REFUSAL_TEXT[refused], refresh: true };
  }
  if (isApiError(error, 'DISPUTE_NOT_ALLOWED')) {
    return { kind: 'alert', message: copy.errUnknown, refresh: true };
  }
  if (isApiError(error, 'NOT_FOUND')) {
    return { kind: 'alert', message: copy.errAdminDisputeNotFound, refresh: true };
  }
  if (isApiError(error, 'UNAUTHENTICATED')) {
    return { kind: 'alert', message: copy.errUnauthenticated, refresh: false };
  }
  // Not the account check above: AdminGuard's, once another admin revoked this one's role.
  if (isApiError(error, 'FORBIDDEN'))
    return { kind: 'alert', message: copy.adminOnly, refresh: false };
  if (isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'reason') {
    return { kind: 'field', message: copy.errMarketReviewReason };
  }
  return {
    kind: 'alert',
    message: isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown,
    refresh: false,
  };
}
