import { BP_MAX, ORDER_QTY_MAX, PRICE_MAX, PRICE_MIN } from './constants.js';
import type { Outcome } from './enums.js';

/**
 * LMSR pricing engine (PLAN 5.3). Pure functions over doubles; every P amount is fixed to
 * an integer at the boundary (PLAN 0.2) and returned as `bigint`.
 *
 *   C(qY, qN) = b · ln(exp(qY/b) + exp(qN/b))
 *   pY        = 1 / (1 + exp((qN − qY)/b))
 *   buy Δ:    costP     = clamp(ceil(100 · (C(q + Δe_o) − C(q))), 1, 100·Δ)
 *   sell Δ:   proceedsP = clamp(floor(100 · (C(q) − C(q − Δe_o))), 0, 100·Δ)
 *
 * The cost difference is never computed as `C(q') − C(q)`: both terms carry ulp(|q|), which is
 * already 0.016 (1.6P) at the |q| ≈ 1e14 the DB column holds, so the difference loses whole
 * P long before the state stops being valid. Instead `C(q) = q_other + b·softplus(y)` with
 * y = (q_o − q_other)/b and softplus(t) = ln(1 + eᵗ), so every increment depends on q only
 * through the spread — see `costIncrement`. With p_o the probability of the traded outcome
 * this equals the closed forms `ΔC_buy = b·log1p(p_o·expm1(Δ/b))` and
 * `ΔC_sell = −b·log1p(p_o·expm1(−Δ/b))` wherever those do not overflow or cancel.
 *
 * The clamps are justified by 0 ≤ ΔC ≤ Δ: C is 1-Lipschitz in each coordinate, so a buy
 * never costs more than 100P per contract and a sell never pays more. Without them double
 * rounding could produce 100·Δ + 1 (breaking `fills.price_avg_bp ≤ 10000`) or 0 (breaking
 * PLAN invariant 2 and writing a 0-P ledger row).
 */
export interface LmsrState {
  /** Contracts issued for YES; may be negative (net sold to the AMM). */
  qYes: number;
  qNo: number;
  /** Liquidity parameter, > 0. */
  b: number;
}

export interface Quote {
  shares: number;
  /** Buy: cost to pay. Sell: proceeds received. */
  amountP: bigint;
  /** State after the trade executes. */
  next: LmsrState;
  /** Average price paid per contract in basis points of 100P: 0..10000. */
  priceAvgBp: number;
  /** `probabilityBp` of the state before / after the trade. */
  priceBeforeBp: number;
  priceAfterBp: number;
}

/**
 * Widest quantity the DB column holds: `numeric(24,10)` has 14 integer digits, and
 * `toFixed(10)` only stays positional (no exponent) below 1e21 anyway. Quotes stay P-exact
 * across the whole range because they read q only through the spread `qYes − qNo`, which
 * `−` computes exactly whenever the two lie within a factor of two of each other.
 */
const QUANTITY_ABS_MAX = 1e14;

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

function assertShares(shares: number): void {
  if (!Number.isInteger(shares) || shares < 1 || shares > ORDER_QTY_MAX) {
    throw new RangeError(
      `shares must be an integer in 1..${String(ORDER_QTY_MAX)}, got ${String(shares)}`,
    );
  }
}

