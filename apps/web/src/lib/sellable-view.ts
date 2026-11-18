import {
  type MarketStatus,
  type OrderRejectReason,
  type Outcome,
  ORDER_QTY_MAX,
  formatCoin,
  parseCoinAmount,
} from '@buddha/shared';
import { copy } from '@/copy';
import type { Sellable, SellableContract } from './api';
import { formatContracts } from './market-admin';
import { type QuoteStopReason, quoteStopReason } from './order-panel';
import { rejectReasonName, sellableLine } from './order-reasons';

/**
 * 매도 가능 and 매도 잠금 of one holding row (#67, ADR-0142; ADR-0135 결정 4 '매도 가능액', F2): the
 * sellable figures of `GET /me/markets/:id/sellable` — the unlocked holding quoted as an immediate
 * sell with 가격 보호 — read into what the row says. Pure, so the node runner tests every branch.
 * The figures are the server's and nothing here adds to them, divides them or fills one in: a
 * figure not known is a skeleton or '—', never 0.
 */

/** The account's sellable figures of the row's contract, as far as they are known. */
export type SellableReading =
  | { state: 'loading' }
  /** The read failed, or the holding and the figures disagreed again after one more read. */
  | { state: 'failed' }
  | { state: 'ready'; contract: SellableContract };

/** What the 매도 가능 cell says. */
export type SellableCell =
  /** The market is not 거래 중 or 거래 일시 중단: '마감' from its status alone (F2). */
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'failed' }
  /** A market's or an account's refusal (일시 중단, 마감 past the close, 계정 확인 중…). */
  | { kind: 'rejected'; reason: OrderRejectReason }
  /** Every contract in resting sells: '매도 가능 0계약(대기 매도 잠금 K계약)'. */
  | { kind: 'allLocked'; restingSellQty: number }
  /** The market takes no immediate order now (no 가격 보호 폭): a GTC sell still can. */
  | { kind: 'noWidth' }
  /** An immediate sell would fill nothing, for this reason. */
  | { kind: 'none'; reason: QuoteStopReason }
  /** It would fill part of the unlocked holding: N contracts for M Coin, stopped for a reason. */
  | { kind: 'partial'; qty: number; amountCoin: bigint; reason: QuoteStopReason }
  /** All of it: N contracts for M Coin. */
  | { kind: 'full'; qty: number; amountCoin: bigint };

/** The 매도 잠금 cell: resting sells' contracts, once the figures are this holding's. */
export type LockedCell = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; qty: number };

export interface SellableView {
  cell: SellableCell;
  locked: LockedCell;
  /** Over ORDER_QTY_MAX unlocked: a sell takes that many at once, and the row says so. */
  cap: boolean;
}

/** The refusals that are the walk's own, read by `quoteStopReason` rather than as a refusal. */
const WALK_REASONS: readonly OrderRejectReason[] = [
  'no_quote',
  'price_limit',
  'self_trade',
  'budget_too_small',
];

/** The statuses a holding can still be sold in, for now or after a pause. */
function trades(status: MarketStatus): boolean {
  return status === 'open' || status === 'paused';
}

/**
 * The row's 매도 가능 and 매도 잠금, in this order:
 * 1. a market not 거래 중 or 일시 중단 is '마감', from its status alone (F2);
 * 2. the figures loading are a skeleton, failed '—' (and a retry);
 * 3. figures for another quantity than the row's are one of the two answers behind the other —
 *    a skeleton until they agree (the caller reads both again once, then says failed);
 * 4. 일시 중단, or a quote refused for the market or the account, is that refusal's name;
 * 5. nothing unlocked is '매도 가능 0계약(대기 매도 잠금 K계약)' — an OPEN market past its close
 *    the worker has not closed yet comes here too, its quote being null, and the lock is real;
 * 6. no quote with something unlocked is a market with no 가격 보호 폭: 즉시 거래 is off, 지정가 on;
 * 7. a quote filling nothing says why (`quoteStopReason`) — 호가 없음, 가격 한도, 자기 체결;
 * 8. one filling part is '일부 수량만 가능' with its figures and its stop;
 * 9. the rest is all of it.
 * The lock follows 2·3 and is shown in every status: a market closed while held by a ledger
 * failure keeps its resting sells locked (market-close.ts).
 */
