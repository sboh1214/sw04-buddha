import {
  MAX_P_AMOUNT,
  MINUS_SIGN,
  POSITION_QTY_MAX,
  PRICE_MAX,
  PRICE_MIN,
  formatP,
  parsePAmount,
  serializePAmount,
} from '@buddha/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { type Order, type Position } from '@/lib/api';
import { ORDERS_KEY, POSITIONS_KEY } from '@/lib/market-keys';
import {
  type OrdersPage,
  averageCostP,
  markPriceP,
  ordersInfiniteQueryOptions,
  portfolioTotals,
  positionValueP,
  positionsKey,
  positionsQueryOptions,
  unrealizedPnlP,
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
    costBasisP: '5000',
    realizedPnlP: '0',
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
    amountP: '630',
    priceAvgBp: 6300,
    maxCostP: '700',
    minProceedsP: null,
    createdAt: '2026-09-07T00:00:00.000Z',
  };
}

describe('markPriceP / positionValueP / unrealizedPnlP', () => {
  it('values a YES holding at the market price and a NO holding at its complement', () => {
    // The bug this pins is silent: `qty × marketLastPrice` for a NO row produces a plausible
    // number that is wrong by 100 − 2·price per contract, and the screen has nothing to
    // compare it against. `marketLastPrice` is the YES price, so the NO side is 100 − 63 = 37
    // — the same complement `formatNoPrice` prints under "아니오 37%".
    const yes = position({ outcome: 'YES', marketLastPrice: 63, costBasisP: '5000' });
    const no = position({ outcome: 'NO', marketLastPrice: 63, costBasisP: '5000' });

    expect(markPriceP(yes)).toBe(63n);
    expect(markPriceP(no)).toBe(37n);
    expect(positionValueP(yes)).toBe(6300n);
    expect(positionValueP(no)).toBe(3700n);
    expect(unrealizedPnlP(yes)).toBe(1300n);
    expect(unrealizedPnlP(no)).toBe(-1300n);
    // Both sides of the same market add up to the 100P a winning contract pays.
    expect(markPriceP(yes) + markPriceP(no)).toBe(100n);
  });

  it('holds at both ends of the displayed price range', () => {
    // `priceOf` clamps to 1..99, so the two sides of a market at the floor are 1P and 99P.
    const yesAtFloor = position({ outcome: 'YES', marketLastPrice: PRICE_MIN, qty: 10 });
    const noAtFloor = position({ outcome: 'NO', marketLastPrice: PRICE_MIN, qty: 10 });

    expect(positionValueP(yesAtFloor)).toBe(10n);
    expect(positionValueP(noAtFloor)).toBe(990n);
    expect(markPriceP(position({ outcome: 'YES', marketLastPrice: PRICE_MAX }))).toBe(99n);
    expect(markPriceP(position({ outcome: 'NO', marketLastPrice: PRICE_MAX }))).toBe(1n);
  });

  it('values a fully sold row at zero and keeps its cost off the books', () => {
    // `applySell` leaves the row at qty 0 with costBasis 0 so its realised PnL stays visible;
    // it must not still be marked to market.
    const sold = position({ qty: 0, costBasisP: '0', realizedPnlP: '1200' });

    expect(positionValueP(sold)).toBe(0n);
    expect(unrealizedPnlP(sold)).toBe(0n);
    expect(averageCostP(sold)).toBeUndefined();
  });

  it('renders a loss with the typographic minus sign, not an ASCII hyphen', () => {
    const losing = position({ outcome: 'YES', marketLastPrice: 30, costBasisP: '5000' });

    expect(unrealizedPnlP(losing)).toBe(-2000n);
    expect(formatP(unrealizedPnlP(losing))).toBe(`${MINUS_SIGN}2,000P`);
    expect(formatP(unrealizedPnlP(losing)).startsWith('-')).toBe(false);
  });

  it('applies the same formula to a settled row, which is why the screen must not show it', () => {
    // Settlement never writes a price, so `marketLastPrice` on a settled market is the last
    // price something TRADED at — 71 here, for a market that resolved YES and paid 100P. The
    // arithmetic answers anyway; it is the 정산 이력 section's job to render `realizedPnlP`
    // instead, and `portfolioTotals` is therefore given one list at a time.
    const settled = position({
      marketStatus: 'settled',
      resolvedResult: 'YES',
      settled: true,
      qty: 40,
      marketLastPrice: 71,
      costBasisP: '2000',
      realizedPnlP: '2000',
    });

    expect(positionValueP(settled)).toBe(2840n);
    expect(unrealizedPnlP(settled)).toBe(840n);
    // The row really made 2,000P — 40 winners paid 4,000P against a 2,000P basis — and 840P is
    // the last trade's opinion, not a result. Only `realizedPnlP` is a settled row's answer.
    expect(parsePAmount(settled.realizedPnlP)).toBe(2000n);
  });

  it('stays exact at the domain bounds, where a double has already rounded', () => {
    const bound = position({
      outcome: 'YES',
      qty: POSITION_QTY_MAX,
      marketLastPrice: PRICE_MAX,
      costBasisP: serializePAmount(MAX_P_AMOUNT),
    });

    expect(positionValueP(bound)).toBe(212_600_881_053n);
    expect(unrealizedPnlP(bound)).toBe(212_600_881_053n - MAX_P_AMOUNT);
  });
});