function assertProbability(p0: number): void {
  assertFinite('p0', p0);
  if (p0 <= 0 || p0 >= 1)
    throw new RangeError(`p0 must lie strictly between 0 and 1, got ${String(p0)}`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** PLAN 5.3 initialisation: qYes = b·ln(p0/(1−p0)), qNo = 0, so that pYes = p0. */
export function initState(p0: number, b: number): LmsrState {
  assertProbability(p0);
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

/** round(pYes · 10000) clamped to 0..10000 (price_ticks.p_yes_bp). */
export function probabilityBp(state: LmsrState): number {
  return clamp(Math.round(probabilityYes(state) * BP_MAX), 0, BP_MAX);
}

/** Display YES price in P: clamp(round(pYes · 100), 1, 99). */
export function priceOf(state: LmsrState): number {
  return clamp(Math.round(probabilityYes(state) * 100), PRICE_MIN, PRICE_MAX);
}

function withQuantity(state: LmsrState, outcome: Outcome, delta: number): LmsrState {
  return outcome === 'YES'
    ? { qYes: state.qYes + delta, qNo: state.qNo, b: state.b }
    : { qYes: state.qYes, qNo: state.qNo + delta, b: state.b };
}

/** ln(1 + eᵗ) for any finite t: the exponent never overflows and log1p never cancels. */
function softplus(t: number): number {
  return Math.max(t, 0) + Math.log1p(Math.exp(-Math.abs(t)));
}

/**
 * C(q + Δe_o) − C(q) = b·[softplus(y + x) − softplus(y)] with y = (q_o − q_other)/b and
 * x = Δ/b, so |q| never enters — only the spread, which `−` computes exactly for the states
 * the DB holds. The two softplus terms still cancel when both are large (y ≫ 0), so for
 * y ≥ 0 the identity softplus(t) = t + softplus(−t) turns the difference into
 * `x + softplus(−y − x) − softplus(−y)`, where both softplus terms lie in (0, ln 2]. For
 * y < 0 softplus(y) ≤ ln 2 and softplus(y + x) is either as small or ≈ y + x, so nothing
 * cancels beyond a few ulp of max(x, |y|, 1)·b — negligible against 0.01 C for any order.
 */
function costIncrement(state: LmsrState, outcome: Outcome, shares: number): number {
  const own = outcome === 'YES' ? state.qYes : state.qNo;
  const other = outcome === 'YES' ? state.qNo : state.qYes;
  const y = (own - other) / state.b;
  const x = shares / state.b;
  const delta = y >= 0 ? x + softplus(-y - x) - softplus(-y) : softplus(y + x) - softplus(y);
  return state.b * delta;
}

/**
 * C(q) − C(q − Δe_o) ≥ 0: the same increment evaluated at the post-sell state, so a sell
 * and the buy that would undo it share one number and floor ≤ ceil holds by construction.
 */
function costDecrement(state: LmsrState, outcome: Outcome, shares: number): number {
  return costIncrement(withQuantity(state, outcome, -shares), outcome, shares);
}

function priceAvgBp(amountP: bigint, shares: number): number {
  return Math.round((Number(amountP) * 100) / shares);
}

export function quoteBuy(state: LmsrState, outcome: Outcome, shares: number): Quote {
  assertState(state);
  assertShares(shares);
  const increment = costIncrement(state, outcome, shares);
  const amountP = BigInt(clamp(Math.ceil(100 * increment), 1, 100 * shares));
  const next = withQuantity(state, outcome, shares);
  return {
    shares,
    amountP,
    next,
    priceAvgBp: priceAvgBp(amountP, shares),
    priceBeforeBp: probabilityBp(state),
    priceAfterBp: probabilityBp(next),
  };
}

/**
 * The engine does not know the caller's holdings: the caller checks Δ ≤ position.qty and
 * answers INSUFFICIENT_POSITION itself.
 */
export function quoteSell(state: LmsrState, outcome: Outcome, shares: number): Quote {
  assertState(state);
  assertShares(shares);
  const decrement = costDecrement(state, outcome, shares);
  const amountP = BigInt(clamp(Math.floor(100 * decrement), 0, 100 * shares));
  const next = withQuantity(state, outcome, -shares);
  return {
    shares,
    amountP,
    next,
    priceAvgBp: priceAvgBp(amountP, shares),
    priceBeforeBp: probabilityBp(state),
    priceAfterBp: probabilityBp(next),
  };
}

/**
 * Largest integer Δ in [0, ORDER_QTY_MAX] whose buy cost is ≤ `spendP`; 0 when even one
 * contract costs more. The cost is non-decreasing in Δ (C is convex and the clamps preserve
 * order), so a bisection over the integers is exact.
 */
export function sharesForSpend(state: LmsrState, outcome: Outcome, spendP: bigint): number {
  assertState(state);
  if (typeof spendP !== 'bigint' || spendP < 0n) {
    throw new RangeError(`spendP must be a non-negative bigint, got ${String(spendP)}`);
  }
  const affordable = (shares: number) => quoteBuy(state, outcome, shares).amountP <= spendP;
  if (!affordable(1)) return 0;
  if (affordable(ORDER_QTY_MAX)) return ORDER_QTY_MAX;
  // Invariant: affordable(lo) && !affordable(hi).
  let lo = 1;
  let hi = ORDER_QTY_MAX;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (affordable(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Operator's worst-case loss from `initState(p0, b)` over any trade sequence (ADR-0027):
 * ceil(100 · b · −ln(min(p0, 1 − p0))). Equals PLAN 5.3's `100·b·ln2` only at p0 = 0.5.
 */
export function maxLossP(p0: number, b: number): bigint {
  assertProbability(p0);
  assertFinite('b', b);
  if (b <= 0) throw new RangeError(`b must be positive, got ${String(b)}`);
  return BigInt(Math.ceil(100 * b * -Math.log(Math.min(p0, 1 - p0))));
}

/**
 * `markets.q_yes` / `q_no` / `liquidity_b` are `numeric` and cross drizzle as strings.
 * `toFixed(10)` matches the column scale and never uses exponent notation in range.
 */
export function serializeQuantity(q: number): string {
  assertFinite('q', q);
  if (Math.abs(q) >= QUANTITY_ABS_MAX) {
    throw new RangeError(`quantity out of numeric(24,10) range: ${String(q)}`);
  }
  return q.toFixed(10);
}

export function parseQuantity(text: string): number {
  const q = Number(text);
  if (text.trim() === '' || !Number.isFinite(q)) {
    throw new RangeError(`quantity is not a finite decimal: ${JSON.stringify(text)}`);
  }
  return q;
}
