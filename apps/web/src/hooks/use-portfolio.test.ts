import {
  MARKET_STATUSES,
  MAX_COIN_AMOUNT,
  MINUS_SIGN,
  POSITION_QTY_MAX,
  PRICE_MAX,
  PRICE_MIN,
  formatCoin,
  parseCoinAmount,
  serializeCoinAmount,
} from '@buddha/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { type Order, type Position } from '@/lib/api';
import { ORDERS_KEY, POSITIONS_KEY } from '@/lib/market-keys';
import { applyPositionEvent } from '@/lib/market-live';
import { positionFixture } from '@/test/positions';
import {
  type LiveMarketReading,
  type OrdersPage,
  averageCostBp,
  combinedListState,
  dedupeAcrossLists,
  heldGroups,
  holdingDisplay,
  listState,
  liveMarketStatus,
  markPriceCoin,
  priceIsStale,
  markToLiveMarket,
  orderAveragePriceBp,
  ordersInfiniteQueryOptions,
  portfolioTotals,
  positionListStatusFor,
  positionValueCoin,
  positionsKey,
  positionsQueryOptions,
  realizedPnlAcross,
  realizedPnlState,
  unrealizedPnlCoin,
} from './use-portfolio';

/** Whatever better-auth hands back; only "is it there" is read. */
const SESSION = { user: { id: 'a1e1c0de-0000-4000-8000-000000000001' } };
/** The account MY shows (`Me`'s id), which keys its holdings (#67, ADR-0142). */
const ACCOUNT = 'a1e1c0de-0000-4000-8000-000000000001';

const position = positionFixture;

function order(id: string, overrides: Partial<Order> = {}): Order {
  return {
    id,
    requestId: `request-${id}`,
    marketId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    marketSlug: 'rate-cut-2026',
    marketTitle: '기준금리 인하?',
    outcome: 'YES',
    side: 'buy',
    timeInForce: 'ioc',
    limitPriceCoin: 65,
    protectedLimitPriceCoin: 65,
    qty: 10,
    budgetCoin: null,
    filledQty: 10,
    filledAmountCoin: '630',
    cancelledQty: 0,
    unspentCoin: null,
    status: 'filled',
    rejectReason: null,
    cancelReason: null,
    createdAt: '2026-09-07T00:00:00.000Z',
    endedAt: '2026-09-07T00:00:00.000Z',
    awaitingRecovery: false,
    ...overrides,
  };
}

/** A figure the test KNOWS is priced; `undefined` (체결 없음) here is a failure, not a value. */
function priced(value: bigint | undefined): bigint {
  if (value === undefined) throw new Error('expected a priced figure');
  return value;
}

describe('orderAveragePriceBp', () => {
  it("averages the order's fills at its own side's prices, half-up, and has none before a fill", () => {
    // #119: `filledAmountCoin` is Σ price × qty over the order's fills, so 10 at 63 is 63.00 Coin.
    expect(orderAveragePriceBp(order('o1'))).toBe(6300);
    // 2 at 60 and 1 at 61: 181 / 3 = 60.333… → 60.33 Coin.
    expect(orderAveragePriceBp({ filledQty: 3, filledAmountCoin: '181' })).toBe(6033);
    // 1 at 60 and 2 at 61: 182 / 3 = 60.666… → 60.67 Coin, rounded up.
    expect(orderAveragePriceBp({ filledQty: 3, filledAmountCoin: '182' })).toBe(6067);
    // A refused, resting or unfilled order: a dash, not a division by zero.
    const rejected = order('o2', {
      status: 'rejected',
      rejectReason: 'no_quote',
      filledQty: 0,
      filledAmountCoin: '0',
    });
    expect(orderAveragePriceBp(rejected)).toBeUndefined();
  });
});

