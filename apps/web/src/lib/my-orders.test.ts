import { QueryClient, hashKey, partialMatchKey } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type MyFill, type Order } from './api';
import {
  MY_MARKET_FILLS_KEY,
  MY_ORDERS_LIVE_KEY,
  MY_ORDER_DETAIL_KEY,
  MY_ORDER_FILLS_KEY,
  ORDERS_KEY,
  isPrivateQueryKey,
  marketBookKey,
  myMarketFillsKey,
  myOrderFillsKey,
  myOrderKey,
  myOrdersLiveKey,
} from './market-keys';
import {
  type NoticeLog,
  type OrderPages,
  cancelOutcomeOf,
  cancelTargetOrder,
  endedCandidates,
  endedManyText,
  endedNotice,
  joinOrder,
  joinOrderPages,
  liveRowsOnly,
  noticeOnce,
  orderTimeline,
  refreshAfterOwnCancel,
  remainingQty,
  rowInPlaceOf,
  showsCancelling,
  timelineStale,
  withOrderInPages,
} from './my-orders';
import { getQueryClient } from './query-client';

/**
 * 대기 주문과 주문 상세 (#123, ADR-0141): the rules the lists, the detail and the cancel draw by.
 */

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const ORDER = '9c858901-8a57-4791-81fe-4c455b099bc9';
const A = 'account-a';
const B = 'account-b';

function order(over: Partial<Order> = {}): Order {
  return {
    id: ORDER,
    requestId: 'request-1',
    marketId: MARKET,
    marketSlug: 'rate-cut-2026',
    marketTitle: '기준금리 인하?',
    outcome: 'NO',
    side: 'buy',
    timeInForce: 'gtc',
    limitPriceCoin: 40,
    protectedLimitPriceCoin: 40,
    qty: 3,
    budgetCoin: null,
    filledQty: 0,
    filledAmountCoin: '0',
    cancelledQty: 0,
    unspentCoin: null,
    status: 'open',
    rejectReason: null,
    cancelReason: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    endedAt: null,
    awaitingRecovery: false,
    ...over,
  };
}

function fill(id: string, qty: number, over: Partial<MyFill> = {}): MyFill {
  return {
    id,
    orderId: ORDER,
    marketId: MARKET,
    marketSlug: 'rate-cut-2026',
    marketTitle: '기준금리 인하?',
    outcome: 'NO',
    side: 'buy',
    qty,
    priceCoin: 40,
    amountCoin: String(40 * qty),
    yesPriceCoin: 60,
    feeCoin: '0',
    createdAt: `2026-11-16T00:0${id}:00.000Z`,
    ...over,
  };
}

const ENDED = '2026-11-16T01:00:00.000Z';
const cancelledByOwner = (filledQty: number) =>
  order({
    status: 'cancelled',
    cancelReason: 'by_owner',
    filledQty,
    filledAmountCoin: String(40 * filledQty),
    cancelledQty: 3 - filledQty,
    endedAt: ENDED,
  });

const labels = (rows: { label: string }[]) => rows.map((row) => row.label);

describe('the keys (#123): under the orders root, lower-cased ids, the account last', () => {
  it('names the account and lower-cases every id', () => {
    expect(myOrdersLiveKey(A)).toEqual(['orders', 'live', 'all', A]);
    expect(myOrdersLiveKey(A, MARKET.toUpperCase())).toEqual(['orders', 'live', MARKET, A]);
    expect(myOrderKey(ORDER.toUpperCase(), A)).toEqual(['orders', 'detail', ORDER, A]);
    expect(myOrderFillsKey(ORDER.toUpperCase(), A)).toEqual(['orders', 'fills', ORDER, A]);
    expect(myMarketFillsKey(MARKET.toUpperCase(), A)).toEqual([
      'orders',
      'market-fills',
      MARKET,
      A,
    ]);
    expect(hashKey(myOrderKey(ORDER, A))).not.toBe(hashKey(myOrderKey(ORDER, B)));
  });

  it('sits under ORDERS_KEY — private, reset, re-read by user:position — and never the history list', () => {
    for (const key of [
      myOrdersLiveKey(A),
      myOrderKey(ORDER, A),
      myOrderFillsKey(ORDER, A),
      myMarketFillsKey(MARKET, A),
    ]) {
      expect(partialMatchKey(key, ORDERS_KEY)).toBe(true);
      expect(isPrivateQueryKey(key)).toBe(true);
    }
    expect(partialMatchKey(myOrdersLiveKey(A), MY_ORDERS_LIVE_KEY)).toBe(true);
    expect(partialMatchKey(myOrderKey(ORDER, A), MY_ORDER_DETAIL_KEY)).toBe(true);
    expect(partialMatchKey(myOrderFillsKey(ORDER, A), MY_ORDER_FILLS_KEY)).toBe(true);
    expect(partialMatchKey(myMarketFillsKey(MARKET, A), MY_MARKET_FILLS_KEY)).toBe(true);
    // The history list's `['orders']` takes none of the live join.
    expect(partialMatchKey(ORDERS_KEY, MY_ORDERS_LIVE_KEY)).toBe(false);
    expect(partialMatchKey(ORDERS_KEY, MY_ORDER_DETAIL_KEY)).toBe(false);
  });
});

