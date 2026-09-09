import { type PAmount, serializePAmount } from './api/p-amount.js';
import { BP_MAX, MAX_P_AMOUNT } from './constants.js';
import { type OrderSide } from './enums.js';

/**
 * How far the amount recomputed under the market lock may move from the quote the client
 * showed (PLAN 5.3's mandatory guard; apps/api/src/trades/trade.service.ts compares
 * quote.amountP against maxCostP / minProceedsP after `assertTradable`).
 *
 * Fixed, not user-adjustable: PLAN 11.1-3 keeps the panel to two buttons and an amount, and
 * a slippage control is orderbook vocabulary a single-writer AMM under
 * pg_advisory_xact_lock has no referent for — no MEV, no partial fills, no routing. The
 * effect is disclosed instead: the summary's last line renders the absolute guard.
 * Zero tolerance would answer PRICE_MOVED to every trade another account beat to the lock.
 */
export const TRADE_SLIPPAGE_BP = 100; // 1%
export const TRADE_SLIPPAGE_MIN_P = 1n; // a 40P quote must still tolerate 1P

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * The guard field for a trade of the quoted `amountP`. `budgetP` is a spend-mode buy's own
 * typed value: the cap the user authored is never exceeded, so "never charge me more than
 * the number I typed" holds exactly.
 *
 * The headroom is symmetric — `max(TRADE_SLIPPAGE_MIN_P, ceil(amountP · bp / BP_MAX))` on
 * both sides. Floor division on the sell side would give a 40P quote zero tolerance and
 * thrash every cheap sell into PRICE_MOVED.
 *
 * Output is the WIRE type (decimal string) — the body sent to POST /trades is
 * `components['schemas']['TradeBody']`, never `z.infer` of tradeBodySchema, whose `maxCostP`
 * is a bigint after pAmountInputSchema's transform and would throw in JSON.stringify.
 */
export function slippageGuard(
  side: OrderSide,
  amountP: bigint,
  budgetP?: bigint,
): { maxCostP: PAmount } | { minProceedsP: PAmount } {
  const headroomRaw = ceilDiv(amountP * BigInt(TRADE_SLIPPAGE_BP), BigInt(BP_MAX));
  const headroom = headroomRaw > TRADE_SLIPPAGE_MIN_P ? headroomRaw : TRADE_SLIPPAGE_MIN_P;
  if (side === 'buy') {
    let ceiling = amountP + headroom;
    if (budgetP !== undefined && budgetP < ceiling) ceiling = budgetP;
    if (ceiling < 1n) ceiling = 1n; // boundedPAmount(1n) on tradeBodySchema
    if (ceiling > MAX_P_AMOUNT) ceiling = MAX_P_AMOUNT;
    return { maxCostP: serializePAmount(ceiling) };
  }
  const floor = amountP > headroom ? amountP - headroom : 0n; // boundedPAmount(0n)
  return { minProceedsP: serializePAmount(floor) };
}
