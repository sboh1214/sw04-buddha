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
import {
  type OrdersPage,
  averageCostCoin,
  combinedListState,
  listState,
  liveMarketStatus,
  markPriceCoin,
  priceIsStale,
  markToLiveMarket,
  ordersInfiniteQueryOptions,
  portfolioTotals,
  positionListStatusFor,
  positionValueCoin,
  positionsKey,
  positionsQueryOptions,
  realizedPnlAcross,
  unrealizedPnlCoin,
} from './use-portfolio';

/** Whatever better-auth hands back; only "is it there" is read. */
const SESSION = { user: { id: 'a1e1c0de-0000-4000-8000-000000000001' } };

function position(overrides: Partial<Position> = {}): Position {
  return {
    marketId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    marketSlug: 'rate-cut-2026',
    marketTitle: '기준금리 인하?',
    marketStatus: 'open',
    marketLastPrice: 63,
    resolvedResult: null,
    outcome: 'YES',
    qty: 100,
    costBasisCoin: '5000',
    realizedPnlCoin: '0',
    settled: false,
    version: 1,
    updatedAt: '2026-09-07T00:00:00.000Z',
    ...overrides,
  };
}

function order(id: string): Order {
  return {
    id,
    marketId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    marketSlug: 'rate-cut-2026',
    marketTitle: '기준금리 인하?',
    outcome: 'YES',
    side: 'buy',
    type: 'market',
    qty: 10,
    filledQty: 10,
    status: 'filled',
    amountCoin: '630',
    priceAvgBp: 6300,
    createdAt: '2026-09-07T00:00:00.000Z',
  };
}

/** A figure the test KNOWS is priced; `undefined` (체결 없음) here is a failure, not a value. */
function priced(value: bigint | undefined): bigint {
  if (value === undefined) throw new Error('expected a priced figure');
  return value;
}

