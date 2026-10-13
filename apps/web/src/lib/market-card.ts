import { PRICE_MAX, PRICE_MIN } from '@buddha/shared';
import { copy } from '@/copy';
import { formatNoPrice, formatYesPrice } from './market-admin';

/**
 * The arithmetic behind the card's two outcome rows (ADR-0041's Kalshi tile, PLAN 11.1-1): the
 * percentage each row shows, the "맞히면 투입 대비 N.NNx" figure beside it, and the words a screen
 * reader hears for it. Pure functions of `lastPrice`, so a node test pins the numbers and the
 * component only lays them out — the same split `lib/sparkline.ts` makes for the trace. A market
 * with no fill has no `lastPrice` and no rows: the card reads 체결 없음 instead (N02 §5).
 *
 * Nothing here is domain maths in PLAN 11.5's sense: `lastPrice` is the last fill's price as the
 * API sends it (1..99, `priceSchema`), and the two rows are that number and its complement. The
 * multiple is the one derived figure, and it is a display convention — Kalshi's "2.14x" — not
 * a quote: what a contract actually costs is what the order book offers, never this.
 */

/** One of the tile's two rows: 예 first, 아니오 second, as `outcomeRows` orders them. */
export interface OutcomeRow {
  key: 'yes' | 'no';
  /** The visible label, `copy.yes` / `copy.no`: the words that carry the meaning (PLAN 11.2). */
  label: string;
  /** The whole-percent reading the pill shows: `lastPrice` for 예, its complement for 아니오. */
  percent: number;
  /** `payoutMultiple(percent)` — `1.59x`. */
  multiple: string;
  /**
   * `formatYesPrice` / `formatNoPrice` — "예 63%" / "아니오 37%": the bar's `aria-label`, so the
   * row is read by its reading and not by the bare "63%" the pill paints.
   */
  accessibleName: string;
  /**
   * The bar's colour token. `row.first`/`row.second` (Kalshi's green and blue pair) rather than
   * the `yes`/`no` palettes: theme/system.ts says why — the label beside it carries the meaning,
   * and the pair is what Kalshi draws on every tile.
   */
  accent: 'row.first' | 'row.second';
}

/**
 * Kalshi's "2.14x": what 1P put on this side comes back as if it wins, `100 / price` with two
 * decimals — a contract pays `PAYOUT_PER_CONTRACT_P` (100P) and costs `price` P (PLAN 5.4).
 *
 * Out of range is CLAMPED to `PRICE_MIN..PRICE_MAX`, never thrown on. The API guarantees the
 * range (`priceSchema` on every row and every `market:tick`), so a value outside it is a bug
 * upstream, and the question is only what the card does about it:
 * throwing inside a render would take the whole home grid down with the one card, and printing
 * `Infinityx` for 0 is no better. Clamping to the bounds every producer already applies prints
 * exactly what the API would have printed, which is the least surprising answer a display-only
 * component can give. A NaN is not defended against — no producer can emit one — and would
 * print as `NaNx`, which at least does not pretend to be a number.
 */
export function payoutMultiple(price: number): string {
  const clamped = Math.min(PRICE_MAX, Math.max(PRICE_MIN, price));
  return `${(100 / clamped).toFixed(2)}x`;
}

/**
 * The 아니오 side of a reading, the complement of the same `lastPrice`, for the reason
 * `formatNoPrice` gives: 예 and 아니오 on one card always add up to 100.
 */
export function noPrice(lastPrice: number): number {
  return 100 - lastPrice;
}

/** The two rows in the order the tile draws them: 예 (green, first) then 아니오 (blue, second). */
export function outcomeRows(lastPrice: number): [OutcomeRow, OutcomeRow] {
  const no = noPrice(lastPrice);
  return [
    {
      key: 'yes',
      label: copy.yes,
      percent: lastPrice,
      multiple: payoutMultiple(lastPrice),
      accessibleName: formatYesPrice(lastPrice),
      accent: 'row.first',
    },
    {
      key: 'no',
      label: copy.no,
      percent: no,
      multiple: payoutMultiple(no),
      accessibleName: formatNoPrice(lastPrice),
      accent: 'row.second',
    },
  ];
}