describe('markPriceCoin / positionValueCoin / unrealizedPnlCoin', () => {
  it('values a YES holding at the market price and a NO holding at its complement', () => {
    // The bug this pins is silent: `qty × marketLastPrice` for a NO row produces a plausible
    // number that is wrong by 100 − 2·price per contract, and the screen has nothing to
    // compare it against. `marketLastPrice` is the YES price, so the NO side is 100 − 63 = 37
    // — the same complement `formatNoPrice` prints under "NO 37%".
    const yes = position({ outcome: 'YES', marketLastPrice: 63, costBasisCoin: '5000' });
    const no = position({ outcome: 'NO', marketLastPrice: 63, costBasisCoin: '5000' });

    expect(markPriceCoin(yes)).toBe(63n);
    expect(markPriceCoin(no)).toBe(37n);
    expect(positionValueCoin(yes)).toBe(6300n);
    expect(positionValueCoin(no)).toBe(3700n);
    expect(unrealizedPnlCoin(yes)).toBe(1300n);
    expect(unrealizedPnlCoin(no)).toBe(-1300n);
    // Both sides of the same market add up to the 100 Coin a winning contract pays.
    expect(priced(markPriceCoin(yes)) + priced(markPriceCoin(no))).toBe(100n);
  });

  it('holds at both ends of the displayed price range', () => {
    // `priceOf` clamps to 1..99, so the two sides of a market at the floor are 1 Coin and 99 Coin.
    const yesAtFloor = position({ outcome: 'YES', marketLastPrice: PRICE_MIN, qty: 10 });
    const noAtFloor = position({ outcome: 'NO', marketLastPrice: PRICE_MIN, qty: 10 });

    expect(positionValueCoin(yesAtFloor)).toBe(10n);
    expect(positionValueCoin(noAtFloor)).toBe(990n);
    expect(markPriceCoin(position({ outcome: 'YES', marketLastPrice: PRICE_MAX }))).toBe(99n);
    expect(markPriceCoin(position({ outcome: 'NO', marketLastPrice: PRICE_MAX }))).toBe(1n);
  });

  it('values a fully sold row at zero and keeps its cost off the books', () => {
    // `applySell` leaves the row at qty 0 with costBasis 0 so its realised PnL stays visible;
    // it must not still be marked to market.
    const sold = position({ qty: 0, costBasisCoin: '0', realizedPnlCoin: '1200' });

    expect(positionValueCoin(sold)).toBe(0n);
    expect(unrealizedPnlCoin(sold)).toBe(0n);
    expect(averageCostBp(sold)).toBeUndefined();
  });

  it('renders a loss with the typographic minus sign, not an ASCII hyphen', () => {
    const losing = position({ outcome: 'YES', marketLastPrice: 30, costBasisCoin: '5000' });

    expect(unrealizedPnlCoin(losing)).toBe(-2000n);
    expect(formatCoin(priced(unrealizedPnlCoin(losing)))).toBe(`${MINUS_SIGN}2,000 Coin`);
    expect(formatCoin(priced(unrealizedPnlCoin(losing))).startsWith('-')).toBe(false);
  });

  it('applies the same formula to a settled row, which is why the screen must not show it', () => {
    // Settlement never writes a price, so `marketLastPrice` on a settled market is the last
    // price something TRADED at — 71 here, for a market that resolved YES and paid 100 Coin. The
    // arithmetic answers anyway; it is the 정산 이력 section's job to render `realizedPnlCoin`
    // instead, and `portfolioTotals` is therefore given one list at a time.
    const settled = position({
      marketStatus: 'settled',
      resolvedResult: 'YES',
      settled: true,
      qty: 40,
      marketLastPrice: 71,
      costBasisCoin: '2000',
      realizedPnlCoin: '2000',
    });

    expect(positionValueCoin(settled)).toBe(2840n);
    expect(unrealizedPnlCoin(settled)).toBe(840n);
    // The row really made 2,000 Coin — 40 winners paid 4,000 Coin against a 2,000 Coin basis —
    // and 840 Coin is the last trade's opinion, not a result. Only `realizedPnlCoin` is a settled
    // row's answer.
    expect(parseCoinAmount(settled.realizedPnlCoin)).toBe(2000n);
  });

  it('stays exact at the domain bounds, where a double has already rounded', () => {
    const bound = position({
      outcome: 'YES',
      qty: POSITION_QTY_MAX,
      marketLastPrice: PRICE_MAX,
      costBasisCoin: serializeCoinAmount(MAX_COIN_AMOUNT),
    });

    expect(positionValueCoin(bound)).toBe(212_600_881_053n);
    expect(unrealizedPnlCoin(bound)).toBe(212_600_881_053n - MAX_COIN_AMOUNT);
  });
});

describe('a market with no fill (체결 없음)', () => {
  it('has no price to mark a holding to, so every valued figure is undefined', () => {
    // N02 §5: before the first fill there is no price — the screen shows 체결 없음 and a dash,
    // never a number derived from an initial setting.
    const unpriced = position({ marketLastPrice: null, costBasisCoin: '5000' });
    expect(markPriceCoin(unpriced)).toBeUndefined();
    expect(positionValueCoin(unpriced)).toBeUndefined();
    expect(unrealizedPnlCoin(unpriced)).toBeUndefined();
  });

  it('is left out of the valued totals but keeps its realised PnL', () => {
    // Counting its cost without a value would print a loss nobody has.
    const rows = [
      position({ outcome: 'YES', qty: 10, marketLastPrice: 60, costBasisCoin: '400' }),
      position({ marketLastPrice: null, costBasisCoin: '5000', realizedPnlCoin: '30' }),
    ];
    expect(portfolioTotals(rows)).toEqual({
      valueCoin: 600n,
      costBasisCoin: 400n,
      unrealizedPnlCoin: 200n,
      realizedPnlCoin: 30n,
    });
  });
});

describe('averageCostBp', () => {
  it('reads to two decimals, half-up in bigint, and has none for nothing held', () => {
    // 100 / 3 = 33.333… → 33.33 Coin (ADR-0135 결과 4: 소수 둘째 자리), where a whole-Coin average
    // said 33. 101 / 2 = 50.50; 5000 / 100 = 50.00.
    expect(averageCostBp(position({ qty: 3, costBasisCoin: '100' }))).toBe(3333);
    expect(averageCostBp(position({ qty: 2, costBasisCoin: '101' }))).toBe(5050);
    expect(averageCostBp(position({ qty: 100, costBasisCoin: '5000' }))).toBe(5000);
    expect(averageCostBp(position({ qty: 0, costBasisCoin: '0' }))).toBeUndefined();
  });

  it('rounds half-up at the boundary: x.xx5 goes up, below it stays', () => {
    // 2 / 3 = 0.6666… → 0.67; 1 / 8 = 0.125 → 0.13 (half-up); 1 / 3 = 0.3333… → 0.33.
    expect(averageCostBp(position({ qty: 3, costBasisCoin: '2' }))).toBe(67);
    expect(averageCostBp(position({ qty: 8, costBasisCoin: '1' }))).toBe(13);
    expect(averageCostBp(position({ qty: 3, costBasisCoin: '1' }))).toBe(33);
  });

  it('moves inside a Coin after a partial sell, and never reaches a PnL (33.33 → 33.50)', () => {
    // N02 §8 and ADR-0135 결과 4: bought 1 each at 33, 33 and 34 — cost 100, average 33.33. A sell
    // of one at 45 releases the average cost in whole Coin (`applySell`): 100 / 3 → 33, so 67 is
    // left on two contracts, an average of 33.50, and 45 − 33 = 12 is realised.
    const before = position({ qty: 3, costBasisCoin: '100', marketLastPrice: 45 });
    const after = position({
      qty: 2,
      costBasisCoin: '67',
      realizedPnlCoin: '12',
      marketLastPrice: 45,
    });
    expect(averageCostBp(before)).toBe(3333);
    expect(averageCostBp(after)).toBe(3350);
    // 미실현 손익 is 참고 평가 − 잔여 원가 (F1), never average × qty: 90 − 67 = 23.
    expect(unrealizedPnlCoin(after)).toBe(23n);
    // Sold out at 50 later, 실현 is Σ received − Σ cost, 45 + 50 + 50 − 100 = 45, whatever the
    // average said on the way: the server's accounting (`applySell`, packages/shared
    // accounting.test.ts, #119) — the screen only reads it. A sold-out row has no average, and the
    // card's total counts its 실현 with nothing to value.
    const soldOut = position({ qty: 0, costBasisCoin: '0', realizedPnlCoin: '45' });
    expect(averageCostBp(soldOut)).toBeUndefined();
    const soldNo = position({ outcome: 'NO', qty: 0, costBasisCoin: '0', realizedPnlCoin: '-5' });
    expect(portfolioTotals([soldOut, soldNo])).toEqual({
      valueCoin: 0n,
      costBasisCoin: 0n,
      unrealizedPnlCoin: 0n,
      realizedPnlCoin: 40n,
    });
  });
});