describe('remainingQty', () => {
  it('is what a quantity order still rests with, none for a budget order', () => {
    expect(remainingQty(order({ filledQty: 1 }))).toBe(2);
    expect(remainingQty(order({ qty: null, budgetCoin: '300' }))).toBeNull();
  });
});

describe('orderTimeline (결정 7)', () => {
  it('is 접수 alone while nothing filled', () => {
    const rows = orderTimeline(order(), [], true);
    expect(rows).toEqual([{ id: 'accepted', at: order().createdAt, label: '접수' }]);
  });

  it('says each fill with the state it left, then 취소 완료(본인 취소) at the end', () => {
    const rows = orderTimeline(cancelledByOwner(1), [fill('1', 1)], true);
    expect(labels(rows)).toEqual([
      '접수',
      '체결 1계약 @40.00 Coin · 부분 체결',
      '취소 완료(본인 취소)',
    ]);
    expect(rows.at(-1)?.at).toBe(ENDED);
  });

  it('ends a quantity order’s 전량 체결 on its last fill line, oldest fill first', () => {
    const filled = order({ status: 'filled', filledQty: 3, endedAt: ENDED });
    // The API pages newest first.
    const rows = orderTimeline(filled, [fill('2', 2), fill('1', 1)], true);
    expect(labels(rows)).toEqual([
      '접수',
      '체결 1계약 @40.00 Coin · 부분 체결',
      '체결 2계약 @40.00 Coin · 전량 체결',
    ]);
  });

  it('says an immediate order’s 즉시 거래 잔량 and 자기 체결 by their names', () => {
    const ioc = (cancelReason: 'ioc_remainder' | 'self_trade') =>
      order({
        timeInForce: 'ioc',
        status: 'cancelled',
        cancelReason,
        filledQty: 1,
        cancelledQty: 2,
        endedAt: ENDED,
      });
    expect(labels(orderTimeline(ioc('ioc_remainder'), [fill('1', 1)], true)).at(-1)).toBe(
      '취소 완료(즉시 거래 잔량)',
    );
    expect(labels(orderTimeline(ioc('self_trade'), [fill('1', 1)], true)).at(-1)).toBe(
      '취소 완료(자기 체결)',
    );
  });

  it('names no state on a budget order’s fills, and ends it 전량 체결', () => {
    const budget = order({
      qty: null,
      budgetCoin: '100',
      timeInForce: 'ioc',
      status: 'filled',
      filledQty: 2,
      endedAt: ENDED,
    });
    expect(labels(orderTimeline(budget, [fill('1', 2)], true))).toEqual([
      '접수',
      '체결 2계약 @40.00 Coin',
      '전량 체결',
    ]);
  });

  it('is one line for a 거절, never 접수', () => {
    const rejected = order({ status: 'rejected', rejectReason: 'ledger_hold', endedAt: ENDED });
    expect(labels(orderTimeline(rejected, [], true))).toEqual(['거절(계정 확인 중)']);
  });

  it('ends a 만료 with its state alone', () => {
    const expired = order({ status: 'expired', filledQty: 1, cancelledQty: 2, endedAt: ENDED });
    expect(labels(orderTimeline(expired, [fill('1', 1)], true))).toEqual([
      '접수',
      '체결 1계약 @40.00 Coin · 부분 체결',
      '만료',
    ]);
  });

  it('opens with the earlier quantity and names no state while the fills are read in part', () => {
    const partly = order({ status: 'partially_filled', filledQty: 2 });
    expect(labels(orderTimeline(partly, [fill('2', 1)], false))).toEqual([
      '접수',
      `${copy.orderTimelineEarlierHead} 1계약 ${copy.orderTimelineEarlierTail}`,
      '체결 1계약 @40.00 Coin',
    ]);
  });

  it('draws no line from fills while they are not read at all (pending or failed)', () => {
    const partly = order({ status: 'partially_filled', filledQty: 2 });
    expect(labels(orderTimeline(partly, [], null))).toEqual(['접수']);
    // A quantity order filled whole: its end stays on the history — no last fill line says it yet.
    const filled = order({ status: 'filled', filledQty: 2, endedAt: ENDED });
    expect(labels(orderTimeline(filled, [], null))).toEqual(['접수', '전량 체결']);
  });

  it('names no state when the two readings disagree, and says which to read again', () => {
    const partly = order({ status: 'partially_filled', filledQty: 1 });
    // The fills add up to more: the order is the older reading.
    expect(labels(orderTimeline(partly, [fill('2', 1), fill('1', 1)], true))).toEqual([
      '접수',
      '체결 1계약 @40.00 Coin',
      '체결 1계약 @40.00 Coin',
    ]);
    expect(timelineStale(partly, [fill('2', 1), fill('1', 1)], true)).toBe('order');
    // To less: the fills are.
    expect(timelineStale(order({ filledQty: 2 }), [fill('1', 1)], true)).toBe('fills');
    expect(timelineStale(partly, [fill('1', 1)], true)).toBeNull();
    // Not all read: nothing to compare yet.
    expect(timelineStale(order({ filledQty: 2 }), [fill('1', 1)], false)).toBeNull();
  });
});

