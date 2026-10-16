import { copy } from '@/copy';
import { type MarketSummary } from './api';
import { formatNoPrice, formatYesPrice } from './market-admin';

/**
 * The arithmetic behind the card's two outcome rows (ADR-0041's Kalshi tile, PLAN 11.1-1): the
 * percentage each row shows and the words a screen reader hears for it — and the footer's 참여자
 * line beside them. Pure functions of the row, so a node test pins the text and the component
 * only lays it out. A market with no fill has no `lastPrice`, so its two rows keep their labels
 * and carry no reading: the card prints '—' in the pills and says 체결 없음 once beside them (N02
 * §5, owner decision #125 in ADR-0048). No initial setting stands in for a price.
 *
 * Nothing here is domain maths in PLAN 11.5's sense: `lastPrice` is the last fill's price as the
 * API sends it (1..99, `priceSchema`), and the two rows are that number and its complement. The
 * NO row is a display complement (ADR-0061 decision 1, item 2): YES and NO on one card add up
 * to 100, while what a NO contract costs is what the order book offers, never this. The card
 * once printed Kalshi's payout multiple ("1.59x") beside each row; it no longer does (O-21 in
 * ADR-0047, ADR-0062).
 */

/** One of the tile's two rows: YES first, NO second, as `outcomeRows` orders them. */
export interface OutcomeRow {
  key: 'yes' | 'no';
  /** The visible label, `copy.yes` / `copy.no`: the words that carry the meaning (PLAN 11.2). */
  label: string;
  /**
   * The bar's colour token. `row.first`/`row.second` (Kalshi's green and blue pair) rather than
   * the `yes`/`no` palettes: theme/system.ts says why — the label beside it carries the meaning,
   * and the pair is what Kalshi draws on every tile.
   */
  accent: 'row.first' | 'row.second';
  /** What the row reads at the last fill's price, or `null` before the first fill (N02 §5). */
  reading: OutcomeReading | null;
}

/** A row's reading, both halves from the same `lastPrice`. */
export interface OutcomeReading {
  /** The whole-percent reading the pill shows: `lastPrice` for YES, its complement for NO. */
  percent: number;
  /**
   * `formatYesPrice` / `formatNoPrice` — "YES 63%" / "NO 37%": the bar's `aria-label`, so the
   * row is read by its reading and not by the bare "63%" the pill paints.
   */
  accessibleName: string;
}

/**
 * The NO side of a reading, the complement of the same `lastPrice`, for the reason
 * `formatNoPrice` gives: YES and NO on one card always add up to 100.
 */
export function noPrice(lastPrice: number): number {
  return 100 - lastPrice;
}

/**
 * The two rows in the order the tile draws them: YES (green, first) then NO (blue, second).
 * `null` — no fill yet — gives the same two rows with no reading, never a made-up one.
 */
export function outcomeRows(lastPrice: number | null): [OutcomeRow, OutcomeRow] {
  return [
    {
      key: 'yes',
      label: copy.yes,
      accent: 'row.first',
      reading: lastPrice === null ? null : readingOf(lastPrice, formatYesPrice(lastPrice)),
    },
    {
      key: 'no',
      label: copy.no,
      accent: 'row.second',
      reading: lastPrice === null ? null : readingOf(noPrice(lastPrice), formatNoPrice(lastPrice)),
    },
  ];
}

function readingOf(percent: number, accessibleName: string): OutcomeReading {
  return { percent, accessibleName };
}

/**
 * The footer's '참여자 N' (ADR-0062): `traderCount`, the market's participants — never
 * `tradeCount`, the number of fills, which the same `MarketSummary` carries and which is 0
 * alongside it on every market that has not traded. A 0 is written as 0, not hidden (ADR-0061
 * decision 1, item 4). The spelling is the detail header's (market-detail.tsx): the count as
 * `String` writes it, not through `toLocaleString`, so the server's ICU data and the browser's
 * never have to agree on the string.
 */
export function participantsText(market: Pick<MarketSummary, 'traderCount'>): string {
  return `${copy.marketTraders} ${String(market.traderCount)}`;
}