describe('portfolioTotals', () => {
  it('sums nothing to zero, including a list that has not loaded', () => {
    expect(portfolioTotals([])).toEqual({
      valueCoin: 0n,
      costBasisCoin: 0n,
      unrealizedPnlCoin: 0n,
      realizedPnlCoin: 0n,
    });
    expect(portfolioTotals()).toEqual(portfolioTotals([]));
  });

  it('sums a mixed list of winners, losers and closed rows', () => {
    const rows = [
      position({ outcome: 'YES', qty: 10, marketLastPrice: 60, costBasisCoin: '400' }),
      position({
        outcome: 'NO',
        qty: 20,
        marketLastPrice: 60,
        costBasisCoin: '900',
        realizedPnlCoin: '50',
      }),
      position({ qty: 0, marketLastPrice: 60, costBasisCoin: '0', realizedPnlCoin: '-250' }),
    ];

    // 10 × 60 = 600, 20 × (100 − 60) = 800, 0.
    expect(portfolioTotals(rows)).toEqual({
      valueCoin: 1400n,
      costBasisCoin: 1300n,
      unrealizedPnlCoin: 100n,
      realizedPnlCoin: -200n,
    });
    // The total is the sum of the per-row figures, so a row and the summary cannot disagree.
    expect(portfolioTotals(rows).unrealizedPnlCoin).toBe(
      rows.reduce((sum, row) => sum + priced(unrealizedPnlCoin(row)), 0n),
    );
  });

  it('carries a total past 2^53, where a number implementation silently rounds', () => {
    // Ten positions at the MAX_COIN_AMOUNT bound cost 10^16 Coin. Against one holding at the qty
    // and price ceilings the unrealised total is −9,999,787,399,118,947 — odd, and above 2^53,
    // where doubles step by 2. This is the whole reason the module never touches Number.
    const sold = position({ qty: 0, costBasisCoin: serializeCoinAmount(MAX_COIN_AMOUNT) });
    const rows = [
      position({
        outcome: 'YES',
        qty: POSITION_QTY_MAX,
        marketLastPrice: PRICE_MAX,
        costBasisCoin: serializeCoinAmount(MAX_COIN_AMOUNT),
      }),
      ...Array.from({ length: 9 }, () => sold),
    ];

    const totals = portfolioTotals(rows);

    expect(totals.costBasisCoin).toBe(10n * MAX_COIN_AMOUNT);
    expect(totals.valueCoin).toBe(212_600_881_053n);
    expect(totals.unrealizedPnlCoin).toBe(-9_999_787_399_118_947n);
    expect(BigInt(Number(totals.unrealizedPnlCoin))).not.toBe(totals.unrealizedPnlCoin);
  });
});

describe('realizedPnlAcross', () => {
  it('counts a profit taken in a market that is still open', () => {
    // THE BUG: selling books the realised PnL onto the row and LEAVES it in the open list, so
    // 총 실현 손익 read from the settled list alone answered 0 Coin to an account that had just
    // taken 100 Coin out of a market that has not finished — and would keep saying 0 Coin until
    // it did.
    const open = portfolioTotals([
      position({ qty: 0, costBasisCoin: '0', realizedPnlCoin: '10000' }),
    ]);
    const settled = portfolioTotals([]);
    expect(realizedPnlAcross(open, settled)).toBe(10_000n);
  });

  it('sums the two lists, which a row is never in at once', () => {
    // A row MOVES to the settled list when the market finishes, carrying the same accumulated
    // figure with it, so adding the lists cannot count one row twice.
    const open = portfolioTotals([position({ realizedPnlCoin: '700' })]);
    const settled = portfolioTotals([
      position({ settled: true, realizedPnlCoin: '-250' }),
      position({ settled: true, outcome: 'NO', realizedPnlCoin: '4000' }),
    ]);
    expect(realizedPnlAcross(open, settled)).toBe(4_450n);
    expect(realizedPnlAcross()).toBe(0n);
  });

  it('carries a total past 2^53, where a number implementation silently rounds', () => {
    const huge = serializeCoinAmount(MAX_COIN_AMOUNT);
    const open = portfolioTotals([position({ realizedPnlCoin: huge })]);
    const settled = portfolioTotals([position({ settled: true, realizedPnlCoin: huge })]);
    expect(realizedPnlAcross(open, settled)).toBe(MAX_COIN_AMOUNT * 2n);
  });
});

