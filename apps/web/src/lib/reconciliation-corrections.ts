import { copy } from '@/copy';
import {
  type ReconciliationCorrectionCandidate,
  type ReconciliationCorrectionRequest,
  isApiError,
  validationMessage,
} from './api';
import { reconciliationFailure } from './reconciliation';

export type CorrectionAction = 'approve' | 'reject' | 'retract';

export const CORRECTION_MODE_LABEL: Record<ReconciliationCorrectionCandidate['mode'], string> = {
  restore_actual: copy.reconciliationCorrectionRestore,
  replenish_ledger: copy.reconciliationCorrectionReplenish,
  fund_collateral: copy.reconciliationCorrectionFund,
  return_collateral: copy.reconciliationCorrectionReturn,
};
export const CORRECTION_MODE_HINT: Record<ReconciliationCorrectionCandidate['mode'], string> = {
  restore_actual: copy.reconciliationCorrectionRestoreHint,
  replenish_ledger: copy.reconciliationCorrectionReplenishHint,
  fund_collateral: copy.reconciliationCorrectionFundHint,
  return_collateral: copy.reconciliationCorrectionReturnHint,
};
export const CORRECTION_STATUS_LABEL: Record<ReconciliationCorrectionRequest['status'], string> = {
  pending: copy.reconciliationCorrectionPending,
  approved: copy.reconciliationCorrectionApproved,
  rejected: copy.reconciliationCorrectionRejected,
  retracted: copy.reconciliationCorrectionRetracted,
};

export function correctionReasonDraft(reason: string, userReason: string, member: boolean) {
  const internal = reason.trim();
  const publicReason = userReason.trim();
  return {
    reason: internal,
    userReason: member ? publicReason : null,
    ready:
      internal.length >= 1 &&
      internal.length <= 500 &&
      (!member || (publicReason.length >= 1 && publicReason.length <= 500)),
  };
}

export function correctionRequestState(
  request: ReconciliationCorrectionRequest,
  operatorId: string | undefined,
) {
  const pending = request.status === 'pending';
  const own = operatorId !== undefined && request.requestedBy.id === operatorId;
  return {
    pending,
    own,
    canApprove: pending && operatorId !== undefined && !own,
    canReject: pending && operatorId !== undefined && !own,
    canRetract: pending && own,
  };
}

export function sameCorrectionCandidate(
  a: ReconciliationCorrectionCandidate,
  b: ReconciliationCorrectionCandidate,
) {
  return (
    a.accountId === b.accountId &&
    a.mode === b.mode &&
    a.amountCoin === b.amountCoin &&
    a.snapshotKey === b.snapshotKey
  );
}

export function correctionFailure(error: unknown): { message: string; close: boolean } {
  if (isApiError(error, 'NOT_FOUND'))
    return { message: copy.reconciliationCorrectionNotFound, close: false };
  const reason = isApiError(error) ? validationMessage(error) : undefined;
  const messages: Record<string, string> = {
    stale: copy.reconciliationCorrectionStale,
    insufficient_treasury: copy.reconciliationCorrectionTreasuryWait,
    unsupported: copy.reconciliationCorrectionNotEligible,
    pending: copy.reconciliationCorrectionPending,
  };
  if (reason !== undefined && messages[reason]) return { message: messages[reason], close: false };
  return reconciliationFailure(error);
}
