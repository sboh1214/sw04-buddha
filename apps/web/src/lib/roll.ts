/**
 * The cells behind `RollingNumber` (PLAN 11.1-5, 실시간은 조용하게).
 *
 * A rolling digit here is a pure function of the value on screen: each digit cell is a clipped
 * window over one ten-digit column, and the column is translated to the digit it must show. The
 * roll itself is a CSS `transition` between two static renders, so this module needs no state,
 * no ref, no effect and no `requestAnimationFrame` — which is also why the server and the
 * browser emit identical markup and a page load does not roll every number up from zero.
 *
 * The text arrives already formatted (`formatCoin`, `formatYesPrice`); nothing is formatted here,
 * so the composed labels those helpers produce — '예 63%', '−1,200P' — survive intact and the
 * 예/아니오 word always travels with its number (PLAN 11.2).
 */

export const ROLL_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** How far one digit is down the column, as a percentage of the column's own height. */
const ROLL_STEP_PCT = 100 / ROLL_DIGITS.length;

export interface RollCell {
  /** React key. Counted from the END of the string — see `rollCells`. */
  readonly key: string;
  readonly char: string;
  /** Percent of the ten-digit column to translate up; `null` when `char` is not a digit. */
  readonly offsetPct: number | null;
}

/**
 * Splits an already-formatted string into roll cells.
 *
 * Keys are anchored to the END of the string, not the start. A formatted value changes length
 * on ordinary one-point moves — '예 9%' -> '예 63%', '9,900P' -> '10,000P' — and keying from the
 * left makes React reuse the cell that held a '9' for a '6', animating the wrong glyphs on the
 * common case. Anchored from the right, the units digit, the '%' and the thousands digits keep
 * their identity; a new leading digit simply mounts, which correctly does not animate.
 *
 * Split by code point rather than by UTF-16 unit, so a character outside the BMP is one cell
 * and cannot be torn into two halves that render as replacement glyphs.
 */
export function rollCells(text: string): RollCell[] {
  const chars = Array.from(text);
  return chars.map((char, index) => {
    // Only the ASCII digits roll: the column holds those ten glyphs and nothing else, so any
    // other character — 예, a space, '%', a comma, the U+2212 minus — is rendered as itself.
    const digit = (ROLL_DIGITS as readonly string[]).indexOf(char);
    return {
      key: `r${String(chars.length - 1 - index)}`,
      char,
      offsetPct: digit < 0 ? null : digit * ROLL_STEP_PCT,
    };
  });
}
