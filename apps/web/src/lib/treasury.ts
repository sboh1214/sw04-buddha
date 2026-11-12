import { APPROVAL_REASON_MAX_LENGTH, coinAmountInputSchema, MAX_COIN_AMOUNT } from '@buddha/shared';
import { copy } from '@/copy';
import {
  type TreasuryIssueRequest,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
} from './api';

export type TreasuryAction = 'approve' | 'reject' | 'retract';

export const TREASURY_STATUS_LABEL: Record<TreasuryIssueRequest['status'], string> = {
  pending: copy.treasuryIssuePending,
  approved: copy.treasuryIssueApproved,
  rejected: copy.treasuryIssueRejected,
  retracted: copy.treasuryIssueRetracted,
};

export function treasuryReasonDraft(input: string) {
  const reason = input.trim();
  return { reason, ready: reason.length > 0 && reason.length <= APPROVAL_REASON_MAX_LENGTH };
}

export function treasuryIssueDraft(amount: string, inputReason: string) {
  const amountCoin = amount.trim();
  const parsed = coinAmountInputSchema.safeParse(amountCoin);
  const reason = treasuryReasonDraft(inputReason);
  const validAmount = parsed.success && parsed.data > 0n && parsed.data <= MAX_COIN_AMOUNT;
  return { amountCoin, reason: reason.reason, validAmount, ready: validAmount && reason.ready };
}

export function treasuryRequestState(
  request: TreasuryIssueRequest,
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

export function treasuryFailure(error: unknown): { message: string; close: boolean } {
  if (isForAnotherAccount(error)) return { message: copy.sessionChanged, close: true };
  if (isApiUnreachable(error)) return { message: copy.errNetwork, close: false };
  if (isApiError(error, 'UNAUTHENTICATED'))
    return { message: copy.errUnauthenticated, close: false };
  if (isApiError(error, 'FORBIDDEN')) return { message: copy.adminOnly, close: false };
  if (isApiError(error, 'NOT_FOUND')) return { message: copy.treasuryIssueNotFound, close: false };
  if (isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'treasuryIssue') {
    const message = validationMessage(error);
    const specific: Record<string, string> = {
      treasury_inconsistent: copy.treasuryIssueLedgerMismatch,
      amount: copy.treasuryIssueAmountInvalid,
      approval: copy.treasuryIssueApprovalInvalid,
      requester: copy.treasuryIssueRequesterUnavailable,
    };
    if (message && Object.hasOwn(specific, message))
      return { message: specific[message]!, close: false };
  }
  const messages: Record<string, string> = {
    requester: copy.treasuryIssueOwnRequest,
    no_decider: copy.errApprovalNoDecider,
    decided: copy.errApprovalDecided,
    retracted: copy.errApprovalRetracted,
    not_requester: copy.errApprovalNotRequester,
  };
  const reason = isApiError(error, 'APPROVAL_NOT_ALLOWED') ? validationMessage(error) : undefined;
  return {
    message:
      reason !== undefined && Object.hasOwn(messages, reason) ? messages[reason]! : copy.errUnknown,
    close: false,
  };
}
