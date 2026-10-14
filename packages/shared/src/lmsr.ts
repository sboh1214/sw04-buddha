/**
 * LMSR curve maths (N01 §6): the curve the operator market maker computes its quotes from (#127,
 * N01 §1). Nobody trades against the curve directly (#125). Pure functions over doubles:
 *
 *   C(qY, qN) = P · b · ln(e^(qY/b) + e^(qN/b))
 *   pY        = σ(d / b),  d = qY − qN
 *
 * P is the normal payout of a contract (the plan's 100, a design proposal — N01 §3, #177), b the
 * liquidity in contracts. qY·qN are the bot's net sales; the bot counts them from what it holds,
 * qY − qN = held NO − held YES, starting at 0 (ADR-0058 결정 1의 7). Prices depend on d alone:
 * C(qY + t, qN + t) = C(qY, qN) + P·t, so minting or burning pairs and trades between users
 * leave every quote where it was.
 *
 * The opening reference is 50% for every market (ADR-0058 결정 1의 2), so d = 0 at the open and
 * there is no initial-probability input. The direct-LMSR loss bound P·b·ln 2 is a reference
 * value only, not a guarantee of the bot quoting from this curve (N01 §6); its loss is limited
 * by the market's maximum loss L (#128).
 */

function assertFinite(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number, got ${String(value)}`);
  }
}

function assertPositive(name: string, value: number): void {
  assertFinite(name, value);
  if (value <= 0) throw new RangeError(`${name} must be positive, got ${String(value)}`);
}

/**
 * b > 0 with 1/b finite, and P > 0 with P·b finite: the doubles the formulas below divide and
 * multiply by. Outside that (b below about 5.6e-309, or P·b above about 1.8e308) a cost would
 * come out NaN or infinite.
 */
function assertCurve(b: number, payoutCoin: number): void {
  assertPositive('b', b);
  assertPositive('payoutCoin', payoutCoin);
  if (!Number.isFinite(1 / b) || !Number.isFinite(payoutCoin * b)) {
    throw new RangeError(`b = ${String(b)} is out of range for a payout of ${String(payoutCoin)}`);
  }
}

/** ln(1 + e^x) without overflow or loss of precision at either end. */
function softplus(x: number): number {
  return x > 0 ? x + Math.log1p(Math.exp(-x)) : Math.log1p(Math.exp(x));
}

/** σ(x) = 1 / (1 + e^(−x)), computed on the side where the exponent cannot overflow. */
function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/** C(qY, qN) via log-sum-exp: the larger exponent is factored out so nothing overflows. */
export function lmsrCost(qYes: number, qNo: number, b: number, payoutCoin: number): number {
  assertFinite('qYes', qYes);
  assertFinite('qNo', qNo);
  assertCurve(b, payoutCoin);
  const m = Math.max(qYes, qNo);
  return payoutCoin * (m + b * Math.log(Math.exp((qYes - m) / b) + Math.exp((qNo - m) / b)));
}

/**
 * pY = σ(d / b) ∈ [0, 1]. It rounds to exactly 1 once d/b passes about 37, and to exactly 0
 * only below about −745, where e^(d/b) underflows.
 */
export function probabilityYes(d: number, b: number): number {
  assertFinite('d', d);
  assertCurve(b, 1);
  return sigmoid(d / b);
}

/** The curve's reference price P·pY in Coin (N01 §6 "100×pY는 곡선의 기준가격"). */
export function referencePriceCoin(d: number, b: number, payoutCoin: number): number {
  assertPositive('payoutCoin', payoutCoin);
  return payoutCoin * probabilityYes(d, b);
}

/**
 * Y(d) = C(qY + 1, qN) − C(qY, qN): the cost of one more YES sold, moving d to d + 1. The same
 * move by buying back one NO costs the bot P − Y(d), one pair less. Moving d to d − 1, the YES
 * the bot buys back costs Y(d − 1).
 *
 * Y(d) = P·b·ln(1 + σ(d/b)·(e^(1/b) − 1)), which never subtracts two large logarithms, so it
 * keeps its digits for a large b and does not overflow for a large |d| (N01 §6 "안정적인
 * log-sum-exp"). For 1/b > 30 the same value is taken as a log-sum-exp of ln(1 − σ) and
 * ln σ + 1/b, which stays finite for every b the curve accepts (1/b and P·b finite).
 * 0 < Y(d) < P in exact arithmetic.
 */
export function yesUnitCostCoin(d: number, b: number, payoutCoin: number): number {
  assertFinite('d', d);
  assertCurve(b, payoutCoin);
  const x = d / b;
  const h = 1 / b;
  if (h <= 30) return payoutCoin * b * Math.log1p(sigmoid(x) * Math.expm1(h));
  const lnNo = -softplus(x); // ln(1 − σ(x))
  const lnYes = h - softplus(-x); // ln σ(x) + 1/b
  const top = Math.max(lnNo, lnYes);
  return payoutCoin * b * (top + Math.log1p(Math.exp(Math.min(lnNo, lnYes) - top)));
}
