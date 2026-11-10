import { copy } from '@/copy';
import type { AdminMarketMaker } from './api';

export const MARKET_MAKER_BLOCKER_LABEL: Record<
  AdminMarketMaker['readiness']['blockers'][number],
  string
> = {
  market_not_open: copy.marketMakerMarketNotOpen,
  ledger_hold: copy.marketMakerLedgerHold,
  liquidity_missing: copy.marketMakerLiquidityMissing,
  risk_settings_missing: copy.marketMakerRiskSettingsMissing,
  risk_settings_invalid: copy.marketMakerRiskSettingsInvalid,
  intake_closed: copy.marketMakerIntakeClosed,
  not_allocated: copy.marketMakerNotAllocated,
  disabled: copy.marketMakerDisabled,
};
export const MARKET_MAKER_STATE_LABEL: Record<
  NonNullable<AdminMarketMaker['runtime']>['state'],
  string
> = {
  ready: copy.marketMakerReady,
  waiting: copy.marketMakerWaiting,
  stopped: copy.marketMakerStopped,
  error: copy.marketMakerError,
};
export const MARKET_MAKER_STAGE_LABEL: Record<AdminMarketMaker['stageSettings']['status'], string> =
  {
    ready: copy.marketMakerStageReady,
    undecided: copy.marketMakerStageUndecided,
    invalid: copy.marketMakerStageInvalid,
  };

/** Last-attempt reasons are historical strings, never a claim about current readiness. */
export function marketMakerReason(
  reason: string,
  fallback: string = copy.marketMakerUnknownReason,
): string {
  const labels: Record<string, string> = {
    ...MARKET_MAKER_BLOCKER_LABEL,
    not_trading: copy.marketMakerMarketNotOpen,
    close_passed: copy.marketMakerClosePassed,
    paused: copy.marketMakerPaused,
    stopped: copy.marketMakerExecutionStopped,
    no_quotes: copy.marketMakerNoQuotes,
    admission_refused: copy.marketMakerAdmissionRefused,
    missing_config: copy.marketMakerLiquidityMissing,
    missing_market_maker: copy.marketMakerAccountMissing,
    missing_funds: copy.marketMakerNotAllocated,
    treasury_insufficient: copy.marketMakerTreasuryInsufficient,
    insufficient_treasury: copy.marketMakerTreasuryInsufficient,
    treasury_inconsistent: copy.treasuryIssueLedgerMismatch,
    treasury_missing: copy.marketMakerTreasuryMissing,
    market_maker_approval_missing: copy.marketMakerApprovalMissing,
    market_maker_funds_inconsistent: copy.marketMakerFundsInconsistent,
  };
  return Object.hasOwn(labels, reason) ? labels[reason]! : fallback;
}