export function sellableView(facts: {
  marketStatus: MarketStatus;
  position: { qty: number };
  sellable: SellableReading;
}): SellableView {
  const { sellable } = facts;
  const agrees = sellable.state === 'ready' && sellable.contract.qty === facts.position.qty;
  const locked: LockedCell =
    sellable.state === 'failed'
      ? { kind: 'failed' }
      : agrees
        ? { kind: 'ready', qty: sellable.contract.restingSellQty }
        : { kind: 'loading' };
  const unlockedQty = agrees ? sellable.contract.unlockedQty : 0;
  const cap = unlockedQty > ORDER_QTY_MAX;
  const view = (cell: SellableCell): SellableView => ({ cell, locked, cap });
  if (!trades(facts.marketStatus)) return { cell: { kind: 'closed' }, locked, cap: false };
  if (sellable.state === 'loading') return view({ kind: 'loading' });
  if (sellable.state === 'failed') return view({ kind: 'failed' });
  if (!agrees) return view({ kind: 'loading' });
  const { contract } = sellable;
  const { quote } = contract;
  if (facts.marketStatus === 'paused') return view({ kind: 'rejected', reason: 'paused' });
  if (quote !== null && quote.rejectReason !== null && !WALK_REASONS.includes(quote.rejectReason)) {
    return view({ kind: 'rejected', reason: quote.rejectReason });
  }
  if (contract.unlockedQty === 0) {
    return view({ kind: 'allLocked', restingSellQty: contract.restingSellQty });
  }
  if (quote === null) return view({ kind: 'noWidth' });
  if (quote.filledQty === 0) return view({ kind: 'none', reason: quoteStopReason(quote) });
  const amountCoin = parseCoinAmount(quote.filledAmountCoin);
  if (quote.filledQty < contract.unlockedQty) {
    return view({
      kind: 'partial',
      qty: quote.filledQty,
      amountCoin,
      reason: quoteStopReason(quote),
    });
  }
  return view({ kind: 'full', qty: quote.filledQty, amountCoin });
}

/** A walk's stop as the cell's main line, when it filled nothing (7). */
function noneText(reason: QuoteStopReason): string {
  switch (reason) {
    case 'no_quote':
      return copy.marketBookEmpty;
    case 'price_limit':
      return copy.orderRejectNamePriceLimit;
    case 'self_trade':
      return copy.orderRejectNameSelfTrade;
  }
}

/** A walk's stop as the small line under '일부 수량만 가능' (8): 호가 부족, 가격 한도, 자기 체결. */
function partialReasonText(reason: QuoteStopReason): string {
  switch (reason) {
    case 'no_quote':
      return copy.orderRejectNameNoQuote;
    case 'price_limit':
      return copy.orderRejectNamePriceLimit;
    case 'self_trade':
      return copy.orderRejectNameSelfTrade;
  }
}

/** 'N계약 · M Coin'. */
function figures(qty: number, amountCoin: bigint): string {
  return `${formatContracts(qty)} · ${formatCoin(amountCoin)}`;
}

/**
 * The cell's words: its line and, for '일부 수량만 가능', the stop's under it. Null for a skeleton
 * or a failure, which the row draws as such.
 */
export function sellableCellText(cell: SellableCell): { line: string; reason?: string } | null {
  switch (cell.kind) {
    case 'loading':
    case 'failed':
      return null;
    case 'closed':
      return { line: rejectReasonName('closed') };
    case 'rejected':
      return { line: rejectReasonName(cell.reason) };
    case 'allLocked':
      return { line: sellableLine(0, cell.restingSellQty) };
    case 'noWidth':
      return { line: copy.orderBlockNoWidth };
    case 'none':
      return { line: noneText(cell.reason) };
    case 'partial':
      return {
        line: `${copy.positionSellablePartial} · ${figures(cell.qty, cell.amountCoin)}`,
        reason: partialReasonText(cell.reason),
      };
    case 'full':
      return { line: figures(cell.qty, cell.amountCoin) };
  }
}

/** Why a holding's '매도' is off, or that it is on, or that the row has none (ADR-0142). */
export type SellEntry =
  | { kind: 'on' }
  /** D13 (관리자·계정 제한), or the account not judged yet: the values stay, the button is off. */
  | { kind: 'account' }
  /**
   * The market is not 거래 중 — 일시 중단 included, which has no order area (ADR-0135 D1): the
   * row's own 매도 가능 cell ('마감', '일시 중단') says why.
   */
  | { kind: 'market' }
  /** Nothing held (the detail's sold-out contract): no button at all. */
  | { kind: 'none' };

/**
 * The '매도' of a holding row: none for nothing held; off while the account is not known or may
 * not order (D13 — the line above the list says why) and while the market is not 거래 중: a paused
 * one has no order area to open (ADR-0135 D1), though its 매도 가능 cell still reads as paused. On
 * otherwise, all-locked and no-width holdings included — the panel says what is possible and the
 * server decides (ADR-0142).
 */
export function sellEntryOf(facts: {
  qty: number;
  marketStatus: MarketStatus;
  account: 'admin' | 'restricted' | null;
  accountKnown: boolean;
}): SellEntry {
  if (facts.qty < 1) return { kind: 'none' };
  if (!facts.accountKnown || facts.account !== null) return { kind: 'account' };
  if (facts.marketStatus !== 'open') return { kind: 'market' };
  return { kind: 'on' };
}

/** What a holdings screen knows of a read: the market's sellable, or the holdings list. */
export interface ReadFacts {
  isFetching: boolean;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
}

/** A market's sellable read as the screen holds it (`useQueries`' answer satisfies it). */
export interface SellableRead extends ReadFacts {
  data: Sellable | undefined;
  isError: boolean;
}

/** A pair of answers that disagreed with both reads settled, and when each had answered then. */
export interface SellableRetry {
  key: string;
  marketId: string;
  sellableAt: number;
  positionsAt: number;
}

