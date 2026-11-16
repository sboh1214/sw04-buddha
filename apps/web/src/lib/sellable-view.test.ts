import { MARKET_STATUSES, type MarketStatus, ORDER_QTY_MAX } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import type { OrderQuote, SellableContract } from './api';
import { initialOrderInput, orderBlock } from './order-panel';
import {
  PANEL_ACCOUNT_LINE_ID,
  POSITION_ACCOUNT_LINE_ID,
  type ReadFacts,
  type SellableRead,
  type SellableReading,
  type SellableRetry,
  positionAccountLine,
  sellCapText,
  sellEntryOf,
  sellableCellText,
  sellableReadingOf,
  sellableRetriesDue,
  sellableView,
} from './sellable-view';

/**
 * 매도 가능 and 매도 잠금 of a holding row (#67, ADR-0142; ADR-0135 결정 4, F2): every branch of
 * `sellableView` in its order, the words each says, and the '매도' rule.
 */

function quote(over: Partial<OrderQuote> = {}): OrderQuote {
  return {
    protectedLimitPriceCoin: 40,
    filledQty: 3,
    filledAmountCoin: '132',
    remainingQty: 0,
    unspentCoin: null,
    maxSpendCoin: null,
    feeCoin: '0',
    stop: 'filled',
    status: 'filled',
    rejectReason: null,
    cancelReason: null,
    ...over,
  };
}

function contract(over: Partial<SellableContract> = {}): SellableContract {
  return {
    outcome: 'YES',
    qty: 3,
    restingSellQty: 0,
    unlockedQty: 3,
    quote: quote(),
    ...over,
  };
}

const ready = (over: Partial<SellableContract> = {}): SellableReading => ({
  state: 'ready',
  contract: contract(over),
});

const view = (sellable: SellableReading, marketStatus: MarketStatus = 'open', qty = 3) =>
  sellableView({ marketStatus, position: { qty }, sellable });

