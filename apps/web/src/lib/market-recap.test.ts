import { MARKET_STATUSES, type MarketStatus } from '@buddha/shared';
import { type InfiniteData, InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import { positionFixture } from '@/test/positions';
import type { MySettlement } from './api';
import {
  type RecapViewInput,
  cancelEarlierRecordReads,
  marketHistoryLinks,
  positionEmptyCopy,
  recapViewOf,
  recordsReadingOf,
  recordsStaleTime,
  settledRecapOf,
} from './market-recap';
import { myHistoryPath } from './my-history';
import { restartQueries } from './query-client';

/**
 * 종료 시장의 복기 (#34, ADR-0145; ADR-0135 I1·I3, F2, 결과 4): which body the detail's 내 포지션
 * draws, the contracts of a paid-out market as figures read and never worked out, the empty line
 * once trading has ended, and the three ways to MY's history of this market.
 */

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

/** A winning YES held at 2 for 60, paid 100 each; 12 realised by an earlier sale. */
const WON: MySettlement = {
  marketId: MARKET,
  marketSlug: 'rate-cut-2026',
  marketTitle: '기준금리 인하?',
  outcome: 'YES',
  result: 'YES',
  qty: 2,
  costBasisCoin: '60',
  payoutPerContractCoin: 100,
  payoutCoin: '200',
  settlementPnlCoin: '140',
  resolvedAt: '2026-11-15T01:00:00.000Z',
  settledAt: '2026-11-16T02:00:00.000Z',
  correctedResult: null,
};

/** The paid-out row: the payout left it at 0, its 실현 손익 the cumulative 12 + 140. */
const settledRow = (over: Parameters<typeof positionFixture>[0] = {}) =>
  positionFixture({
    marketStatus: 'settled',
    resolvedResult: 'YES',
    settled: true,
    qty: 0,
    costBasisCoin: '0',
    realizedPnlCoin: '152',
    ...over,
  });

const answered = { pending: false, readAfterMount: true, failed: false, count: 1 };

function view(over: Partial<RecapViewInput> & Pick<RecapViewInput, 'status'>) {
  return recapViewOf({
    list: over.status === 'settled' || over.status === 'cancelled' ? 'settled' : 'open',
    positions: 'rows',
    records: answered,
    ...over,
  });
}

describe('recapViewOf', () => {
  it('never draws a recap before 지급 완료, whatever the records say (수용 기준 8, F2)', () => {
    for (const status of ['closed', 'provisional', 'resolved', 'settling'] as const) {
      for (const records of [
        answered,
        { pending: true, readAfterMount: false, failed: false, count: 0 },
        { pending: false, readAfterMount: true, failed: true, count: 0 },
      ]) {
        expect(view({ status, records }), status).toBe('holding');
      }
      expect(view({ status, positions: 'empty' }), status).toBe('empty');
    }
  });

  it('waits for the records on a paid-out market', () => {
    expect(
      view({
        status: 'settled',
        records: { pending: true, readAfterMount: false, failed: false, count: 0 },
      }),
    ).toBe('pending');
  });

  it('decides nothing from a list cached before this mount — not 없음, not 보유 없음', () => {
    const cached = { pending: false, readAfterMount: false, failed: false, count: 0 };
    expect(view({ status: 'settled', records: cached })).toBe('pending');
    expect(view({ status: 'settled', positions: 'empty', records: cached })).toBe('pending');
  });

  it('draws the recap from the records though the positions list came back empty', () => {
    expect(view({ status: 'settled', positions: 'empty' })).toBe('recap');
    expect(view({ status: 'settled' })).toBe('recap');
    // Sold out before the payout: rows, no record.
    expect(view({ status: 'settled', records: { ...answered, count: 0 } })).toBe('recap');
  });

  it('says 없음 on a paid-out market only when both lists answered with nothing', () => {
    expect(
      view({ status: 'settled', positions: 'empty', records: { ...answered, count: 0 } }),
    ).toBe('empty');
  });

  it('draws no figure when the records’ first read failed', () => {
    expect(view({ status: 'settled', records: { ...answered, failed: true, count: 0 } })).toBe(
      'recordsFailed',
    );
  });

  it('keeps the positions list’s own rungs first', () => {
    expect(view({ status: 'settled', positions: 'pending' })).toBe('pending');
    expect(view({ status: 'settled', positions: 'failed' })).toBe('failed');
    expect(view({ status: 'open', positions: 'failed' })).toBe('failed');
  });

  it('never waits for records on a cancelled market (the query is off there)', () => {
    const off = { pending: true, readAfterMount: false, failed: false, count: 0 };
    expect(view({ status: 'cancelled', records: off })).toBe('ended');
    expect(view({ status: 'cancelled', positions: 'empty', records: off })).toBe('empty');
  });
});

describe('recordsReadingOf: only a list read on this mount decides (결정 3-5)', () => {
  const MOUNTED = 1_000_000;
  const state = {
    isPending: false,
    isLoadingError: false,
    isRefetchError: false,
    isFetching: false,
    dataUpdatedAt: MOUNTED - 60_000,
  };

  it('is no reading over a list cached before the mount', () => {
    expect(recordsReadingOf(state, MOUNTED, 0)).toEqual({
      pending: false,
      readAfterMount: false,
      failed: false,
      count: 0,
    });
  });

  it('is a failure when the mount’s read failed over that list — never 보유 없음', () => {
    const reading = recordsReadingOf({ ...state, isRefetchError: true }, MOUNTED, 0);
    expect(reading.failed).toBe(true);
    // A paid holder whose rows are there, over a pre-payout empty list: no recap.
    expect(view({ status: 'settled', records: reading })).toBe('recordsFailed');
    expect(view({ status: 'settled', positions: 'empty', records: reading })).toBe('recordsFailed');
  });

  it('keeps a list read on this mount when a later read fails (the card’s stale notice)', () => {
    const reading = recordsReadingOf(
      { ...state, isRefetchError: true, dataUpdatedAt: MOUNTED + 5 },
      MOUNTED,
      1,
    );
    expect(reading).toMatchObject({ readAfterMount: true, failed: false });
    expect(view({ status: 'settled', records: reading })).toBe('recap');
  });

  it('is a failure when the first read failed with no list', () => {
    const reading = recordsReadingOf(
      { ...state, isLoadingError: true, dataUpdatedAt: 0 },
      MOUNTED,
      0,
    );
    expect(view({ status: 'settled', records: reading })).toBe('recordsFailed');
  });

  it('waits on the skeleton while the mount’s read runs over an earlier failed refetch', () => {
    // The entry stays in 'error' with its list through the fetch (query-core keeps the status).
    const reading = recordsReadingOf(
      { ...state, isRefetchError: true, isFetching: true, dataUpdatedAt: MOUNTED - 1 },
      MOUNTED,
      0,
    );
    expect(reading.failed).toBe(false);
    expect(view({ status: 'settled', records: reading })).toBe('pending');
    expect(view({ status: 'settled', positions: 'empty', records: reading })).toBe('pending');
  });

  it('waits on the skeleton while a retry of a failed first read runs', () => {
    const reading = recordsReadingOf(
      { ...state, isLoadingError: true, isFetching: true, dataUpdatedAt: 0 },
      MOUNTED,
      0,
    );
    expect(view({ status: 'settled', records: reading })).toBe('pending');
  });
});

describe('recordsStaleTime: a query turned on over an older cached list reads (결정 3-5)', () => {
  const KEY = ['settlements', 'recap-test'];
  type Page = { items: MySettlement[]; nextCursor: string | null };
  const EMPTY: InfiniteData<Page, string | undefined> = {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  };
  type StaleTimeOf = (mountedAt: number) => number | ((query: RecordsStaleQuery) => number);
  type RecordsStaleQuery = { state: { dataUpdatedAt: number } };

  /**
   * A detail mounted while the market was settling over a fresh empty list MY's history cached
   * earlier, then the market paid out: the query turns on (`useBaseQuery`'s `setOptions`).
   */
  async function payOutWhileOpen(staleTime: StaleTimeOf, fail = false) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const mountedAt = Date.now();
    client.setQueryData(KEY, EMPTY, { updatedAt: mountedAt - 60_000 });
    const queryFn = vi.fn((): Promise<Page> =>
      fail
        ? Promise.reject(new Error('down'))
        : Promise.resolve({ items: [WON], nextCursor: null }),
    );
    const options = (enabled: boolean) => ({
      queryKey: KEY,
      queryFn,
      initialPageParam: undefined as string | undefined,
      getNextPageParam: () => undefined,
      refetchOnMount: 'always' as const,
      staleTime: staleTime(mountedAt),
      enabled,
    });
    const observer = new InfiniteQueryObserver(client, options(false));
    const unsubscribe = observer.subscribe(() => {});
    try {
      expect(queryFn).not.toHaveBeenCalled();
      observer.setOptions(options(true));
      await vi.waitFor(() => {
        expect(observer.getCurrentResult().fetchStatus).toBe('idle');
      });
      const result = observer.getCurrentResult();
      return { calls: queryFn.mock.calls.length, result, mountedAt };
    } finally {
      unsubscribe();
      client.clear();
    }
  }

  it('reads the records once when the market pays out on an open detail', async () => {
    const { calls, result, mountedAt } = await payOutWhileOpen(recordsStaleTime);
    expect(calls).toBe(1);
    const count = result.data?.pages.flatMap((page) => page.items).length ?? 0;
    expect(view({ status: 'settled', records: recordsReadingOf(result, mountedAt, count) })).toBe(
      'recap',
    );
  });

  it('is what a plain Infinity missed: no read, and the card waited on its skeleton', async () => {
    const { calls } = await payOutWhileOpen(() => Infinity);
    expect(calls).toBe(0);
  });

  it('draws the failure, not 보유 없음, when that read fails', async () => {
    const { result, mountedAt } = await payOutWhileOpen(recordsStaleTime, true);
    expect(view({ status: 'settled', records: recordsReadingOf(result, mountedAt, 0) })).toBe(
      'recordsFailed',
    );
  });

  it('asks nothing again once a list was read on this mount', () => {
    const stale = recordsStaleTime(1_000);
    expect(stale({ state: { dataUpdatedAt: 999 } })).toBe(0);
    expect(stale({ state: { dataUpdatedAt: 1_000 } })).toBe(Infinity);
    expect(stale({ state: { dataUpdatedAt: 1_500 } })).toBe(Infinity);
  });
});

