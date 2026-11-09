import { CONTRACT_TERMS } from './contract.js';
import type { PositionState } from './accounting.js';
import type { MarketResult, Outcome } from './enums.js';

/** The approved, fee-free Coin paid by one contract (#126, ADR-0107). */
export function settlementPayoutPerContract(result: MarketResult, outcome: Outcome): number {
  if (result === 'VOID') {
    return outcome === 'YES' ? CONTRACT_TERMS.voidPayoutYesCoin : CONTRACT_TERMS.voidPayoutNoCoin;
  }
  return result === outcome ? CONTRACT_TERMS.payoutCoin : 0;
}

/**
 * Close a position and preserve the two distinct facts: its settlement PnL and its cumulative
 * realized PnL. VOID is a fixed payout, never a refund of the position's cost (#177 16항).
 */
export function settlePosition(
  position: PositionState,
  result: MarketResult,
  outcome: Outcome,
): PositionState & {
  payoutPerContractCoin: number;
  payoutCoin: bigint;
  settlementPnlCoin: bigint;
} {
  if (!Number.isSafeInteger(position.qty) || position.qty < 0) {
    throw new RangeError('Settlement quantity must be a non-negative safe integer');
  }
  if (position.costBasisCoin < 0n || (position.qty === 0 && position.costBasisCoin !== 0n)) {
    throw new RangeError('Settlement cost must be non-negative and zero without contracts');
  }
  const payoutPerContractCoin = settlementPayoutPerContract(result, outcome);
  const payoutCoin = BigInt(position.qty) * BigInt(payoutPerContractCoin);
  const settlementPnlCoin = payoutCoin - position.costBasisCoin;
  return {
    qty: 0,
    costBasisCoin: 0n,
    realizedPnlCoin: position.realizedPnlCoin + settlementPnlCoin,
    payoutPerContractCoin,
    payoutCoin,
    settlementPnlCoin,
  };
}