describe('listState / combinedListState', () => {
  it('tells a list that is coming from one that failed', () => {
    expect(listState({ data: [], isPending: false })).toBe('ready');
    expect(listState({ data: undefined, isPending: true })).toBe('pending');
    expect(listState({ data: undefined, isPending: false })).toBe('failed');
  });

  it('reports a figure that needs both lists as unknown until both are known', () => {
    // A total drawn from one of two lists is not a smaller total, it is a wrong one — so
    // failure dominates, and anything still loading holds the figure back.
    expect(combinedListState('ready', 'ready')).toBe('ready');
    expect(combinedListState('ready', 'pending')).toBe('pending');
    expect(combinedListState('pending', 'failed')).toBe('failed');
    expect(combinedListState('ready', 'failed')).toBe('failed');
    expect(combinedListState()).toBe('ready');
  });
});

describe('holdingDisplay', () => {
  it('takes the badge flags from a live row of the status the holding shows, and only then', () => {
    const flags = { judgementDelayed: true, disputeUnderReview: true };
    expect(holdingDisplay({ status: 'provisional', ...flags }, 'provisional')).toEqual(flags);
    // A CLOSED row past its scheduled judgement, a step behind a fresh 잠정 결과: not '판정 지연'.
    const none = { judgementDelayed: false, disputeUnderReview: false };
    expect(
      holdingDisplay(
        { status: 'closed', judgementDelayed: true, disputeUnderReview: false },
        'provisional',
      ),
    ).toEqual(none);
    expect(holdingDisplay(undefined, 'provisional')).toEqual(none);
  });
});

/** A live `['market', id]` row's reading, the position fixture's market unless overridden. */
function liveRow(overrides: Partial<LiveMarketReading> = {}): LiveMarketReading {
  return {
    lastPrice: 63,
    lastFillAt: '2026-09-06T23:00:00.000Z',
    tradeCount: 5,
    status: 'open',
    statusEventId: '10',
    ...overrides,
  };
}

describe('markToLiveMarket', () => {
  it('marks the row to the live price and its time, which a later fill count carries', () => {
    // `marketLastPrice` is a join taken when the list was fetched and nothing refreshes it on
    // somebody else's trade — that arrives as a `market:tick` on the market cache instead.
    const row = position({ marketLastPrice: 50, marketTradeCount: 5 });
    const live = liveRow({ lastPrice: 63, lastFillAt: '2026-09-07T01:00:00.000Z', tradeCount: 6 });
    const marked = markToLiveMarket(row, live);
    expect(marked.marketLastPrice).toBe(63);
    expect(marked.marketLastFillAt).toBe('2026-09-07T01:00:00.000Z');
    expect(marked.marketTradeCount).toBe(6);
    expect(unrealizedPnlCoin(marked)).toBe(63n * 100n - 5_000n);
  });

  it('takes the live pair on an equal fill count too', () => {
    const row = position({ marketLastPrice: 50, marketTradeCount: 5 });
    const marked = markToLiveMarket(row, liveRow({ lastPrice: 52, tradeCount: 5 }));
    expect(marked.marketLastPrice).toBe(52);
  });

  it('keeps the holding’s price when the live row was read before its fills (M1, A-M4-33)', () => {
    // A live row read before the first fill says 체결 없음; the positions list read after the
    // fills says 33 at its time. The count orders them: the live row is behind, so the holding is
    // never covered with '체결 없음', and the time stays the 33's.
    const row = position({
      marketLastPrice: 33,
      marketLastFillAt: '2026-09-07T01:00:00.000Z',
      marketTradeCount: 2,
    });
    const before = liveRow({ lastPrice: null, lastFillAt: null, tradeCount: 0 });
    expect(markToLiveMarket(row, before)).toBe(row);
    expect(positionValueCoin(markToLiveMarket(row, before))).toBe(3300n);
  });

  it('never mixes one reading’s price with the other’s time', () => {
    const row = position({
      marketLastPrice: 40,
      marketLastFillAt: '2026-09-07T01:00:00.000Z',
      marketTradeCount: 3,
    });
    const behind = markToLiveMarket(
      row,
      liveRow({ lastPrice: 70, lastFillAt: '2026-09-07T00:00:00.000Z', tradeCount: 2 }),
    );
    expect([behind.marketLastPrice, behind.marketLastFillAt]).toEqual([
      40,
      '2026-09-07T01:00:00.000Z',
    ]);
    const ahead = markToLiveMarket(
      row,
      liveRow({ lastPrice: 70, lastFillAt: '2026-09-07T02:00:00.000Z', tradeCount: 4 }),
    );
    expect([ahead.marketLastPrice, ahead.marketLastFillAt]).toEqual([
      70,
      '2026-09-07T02:00:00.000Z',
    ]);
  });

  it('marks the STATUS too, which no user event ever moves', () => {
    // A transition publishes `market:status` and nothing else — no `user:position`.
    const row = position({ marketStatus: 'open', marketStatusEventId: '10' });
    const closed = markToLiveMarket(row, liveRow({ status: 'closed', statusEventId: '11' }));
    expect(closed.marketStatus).toBe('closed');
    expect(closed.marketLastPrice).toBe(row.marketLastPrice);
  });

  it('orders the status on the two transition keys when both rows have one', () => {
    // The live row's key behind the holding's: an older reading, refused — OPEN ↔ PAUSED included,
    // which the value alone cannot order.
    const paused = position({ marketStatus: 'paused', marketStatusEventId: '12' });
    expect(markToLiveMarket(paused, liveRow({ status: 'open', statusEventId: '11' }))).toBe(paused);
    expect(
      markToLiveMarket(paused, liveRow({ status: 'open', statusEventId: '13' })).marketStatus,
    ).toBe('open');
    const open = position({ marketStatus: 'open', marketStatusEventId: '13' });
    expect(markToLiveMarket(open, liveRow({ status: 'paused', statusEventId: '12' }))).toBe(open);
  });

  it('falls back to the value order without a key, and refuses a status that moves lists', () => {
    const closed = position({ marketStatus: 'closed', marketStatusEventId: null });
    expect(markToLiveMarket(closed, liveRow({ status: 'open', statusEventId: null }))).toBe(closed);
    const paused = position({ marketStatus: 'paused', marketStatusEventId: null });
    expect(
      markToLiveMarket(paused, liveRow({ status: 'open', statusEventId: '1' })).marketStatus,
    ).toBe('open');
    // With keys or without, 지급 완료 and 취소 move the row to the other list: the REST answer's.
    const open = position({ marketStatus: 'open', marketStatusEventId: '10' });
    expect(markToLiveMarket(open, liveRow({ status: 'settled', statusEventId: '99' }))).toBe(open);
    const cancelled = liveRow({ status: 'cancelled', statusEventId: null });
    expect(markToLiveMarket(open, cancelled)).toBe(open);
  });

  it('keeps the row itself when there is nothing newer, or no live row at all', () => {
    const row = position();
    expect(markToLiveMarket(row, undefined)).toBe(row);
    expect(markToLiveMarket(row, liveRow())).toBe(row);
  });
});

