import {
  CONTRACT_TERMS,
  type Outcome,
  formatCoin,
  isLiveOrderStatus,
  orderRemainingLock,
  parseCoinAmount,
} from '@buddha/shared';
import { copy } from '@/copy';
import { orderAveragePriceBp } from '@/hooks/use-portfolio';
import { type Order, type PlaceOrderBody } from './api';
import { formatContracts, formatPricePerContract } from './market-admin';
import { type FrozenQuote } from './order-panel';

/**
 * 확인 화면 (#66, ADR-0140 결정 2-8): the rows of a frozen quote, every one of them
 * open — none folded (N02 §4) — and every number from the quote's own fields, `CONTRACT_TERMS`, the
 * average and a plain product. Nothing here walks the book, divides a budget by a price, makes a
 * price as 100 − another, computes a fee or a balance after the order. Coin is bigint.
 */

/** A whole-Coin contract price as the book and 확인 write it: 63 → '63.00 Coin'. */
export function formatContractPrice(priceCoin: number): string {
  return formatPricePerContract(priceCoin * 100);
}

/** The row ids, which the panel turns into `order-review-<id>` test ids. */
export type ConfirmRowId =
  | 'contract'
  | 'kind'
  | 'size'
  | 'limit'
  | 'filled'
  | 'immediate'
  | 'resting'
  | 'avg'
  | 'pay'
  | 'unspent'
  | 'pay-full'
  | 'max-spend'
  | 'min-receive'
  | 'fee'
  | 'payout-win'
  | 'net'
  | 'payout-lose'
  | 'payout-void'
  | 'unfilled';

export interface ConfirmRow {
  id: ConfirmRowId;
  label: string;
  value: string;
}

/** The contract and the direction as the panel names them: 'YES 매수'. */
export function contractSideLabel(outcome: Outcome, side: 'buy' | 'sell'): string {
  return `${outcome === 'YES' ? copy.yes : copy.no} ${side === 'buy' ? copy.buy : copy.sell}`;
}

export function kindLabel(kind: 'ioc' | 'gtc'): string {
  return kind === 'ioc' ? copy.orderKindIoc : copy.orderKindGtc;
}

/** 평균가 of `filledAmount` over `filledQty`, to 0.01 Coin (MY's rounding), or '—' with no fill. */
export function averagePriceText(fill: { filledQty: number; filledAmountCoin: string }): string {
  const bp = orderAveragePriceBp(fill);
  return bp === undefined ? copy.orderNone : formatPricePerContract(bp);
}

/** '계약당 50 Coin(합계 100 Coin)': VOID's payout per contract and on `qty` contracts (D5). */
export function voidPayoutLine(outcome: Outcome, qty: number): string {
  const each =
    outcome === 'YES' ? CONTRACT_TERMS.voidPayoutYesCoin : CONTRACT_TERMS.voidPayoutNoCoin;
  return `${copy.orderPerContract} ${formatCoin(each)}(${copy.orderTotal} ${formatCoin(
    BigInt(each) * BigInt(qty),
  )})`;
}

/**
 * Every row 확인 shows for a frozen quote, in order. An immediate buy counts 정답 시 총지급, 순이익
 * and the VOID total on the expected fill (owner answer 66-Q1: what is left is cancelled, and the
 * 미체결 row says so); a GTC buy counts them on the whole quantity (D6), its 순이익 against what the
 * whole would cost — the immediate part at its prices, the resting part at the limit, where it
 * fills. A GTC sell adds 최소 수령 (limit × quantity); an immediate one has none — an IOC may fill
 * less than quoted, so no such figure is a floor. A sell has no 손익 or VOID row (D10, D5).
 */