describe('joinOrder and joinOrderPages (결정 8)', () => {
  const pages = (...items: Order[]): OrderPages => ({
    pages: [{ items, nextCursor: null }],
    pageParams: [undefined],
  });

  it('keeps an ended order against a late live reading, and a fill against an older one', () => {
    const ended = cancelledByOwner(1);
    expect(joinOrder(ended, order())).toBe(ended);
    const partly = order({ status: 'partially_filled', filledQty: 2 });
    expect(joinOrder(partly, order({ filledQty: 1, status: 'partially_filled' }))).toBe(partly);
    expect(joinOrder(order(), partly)).toBe(partly);
    expect(joinOrder(undefined, partly)).toBe(partly);
  });

  it('takes the newer fields at the same rank (복구 대기 coming and going)', () => {
    const held = order({ awaitingRecovery: true });
    expect(joinOrder(order(), held)).toBe(held);
    expect(joinOrder(held, order())).toEqual(order());
  });

  it('joins the pages row by row, the pages and cursors the answer’s', () => {
    const ended = cancelledByOwner(1);
    const other = order({ id: 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46' });
    const joined = joinOrderPages(pages(ended), {
      pages: [{ items: [order(), other], nextCursor: 'next' }],
      pageParams: [undefined],
    });
    expect(joined.pages[0]?.items).toEqual([ended, other]);
    expect(joined.pages[0]?.nextCursor).toBe('next');
    // And the live select takes the ended row out.
    expect(liveRowsOnly(joined).pages[0]?.items).toEqual([other]);
  });

  it('writes an answer only into the pages that hold its order', () => {
    const answer = cancelledByOwner(0);
    expect(withOrderInPages(pages(order()), answer)?.pages[0]?.items).toEqual([answer]);
    expect(withOrderInPages(pages(order({ id: 'x' })), answer)).toBeUndefined();
    expect(withOrderInPages(undefined, answer)).toBeUndefined();
  });

  it('is the cache’s own join: a late GET cannot put 대기 back over the cancel’s answer', () => {
    const client = getQueryClient();
    const key = myOrderKey(ORDER, A);
    client.setQueryData(key, cancelledByOwner(1));
    client.setQueryData(key, order({ status: 'partially_filled', filledQty: 1 }));
    expect(client.getQueryData<Order>(key)?.status).toBe('cancelled');
    const live = myOrdersLiveKey(A);
    client.setQueryData(live, pages(cancelledByOwner(1)));
    client.setQueryData(live, pages(order()));
    expect(client.getQueryData<OrderPages>(live)?.pages[0]?.items[0]?.status).toBe('cancelled');
    client.clear();
  });
});

describe('cancelOutcomeOf (결정 5)', () => {
  type Envelope = ConstructorParameters<typeof ApiError>[1];
  const error = (status: number, code: string, details?: unknown) =>
    new ApiError(status, {
      code,
      message: code,
      ...(details === undefined ? {} : { details }),
    } as Envelope);

  it('reads a 200 as the order’s final state, 본인 취소 or the end it met first', () => {
    expect(cancelOutcomeOf({ order: cancelledByOwner(1) })).toMatchObject({
      kind: 'done',
      own: true,
    });
    const filled = order({ status: 'filled', filledQty: 3, endedAt: ENDED });
    expect(cancelOutcomeOf({ order: filled })).toMatchObject({ kind: 'done', own: false });
    const paused = order({ status: 'cancelled', cancelReason: 'paused', endedAt: ENDED });
    expect(cancelOutcomeOf({ order: paused })).toMatchObject({ kind: 'done', own: false });
  });

  it('tells each refusal apart', () => {
    const paused = [{ path: ['market'], message: 'paused' }];
    expect(cancelOutcomeOf({ error: error(409, 'MARKET_NOT_OPEN', paused) })).toEqual({
      kind: 'held',
    });
    expect(cancelOutcomeOf({ error: error(404, 'NOT_FOUND') })).toEqual({ kind: 'notFound' });
    const account = [{ path: ['expectedAccountId'], message: 'not the session' }];
    expect(cancelOutcomeOf({ error: error(403, 'FORBIDDEN', account) })).toEqual({
      kind: 'anotherAccount',
    });
    expect(cancelOutcomeOf({ error: error(403, 'FORBIDDEN') })).toEqual({ kind: 'forbidden' });
    expect(cancelOutcomeOf({ error: error(401, 'UNAUTHENTICATED') })).toEqual({
      kind: 'signedOut',
    });
    expect(cancelOutcomeOf({ error: error(500, 'INTERNAL') })).toEqual({ kind: 'unknown' });
    expect(cancelOutcomeOf({ error: new TypeError('Failed to fetch') })).toEqual({
      kind: 'unknown',
    });
  });
});

describe('showsCancelling (결정 4)', () => {
  it('is a cancel in flight on a live order, and never on an ended one', () => {
    expect(showsCancelling(true, order())).toBe(true);
    expect(showsCancelling(true, order({ status: 'partially_filled', filledQty: 1 }))).toBe(true);
    expect(showsCancelling(false, order())).toBe(false);
    for (const status of ['filled', 'cancelled', 'expired'] as const) {
      expect(showsCancelling(true, order({ status })), status).toBe(false);
    }
  });
});

describe('cancelTargetOrder: what the cancel’s confirmation draws (결정 4)', () => {
  const opened = order();

  it('draws the list’s row joined with the detail key’s, the fresher of the two', () => {
    const filled = order({ status: 'partially_filled', filledQty: 1 });
    expect(cancelTargetOrder(ORDER, filled, opened, undefined)).toBe(filled);
    expect(cancelTargetOrder(ORDER, opened, opened, filled)).toBe(filled);
    // A late detail that ranks below the row changes nothing.
    expect(cancelTargetOrder(ORDER, filled, opened, order())).toBe(filled);
  });

  it('keeps the row as it opened once a newer order pushed it past the loaded pages', () => {
    // Not in the list any more and no detail held yet: the dialog keeps its body and its button.
    expect(cancelTargetOrder(ORDER, undefined, opened, undefined)).toBe(opened);
    // The detail asked for it answers: the freshest value is drawn — a fill, or its end.
    const filled = order({ status: 'partially_filled', filledQty: 2 });
    expect(cancelTargetOrder(ORDER, undefined, opened, filled)).toBe(filled);
    expect(cancelTargetOrder(ORDER, undefined, opened, cancelledByOwner(0))?.status).toBe(
      'cancelled',
    );
  });

  it('draws nothing while closed, nor another order’s reading', () => {
    expect(cancelTargetOrder(null, opened, opened, opened)).toBeUndefined();
    const other = order({ id: '0b0b0b0b-0000-4000-8000-0000000000ff' });
    expect(cancelTargetOrder(ORDER, undefined, other, other)).toBeUndefined();
  });
});

describe('rowInPlaceOf: where the focus goes once its row left (결정 4)', () => {
  it('is the row now in its place, else the one above it, else the list (null)', () => {
    expect(rowInPlaceOf(['1', '2', '3'], ['1', '3'], '2')).toBe('3');
    expect(rowInPlaceOf(['1', '2', '3'], ['1', '2'], '3')).toBe('2');
    expect(rowInPlaceOf(['1'], [], '1')).toBeNull();
  });

  it('is nothing for a row the list did not draw', () => {
    expect(rowInPlaceOf(['1'], ['1'], '9')).toBeUndefined();
  });
});

describe('endedCandidates (결정 6)', () => {
  it('is what left the list since the last read, a row slid past the pages too', () => {
    expect(endedCandidates({ accountId: A, ids: ['1', '2', '3'] }, A, ['0', '1', '2'])).toEqual([
      '3',
    ]);
    expect(endedCandidates({ accountId: A, ids: ['1', '2'] }, A, ['1', '2'])).toEqual([]);
  });

  it('is nothing before the first read after mount, and nothing across an account change', () => {
    expect(endedCandidates(undefined, A, [])).toEqual([]);
    expect(endedCandidates({ accountId: A, ids: ['1'] }, B, [])).toEqual([]);
  });
});

describe('noticeOnce and the notice (결정 6)', () => {
  it('tells an order once, whichever learns of its end first', () => {
    const log: NoticeLog = new Map();
    // The answer first, the read back after.
    expect(noticeOnce(log, A, '1', A)).toBe(true);
    expect(noticeOnce(log, A, '1', A)).toBe(false);
    // The read back first, the answer after.
    expect(noticeOnce(log, A, '2', A)).toBe(true);
    expect(noticeOnce(log, A, '2', A)).toBe(false);
  });

  it('tells nothing of an account that is not the one on screen', () => {
    const log: NoticeLog = new Map();
    expect(noticeOnce(log, A, '1', B)).toBe(false);
    expect(noticeOnce(log, A, '1', undefined)).toBe(false);
    // Not spent by that: A is still told once it is A's screen again.
    expect(noticeOnce(log, A, '1', A)).toBe(true);
  });

  it('says the market, contract, state and reason, and a 본인 취소’s quantities', () => {
    expect(endedNotice(cancelledByOwner(1))).toEqual({
      title: '기준금리 인하? NO 매수 주문 · 취소 완료(본인 취소)',
      description: '체결 1계약 · 취소 2계약',
    });
    expect(endedNotice(order({ status: 'expired', endedAt: ENDED, marketTitle: null }))).toEqual({
      title: `${copy.postMarketNotPublic} NO 매수 주문 · 만료`,
    });
    expect(endedManyText(3)).toBe('주문 3건이 끝났습니다. 거래·정산 이력에서 확인하세요.');
    expect(endedManyText(null)).toBe(copy.orderEndedSome);
  });
});

describe('refreshAfterOwnCancel (결정 9)', () => {
  it('reads again what an order’s end moves, the market’s book restarted', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    refreshAfterOwnCancel(client, MARKET);
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['me'],
        ['sellable', MARKET],
        ['positions'],
        ['orders'],
        marketBookKey(MARKET),
        ['me', 'closure'],
      ]),
    );
    expect(invalidate.mock.calls[0]?.[0]).toMatchObject({ queryKey: ['me'], exact: true });
  });

  it('restarts a first read still in flight rather than waiting on it (as #66’s afterOrder)', () => {
    const client = new QueryClient();
    const cancel = vi.spyOn(client, 'cancelQueries');
    refreshAfterOwnCancel(client, MARKET);
    const keys = cancel.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['sellable', MARKET],
        ['positions'],
        ['orders'],
        marketBookKey(MARKET),
      ]),
    );
    // `['me']` always holds data: never cancelled, only invalidated.
    expect(keys).not.toContainEqual(['me']);
  });
});