describe('dedupeAcrossLists', () => {
  it('leaves out an open row the settled list holds too, so 실현 손익 counts once (M3)', () => {
    // A settlement's `user:position` reads both lists again, and the settled answer can land first.
    const openRow = position({ qty: 0, costBasisCoin: '0', realizedPnlCoin: '250' });
    const other = position({
      marketId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      realizedPnlCoin: '5',
    });
    const settledRow = position({ settled: true, marketStatus: 'settled', realizedPnlCoin: '250' });
    const open = dedupeAcrossLists([openRow, other], [settledRow]);
    expect(open).toEqual([other]);
    expect(realizedPnlAcross(portfolioTotals(open), portfolioTotals([settledRow]))).toBe(255n);
    // The other contract of the same market is another key.
    const no = position({ outcome: 'NO' });
    expect(dedupeAcrossLists([no], [settledRow])).toEqual([no]);
    expect(dedupeAcrossLists([openRow], undefined)).toEqual([openRow]);
  });
});

describe('realizedPnlState', () => {
  /** A list that has answered, idle and fresh unless overridden. */
  const list = (overrides: Partial<Parameters<typeof realizedPnlState>[0]> = {}) => ({
    data: [] as Position[],
    isPending: false,
    isFetching: false,
    isRefetchError: false,
    dataUpdatedAt: 1_000,
    ...overrides,
  });

  it('holds 총 실현 손익 while the settled list is behind the open one (open first)', () => {
    // A settlement reads both lists again. The open answer lands first: the contract has left it,
    // and the settled list still lacks it — in neither, the sum would drop its 실현 손익.
    const row = position({ realizedPnlCoin: '250' });
    const settledRow = position({ settled: true, marketStatus: 'settled', realizedPnlCoin: '250' });
    const open = list({ data: [], dataUpdatedAt: 2_000 });
    const settledBehind = list({ data: [], isFetching: true, dataUpdatedAt: 1_000 });
    expect(realizedPnlAcross(portfolioTotals([]), portfolioTotals([]))).toBe(0n);
    expect(realizedPnlState(open, settledBehind)).toBe('pending');
    // The settled answer lands: the row is there, and the figure is drawn again.
    const settledNow = list({ data: [settledRow], dataUpdatedAt: 2_100 });
    expect(realizedPnlState(open, settledNow)).toBe('ready');
    expect(realizedPnlAcross(portfolioTotals([]), portfolioTotals([settledRow]))).toBe(250n);
    // The other order is `dedupeAcrossLists`': the open list behind is no reason to wait.
    const openBehind = list({ data: [row], isFetching: true, dataUpdatedAt: 1_000 });
    expect(realizedPnlState(openBehind, settledNow)).toBe('ready');
    // A settled read that is fetching but not behind (a focus refetch with the open idle): drawn.
    expect(realizedPnlState(list(), list({ isFetching: true, dataUpdatedAt: 1_000 }))).toBe(
      'ready',
    );
  });

  it('reports a failed refetch of either list as unknown, never a short sum', () => {
    const failed = list({ isRefetchError: true });
    expect(realizedPnlState(list({ dataUpdatedAt: 2_000 }), failed)).toBe('failed');
    expect(realizedPnlState(failed, list())).toBe('failed');
  });

  it('keeps the first-load ladder of the two lists', () => {
    expect(realizedPnlState(list(), list())).toBe('ready');
    expect(realizedPnlState(list({ data: undefined, isPending: true }), list())).toBe('pending');
    expect(realizedPnlState(list(), list({ data: undefined }))).toBe('failed');
  });
});