describe('sellableView: the nine branches, in order', () => {
  it('1. a market that does not trade is 마감 from its status alone, the lock still shown (F2)', () => {
    for (const status of ['closed', 'provisional', 'resolved', 'settling'] as const) {
      const out = sellableView({
        marketStatus: status,
        position: { qty: 3 },
        sellable: ready({ restingSellQty: 2, unlockedQty: 1, quote: null }),
      });
      expect(out.cell, status).toEqual({ kind: 'closed' });
      // A market closed while a ledger failure held it keeps its resting sells locked (M9).
      expect(out.locked).toEqual({ kind: 'ready', qty: 2 });
    }
    expect(sellableCellText({ kind: 'closed' })?.line).toBe('마감');
    // Before the figures are read the status still says 마감; the lock waits.
    const loading = sellableView({
      marketStatus: 'closed',
      position: { qty: 3 },
      sellable: { state: 'loading' },
    });
    expect(loading).toMatchObject({ cell: { kind: 'closed' }, locked: { kind: 'loading' } });
  });

  it('2. loading is a skeleton and failed a dash, never 0', () => {
    expect(view({ state: 'loading' })).toMatchObject({
      cell: { kind: 'loading' },
      locked: { kind: 'loading' },
    });
    expect(view({ state: 'failed' })).toMatchObject({
      cell: { kind: 'failed' },
      locked: { kind: 'failed' },
    });
    expect(sellableCellText({ kind: 'loading' })).toBeNull();
    expect(sellableCellText({ kind: 'failed' })).toBeNull();
  });

  it('3. figures for another quantity than the row’s wait as a skeleton (M2)', () => {
    expect(view(ready({ qty: 2, unlockedQty: 2 }), 'open', 3)).toMatchObject({
      cell: { kind: 'loading' },
      locked: { kind: 'loading' },
    });
  });

  it('4. 일시 중단, or a market’s or account’s refusal, is that refusal’s name', () => {
    expect(view(ready(), 'paused').cell).toEqual({ kind: 'rejected', reason: 'paused' });
    const closedQuote = quote({ filledQty: 0, filledAmountCoin: '0', rejectReason: 'closed' });
    // An OPEN market past its close the worker has not closed yet: the quote says 마감.
    expect(view(ready({ quote: closedQuote })).cell).toEqual({
      kind: 'rejected',
      reason: 'closed',
    });
    const held = quote({ filledQty: 0, filledAmountCoin: '0', rejectReason: 'ledger_hold' });
    expect(sellableCellText(view(ready({ quote: held })).cell)?.line).toBe(
      copy.orderRejectNameLedgerHold,
    );
    expect(sellableCellText({ kind: 'rejected', reason: 'paused' })?.line).toBe('일시 중단');
  });

  it('5. nothing unlocked says so with the resting sells, past the close too (R22)', () => {
    const allLocked = view(ready({ restingSellQty: 3, unlockedQty: 0, quote: null }));
    expect(allLocked.cell).toEqual({ kind: 'allLocked', restingSellQty: 3 });
    expect(allLocked.locked).toEqual({ kind: 'ready', qty: 3 });
    expect(sellableCellText(allLocked.cell)?.line).toBe('매도 가능 0계약(대기 매도 잠금 3계약)');
  });

  it('6. no quote with something unlocked is a market with no width: 지정가 still open (A4)', () => {
    const noWidth = view(ready({ quote: null }));
    expect(noWidth.cell).toEqual({ kind: 'noWidth' });
    expect(sellableCellText(noWidth.cell)?.line).toBe(copy.orderBlockNoWidth);
  });

  it('7. a quote filling nothing says why: 호가 없음, 가격 한도, 자기 체결 (A3, M6)', () => {
    const none = (over: Partial<OrderQuote>) =>
      view(ready({ quote: quote({ filledQty: 0, filledAmountCoin: '0', ...over }) })).cell;
    expect(none({ rejectReason: 'no_quote', stop: 'no_quote' })).toEqual({
      kind: 'none',
      reason: 'no_quote',
    });
    expect(sellableCellText(none({ rejectReason: 'no_quote' }))?.line).toBe('호가 없음');
    expect(sellableCellText(none({ rejectReason: 'price_limit' }))?.line).toBe('가격 한도');
    // The holder's own bid: never hidden as 호가 없음.
    expect(sellableCellText(none({ rejectReason: 'self_trade' }))?.line).toBe('자기 체결');
  });

  it('8. part of it is 일부 수량만 가능 with its figures and its stop', () => {
    const partial = (stop: OrderQuote['stop']) =>
      view(ready({ quote: quote({ filledQty: 1, filledAmountCoin: '44', stop }) })).cell;
    expect(partial('no_quote')).toEqual({
      kind: 'partial',
      qty: 1,
      amountCoin: 44n,
      reason: 'no_quote',
    });
    expect(sellableCellText(partial('no_quote'))).toEqual({
      line: '일부 수량만 가능 · 1계약 · 44 Coin',
      reason: '호가 부족',
    });
    expect(sellableCellText(partial('price_limit'))?.reason).toBe('가격 한도');
    expect(sellableCellText(partial('self_trade'))?.reason).toBe('자기 체결');
  });

  it('9. all of it is N계약 · M Coin, the server’s figures as they are', () => {
    const full = view(ready({ quote: quote({ filledQty: 3, filledAmountCoin: '132' }) }));
    expect(full.cell).toEqual({ kind: 'full', qty: 3, amountCoin: 132n });
    expect(sellableCellText(full.cell)?.line).toBe('3계약 · 132 Coin');
    expect(full.locked).toEqual({ kind: 'ready', qty: 0 });
  });

  it('the lock beside a resting sell, the rest quoted in full (e2e 4단계)', () => {
    const out = view(
      ready({
        qty: 2,
        restingSellQty: 1,
        unlockedQty: 1,
        quote: quote({ filledQty: 1, filledAmountCoin: '44' }),
      }),
      'open',
      2,
    );
    expect(out.locked).toEqual({ kind: 'ready', qty: 1 });
    expect(sellableCellText(out.cell)?.line).toBe('1계약 · 44 Coin');
  });
});

describe('the 1,000,000 line (ADR-0135 결과 4: not split)', () => {
  it('says a sell takes ORDER_QTY_MAX at once when more is unlocked', () => {
    const over = ORDER_QTY_MAX + 1;
    const out = view(
      ready({
        qty: over,
        unlockedQty: over,
        quote: quote({ filledQty: 10, filledAmountCoin: '400' }),
      }),
      'open',
      over,
    );
    expect(out.cap).toBe(true);
    expect(sellCapText()).toBe('한 번에 1,000,000계약까지 팔 수 있습니다');
    expect(view(ready()).cap).toBe(false);
  });
});

