import { type MarketStatusRejectReason } from '@buddha/shared';
import { copy } from '@/copy';
import { type Market, type OrderBookContract, type OrderBookLevel } from './api';

/**
 * 호가창 (#122, ADR-0138): what the detail's book section decides without React, so it can be
 * tested under node. No directive, like the other lib modules a component reads.
 *
 * It never makes a value. Every price and quantity the section draws is the public book's own
 * (`GET /markets/:id/book`, #179, ADR-0114): no ask made as `100 − bid` of the same contract, no
 * level taken from the other contract, no two contracts' quantities added, no running total and
 * no spread (N02 §5, ADR-0135 decision 1 item 17 and B6). The book already holds the converted
 * supply once per side (ADR-0114), so the screen draws it as it comes.
 */

/** The levels a side shows before 더 보기 (ADR-0135 B2; a code constant by P5). */
export const ORDER_BOOK_SHOWN_LEVELS = 5;

/** The two sides of a contract, in the order the section draws them: 매도호가 over 매수호가. */
export const BOOK_SIDES = ['asks', 'bids'] as const;
export type BookSide = (typeof BOOK_SIDES)[number];
export type BookOutcome = OrderBookContract['outcome'];
/** One side of one contract, the unit 더 보기 opens and 접기 folds (`yes-asks`). */
export type BookSideKey = `${Lowercase<BookOutcome>}-${BookSide}`;

export function bookSideKey(outcome: BookOutcome, side: BookSide): BookSideKey {
  return `${outcome === 'YES' ? 'yes' : 'no'}-${side}`;
}

/**
 * The levels a side draws: the first five while folded, all of them once its 더 보기 is pressed
 * (until its 접기). The book's order is kept — the best price first on both sides — so cutting
 * at five keeps the best.
 */
export function shownLevels(
  levels: readonly OrderBookLevel[],
  expanded: boolean,
): readonly OrderBookLevel[] {
  return expanded ? levels : levels.slice(0, ORDER_BOOK_SHOWN_LEVELS);
}

/** How many levels a folded side leaves out: what 더 보기 opens. */
export function hiddenLevelCount(levels: readonly OrderBookLevel[]): number {
  return Math.max(0, levels.length - ORDER_BOOK_SHOWN_LEVELS);
}

/**
 * The one line a book with a reason shows in place of the contracts (ADR-0135 B3). It says why
 * no order is taken in the reject reason's own name — 개장 전, 일시 중단, 마감 (docs/TERMS.md) —
 * and not the market's status label (#173): the book's reason, not the status, decides it, so a
 * market still 거래 중 past its close reads '마감' here while its badge says 거래 중. Exported for
 * the order panel (#66), which shows the same line in that window (ADR-0135 result 4). Every
 * reason has its case and none falls through: a new reason fails to compile here.
 */
export function bookReasonMessage(reason: MarketStatusRejectReason): string {
  switch (reason) {
    case 'not_open_yet':
      return copy.marketBookReasonNotOpenYet;
    case 'paused':
      return copy.marketBookReasonPaused;
    case 'closed':
      return copy.marketBookReasonClosed;
  }
}

/**
 * The accessible name of a side's 더 보기, which says whose levels it opens: 'YES 매수호가 더
 * 보기', and on an open side, where the same button folds it, 'YES 매수호가 접기'. The button's
 * visible text is `copy.marketBookShowAll` or `copy.marketBookCollapse` alone. Here rather than
 * in `copy`: copy holds strings only.
 */
export function bookMoreLabel(outcome: BookOutcome, side: BookSide, expanded: boolean): string {
  const sideName = side === 'asks' ? copy.marketBookAsks : copy.marketBookBids;
  const action = expanded ? copy.marketBookCollapse : copy.marketBookShowAll;
  return `${outcome === 'YES' ? copy.yes : copy.no} ${sideName} ${action}`;
}

/**
 * How long after `closeAt` the open detail reads its book once more. The API judges a passed close
 * on the database's clock (`marketTradingRejectReason`, ADR-0115), which the screen's server
 * anchor may run a little ahead of; a second's slack makes the read land after it.
 */
export const BOOK_CLOSE_REREAD_SLACK_MS = 1_000;

/**
 * The instant the open detail reads its book again: the close plus the slack, for an open market
 * only (ADR-0135 result 4, ADR-0114 result 5, ADR-0115 result 5). Nothing is published at
 * `close_at` itself — the worker's close sends `market:status` when it runs — so the book would
 * otherwise go on showing a market that takes no order as open. A market that is not open, or not
 * known yet, waits for nothing. A moved close (#80) is a new instant, waited for afresh.
 */
export function bookRereadAt(
  market: Pick<Market, 'status' | 'closeAt'> | undefined,
): string | null {
  if (market?.status !== 'open') return null;
  const close = Date.parse(market.closeAt);
  if (Number.isNaN(close)) return null;
  return new Date(close + BOOK_CLOSE_REREAD_SLACK_MS).toISOString();
}