describe('heldGroups', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('keeps the rows held at 1 or more, one group per market, YES before NO (F4·F7)', () => {
    const groups = heldGroups([
      position({ marketId: A, outcome: 'NO', qty: 1 }),
      position({ marketId: A, outcome: 'YES', qty: 2 }),
      position({ marketId: B, outcome: 'YES', qty: 0, realizedPnlCoin: '12' }),
    ]);
    expect(groups.map((g) => [g.marketId, g.rows.map((r) => r.outcome)])).toEqual([
      [A, ['YES', 'NO']],
    ]);
  });

  it('draws a YES-only and a NO-only market as one row each', () => {
    const groups = heldGroups([
      position({ marketId: A, outcome: 'YES', updatedAt: '2026-09-07T02:00:00.000Z' }),
      position({ marketId: B, outcome: 'NO', updatedAt: '2026-09-07T01:00:00.000Z' }),
    ]);
    expect(groups.map((g) => g.rows.map((r) => r.outcome))).toEqual([['YES'], ['NO']]);
  });

  it('orders the groups by their newest change, then by market id', () => {
    const groups = heldGroups([
      position({ marketId: A, outcome: 'YES', updatedAt: '2026-09-07T01:00:00.000Z' }),
      position({ marketId: B, outcome: 'YES', updatedAt: '2026-09-07T00:00:00.000Z' }),
      // B's NO changed last: a resting sell moves `updatedAt` too, and its market goes to the top.
      position({ marketId: B, outcome: 'NO', updatedAt: '2026-09-07T03:00:00.000Z' }),
    ]);
    expect(groups.map((g) => g.marketId)).toEqual([B, A]);
    expect(groups[0]?.updatedAt).toBe('2026-09-07T03:00:00.000Z');
    const tie = heldGroups([
      position({ marketId: B, updatedAt: '2026-09-07T00:00:00.000Z' }),
      position({ marketId: A, updatedAt: '2026-09-07T00:00:00.000Z' }),
    ]);
    expect(tie.map((g) => g.marketId)).toEqual([A, B]);
  });

  it('draws fewer rows than the totals count, and the drawn values add up to the total (M4)', () => {
    // The totals take every open row; a sold-out row is not drawn but its 실현 손익 counts, and
    // its value is 0, so Σ(drawn values) = 총 참고 평가 still holds.
    const markedAll = [
      position({
        marketId: A,
        outcome: 'YES',
        qty: 2,
        costBasisCoin: '67',
        realizedPnlCoin: '12',
        marketLastPrice: 45,
      }),
      position({
        marketId: A,
        outcome: 'NO',
        qty: 0,
        costBasisCoin: '0',
        realizedPnlCoin: '-10',
        marketLastPrice: 45,
      }),
    ];
    const drawn = heldGroups(markedAll).flatMap((g) => g.rows);
    const totals = portfolioTotals(markedAll);
    expect(drawn).toHaveLength(1);
    expect(totals.realizedPnlCoin).toBe(2n);
    expect(drawn.reduce((sum, row) => sum + priced(positionValueCoin(row)), 0n)).toBe(
      totals.valueCoin,
    );
    expect(totals.valueCoin).toBe(90n);
    expect(totals.unrealizedPnlCoin).toBe(23n);
  });
});

describe('총 실현 손익 across the two lists', () => {
  it('is only summable because a row is never in both lists, which the socket used to break', () => {
    // `realizedPnlAcross` sums BOTH lists on a promise its own doc makes: "a row MOVES between
    // the two lists … so it is never in both and this cannot double count". The socket broke
    // that promise. `applyPositionEvent` matched a row on (marketId, outcome) alone, so a
    // settling event's `settled: true` was written back into `['positions', 'open']` — the list the row had just
    // LEFT — and the patch kind stayed `replace`, so nothing was scheduled to correct it. The
    // write refreshed `dataUpdatedAt` too, putting the poisoned list inside `staleTime`.
    const openRow = position({ realizedPnlCoin: '250', qty: 10, costBasisCoin: '5000' });
    const event = {
      type: 'user:position' as const,
      marketId: openRow.marketId,
      outcome: openRow.outcome,
      qty: 0,
      costBasisCoin: '0',
      realizedPnlCoin: '250',
      settled: true,
      version: openRow.version + 1,
      ts: '2026-09-07T01:00:00.000Z',
    };
    // 정산 이력, once fetched, holds this row: that is where a settlement puts it.
    const settledList: Position[] = [
      { ...openRow, qty: 0, costBasisCoin: '0', settled: true, version: event.version },
    ];

    // The arithmetic that made it visible, kept as the counterfactual this guard exists for:
    // one 250 Coin row read as 500 Coin, on the 총 실현 손익 line of MY's 잔고 요약.
    const poisonedOpen: Position[] = [
      { ...openRow, qty: 0, costBasisCoin: '0', settled: true, version: event.version },
    ];
    expect(realizedPnlAcross(portfolioTotals(poisonedOpen), portfolioTotals(settledList))).toBe(
      500n,
    );

    // The guard: the reducer will not write a row into a list it has left, so the poisoned
    // state above is not reachable — the list is ASKED for, and `joinPositions` takes its
    // membership from the answer.
    expect(applyPositionEvent([openRow], event)).toEqual({ kind: 'refetch' });
  });
});