/** One disagreement: the contract and the two quantities, the row's and the figures'. */
function pairKey(marketId: string, outcome: Outcome, qty: number, sellableQty: number): string {
  return `${marketId.toLowerCase()}:${outcome}:${String(qty)}:${String(sellableQty)}`;
}

function lastAnswer(read: ReadFacts): number {
  return Math.max(read.dataUpdatedAt, read.errorUpdatedAt);
}

/**
 * The disagreements to read once more now (ADR-0142 결정 2-7 (3), M2): a row whose sellable
 * figures carry another quantity, with both reads settled, and not read again for that pair of
 * quantities before — once per pair, so two answers that keep disagreeing are read once.
 */
export function sellableRetriesDue(facts: {
  positions: readonly { marketId: string; outcome: Outcome; qty: number }[];
  sellableOf: (marketId: string) => SellableRead | undefined;
  list: ReadFacts;
  retries: readonly SellableRetry[];
}): SellableRetry[] {
  const due: SellableRetry[] = [];
  for (const position of facts.positions) {
    const read = facts.sellableOf(position.marketId.toLowerCase());
    const contract = read?.data?.contracts.find((c) => c.outcome === position.outcome);
    if (read === undefined || contract === undefined || contract.qty === position.qty) continue;
    if (read.isFetching || facts.list.isFetching) continue;
    const key = pairKey(position.marketId, position.outcome, position.qty, contract.qty);
    if (facts.retries.some((r) => r.key === key) || due.some((r) => r.key === key)) continue;
    due.push({
      key,
      marketId: position.marketId.toLowerCase(),
      sellableAt: lastAnswer(read),
      positionsAt: lastAnswer(facts.list),
    });
  }
  return due;
}

/**
 * One row's sellable figures as far as they are known: loading until read; failed for a failed
 * read or a contract the answer lacks; ready when the quantities agree. While they disagree it is
 * loading, and failed once the pair's one more read has answered on both sides and they still do.
 *
 * A failed REFETCH is failed too, though the query keeps its last answer (`isError` with `data`):
 * a bid withdrawn or a resting sell cancelled leaves the holding's quantity as it was, so the old
 * answer would still agree and be drawn as current — proceeds or a 매도 잠금 that are gone. The
 * cell says '—' with its 다시 시도 instead, as for a first read that failed (ADR-0142 결정 2-7 (2)).
 */
export function sellableReadingOf(facts: {
  read: SellableRead | undefined;
  list: ReadFacts;
  retries: readonly SellableRetry[];
  marketId: string;
  outcome: Outcome;
  qty: number;
}): SellableReading {
  const { read, list } = facts;
  if (read === undefined) return { state: 'loading' };
  // Before the answer is looked at: a failed refetch keeps `data`, and it is not current.
  if (read.isError) return { state: 'failed' };
  if (read.data === undefined) return { state: 'loading' };
  const contract = read.data.contracts.find((c) => c.outcome === facts.outcome);
  if (contract === undefined) return { state: 'failed' };
  if (contract.qty === facts.qty) return { state: 'ready', contract };
  const key = pairKey(facts.marketId, facts.outcome, facts.qty, contract.qty);
  const retry = facts.retries.find((r) => r.key === key);
  const settled = !read.isFetching && !list.isFetching;
  const reread =
    retry !== undefined &&
    lastAnswer(read) > retry.sellableAt &&
    lastAnswer(list) > retry.positionsAt;
  return settled && reread ? { state: 'failed' } : { state: 'loading' };
}

/** The order column's D13 line (order-panel.tsx `accountLineId('column')`). */
export const PANEL_ACCOUNT_LINE_ID = 'order-account-blocked-column';

/** The detail's 내 포지션's own D13 line, where the column's is not drawn. */
export const POSITION_ACCOUNT_LINE_ID = 'market-position-account-blocked';

/**
 * What the detail's 내 포지션 points a D13 '매도' at (ADR-0135 D13 '까닭 한 줄'): the order column's
 * account line where that column is drawn — md and up, on a market with an order area — else a
 * line of the card's own, which it then draws: below md the sheet is shut, and a market with no
 * order area has no column. Nothing for an account that may order.
 */
export function positionAccountLine(facts: {
  account: 'admin' | 'restricted' | null;
  orderArea: boolean;
  mdUp: boolean | null;
}): { ownLine: boolean; describedBy: string | undefined } {
  if (facts.account === null) return { ownLine: false, describedBy: undefined };
  if (facts.orderArea && facts.mdUp === true) {
    return { ownLine: false, describedBy: PANEL_ACCOUNT_LINE_ID };
  }
  return { ownLine: true, describedBy: POSITION_ACCOUNT_LINE_ID };
}

/** '한 번에 1,000,000계약까지 팔 수 있습니다' (ADR-0135 결과 4: not split). */
export function sellCapText(): string {
  const most = formatContracts(ORDER_QTY_MAX);
  return `${copy.positionSellCapBefore} ${most}${copy.positionSellCapAfter}`;
}