describe('cancelEarlierRecordReads: a read out at the mount is not this mount’s (결정 3-5)', () => {
  const KEY = ['settlements', 'recap-in-flight'];
  type Page = { items: MySettlement[]; nextCursor: string | null };
  const paging = {
    initialPageParam: undefined as string | undefined,
    getNextPageParam: () => undefined,
  };

  /**
   * MY's history refetches this market's records before the payout and is left while that read
   * is out; the payout's `user:position` restart finds the entry unwatched and only marks it; the
   * paid-out detail then mounts, and only after that does the old read answer — with no record.
   */
  async function openWhileHistoryReadIsOut(cancelFirst: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(
      KEY,
      { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] },
      { updatedAt: Date.now() - 60_000 },
    );
    let answerOld: (page: Page) => void = () => {};
    const historyFn = vi.fn(
      () =>
        new Promise<Page>((resolve) => {
          answerOld = resolve;
        }),
    );
    const history = new InfiniteQueryObserver(client, {
      queryKey: KEY,
      queryFn: historyFn,
      ...paging,
    });
    const leaveHistory = history.subscribe(() => {});
    expect(historyFn).toHaveBeenCalledTimes(1);
    leaveHistory();
    await restartQueries(client, KEY);

    const mountedAt = Date.now();
    if (cancelFirst) cancelEarlierRecordReads(client, KEY);
    const cardFn = vi.fn((): Promise<Page> => Promise.resolve({ items: [WON], nextCursor: null }));
    const card = new InfiniteQueryObserver(client, {
      queryKey: KEY,
      queryFn: cardFn,
      ...paging,
      refetchOnMount: 'always',
      staleTime: recordsStaleTime(mountedAt),
    });
    const unmount = card.subscribe(() => {});
    try {
      answerOld({ items: [], nextCursor: null });
      await vi.waitFor(() => {
        expect(card.getCurrentResult().fetchStatus).toBe('idle');
      });
      const result = card.getCurrentResult();
      const count = result.data?.pages.flatMap((page) => page.items).length ?? 0;
      return {
        calls: historyFn.mock.calls.length + cardFn.mock.calls.length,
        cardCalls: cardFn.mock.calls.length,
        reading: recordsReadingOf(result, mountedAt, count),
        stale: result.isStale,
      };
    } finally {
      unmount();
      client.clear();
    }
  }

  it('asks again on the mount and draws the payout, not the old read’s empty list', async () => {
    const { calls, cardCalls, reading, stale } = await openWhileHistoryReadIsOut(true);
    // The history's read already left; the card adds its one read and no other.
    expect(calls).toBe(2);
    expect(cardCalls).toBe(1);
    expect(reading).toMatchObject({ readAfterMount: true, failed: false, count: 1 });
    expect(view({ status: 'settled', records: reading })).toBe('recap');
    expect(stale).toBe(false);
  });

  it('is what the mount alone did: it joined the old read and took its empty list', async () => {
    const { cardCalls, reading, stale } = await openWhileHistoryReadIsOut(false);
    expect(cardCalls).toBe(0);
    // Taken as this mount's list and fresh for good: a paid holder's rows drew 보유 없음.
    expect(reading).toMatchObject({ readAfterMount: true, failed: false, count: 0 });
    expect(stale).toBe(false);
  });

  it('cancels nothing when no read is out', () => {
    const client = new QueryClient();
    client.setQueryData(KEY, { pages: [], pageParams: [] });
    const before = client.getQueryState(KEY);
    cancelEarlierRecordReads(client, KEY);
    expect(client.getQueryState(KEY)).toEqual(before);
    client.clear();
  });
});

