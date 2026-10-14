import { PAYOUT_PER_CONTRACT_COIN, POSITION_QTY_MAX } from './constants.js';

/**
 * Position accounting (PLAN 5.4): buys, sells and settlement of one position row, whoever the
 * counterparty is. The worker's finalize settles with it (PLAN 9). Pure: every function returns
 * a new state and never mutates its input.
 *
 * All money is `bigint`; the only division (the cost released by a partial sell) rounds
 * half-up in bigint arithmetic so the API and the worker can never disagree by one Coin.
 */
export interface PositionState {
  qty: number;
  costBasisCoin: bigint;
  realizedPnlCoin: bigint;
}

function assertPosition(position: PositionState): void {
  if (!Number.isInteger(position.qty) || position.qty < 0) {
    throw new RangeError(
      `position qty must be a non-negative integer, got ${String(position.qty)}`,
    );
  }
}

function assertDelta(qty: number): void {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new RangeError(`qty must be a positive integer, got ${String(qty)}`);
  }
}

function assertAmount(name: string, amountCoin: bigint): void {
  if (typeof amountCoin !== 'bigint' || amountCoin < 0n) {
    throw new RangeError(`${name} must be a non-negative bigint, got ${String(amountCoin)}`);
  }
}

/** qty += Δ, costBasis += cost. RangeError when the row would overflow int4. */
export function applyBuy(position: PositionState, qty: number, costCoin: bigint): PositionState {
  assertPosition(position);
  assertDelta(qty);
  assertAmount('costCoin', costCoin);
  if (position.qty + qty > POSITION_QTY_MAX) {
    throw new RangeError(`position would exceed ${String(POSITION_QTY_MAX)} contracts`);
  }
  return {
    qty: position.qty + qty,
    costBasisCoin: position.costBasisCoin + costCoin,
    realizedPnlCoin: position.realizedPnlCoin,
  };
}

/**
 * released = roundHalfUp(costBasis · Δ / qty); qty −= Δ; costBasis −= released;
 * realized += proceeds − released. RangeError when Δ > qty (the caller refuses such a sell
 * before getting here).
 */
export function applySell(
  position: PositionState,
  qty: number,
  proceedsCoin: bigint,
): PositionState {
  assertPosition(position);
  assertDelta(qty);
  assertAmount('proceedsCoin', proceedsCoin);
  if (qty > position.qty) {
    throw new RangeError(`cannot sell ${String(qty)} of ${String(position.qty)} contracts`);
  }
  const held = BigInt(position.qty);
  const released = (position.costBasisCoin * BigInt(qty) + held / 2n) / held;
  return {
    qty: position.qty - qty,
    costBasisCoin: position.costBasisCoin - released,
    realizedPnlCoin: position.realizedPnlCoin + proceedsCoin - released,
  };
}

/**
 * Settlement (PLAN 5.4): the winning outcome pays qty · 100 Coin and realises payout − costBasis;
 * the losing one realises −costBasis. Either way the row ends at qty 0, costBasis 0.
 */
export function settle(
  position: PositionState,
  won: boolean,
): PositionState & { payoutCoin: bigint } {
  assertPosition(position);
  const payoutCoin = won ? BigInt(position.qty) * PAYOUT_PER_CONTRACT_COIN : 0n;
  return {
    qty: 0,
    costBasisCoin: 0n,
    realizedPnlCoin: position.realizedPnlCoin + payoutCoin - position.costBasisCoin,
    payoutCoin,
  };
}