export function confirmRows(frozen: Pick<FrozenQuote, 'terms' | 'quote'>): ConfirmRow[] {
  const { terms, quote } = frozen;
  const buy = terms.side === 'buy';
  const gtc = terms.timeInForce === 'gtc';
  const rows: ConfirmRow[] = [
    {
      id: 'contract',
      label: copy.orderContract,
      value: contractSideLabel(terms.outcome, terms.side),
    },
    { id: 'kind', label: copy.orderKind, value: kindLabel(terms.timeInForce) },
  ];
  rows.push(
    terms.budgetCoin === undefined
      ? { id: 'size', label: copy.orderQty, value: formatContracts(terms.qty ?? 0) }
      : {
          id: 'size',
          label: copy.orderBudget,
          value: formatCoin(parseCoinAmount(terms.budgetCoin)),
        },
  );
  // The limit 확인 shows is the one the order sends (`placeBodyOf`): the same field.
  rows.push({
    id: 'limit',
    label: gtc ? copy.orderLimit : buy ? copy.orderMaxBuyPrice : copy.orderMinSellPrice,
    value: formatContractPrice(quote.protectedLimitPriceCoin),
  });
  const filledAmount = parseCoinAmount(quote.filledAmountCoin);
  if (gtc) {
    rows.push(
      {
        id: 'immediate',
        label: copy.orderImmediate,
        value: formatContracts(quote.filledQty),
      },
      { id: 'resting', label: copy.orderResting, value: formatContracts(quote.remainingQty ?? 0) },
    );
  } else {
    rows.push({ id: 'filled', label: copy.orderFilled, value: formatContracts(quote.filledQty) });
  }
  // A GTC's payment or receipt is only the part that fills now: its name says so, beside 지금 체결
  // 예상 (ADR-0140 결정 2-23). The whole is 전량 체결 시 예상 지불 or 최소 수령 below.
  const payLabel = gtc
    ? buy
      ? copy.orderPayImmediate
      : copy.orderReceiveImmediate
    : buy
      ? copy.orderPay
      : copy.orderReceive;
  rows.push(
    { id: 'avg', label: copy.orderAvgPrice, value: averagePriceText(quote) },
    { id: 'pay', label: payLabel, value: formatCoin(filledAmount) },
  );
  if (quote.unspentCoin !== null) {
    rows.push({
      id: 'unspent',
      label: copy.orderUnspent,
      value: formatCoin(parseCoinAmount(quote.unspentCoin)),
    });
  }
  const qty = terms.qty ?? 0;
  const payFull =
    gtc && buy
      ? filledAmount + BigInt(quote.remainingQty ?? 0) * BigInt(quote.protectedLimitPriceCoin)
      : filledAmount;
  if (gtc && buy) {
    rows.push({ id: 'pay-full', label: copy.orderPayFull, value: formatCoin(payFull) });
  }
  if (buy && quote.maxSpendCoin !== null) {
    rows.push({
      id: 'max-spend',
      label: copy.orderMaxSpend,
      value: formatCoin(parseCoinAmount(quote.maxSpendCoin)),
    });
  }
  if (gtc && !buy) {
    rows.push({
      id: 'min-receive',
      label: copy.orderMinReceive,
      value: formatCoin(BigInt(quote.protectedLimitPriceCoin) * BigInt(qty)),
    });
  }
  rows.push({ id: 'fee', label: copy.orderFee, value: formatCoin(parseCoinAmount(quote.feeCoin)) });
  if (buy) {
    const basis = gtc ? qty : quote.filledQty;
    const win = BigInt(CONTRACT_TERMS.payoutCoin) * BigInt(basis);
    rows.push(
      { id: 'payout-win', label: copy.orderPayoutWin, value: formatCoin(win) },
      { id: 'net', label: copy.orderNet, value: formatCoin(win - payFull) },
      { id: 'payout-lose', label: copy.orderPayoutLose, value: formatCoin(0) },
      {
        id: 'payout-void',
        label: copy.orderPayoutVoid,
        value: voidPayoutLine(terms.outcome, basis),
      },
    );
  }
  rows.push({
    id: 'unfilled',
    label: copy.orderUnfilled,
    value: gtc ? copy.orderUnfilledGtc : copy.orderUnfilledIoc,
  });
  return rows;
}

/**
 * What 입력 shows of a quote before 확인 (ADR-0140 결정 2-8; N01 §8): the limit, the expected
 * fill — or a GTC's 지금 체결 예상 and 대기 — the average, the expected payment or receipt and a
 * buy's 최대 지출. The same rows as 확인's, so the two can never word one quote apart. A GTC's
 * 한도가격 is left out here: it is the field right above, typed (결정 2-23); 확인 keeps it. An
 * immediate order's limit is the 최대 매수 단가 or 최소 매도 단가 the market narrowed, no field's.
 */
const QUOTE_ROW_IDS: ReadonlySet<ConfirmRowId> = new Set([
  'limit',
  'filled',
  'immediate',
  'resting',
  'avg',
  'pay',
  'unspent',
  'max-spend',
]);

export function quoteRows(quoted: Pick<FrozenQuote, 'terms' | 'quote'>): ConfirmRow[] {
  const gtc = quoted.terms.timeInForce === 'gtc';
  return confirmRows(quoted).filter(
    (row) => QUOTE_ROW_IDS.has(row.id) && !(gtc && row.id === 'limit'),
  );
}

/** A figure and its unit as one word: '65.00 Coin' never wraps between the two (결정 2-24). */
export function unbroken(figure: string): string {
  return figure.replaceAll(' ', '\u00a0');
}

/**
 * A sent request's terms on one line, as 확인 named them — 'YES 매수 · 지정가 · 3계약 · 한도가격
 * 70.00 Coin' — for 접수 중 and the read-back, which show no rows (ADR-0140 결정 2-23). Each
 * figure keeps its unit on its line (a no-break space, 결정 2-24); the line breaks between terms.
 */