describe('markPriceCoin / positionValueCoin / unrealizedPnlCoin', () => {
  it('values a YES holding at the market price and a NO holding at its complement', () => {
    // The bug this pins is silent: `qty × marketLastPrice` for a NO row produces a plausible
    // number that is wrong by 100 − 2·price per contract, and the screen has nothing to
    // compare it against. `marketLastPrice` is the YES price, so the NO side is 100 − 63 = 37
    // — the same complement `formatNoPrice` prints under "아니오 37%".
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
    expect(averageCostCoin(sold)).toBeUndefined();
  });

  it('renders a loss with the typographic minus sign, not an ASCII hyphen', () => {
    const losing = position({ outcome: 'YES', marketLastPrice: 30, costBasisCoin: '5000' });

    expect(unrealizedPnlCoin(losing)).toBe(-2000n);
    expect(formatCoin(priced(unrealizedPnlCoin(losing)))).toBe(`${MINUS_SIGN}2,000P`);
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

describe('averageCostCoin', () => {
  it('rounds half-up in bigint, the way applySell releases cost', () => {
    // 100 / 3 = 33.33 → 33; 101 / 2 = 50.5 → 51. Both round the same way the API does, so the
    // 평단 on screen and the cost a sell releases can never drift apart by a Coin.
    expect(averageCostCoin(position({ qty: 3, costBasisCoin: '100' }))).toBe(33n);
    expect(averageCostCoin(position({ qty: 2, costBasisCoin: '101' }))).toBe(51n);
    expect(averageCostCoin(position({ qty: 100, costBasisCoin: '5000' }))).toBe(50n);
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

describe('markToLiveMarket', () => {
  it('marks the row to the price the market cache holds, not the one the list was fetched at', () => {
    // `marketLastPrice` is a join taken when the list was fetched and nothing refreshes it on
    // somebody else's trade — that arrives as a `market:tick` on the market cache instead.
    const row = position({ marketLastPrice: 50 });
    expect(markToLiveMarket(row, { lastPrice: 63 }).marketLastPrice).toBe(63);
    expect(unrealizedPnlCoin(markToLiveMarket(row, { lastPrice: 63 }))).toBe(63n * 100n - 5_000n);
  });

  it('marks the STATUS too, which no user event ever moves', () => {
    // A transition publishes `market:status` and nothing else — no `user:position` — so a
    // holding in a market that has just closed kept announcing 진행 중 until an unrelated
    // positions refetch. Refetching the lists on that event would be two private requests per
    // signed-in tab to move one denormalized enum.
    const row = position({ marketStatus: 'open' });
    expect(markToLiveMarket(row, { status: 'closed' }).marketStatus).toBe('closed');
    expect(markToLiveMarket(row, { status: 'closed' }).marketLastPrice).toBe(row.marketLastPrice);
  });

  it('runs the status through `liveMarketStatus` rather than a `??`, wiring included', () => {
    // The guard has to be reached THROUGH this function, not merely exist beside it: a row the
    // list fetched as 마감 must survive a `['market', id]` entry left at 진행 중 by a failed
    // refetch, and an open holding must not be badged with a terminal status while it is still
    // valued at the last traded price. Both are `markToLiveMarket`'s callers' actual arguments (portfolio.tsx).
    const closed = position({ marketStatus: 'closed', marketLastPrice: 50 });
    expect(markToLiveMarket(closed, { status: 'open', lastPrice: 50 })).toBe(closed);
    const open = position({ marketStatus: 'open', marketLastPrice: 50 });
    expect(markToLiveMarket(open, { status: 'voided', lastPrice: 50 })).toBe(open);
  });

  it('takes the live row saying 체결 없음 as it is, and only an absent row as no reading', () => {
    // `null` is the market cache SAYING there is no fill; `undefined` is no cache entry at all.
    const row = position({ marketLastPrice: null });
    expect(markToLiveMarket(row, { lastPrice: null })).toBe(row);
    expect(markToLiveMarket(row, { lastPrice: 63 }).marketLastPrice).toBe(63);
    expect(markToLiveMarket(position({ marketLastPrice: 63 }), {}).marketLastPrice).toBe(63);
  });

  it('keeps the row itself when there is nothing newer to mark it to', () => {
    // The same reference, so an untouched row does not re-render; an absent field is a market
    // this tab holds no cache entry for, which is not a reason to invent one.
    const row = position({ marketLastPrice: 63, marketStatus: 'open' });
    expect(markToLiveMarket(row, {})).toBe(row);
    expect(markToLiveMarket(row, { lastPrice: 63, status: 'open' })).toBe(row);
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
    // one 250 Coin row read as 500 Coin, on the 총 실현 손익 line of /portfolio.
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
  it('takes the live status only while it is strictly newer, so a market refetch that failed cannot walk 마감 back to 진행 중', () => {
    // `['market', id]` and `['positions', …]` are two independent fetches, and the market's can
    // be the OLDER of the two: react-query keeps the row it already had when a REFETCH fails,
    // so a positions answer carrying 마감 was overwritten on screen by a market entry still
    // saying 진행 중 — with nothing scheduled to correct it. Ranked by the same order
    // `applyStatus` and `joinMarket` compare on, so no reading here walks a badge backwards.
    expect(liveMarketStatus('closed', 'open')).toBe('closed');
    expect(liveMarketStatus('resolved', 'closed')).toBe('resolved');
    // Equal is not newer: an event that has already been applied writes nothing either.
    expect(liveMarketStatus('closed', 'closed')).toBe('closed');
    // And an absent entry — the market this tab holds no cache row for — is not a status.
    expect(liveMarketStatus('closed', undefined)).toBe('closed');
    // The half this guard must NOT break: 진행 중 → 마감 is strictly newer and stays taken.
    expect(liveMarketStatus('open', 'closed')).toBe('closed');
  });

  it('leaves a terminal status to the REST answer, the only thing that moves a row between the two lists', () => {
    // A settlement or a void moves the row to 정산 이력 (`positions.settled`), and both publish
    // their own `user:position`, which restarts BOTH lists. Taking the status here instead would
    // badge an open holding 무효 while 평가 금액 and 총 평가 금액 still value it at the last
    // traded price — the fiction `positionValueCoin` and 정산 이력 are documented never to print.
    expect(liveMarketStatus('open', 'settled')).toBe('open');
    expect(liveMarketStatus('resolved', 'voided')).toBe('resolved');
    // The refusal is about MEMBERSHIP, not about the word: a row already in the settled list
    // takes a terminal status from the live row like any other same-list transition.
    expect(liveMarketStatus('settled', 'voided')).toBe('voided');
  });

  it('classifies every pair, so a new status cannot fall through by default', () => {
    // The whole table, like `positionListStatusFor`'s: a status added to MARKET_STATUSES fails
    // this with whatever it was silently given, which is a decision that has to be made rather
    // than inherited. Every cell is the held status unless the live one is BOTH strictly newer
    // and in the same list.
    const table = MARKET_STATUSES.map((held) =>
      MARKET_STATUSES.map((live) => liveMarketStatus(held, live)),
    );
    expect(table).toEqual([
      // held 'draft'  — nothing is newer only for itself; settled/voided change the list.
      ['draft', 'open', 'closed', 'resolved', 'draft', 'draft'],
      ['open', 'open', 'closed', 'resolved', 'open', 'open'],
      ['closed', 'closed', 'closed', 'resolved', 'closed', 'closed'],
      ['resolved', 'resolved', 'resolved', 'resolved', 'resolved', 'resolved'],
      // held 'settled' — already in 정산 이력, so a terminal live status is same-list.
      ['settled', 'settled', 'settled', 'settled', 'settled', 'voided'],
      ['voided', 'voided', 'voided', 'voided', 'voided', 'voided'],
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
    expect(positionListStatusFor('voided')).toBe('settled');
    expect(positionListStatusFor('settled')).toBe('settled');
    // Trading has stopped in these two and nothing has been paid out yet: the rows are still
    // open holdings, and asking for the settled list would empty the card the other way.
    expect(positionListStatusFor('closed')).toBe('open');
    expect(positionListStatusFor('resolved')).toBe('open');
    expect(positionListStatusFor('open')).toBe('open');
    // A draft never reaches the detail route (the API 404s it), but the prop is typed over
    // every status, so it must still answer with the list that exists.
    expect(positionListStatusFor('draft')).toBe('open');
  });

  it('classifies every status, so a new one cannot fall to a list by default', () => {
    // Pinned as the whole table rather than as a predicate: a status added to MARKET_STATUSES
    // fails this with the pair it was silently given, which is the decision that has to be
    // made deliberately — the wrong default is invisible on screen, it just empties the card.
    expect(MARKET_STATUSES.map((status) => [status, positionListStatusFor(status)])).toEqual([
      ['draft', 'open'],
      ['open', 'open'],
      ['closed', 'open'],
      ['resolved', 'open'],
      ['settled', 'settled'],
      ['voided', 'settled'],
    ]);
  });
});

describe('positionsQueryOptions', () => {
  it('sends no request until the session says somebody is signed in', () => {
    expect(positionsQueryOptions('open').enabled).toBe(false);
    expect(positionsQueryOptions('open', null).enabled).toBe(false);
    expect(positionsQueryOptions('open', SESSION).enabled).toBe(true);
  });

  it('keys the two lists apart under the one root the socket invalidates', async () => {
    // `user:position` invalidates POSITIONS_KEY once; react-query matches by key prefix, so
    // that must reach both the open holdings and the settled history — and nothing else.
    const open = positionsQueryOptions('open', SESSION);
    const settled = positionsQueryOptions('settled', SESSION);
    expect(open.queryKey).toEqual(positionsKey('open'));
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
