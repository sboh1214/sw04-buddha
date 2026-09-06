import { PAYOUT_PER_CONTRACT_P, POSITION_QTY_MAX } from './constants.js';

/**
 * Position accounting (PLAN 5.4). Shared by the API (trades, void) and the worker
 * (finalize, PLAN 9). Pure: every function returns a new state and never mutates its input.
 *
 * All money is `bigint`; the only division (the cost released by a partial sell) rounds
 * half-up in bigint arithmetic so the API and the worker can never disagree by a P.
 */
export interface PositionState {
  qty: number;
  costBasisP: bigint;
  realizedPnlP: bigint;
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

function assertAmount(name: string, amountP: bigint): void {
  if (typeof amountP !== 'bigint' || amountP < 0n) {
    throw new RangeError(`${name} must be a non-negative bigint, got ${String(amountP)}`);
  }
}

/** qty += Δ, costBasis += cost. RangeError when the row would overflow int4. */
export function applyBuy(position: PositionState, qty: number, costP: bigint): PositionState {
  assertPosition(position);
  assertDelta(qty);
  assertAmount('costP', costP);
  if (position.qty + qty > POSITION_QTY_MAX) {
    throw new RangeError(`position would exceed ${String(POSITION_QTY_MAX)} contracts`);
  }
  return {
    qty: position.qty + qty,
    costBasisP: position.costBasisP + costP,
    realizedPnlP: position.realizedPnlP,
  };
}

/**
 * released = roundHalfUp(costBasis · Δ / qty); qty −= Δ; costBasis −= released;
 * realized += proceeds − released. RangeError when Δ > qty (the caller answers
 * INSUFFICIENT_POSITION before getting here).
 */
export function applySell(position: PositionState, qty: number, proceedsP: bigint): PositionState {
  assertPosition(position);
  assertDelta(qty);
  assertAmount('proceedsP', proceedsP);
  if (qty > position.qty) {
    throw new RangeError(`cannot sell ${String(qty)} of ${String(position.qty)} contracts`);
  }
  const held = BigInt(position.qty);
  const released = (position.costBasisP * BigInt(qty) + held / 2n) / held;
  return {
    qty: position.qty - qty,
    costBasisP: position.costBasisP - released,
    realizedPnlP: position.realizedPnlP + proceedsP - released,
  };
}

/**
 * Settlement (PLAN 5.4): the winning outcome pays qty · 100P and realises payout − costBasis;
 * the losing one realises −costBasis. Either way the row ends at qty 0, costBasis 0.
 */
export function settle(position: PositionState, won: boolean): PositionState & { payoutP: bigint } {
  assertPosition(position);
  const payoutP = won ? BigInt(position.qty) * PAYOUT_PER_CONTRACT_P : 0n;
  return {
    qty: 0,
    costBasisP: 0n,
    realizedPnlP: position.realizedPnlP + payoutP - position.costBasisP,
    payoutP,
  };
}

/**
 * Void (PLAN 5.5): the cost basis is refunded, the row is closed out and realised PnL from
 * earlier sells stays as it is — so a void's total refund is not bounded by the reserve
 * (ADR-0027).
 */
export function voidRefund(position: PositionState): PositionState & { refundP: bigint } {
  assertPosition(position);
  return {
    qty: 0,
    costBasisP: 0n,
    realizedPnlP: position.realizedPnlP,
    refundP: position.costBasisP,
  };
}