describe('settledRecapOf', () => {
  it('takes every settlement figure from the record and 실현 손익 from the row as it is', () => {
    const [yes] = settledRecapOf([settledRow()], [WON]);
    expect(yes).toEqual({ kind: 'record', outcome: 'YES', record: WON, realizedPnlCoin: '152' });
    // The quantity is the record's — 2 held at the payout — never the row's 0.
    expect(yes?.kind === 'record' && yes.record.qty).toBe(2);
  });

  it('keeps a losing contract’s record: a payout of 0 and its loss', () => {
    const lost: MySettlement = {
      ...WON,
      outcome: 'NO',
      payoutPerContractCoin: 0,
      payoutCoin: '0',
      costBasisCoin: '140',
      settlementPnlCoin: '-140',
    };
    expect(
      settledRecapOf([settledRow({ outcome: 'NO', realizedPnlCoin: '-140' })], [lost]),
    ).toEqual([{ kind: 'record', outcome: 'NO', record: lost, realizedPnlCoin: '-140' }]);
  });

  it('draws 무효 as 50 a contract with the P&L its price makes', () => {
    const voided: MySettlement = {
      ...WON,
      result: 'VOID',
      costBasisCoin: '140',
      payoutPerContractCoin: 50,
      payoutCoin: '100',
      settlementPnlCoin: '-40',
    };
    const [entry] = settledRecapOf([settledRow({ resolvedResult: 'VOID' })], [voided]);
    expect(entry?.kind === 'record' && entry.record).toMatchObject({
      result: 'VOID',
      payoutPerContractCoin: 50,
      settlementPnlCoin: '-40',
    });
  });

  it('shows a contract sold out before the payout as no holding, never a 정산 손익 of 0', () => {
    expect(settledRecapOf([settledRow({ realizedPnlCoin: '25' })], [])).toEqual([
      { kind: 'soldOut', outcome: 'YES', result: 'YES', realizedPnlCoin: '25' },
    ]);
  });

  it('draws a record whose row is missing with its 실현 손익 unknown', () => {
    expect(settledRecapOf([], [WON])).toEqual([
      { kind: 'record', outcome: 'YES', record: WON, realizedPnlCoin: null },
    ]);
  });

  it('puts YES first and pairs each record with its own contract’s row', () => {
    const no: MySettlement = { ...WON, outcome: 'NO', payoutCoin: '0', settlementPnlCoin: '-60' };
    const entries = settledRecapOf(
      [settledRow({ outcome: 'NO', realizedPnlCoin: '-60' }), settledRow()],
      [no, WON],
    );
    expect(entries.map((entry) => [entry.outcome, entry.realizedPnlCoin])).toEqual([
      ['YES', '152'],
      ['NO', '-60'],
    ]);
  });
});

