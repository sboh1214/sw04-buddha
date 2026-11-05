import type { ContractTerms } from '../contract.js';
import { assertWhole } from './validate.js';

/**
 * The largest payout the market maker prices: below it a contract's cost in doubles is exact to
 * well under a thousandth of a Coin, so the ladder rounds to the tick reliably.
 */
export const CONTRACT_PAYOUT_MAX_COIN = 1_000_000_000;

/**
 * RangeError unless the terms make a grid of whole-Coin prices inside (0, payout): positive
 * integers, a payout of at most `CONTRACT_PAYOUT_MAX_COIN`, a tick that divides the payout and
 * both ends of the price range, and VOID payouts that share out exactly one pair's collateral
 * (완전 담보, N01 §3). The market maker computes with the approved `CONTRACT_TERMS` (contract.ts)
 * and checks whatever terms it is handed with this (ADR-0058 결정 2).
 */
export function assertContractTerms(terms: ContractTerms): void {
  assertWhole('payoutCoin', terms.payoutCoin, 1);
  if (terms.payoutCoin > CONTRACT_PAYOUT_MAX_COIN) {
    throw new RangeError(
      `payoutCoin must be at most ${String(CONTRACT_PAYOUT_MAX_COIN)}, got ${String(terms.payoutCoin)}`,
    );
  }
  assertWhole('tickCoin', terms.tickCoin, 1);
  assertWhole('priceMinCoin', terms.priceMinCoin, 1);
  assertWhole('priceMaxCoin', terms.priceMaxCoin, 1);
  assertWhole('voidPayoutYesCoin', terms.voidPayoutYesCoin, 0);
  assertWhole('voidPayoutNoCoin', terms.voidPayoutNoCoin, 0);
  for (const [name, value] of [
    ['payoutCoin', terms.payoutCoin],
    ['priceMinCoin', terms.priceMinCoin],
    ['priceMaxCoin', terms.priceMaxCoin],
  ] as const) {
    if (value % terms.tickCoin !== 0) {
      throw new RangeError(`${name} must be a multiple of the tick, got ${String(value)}`);
    }
  }
  if (terms.priceMinCoin > terms.priceMaxCoin || terms.priceMaxCoin >= terms.payoutCoin) {
    throw new RangeError(
      `the price range must lie inside (0, payout), got ${String(terms.priceMinCoin)}–${String(terms.priceMaxCoin)}`,
    );
  }
  if (terms.voidPayoutYesCoin + terms.voidPayoutNoCoin !== terms.payoutCoin) {
    throw new RangeError('the VOID payouts of YES and NO must add up to the payout');
  }
}
