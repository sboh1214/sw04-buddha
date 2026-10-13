import { BP_MAX } from './constants.js';

/**
 * LMSR curve maths (PLAN 5.3), kept as the curve the market maker's quotes are computed from
 * (#127; N01 §1). Pure functions over doubles:
 *
 *   C(qY, qN) = b · ln(exp(qY/b) + exp(qN/b))
 *   pY        = 1 / (1 + exp((qN − qY)/b))
 *
 * Nobody trades against this curve directly (#125): there is no quote, fill or reserve here.
 * The direct-LMSR loss bound 100·b·ln 2 is a reference value of that earlier design, not a
 * guarantee of the bot that quotes from this curve (N01 §6), and the earlier direct-AMM
 * examples and verification are not results of the new engine (N01 §10).
 */
export interface LmsrState {
  /** Contracts issued for YES; may be negative. */
  qYes: number;
  qNo: number;
  /** Liquidity parameter, > 0. */
  b: number;
}

function assertFinite(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number, got ${String(value)}`);
  }
}

function assertState(state: LmsrState): void {
  assertFinite('qYes', state.qYes);
  assertFinite('qNo', state.qNo);
  assertFinite('b', state.b);
  if (state.b <= 0) throw new RangeError(`b must be positive, got ${String(state.b)}`);
}

/** PLAN 5.3 initialisation: qYes = b·ln(p0/(1−p0)), qNo = 0, so that pYes = p0. */
export function initState(p0: number, b: number): LmsrState {
  assertFinite('p0', p0);
  if (p0 <= 0 || p0 >= 1) {
    throw new RangeError(`p0 must lie strictly between 0 and 1, got ${String(p0)}`);
  }
  assertFinite('b', b);
  if (b <= 0) throw new RangeError(`b must be positive, got ${String(b)}`);
  return { qYes: b * Math.log(p0 / (1 - p0)), qNo: 0, b };
}

/** C(q) via log-sum-exp (the larger exponent is factored out so nothing overflows). */
export function cost(state: LmsrState): number {
  assertState(state);
  const a = state.qYes / state.b;
  const c = state.qNo / state.b;
  const m = Math.max(a, c);
  return state.b * (m + Math.log(Math.exp(a - m) + Math.exp(c - m)));
}

/** pYes ∈ [0, 1]; saturates to exactly 0 or 1 in double once |qN − qY|/b exceeds ~37. */
export function probabilityYes(state: LmsrState): number {
  assertState(state);
  return 1 / (1 + Math.exp((state.qNo - state.qYes) / state.b));
}

/** round(pYes · 10000), within 0..10000 (the basis points of `price_ticks.p_yes_bp`). */
export function probabilityBp(state: LmsrState): number {
  return Math.min(BP_MAX, Math.max(0, Math.round(probabilityYes(state) * BP_MAX)));
}
