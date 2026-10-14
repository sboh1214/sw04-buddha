/** U+2212 MINUS SIGN. PLAN 11.1 (principle 6) mandates it over ASCII hyphen-minus. */
export const MINUS_SIGN = '−';

/**
 * Formats a KRW price as `4,900원`. Prices are plain integers (won has no minor unit) and
 * always positive, so this is the Coin formatter without the sign handling.
 */
export function formatKrw(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`formatKrw expects a non-negative safe integer, got ${String(n)}`);
  }
  return `${groupDigits(n.toString())}원`;
}

/** Inserts a comma every three digits from the right. */
function groupDigits(digits: string): string {
  let grouped = '';
  for (let i = 0; i < digits.length; i++) {
    grouped += digits[i];
    const remaining = digits.length - i - 1;
    if (remaining > 0 && remaining % 3 === 0) grouped += ',';
  }
  return grouped;
}

/**
 * Formats an integer amount of Coin as `12,345P` / `−1,200P`.
 *
 * Accepts `bigint` (canonical for Coin amounts, see PLAN 0.2) or a safe-integer
 * `number`. Non-integers are rejected because Coin amounts are never fractional;
 * numbers outside ±(2^53 − 1) are rejected because the double has already
 * rounded them, so formatting would silently show a wrong amount. Grouping is
 * done manually so the output does not depend on the runtime's ICU locale data.
 */
export function formatCoin(n: bigint | number): string {
  if (typeof n === 'number' && !Number.isSafeInteger(n)) {
    throw new RangeError(`formatCoin expects a safe integer, got ${n}`);
  }
  const value = typeof n === 'bigint' ? n : BigInt(n);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  return `${negative ? MINUS_SIGN : ''}${groupDigits(digits)}P`;
}