describe('averageCostP', () => {
  it('rounds half-up in bigint, the way applySell releases cost', () => {
    // 100 / 3 = 33.33 → 33; 101 / 2 = 50.5 → 51. Both round the same way the API does, so the
    // 평단 on screen and the cost a sell releases can never drift apart by a P.
    expect(averageCostP(position({ qty: 3, costBasisP: '100' }))).toBe(33n);
    expect(averageCostP(position({ qty: 2, costBasisP: '101' }))).toBe(51n);
    expect(averageCostP(position({ qty: 100, costBasisP: '5000' }))).toBe(50n);
  });
});

describe('portfolioTotals', () => {
  it('sums nothing to zero, including a list that has not loaded', () => {
    expect(portfolioTotals([])).toEqual({
      valueP: 0n,
      costBasisP: 0n,
      unrealizedPnlP: 0n,
      realizedPnlP: 0n,
    });
    expect(portfolioTotals()).toEqual(portfolioTotals([]));
  });

  it('sums a mixed list of winners, losers and closed rows', () => {
    const rows = [
      position({ outcome: 'YES', qty: 10, marketLastPrice: 60, costBasisP: '400' }),
      position({
        outcome: 'NO',
        qty: 20,
        marketLastPrice: 60,
        costBasisP: '900',
        realizedPnlP: '50',
      }),
      position({ qty: 0, marketLastPrice: 60, costBasisP: '0', realizedPnlP: '-250' }),
    ];

    // 10 × 60 = 600, 20 × (100 − 60) = 800, 0.
    expect(portfolioTotals(rows)).toEqual({
      valueP: 1400n,
      costBasisP: 1300n,
      unrealizedPnlP: 100n,
      realizedPnlP: -200n,
    });
    // The total is the sum of the per-row figures, so a row and the summary cannot disagree.
    expect(portfolioTotals(rows).unrealizedPnlP).toBe(
      rows.reduce((sum, row) => sum + unrealizedPnlP(row), 0n),
    );
  });

  it('carries a total past 2^53, where a number implementation silently rounds', () => {
    // Ten positions at the MAX_P_AMOUNT bound cost 10^16 P. Against one holding at the qty and
    // price ceilings the unrealised total is −9,999,787,399,118,947 — odd, and above 2^53,
    // where doubles step by 2. This is the whole reason the module never touches Number.
    const sold = position({ qty: 0, costBasisP: serializePAmount(MAX_P_AMOUNT) });
    const rows = [
      position({
        outcome: 'YES',
        qty: POSITION_QTY_MAX,
        marketLastPrice: PRICE_MAX,
        costBasisP: serializePAmount(MAX_P_AMOUNT),
      }),
      ...Array.from({ length: 9 }, () => sold),
    ];

    const totals = portfolioTotals(rows);

    expect(totals.costBasisP).toBe(10n * MAX_P_AMOUNT);
    expect(totals.valueP).toBe(212_600_881_053n);
    expect(totals.unrealizedPnlP).toBe(-9_999_787_399_118_947n);
    expect(BigInt(Number(totals.unrealizedPnlP))).not.toBe(totals.unrealizedPnlP);
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
