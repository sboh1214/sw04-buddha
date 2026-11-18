import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type Order } from '@/lib/api';
import { byTestId, renderWithQueries } from '@/test/render';
import { SRC } from '@/test/screen-text';
import { ORDER_CANCEL_DIALOG } from './order-cancel-dialog';
import { PendingOrderRow } from './pending-order-row';

/**
 * 대기 주문 한 줄 (#123, ADR-0141 결정 3·4; ADR-0135 결과 4 #123, E1): what the row draws, the
 * condition line a market awaiting its recovery replaces, and the cancel that asks a session alone.
 */

const ORDER: Order = {
  id: '9c858901-8a57-4791-81fe-4c455b099bc9',
  requestId: 'request-1',
  marketId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  marketSlug: 'rate-cut-2026',
  marketTitle: '기준금리 인하?',
  outcome: 'NO',
  side: 'buy',
  timeInForce: 'gtc',
  limitPriceCoin: 40,
  protectedLimitPriceCoin: 40,
  qty: 2,
  budgetCoin: null,
  filledQty: 1,
  filledAmountCoin: '40',
  cancelledQty: 0,
  unspentCoin: null,
  status: 'partially_filled',
  rejectReason: null,
  cancelReason: null,
  createdAt: '2026-11-16T00:00:00.000Z',
  endedAt: null,
  awaitingRecovery: false,
};

function row(order: Order, over: { cancelling?: boolean; cancelDisabled?: boolean } = {}) {
  return renderWithQueries(
    <PendingOrderRow
      order={order}
      testId={`portfolio-order-${order.id}`}
      showMarket
      cancelling={over.cancelling ?? false}
      cancelDisabled={over.cancelDisabled ?? false}
      onCancel={() => undefined}
    />,
  );
}

describe('PendingOrderRow', () => {
  it('draws the market, contract, side, state and every figure of 수용 기준 2', () => {
    const html = row(ORDER);
    expect(html).toContain(ORDER.marketTitle);
    expect(html).toContain('/markets/rate-cut-2026');
    expect(byTestId(html, 'order-row-status')?.text).toBe(copy.orderStatusPartiallyFilled);
    expect(byTestId(html, 'order-row-limit')?.text).toBe('40.00 Coin');
    expect(byTestId(html, 'order-row-qty')?.text).toBe('2계약');
    expect(byTestId(html, 'order-row-filled')?.text).toBe('1계약');
    expect(byTestId(html, 'order-row-remaining')?.text).toBe('1계약');
    expect(byTestId(html, 'order-row-avg')?.text).toBe('40.00 Coin');
    expect(byTestId(html, 'order-row-at')?.text).not.toBe('');
    expect(byTestId(html, 'order-row-gtc')?.text).toBe(copy.orderUnfilledGtc);
    expect(byTestId(html, 'order-row-held')).toBeUndefined();
    expect(byTestId(html, 'order-row-detail')?.attributes.href).toBe(`/my/orders/${ORDER.id}`);
    // No counterparty, nor whether it was the 운영 유동성 (B4): `Order` carries neither, so the
    // row has nothing of them to draw.
  });

  it('says 평균가 — before a fill', () => {
    const html = row({ ...ORDER, status: 'open', filledQty: 0, filledAmountCoin: '0' });
    expect(byTestId(html, 'order-row-avg')?.text).toBe(copy.orderNone);
    expect(byTestId(html, 'order-row-status')?.text).toBe(copy.orderStatusOpen);
  });

  it('turns 주문 취소 off in a market awaiting its recovery, the line saying why in place', () => {
    const html = row({ ...ORDER, awaitingRecovery: true });
    expect(byTestId(html, 'order-row-cancel')?.attributes).toHaveProperty('disabled');
    expect(byTestId(html, 'order-row-held')?.text).toBe(copy.orderHeldMarket);
    expect(byTestId(html, 'order-row-gtc')).toBeUndefined();
  });

  it('says 취소 요청 중 while a cancel is in flight, never 취소 완료', () => {
    const html = row(ORDER, { cancelling: true });
    expect(byTestId(html, 'order-row-cancelling')?.text).toContain(copy.orderCancelling);
    expect(byTestId(html, 'order-row-cancel')).toBeUndefined();
    expect(html).not.toContain(copy.orderStatusCancelled);
    expect(byTestId(html, 'order-row-status')?.text).toBe(copy.orderStatusPartiallyFilled);
  });

  it('leaves 주문 취소 on whatever stops a new order: it asks a session alone (결정 4)', () => {
    // The row reads no market state, account restriction, role, onboarding or intake setting: an
    // account restricted, an admin, one sent back to the terms and a closed intake all cancel.
    const html = row(ORDER);
    expect(byTestId(html, 'order-row-cancel')?.attributes).not.toHaveProperty('disabled');
    const source = readFileSync(path.join(SRC, 'components/orders/pending-order-row.tsx'), 'utf8');
    for (const word of [
      'blockText',
      'useMyRestriction',
      'ORDER_ACCEPTING',
      'needsOnboarding',
      'useOrderPanel',
      'useMarket',
      'useMe',
    ]) {
      expect(source, word).not.toContain(word);
    }
  });

  it('says only that the market is not public when the API names none of it', () => {
    const html = row({ ...ORDER, marketSlug: null, marketTitle: null });
    expect(byTestId(html, 'portfolio-order-market-hidden')?.text).toBe(copy.postMarketNotPublic);
    expect(html).not.toContain('/markets/');
  });
});