describe('every status before the payout is 마감 but the two that trade (F2)', () => {
  it('classifies each status', () => {
    const cells = MARKET_STATUSES.map((status) => [
      status,
      sellableView({ marketStatus: status, position: { qty: 3 }, sellable: ready() }).cell.kind,
    ]);
    expect(cells).toEqual([
      ['draft', 'closed'],
      ['review', 'closed'],
      ['scheduled', 'closed'],
      ['open', 'full'],
      ['paused', 'rejected'],
      ['closed', 'closed'],
      ['provisional', 'closed'],
      ['resolved', 'closed'],
      ['settling', 'closed'],
      ['settled', 'closed'],
      ['cancelled', 'closed'],
    ]);
  });
});

describe('sellEntryOf: the row’s 매도', () => {
  const on = { qty: 2, marketStatus: 'open', account: null, accountKnown: true } as const;

  it('is on for a held contract of a trading market, all-locked and no-width ones too', () => {
    expect(sellEntryOf(on)).toEqual({ kind: 'on' });
  });

  it('is off for D13 and until the account is known, off for a market not 거래 중', () => {
    // 일시 중단 has no order area to open (ADR-0135 D1): its cell says '일시 중단'.
    expect(sellEntryOf({ ...on, marketStatus: 'paused' })).toEqual({ kind: 'market' });
    expect(sellEntryOf({ ...on, account: 'admin' })).toEqual({ kind: 'account' });
    expect(sellEntryOf({ ...on, account: 'restricted' })).toEqual({ kind: 'account' });
    expect(sellEntryOf({ ...on, accountKnown: false })).toEqual({ kind: 'account' });
    expect(sellEntryOf({ ...on, marketStatus: 'closed' })).toEqual({ kind: 'market' });
  });

  it('is absent for nothing held', () => {
    expect(sellEntryOf({ ...on, qty: 0 })).toEqual({ kind: 'none' });
  });
});

describe('positionAccountLine: the detail’s D13 reason is on screen at every width (D13)', () => {
  it('points at the column’s line where it is drawn, else draws the card’s own', () => {
    for (const account of ['admin', 'restricted'] as const) {
      // md and up on a market with an order area: the column's line.
      expect(positionAccountLine({ account, orderArea: true, mdUp: true })).toEqual({
        ownLine: false,
        describedBy: PANEL_ACCOUNT_LINE_ID,
      });
      // 375 (the sheet shut), the width not known yet, or no order area: the card's own line.
      for (const [orderArea, mdUp] of [
        [true, false],
        [true, null],
        [false, true],
        [false, false],
      ] as const) {
        expect(positionAccountLine({ account, orderArea, mdUp })).toEqual({
          ownLine: true,
          describedBy: POSITION_ACCOUNT_LINE_ID,
        });
      }
    }
    expect(positionAccountLine({ account: null, orderArea: true, mdUp: false })).toEqual({
      ownLine: false,
      describedBy: undefined,
    });
    expect(PANEL_ACCOUNT_LINE_ID).toBe('order-account-blocked-column');
  });
});

