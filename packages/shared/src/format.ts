/** U+2212 MINUS SIGN. PLAN 11.1 (principle 6) mandates it over ASCII hyphen-minus. */
export const MINUS_SIGN = '−';

/**
 * Formats an integer amount of points as `12,345P` / `−1,200P`.
 *
 * Accepts `bigint` (canonical for P amounts, see PLAN 0.2) or a safe-integer
 * `number`. Non-integers are rejected because P amounts are never fractional;
 * numbers outside ±(2^53 − 1) are rejected because the double has already
 * rounded them, so formatting would silently show a wrong amount. Grouping is
 * done manually so the output does not depend on the runtime's ICU locale data.
 */
export function formatP(n: bigint | number): string {
  if (typeof n === 'number' && !Number.isSafeInteger(n)) {
    throw new RangeError(`formatP expects a safe integer, got ${n}`);
  }
  const value = typeof n === 'bigint' ? n : BigInt(n);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  let grouped = '';
  for (let i = 0; i < digits.length; i++) {
    grouped += digits[i];
    const remaining = digits.length - i - 1;
    if (remaining > 0 && remaining % 3 === 0) grouped += ',';
  }
  return `${negative ? MINUS_SIGN : ''}${grouped}P`;
}
