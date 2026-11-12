import {
  type RECONCILIATION_FINDING_CODES,
  reconciliationTargetSchema,
  type ReconciliationTarget,
} from '@buddha/shared';
import { copy } from '@/copy';
import {
  type ReconciliationHoldDetail,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationMessage,
} from './api';

export const RECONCILIATION_SCOPE_LABEL = {
  market: copy.reconciliationMarket,
  account: copy.reconciliationAccount,
  supply: copy.reconciliationSupply,
} as const;

export const RECONCILIATION_SOURCE_LABEL = {
  manual: copy.reconciliationManual,
  scheduled: copy.reconciliationScheduled,
  recovery: copy.reconciliationRecovery,
} as const;

export const RECONCILIATION_FINDING_LABEL: Record<
  (typeof RECONCILIATION_FINDING_CODES)[number],
  string
> = {
  balance_missing: copy.reconciliationFindingBalanceMissing,
  account_balance: copy.reconciliationFindingAccountBalance,
  account_ledger_copy: copy.reconciliationFindingLedgerCopy,
  coin_lock: copy.reconciliationFindingCoinLock,
  negative_coin: copy.reconciliationFindingNegativeCoin,
  contract_lock: copy.reconciliationFindingContractLock,
  market_maker_account_missing: copy.reconciliationFindingMakerMissing,
  market_maker_recall: copy.reconciliationFindingMakerRecall,
  retired_position: copy.reconciliationFindingRetiredPosition,
  closed_position_holder: copy.reconciliationFindingClosedHolder,
  empty_position_cost: copy.reconciliationFindingEmptyCost,
  settlement_books: copy.reconciliationFindingSettlement,
  pair_supply: copy.reconciliationFindingPairSupply,
  pair_collateral: copy.reconciliationFindingCollateral,
  unexpected_settlement_records: copy.reconciliationFindingUnexpectedSettlement,
  pair_ledger: copy.reconciliationFindingPairLedger,
  settled_live_orders: copy.reconciliationFindingSettledOrders,
  ledger_account_missing: copy.reconciliationFindingAccountMissing,
  supply_balance: copy.reconciliationFindingSupplyBalance,
  supply_ledger_copy: copy.reconciliationFindingSupplyCopy,
};

export type ReconciliationInputKind = 'market' | 'user' | 'account' | 'supply';
export type RecoveryAction = 'request' | 'approve' | 'reject' | 'retract';

export function reconciliationTargetDraft(
  kind: ReconciliationInputKind,
  input: string,
): ReconciliationTarget | null {
  const id = input.trim();
  const target =
    kind === 'market'
      ? { scope: 'market', marketId: id.toLowerCase() }
      : kind === 'user'
        ? { scope: 'account', userId: id }
        : kind === 'account'
          ? { scope: 'account', accountId: id }
          : { scope: 'supply' };
  const parsed = reconciliationTargetSchema.safeParse(target);
  if (!parsed.success) return null;
  if ('accountId' in parsed.data && !Number.isSafeInteger(Number(parsed.data.accountId)))
    return null;
  return parsed.data;
}

export function reconciliationHoldTarget(
  detail: ReconciliationHoldDetail,
): ReconciliationTarget | null {
  const { hold } = detail;
  if (hold.scope === 'market' && hold.marketId) return { scope: 'market', marketId: hold.marketId };
  if (hold.scope === 'account' && hold.userId) return { scope: 'account', userId: hold.userId };
  return null;
}

export function reconciliationRecoveryState(
  detail: ReconciliationHoldDetail,
  operatorId: string | undefined,
) {
  const pending = detail.requests.find((request) => request.status === 'pending') ?? null;
  const active = detail.hold.recoveredAt === null;
  const paused = detail.market?.status === 'paused';
  const passed = detail.latestResult?.passed === true;
  const stale = pending !== null && pending.failureResultId !== detail.hold.failureResultId;
  const own = operatorId !== undefined && pending?.requestedBy.id === operatorId;
  return {
    active,
    paused,
    passed,
    pending,
    stale,
    own,
    canRequest: operatorId !== undefined && active && !paused && passed && pending === null,
    canApprove:
      operatorId !== undefined && active && !paused && passed && pending !== null && !stale && !own,
    canReject: operatorId !== undefined && pending !== null && !own,
    canRetract: operatorId !== undefined && pending !== null && own,
  };
}

/** Every dialog keeps the operator and request it opened with; session errors close it. */
export function reconciliationFailure(error: unknown): { message: string; close: boolean } {
  if (isForAnotherAccount(error)) return { message: copy.sessionChanged, close: true };
  if (isApiUnreachable(error)) return { message: copy.errNetwork, close: false };
  if (isApiError(error, 'UNAUTHENTICATED'))
    return { message: copy.errUnauthenticated, close: false };
  if (isApiError(error, 'FORBIDDEN')) return { message: copy.adminOnly, close: false };
  if (isApiError(error, 'NOT_FOUND')) return { message: copy.reconciliationNotFound, close: false };
  const messages: Record<string, string> = {
    stale: copy.reconciliationStale,
    not_passed: copy.reconciliationNotPassed,
    paused: copy.reconciliationPausePath,
    not_found: copy.reconciliationNotFound,
    requester: copy.reconciliationOwnRequest,
    no_decider: copy.errApprovalNoDecider,
    decided: copy.errApprovalDecided,
    retracted: copy.errApprovalRetracted,
    not_requester: copy.errApprovalNotRequester,
    pending: copy.reconciliationPendingRequest,
  };
  const reason = isApiError(error) ? validationMessage(error) : undefined;
  return {
    message: reason === undefined ? copy.errUnknown : (messages[reason] ?? copy.errUnknown),
    close: false,
  };
}