describe('the reads behind a row’s figures (M2, R3)', () => {
  const MARKET = '11111111-1111-4111-8111-111111111111';
  const settled = { isFetching: false, dataUpdatedAt: 100, errorUpdatedAt: 0 };
  /** The market's sellable answered with YES at `qty`. */
  const read = (qty: number, over: Partial<SellableRead> = {}): SellableRead => ({
    ...settled,
    data: { marketId: MARKET, contracts: [contract({ qty, unlockedQty: qty })] },
    isError: false,
    ...over,
  });
  const row = { marketId: MARKET, outcome: 'YES', qty: 3 } as const;
  const due = (sellable: SellableRead, list: ReadFacts, retries: readonly SellableRetry[] = []) =>
    sellableRetriesDue({ positions: [row], sellableOf: () => sellable, list, retries });
  const reading = (sellable: SellableRead, list: ReadFacts, retries: readonly SellableRetry[]) =>
    sellableReadingOf({ read: sellable, list, retries, ...row });

  it('is ready when the quantities agree, and asks for nothing', () => {
    expect(reading(read(3), settled, [])).toMatchObject({ state: 'ready' });
    expect(due(read(3), settled)).toEqual([]);
  });

  it('waits as a skeleton while they differ, reading the pair again once with both settled', () => {
    // A read still running: no retry yet.
    expect(due(read(2, { isFetching: true }), settled)).toEqual([]);
    expect(due(read(2), { ...settled, isFetching: true })).toEqual([]);
    // Both settled and still apart: one retry for this pair, then none again for it.
    const [retry] = due(read(2), settled);
    expect(retry).toEqual({
      key: `${MARKET}:YES:3:2`,
      marketId: MARKET,
      sellableAt: 100,
      positionsAt: 100,
    });
    if (retry === undefined) throw new Error('no retry');
    expect(due(read(2), settled, [retry])).toEqual([]);
    // Until both have answered again it is a skeleton, never a figure for the wrong quantity.
    expect(reading(read(2), settled, [retry])).toEqual({ state: 'loading' });
    const sellableAgain = read(2, { dataUpdatedAt: 200 });
    expect(reading(sellableAgain, settled, [retry])).toEqual({ state: 'loading' });
    // Both read again and still apart: '—' with 다시 시도.
    const listAgain = { ...settled, dataUpdatedAt: 200 };
    expect(reading(sellableAgain, listAgain, [retry])).toEqual({ state: 'failed' });
    // A new pair of quantities is a new disagreement, read once more of its own.
    expect(due(read(1), listAgain, [retry]).map((r) => r.key)).toEqual([`${MARKET}:YES:3:1`]);
    // And once they agree the figures are drawn.
    expect(reading(read(3, { dataUpdatedAt: 300 }), listAgain, [retry])).toMatchObject({
      state: 'ready',
    });
  });

  it('is loading before the first answer, failed for a failed read or a missing contract', () => {
    expect(sellableReadingOf({ read: undefined, list: settled, retries: [], ...row })).toEqual({
      state: 'loading',
    });
    expect(reading(read(3, { data: undefined }), settled, [])).toEqual({ state: 'loading' });
    expect(reading(read(3, { data: undefined, isError: true }), settled, [])).toEqual({
      state: 'failed',
    });
    const noYes = read(3, { data: { marketId: MARKET, contracts: [] } });
    expect(reading(noYes, settled, [])).toEqual({ state: 'failed' });
  });

  it('is failed for a failed refetch that kept an answer of the same quantity (review P2)', () => {
    // A bid withdrawn or a resting sell cancelled leaves the quantity as it was: the kept answer
    // still agrees with the row, and drawing it would show proceeds or a lock that are gone.
    const kept = read(3, { isError: true, errorUpdatedAt: 200 });
    expect(reading(kept, settled, [])).toEqual({ state: 'failed' });
    // Its 다시 시도 running again: still '—' until an answer lands (status stays 'error').
    expect(reading({ ...kept, isFetching: true }, settled, [])).toEqual({ state: 'failed' });
    // The cell and the lock both say so, in a market that trades.
    const shown = sellableView({
      marketStatus: 'open',
      position: { qty: 3 },
      sellable: reading(kept, settled, []),
    });
    expect(shown.cell).toEqual({ kind: 'failed' });
    expect(shown.locked).toEqual({ kind: 'failed' });
    // And a refetch that succeeds again draws the figures.
    expect(reading(read(3, { dataUpdatedAt: 300 }), settled, [])).toMatchObject({
      state: 'ready',
    });
  });
});

describe('the panel and the row read one quote the same (M6)', () => {
  it('an immediate sell quote that fills nothing: the panel’s block is the row’s reason', () => {
    const q = quote({
      filledQty: 0,
      filledAmountCoin: '0',
      rejectReason: null,
      stop: 'price_limit',
    });
    const block = orderBlock({
      input: { ...initialOrderInput(), side: 'sell', qty: '3' },
      quote: q,
      noWidth: false,
      bestOpposite: 40,
      account: null,
      unlockedQty: 3,
    });
    expect(view(ready({ quote: q })).cell).toEqual({ kind: 'none', reason: block });
  });
});