describe('liveMarketStatus', () => {
  it('refuses a live status the lifecycle never goes back to, so a failed refetch cannot walk 마감 back to 거래 중', () => {
    // `['market', id]` and `['positions', …]` are two independent fetches, and the market's can
    // be the OLDER of the two: react-query keeps the row it already had when a REFETCH fails,
    // so a positions answer carrying 마감 was overwritten on screen by a market entry still
    // saying 거래 중 — with nothing scheduled to correct it. Compared by the lifecycle's order,
    // so no reading here walks a badge back where the lifecycle never goes.
    expect(liveMarketStatus('closed', 'open')).toBe('closed');
    expect(liveMarketStatus('closed', 'paused')).toBe('closed');
    expect(liveMarketStatus('settling', 'resolved')).toBe('settling');
    expect(liveMarketStatus('resolved', 'closed')).toBe('resolved');
    // Equal is not newer: an event that has already been applied writes nothing either.
    expect(liveMarketStatus('closed', 'closed')).toBe('closed');
    // And an absent entry — the market this tab holds no cache row for — is not a status.
    expect(liveMarketStatus('closed', undefined)).toBe('closed');
    // The half this guard must NOT break: 거래 중 → 마감 is newer and stays taken.
    expect(liveMarketStatus('open', 'closed')).toBe('closed');
    expect(liveMarketStatus('resolved', 'settling')).toBe('settling');
  });

  it('takes the live row either way between 거래 중 and 거래 일시 중단, which goes both ways (#174)', () => {
    // OPEN ↔ PAUSED (ADR-0093 decision 1, item 3): ranked by `statusRank` alone, a market resumed
    // after the list was read (snapshot `paused`, live `open`) kept its 거래 일시 중단 badge for good,
    // since `open` sorts first. The value cannot say which of the two came later; the live row is
    // the one its room keeps in event order (`statusSupersedes`), the snapshot a frozen join.
    expect(liveMarketStatus('paused', 'open')).toBe('open');
    expect(liveMarketStatus('open', 'paused')).toBe('paused');
    // Neither is a way back past the close: a closed market is never paused or open again.
    expect(liveMarketStatus('closed', 'paused')).toBe('closed');
    expect(liveMarketStatus('paused', 'closed')).toBe('closed');
  });

  it('leaves a terminal status to the REST answer, the only thing that moves a row between the two lists', () => {
    // A settlement moves the row to 정산 이력 (`positions.settled`) and publishes its own
    // `user:position`, which restarts BOTH lists. Taking the status here instead would badge an
    // open holding 지급 완료 while 평가 금액 and 총 평가 금액 still value it at the last traded
    // price — the fiction `positionValueCoin` and 정산 이력 are documented never to print. A
    // cancelled market lists with the finished ones (`positionListStatusFor`) and is refused alike.
    expect(liveMarketStatus('open', 'settled')).toBe('open');
    expect(liveMarketStatus('settling', 'settled')).toBe('settling');
    expect(liveMarketStatus('paused', 'cancelled')).toBe('paused');
    // The refusal is about MEMBERSHIP, not about the word: a row already in the settled list
    // takes a later status from the live row like any other same-list transition.
    expect(liveMarketStatus('settled', 'cancelled')).toBe('cancelled');
  });

  it('orders on the transition keys when both are given (#67, ADR-0142)', () => {
    // The value says OPEN ↔ PAUSED either way; the keys say which came later.
    expect(liveMarketStatus('paused', 'open', { held: '5', live: '4' })).toBe('paused');
    expect(liveMarketStatus('paused', 'open', { held: '5', live: '6' })).toBe('open');
    expect(liveMarketStatus('closed', 'open', { held: '5', live: '6' })).toBe('open');
    // One side without a key: the value order, as before.
    expect(liveMarketStatus('closed', 'open', { held: '5', live: null })).toBe('closed');
    // A list move is refused whatever the keys say.
    expect(liveMarketStatus('open', 'settled', { held: '5', live: '9' })).toBe('open');
  });

  it('classifies every pair, so a new status cannot fall through by default', () => {
    // The whole table, like `positionListStatusFor`'s: a status added to MARKET_STATUSES fails
    // this with whatever it was silently given, which is a decision that has to be made rather
    // than inherited. Every cell is the held status unless the live one is BOTH not behind it in
    // the lifecycle (`paused` on `open`'s step) and in the same list.
    const [D, RV, SC, O, P, C, PR, RS, SG, ST, CA] = MARKET_STATUSES;
    const table = MARKET_STATUSES.map((held) =>
      MARKET_STATUSES.map((live) => liveMarketStatus(held, live)),
    );
    // Columns: the live status in MARKET_STATUSES order — D RV SC O P C PR RS SG ST CA.
    expect(table).toEqual([
      // held draft, review, scheduled — anything later in the open list; settled/cancelled
      // change the list.
      [D, RV, SC, O, P, C, PR, RS, SG, D, D],
      [RV, RV, SC, O, P, C, PR, RS, SG, RV, RV],
      [SC, SC, SC, O, P, C, PR, RS, SG, SC, SC],
      // held open and paused — each takes the other (one step), and everything after.
      [O, O, O, O, P, C, PR, RS, SG, O, O],
      [P, P, P, O, P, C, PR, RS, SG, P, P],
      [C, C, C, C, C, C, PR, RS, SG, C, C],
      [PR, PR, PR, PR, PR, PR, PR, RS, SG, PR, PR],
      [RS, RS, RS, RS, RS, RS, RS, RS, SG, RS, RS],
      [SG, SG, SG, SG, SG, SG, SG, SG, SG, SG, SG],
      // held settled — already in 정산 이력, so a later live status is same-list.
      [ST, ST, ST, ST, ST, ST, ST, ST, ST, ST, CA],
      [CA, CA, CA, CA, CA, CA, CA, CA, CA, CA, CA],
    ]);
  });
});