export function requestSummary(body: PlaceOrderBody): string {
  const limitLabel =
    body.timeInForce === 'gtc'
      ? copy.orderLimit
      : body.side === 'buy'
        ? copy.orderMaxBuyPrice
        : copy.orderMinSellPrice;
  const size =
    body.budgetCoin === undefined
      ? formatContracts(body.qty ?? 0)
      : `${copy.orderBudget} ${unbroken(formatCoin(parseCoinAmount(body.budgetCoin)))}`;
  return [
    contractSideLabel(body.outcome, body.side),
    kindLabel(body.timeInForce),
    size,
    `${limitLabel} ${unbroken(formatContractPrice(body.limitPriceCoin))}`,
  ].join(' · ');
}

/**
 * The lines under the rows: '현재 호가 기준 예상입니다' always (N02 §6) and a budget's '입력한 금액을
 * 다 쓰지 않을 수 있습니다'. D8 is its own line, drawn as a warning (`immediateFillNotice`).
 */
export function confirmNotes(frozen: Pick<FrozenQuote, 'terms'>): string[] {
  const notes: string[] = [copy.orderQuoteNotice];
  if (frozen.terms.budgetCoin !== undefined) notes.push(copy.orderBudgetNotice);
  return notes;
}

/** D8: a GTC whose limit crosses the opposite book fills that part at once. Null otherwise. */
export function immediateFillNotice(frozen: Pick<FrozenQuote, 'terms' | 'quote'>): string | null {
  if (frozen.terms.timeInForce !== 'gtc' || frozen.quote.filledQty === 0) return null;
  return `${copy.orderImmediateNoticeHead} ${formatContracts(frozen.quote.filledQty)}${copy.orderImmediateNoticeTail}`;
}

/** The row ids of a result card. */
export type ResultRowId =
  'filled-qty' | 'filled-amount' | 'avg' | 'cancelled' | 'limit' | 'resting' | 'locked' | 'unspent';

export interface ResultRow {
  id: ResultRowId;
  label: string;
  value: string;
}

/**
 * 결과 카드 (결정 2-10): the server's order as it stands — filled quantity, Coin and average, the
 * cancelled quantity (`cancelledQty`: a cancelled or expired quantity order's rest, 0 otherwise),
 * the resting quantity only while it rests (open or partly filled, a quantity order), and a
 * budget order's Coin given back only after a fill (a refused budget order gives back all of it,
 * which is no 'unspent' of a trade).
 */
export function resultRows(order: Order): ResultRow[] {
  const rows: ResultRow[] = [
    { id: 'filled-qty', label: copy.orderFilledQty, value: formatContracts(order.filledQty) },
    {
      id: 'filled-amount',
      label: order.side === 'buy' ? copy.orderFilledPaid : copy.orderFilledReceived,
      value: formatCoin(parseCoinAmount(order.filledAmountCoin)),
    },
    { id: 'avg', label: copy.orderAvgPrice, value: averagePriceText(order) },
  ];
  if (order.cancelledQty > 0) {
    rows.push({
      id: 'cancelled',
      label: copy.orderCancelledQty,
      value: formatContracts(order.cancelledQty),
    });
  }
  const resting = order.status === 'open' || order.status === 'partially_filled';
  if (resting && order.qty !== null) {
    // What rests: at which limit, how much, and what it still holds locked — limit × the resting
    // quantity in Coin for a buy, the resting contracts for a sell (`orderRemainingLock`, the rule
    // the server locks by; ADR-0140 결정 2-23). The header's 가용 코인 moved by that much.
    const lock = orderRemainingLock({
      side: order.side,
      outcome: order.outcome,
      limitPriceCoin: order.side === 'buy' ? order.protectedLimitPriceCoin : null,
      qty: order.qty,
      filledQty: order.filledQty,
      budgetCoin: null,
      live: isLiveOrderStatus(order.status),
    });
    rows.push(
      {
        id: 'limit',
        label: copy.orderLimit,
        value: formatContractPrice(order.protectedLimitPriceCoin),
      },
      {
        id: 'resting',
        label: copy.orderRestingQty,
        value: formatContracts(order.qty - order.filledQty),
      },
      lock.kind === 'coin'
        ? { id: 'locked', label: copy.walletLocked, value: formatCoin(lock.amountCoin) }
        : { id: 'locked', label: copy.orderRestingSellLock, value: formatContracts(lock.qty) },
    );
  }
  if (order.unspentCoin !== null && order.filledQty > 0) {
    rows.push({
      id: 'unspent',
      label: copy.orderUnspentReleased,
      value: formatCoin(parseCoinAmount(order.unspentCoin)),
    });
  }
  return rows;
}

/**
 * 잔액 부족's 필요 M Coin, from the server's row: the lock the intake asked for — the budget, or
 * the narrowed limit × quantity it locks with (`orders.ts`). Never a figure of the quote.
 */
export function neededCoinOf(
  order: Pick<Order, 'budgetCoin' | 'qty' | 'protectedLimitPriceCoin'>,
): bigint {
  if (order.budgetCoin !== null) return parseCoinAmount(order.budgetCoin);
  return BigInt(order.protectedLimitPriceCoin) * BigInt(order.qty ?? 0);
}