describe('positionEmptyCopy', () => {
  it('says only that nothing is held once trading has ended, the old line before that', () => {
    const ended: MarketStatus[] = [
      'closed',
      'provisional',
      'resolved',
      'settling',
      'settled',
      'cancelled',
    ];
    for (const status of MARKET_STATUSES) {
      expect(positionEmptyCopy(status), status).toBe(
        ended.includes(status) ? copy.marketMyPositionEmptyEnded : copy.marketMyPositionEmpty,
      );
    }
    expect(positionEmptyCopy(undefined)).toBe(copy.marketMyPositionEmpty);
  });
});

describe('marketHistoryLinks', () => {
  it('opens MY’s history of this market: its fills, its records and its ended orders', () => {
    expect(marketHistoryLinks(MARKET)).toEqual({
      fills: myHistoryPath({ kind: 'fills', market: MARKET }),
      settlements: myHistoryPath({ kind: 'settlements', market: MARKET }),
      orders: myHistoryPath({ market: MARKET }),
    });
    expect(marketHistoryLinks(MARKET.toUpperCase()).settlements).toBe(
      `/my/history?kind=settlements&market=${MARKET}`,
    );
    expect(marketHistoryLinks(MARKET).orders).toBe(`/my/history?market=${MARKET}`);
  });
});