describe('positionListStatusFor', () => {
  it('sends a finished market to the settled list and everything else to the open one', () => {
    // The bug this pins is a false statement on screen: `GET /me/positions?status=open`
    // filters on `settled = false`, and a finished market's holder rows carry `settled: true`.
    // A detail screen that only ever asked for 'open' therefore answered "아직 이 시장에 참여하지
    // 않았습니다" to an account that had just been paid out — while /portfolio listed the very
    // same row under 정산 이력.
    expect(positionListStatusFor('settled')).toBe('settled');
    // A cancelled market ended with no user fill (ADR-0093 decision 1, item 10): over, so it
    // lists with the finished ones should a row ever exist, never among priced holdings.
    expect(positionListStatusFor('cancelled')).toBe('settled');
    // Trading has stopped or the payout is under way, and nothing has been paid out yet: the
    // rows are still open holdings — the worker flips `positions.settled` in the transaction that
    // takes `settling` to `settled` — and asking for the settled list would empty the card the
    // other way.
    for (const status of ['paused', 'closed', 'provisional', 'resolved', 'settling'] as const) {
      expect(positionListStatusFor(status), status).toBe('open');
    }
    expect(positionListStatusFor('open')).toBe('open');
    // A draft or one in review never reaches the detail route (the API 404s it), but the prop is
    // typed over every status, so it must still answer with the list that exists.
    expect(positionListStatusFor('draft')).toBe('open');
    expect(positionListStatusFor('review')).toBe('open');
  });

  it('classifies every status, so a new one cannot fall to a list by default', () => {
    // Pinned as the whole table rather than as a predicate: a status added to MARKET_STATUSES
    // fails this with the pair it was silently given, which is the decision that has to be
    // made deliberately — the wrong default is invisible on screen, it just empties the card.
    expect(MARKET_STATUSES.map((status) => [status, positionListStatusFor(status)])).toEqual([
      ['draft', 'open'],
      ['review', 'open'],
      ['scheduled', 'open'],
      ['open', 'open'],
      ['paused', 'open'],
      ['closed', 'open'],
      ['provisional', 'open'],
      ['resolved', 'open'],
      ['settling', 'open'],
      ['settled', 'settled'],
      ['cancelled', 'settled'],
    ]);
  });
});

describe('positionsQueryOptions', () => {
  it('sends no request until the account MY shows is known', () => {
    expect(positionsQueryOptions('open', undefined).enabled).toBe(false);
    expect(positionsQueryOptions('open', ACCOUNT).enabled).toBe(true);
  });

  it('keys each list by the account, so another account’s rows are never drawn (#67)', () => {
    expect(positionsQueryOptions('open', ACCOUNT).queryKey).toEqual(['positions', 'open', ACCOUNT]);
    expect(positionsKey('open', 'other')).not.toEqual(positionsKey('open', ACCOUNT));
  });

  it('keys the two lists apart under the one root the socket invalidates', async () => {
    // `user:position` invalidates POSITIONS_KEY once; react-query matches by key prefix, so
    // that must reach both the open holdings and the settled history — and nothing else.
    const open = positionsQueryOptions('open', ACCOUNT);
    const settled = positionsQueryOptions('settled', ACCOUNT);
    expect(open.queryKey).toEqual(positionsKey('open', ACCOUNT));
    expect(open.queryKey).not.toEqual(settled.queryKey);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      queryClient.setQueryData(open.queryKey, []);
      queryClient.setQueryData(settled.queryKey, []);
      queryClient.setQueryData(ORDERS_KEY, { pages: [], pageParams: [] });

      await queryClient.invalidateQueries({ queryKey: POSITIONS_KEY });

      expect(queryClient.getQueryState(open.queryKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(settled.queryKey)?.isInvalidated).toBe(true);
      // A different root: 'positions' and 'orders' never partial-match each other.
      expect(queryClient.getQueryState(ORDERS_KEY)?.isInvalidated).toBe(false);
    } finally {
      queryClient.clear();
    }
  });
});

describe('ordersInfiniteQueryOptions', () => {
  it('stops paging on a null cursor and waits for the session', () => {
    const options = ordersInfiniteQueryOptions(SESSION);

    expect(options.queryKey).toEqual(ORDERS_KEY);
    expect(options.initialPageParam).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: 'cursor-2' })).toBe('cursor-2');
    expect(ordersInfiniteQueryOptions().enabled).toBe(false);
  });

  it('accumulates `{ items, nextCursor }` pages until the cursor runs out', async () => {
    const options = ordersInfiniteQueryOptions(SESSION);
    const first: OrdersPage = { items: [order('o1')], nextCursor: 'cursor-2' };
    const last: OrdersPage = { items: [order('o2')], nextCursor: null };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      // The real queryFn needs a cookie and a server; what is worth pinning is that the page
      // shape and the two page-param rules compose into a list that ends by itself.
      const data = await queryClient.fetchInfiniteQuery({
        queryKey: options.queryKey,
        initialPageParam: options.initialPageParam,
        getNextPageParam: options.getNextPageParam,
        queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
          Promise.resolve(pageParam === undefined ? first : last),
        pages: 3,
      });

      expect(data.pageParams).toEqual([undefined, 'cursor-2']);
      expect(data.pages.flatMap((page) => page.items).map((row) => row.id)).toEqual(['o1', 'o2']);
    } finally {
      queryClient.clear();
    }
  });
});

describe('priceIsStale', () => {
  it('counts a FIRST-load failure, which is the state the notice used to miss', () => {
    // Measured against a real QueryObserver: a first fetch that exhausts its retries answers
    // `isLoadingError: true, isRefetchError: false` and holds NO row, so `markToLiveMarket` falls
    // back to the position's frozen join — a plausible, unlabelled price that no tick repairs
    // (`applyTick` will not build a row; `tickRestartsMarket` refuses an idle query). A notice
    // written on `isRefetchError` alone said nothing in exactly that case.
    expect(priceIsStale({ isLoadingError: true, isRefetchError: false })).toBe(true);
  });

  it('still counts a failed refetch, which keeps its row and is repaired by the next tick', () => {
    expect(priceIsStale({ isLoadingError: false, isRefetchError: true })).toBe(true);
  });

  it('says nothing about a market that is answering', () => {
    expect(priceIsStale({ isLoadingError: false, isRefetchError: false })).toBe(false);
  });
});