describe('the cancel’s confirmation (E1)', () => {
  it('says 닫기 beside 주문 취소, and hands the dialog the dismiss button as its first focus', () => {
    // The focus itself is the e2e's to see (`toBeFocused`). Here: the words, and that the dialog
    // takes these settings and turns 'dismiss' into its `initialFocusEl` on that button.
    expect(ORDER_CANCEL_DIALOG.dismissLabel).toBe('닫기');
    expect(copy.orderCancel).toBe('주문 취소');
    const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8');
    expect(read('components/orders/order-cancel-dialog.tsx')).toContain('{...ORDER_CANCEL_DIALOG}');
    const dialog = read('components/ui/confirm-dialog.tsx');
    expect(dialog).toContain(
      "initialFocus === 'dismiss' ? { initialFocusEl: () => dismissRef.current } : {}",
    );
    expect(dialog).toContain('ref={dismissRef}');
  });

  it('keeps its order once the row left the loaded pages: the snapshot, and its detail asked', () => {
    const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8');
    // The list hands the dialog the row as it opened, beside the row it draws now.
    const list = read('components/orders/pending-orders.tsx');
    expect(list).toContain('useState<Order | null>(null)');
    expect(list).toContain('setTarget(order);');
    expect(list).toContain('opened={target ?? undefined}');
    // The dialog asks the detail while its list does not draw the order, and draws the freshest.
    const dialog = read('components/orders/order-cancel-dialog.tsx');
    expect(dialog).toMatch(
      /useHeldOrder\(\s*orderId \?\? undefined,\s*accountId,\s*orderId !== null && listed === undefined,?\s*\)/,
    );
    expect(dialog).toContain('cancelTargetOrder(orderId, listed, opened, held)');
    const hook = read('hooks/use-my-orders.ts');
    expect(hook).toContain(
      'enabled: ask && session != null && orderId !== undefined && accountId !== undefined',
    );
  });
});

describe('the focus once the confirmation’s row left while it was open (결정 4)', () => {
  it('keeps the row in its place, or the list, for the dialog’s close', () => {
    // The rule itself is `rowInPlaceOf` (my-orders.test.ts); the focus is the e2e's to see.
    const list = readFileSync(path.join(SRC, 'components/orders/pending-orders.tsx'), 'utf8');
    // The effect that finds the focus elsewhere (in the dialog) keeps the place for the close…
    expect(list).toContain('const inPlace = rowInPlaceOf(before, after, row);');
    expect(list).toMatch(
      /if \(active !== null && active !== document\.body && active\.isConnected\) \{\s*(\/\/[^\n]*\n\s*)*closeFocus\.current = inPlace;\s*return;/,
    );
    // …the close sends the focus there (the row, else the list), and a new opening forgets it.
    expect(list).toContain(
      'return closeFocus.current === undefined ? null : focusTarget(closeFocus.current);',
    );
    expect(list).toContain('?? listRef.current;');
    expect(list).toMatch(/focusRow\.current = order\.id;\s*closeFocus\.current = undefined;/);
  });
});

describe('the reading a list and the detail watch from (결정 6)', () => {
  it('takes fresh cached rows drawn at mount, not only a read after mount', () => {
    // The rule itself is `watchedReading` (use-my-orders.test.ts); here, that both screens use it.
    const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8');
    const list = read('components/orders/pending-orders.tsx');
    expect(list).toContain('const watched = watchedReading(orders);');
    expect(list).toContain('if (baseline.current === undefined && !watched) return;');
    expect(list).not.toContain('isFetchedAfterMount');
    const detail = read('components/orders/order-detail.tsx');
    expect(detail).toContain('watched={watchedReading(query)}');
    expect(detail).toContain('if (watched) seenLive.current = true;');
    expect(detail).not.toContain('isFetchedAfterMount');
  });
});

describe('the read back of an order gone from a watched list (결정 5·6)', () => {
  it('writes only while its account is still the one on screen, as the cancel’s answer does', () => {
    const hook = readFileSync(path.join(SRC, 'hooks/use-my-orders.ts'), 'utf8');
    const readBack = hook.slice(hook.indexOf('export async function confirmEnded'));
    const fetched = readBack.indexOf('await fetchMyOrder(orderId)');
    const checked = readBack.indexOf('if (shownAccount(queryClient) !== accountId) return;');
    const stored = readBack.indexOf('storeOrder(queryClient, accountId, order)');
    expect(fetched).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(fetched);
    expect(stored).toBeGreaterThan(checked);
    // Every `storeOrder` in the file sits behind that check (the cancel's answer, the read back).
    expect(hook.match(/storeOrder\(queryClient,/g)).toHaveLength(2);
    expect(hook).toContain(
      'if (shownAccount(queryClient) === vars.accountId) {\n        storeOrder(queryClient, vars.accountId, order);',
    );
  });
});
