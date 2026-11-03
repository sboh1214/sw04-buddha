import { PAYOUT_PER_CONTRACT_COIN, PRICE_MAX, PRICE_MIN } from '../constants.js';
import { assertWhole } from './validate.js';

/**
 * The contract values the market maker computes with. They are inputs, not constants of the
 * rules: the plan proposes them and their approval is still open (#177 1항, #173), so a new
 * value changes nothing but this object (ADR-0058 결정 2).
 */
export interface ContractTerms {
  /** Coin a winning contract pays, and the collateral of a YES·NO pair (N01 §3). */
  readonly payoutCoin: number;
  /** The price step in Coin (N01 §3). */
  readonly tickCoin: number;
  /** The lowest and highest order price in Coin (N01 §3). */
  readonly priceMinCoin: number;
  readonly priceMaxCoin: number;
  /** What one YES and one NO contract pay on VOID (N03 §6); together they are the payout. */
  readonly voidPayoutYesCoin: number;
  readonly voidPayoutNoCoin: number;
}

/**
 * The plan's design proposals: whole contracts paying 100 Coin, a 1 Coin tick, prices 1–99
 * (N01 §3) and VOID paying 50/50 (N03 §6). Only VOID 50/50 is approved (ADR-0093 #173 item 9,
 * one value for every market — the rules area shows it from here, #23 ADR-0097); the rest are
 * still the NR 설계 상태.
 */
export const PROPOSED_CONTRACT_TERMS: ContractTerms = {
  payoutCoin: Number(PAYOUT_PER_CONTRACT_COIN),
  tickCoin: 1,
  priceMinCoin: PRICE_MIN,
  priceMaxCoin: PRICE_MAX,
  voidPayoutYesCoin: 50,
  voidPayoutNoCoin: 50,
};

/**
 * The largest payout the market maker prices: below it a contract's cost in doubles is exact to
 * well under a thousandth of a Coin, so the ladder rounds to the tick reliably.
 */
export const CONTRACT_PAYOUT_MAX_COIN = 1_000_000_000;

/**
 * RangeError unless the terms make a grid of whole-Coin prices inside (0, payout): positive
 * integers, a payout of at most `CONTRACT_PAYOUT_MAX_COIN`, a tick that divides the payout and
 * both ends of the price range, and VOID payouts that share out exactly one pair's collateral
 * (완전 담보, N01 §3). Whether VOID payouts may add up to anything else is still open (#173 9항).
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
