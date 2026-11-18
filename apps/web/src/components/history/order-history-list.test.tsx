import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type Order } from '@/lib/api';
import { byTestId, renderWithQueries } from '@/test/render';
import { ORDER_STATUS_PALETTE, OrderHistoryRow } from './order-history-list';

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const ORDER: Order = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
  requestId: 'request-1',
  marketId: MARKET,
  marketSlug: 'rate-cut-2026',
  marketTitle: '기준금리 인하?',
  outcome: 'YES',
  side: 'buy',
  timeInForce: 'gtc',
  limitPriceCoin: 40,
  protectedLimitPriceCoin: 40,
  qty: 1,
  budgetCoin: null,
  filledQty: 0,
  filledAmountCoin: '0',
  cancelledQty: 0,
  unspentCoin: null,
  status: 'rejected',
  rejectReason: 'not_open_yet',
  cancelReason: null,
  createdAt: '2026-11-05T00:00:00.000Z',
  endedAt: '2026-11-05T00:00:00.000Z',
  awaitingRecovery: false,
};

const ONLY = `/my/history?market=${MARKET}`;

function row(over: Partial<Order> = {}, only = true) {
  return renderWithQueries(
    <OrderHistoryRow order={{ ...ORDER, ...over }} onlyMarketHref={only ? ONLY : undefined} />,
  );
}

/**
 * 주문 한 줄의 시장 칸 (#119; #78 되돌리기, ADR-0099, owner answer 2026-11-01): a SCHEDULED market's
 * rejected order reaches the row with no slug or title once the market went back to a draft, and
 * the line says only '공개되지 않은 시장' — no title or link — until it is public again.
 */
describe('OrderHistoryRow market line', () => {
  it('links to a public market by its title', () => {
    const html = row();
    expect(html).toContain(ORDER.marketTitle);
    expect(html).toContain(`/markets/${ORDER.marketSlug}`);
    expect(html).not.toContain(copy.postMarketNotPublic);
  });

  it('says only that the market is not public when the API names none of it', () => {
    const html = row({ marketSlug: null, marketTitle: null });
    expect(html).toContain(copy.postMarketNotPublic);
    expect(html).toContain('data-testid="portfolio-order-market-hidden"');
    expect(html).not.toContain('/markets/');
    // '이 시장만 보기' stays: the filter takes the market's id, which the row still carries.
    expect(byTestId(html, 'history-only-market')?.attributes.href).toBe(ONLY);
  });
});

/**
 * 거래·정산 이력 한 줄's reason and 상세 (#123, ADR-0141 결정 16; ADR-0140 넘긴 것 #123): an ended
 * order's reason by its short name — E3's names among them — and the way to its 주문 상세.
 */
describe('OrderHistoryRow reason and links', () => {
  it('names a 거절 reason and a 취소 reason short, and links the order’s detail', () => {
    const rejected = row({ rejectReason: 'ledger_hold' });
    expect(byTestId(rejected, 'portfolio-order-reason')?.text).toBe('계정 확인 중');
    expect(byTestId(rejected, 'portfolio-order-detail')?.attributes.href).toBe(
      `/my/orders/${ORDER.id}`,
    );
    const cancelled = row({ status: 'cancelled', rejectReason: null, cancelReason: 'admin_role' });
    expect(byTestId(cancelled, 'portfolio-order-reason')?.text).toBe('관리자 권한');
  });

  it('draws no reason for 전량 체결 and 만료', () => {
    for (const status of ['filled', 'expired'] as const) {
      const html = row({ status, rejectReason: null, cancelReason: null });
      expect(byTestId(html, 'portfolio-order-reason'), status).toBeUndefined();
    }
  });

  it("offers '이 시장만 보기' unless the list is that market's already (#124)", () => {
    const link = byTestId(row(), 'history-only-market');
    expect(link?.text).toBe(copy.historyOnlyMarket);
    expect(link?.attributes.href).toBe(ONLY);
    expect(byTestId(row({}, false), 'history-only-market')).toBeUndefined();
  });

  it('tells the four ended states apart by name (N02 §7)', () => {
    const names = (['filled', 'cancelled', 'expired', 'rejected'] as const).map(
      (status) => byTestId(row({ status }), 'history-order-status')?.text,
    );
    expect(names).toEqual(['전량 체결', '취소 완료', '만료', '거절']);
    // …and by colour: no two of the four share a palette.
    const palettes = (['filled', 'cancelled', 'expired', 'rejected'] as const).map(
      (status) => ORDER_STATUS_PALETTE[status],
    );
    expect(new Set(palettes).size).toBe(4);
  });
});

/**
 * What was left when the order ended, beside what filled (#124, ADR-0143 결정 6; N02 §7 '부분 체결
 * 후 취소된 주문에도 체결 수량과 남은 취소 수량을 보존한다').
 */
describe('OrderHistoryRow quantities', () => {
  it('keeps a quantity order’s 체결 수량 and 취소 수량 together', () => {
    const html = row({
      qty: 5,
      filledQty: 3,
      filledAmountCoin: '120',
      cancelledQty: 2,
      status: 'cancelled',
      rejectReason: null,
      cancelReason: 'by_owner',
    });
    expect(byTestId(html, 'history-order-filled')?.text).toBe('3계약');
    expect(byTestId(html, 'history-order-cancelled')?.text).toBe('2계약');
    expect(html).toContain(copy.orderFilledQty);
    expect(html).toContain(copy.orderCancelledQty);
    // The average and the amount are the order's own: 120 over 3.
    expect(html).toContain('40.00 Coin');
    expect(html).toContain('120 Coin');
    expect(byTestId(html, 'history-order-unspent')).toBeUndefined();
  });

  it('draws an expiry’s rest as 취소 수량 too, and none when nothing was left', () => {
    const expired = row({
      qty: 4,
      filledQty: 1,
      filledAmountCoin: '40',
      cancelledQty: 3,
      status: 'expired',
      rejectReason: null,
    });
    expect(byTestId(expired, 'history-order-cancelled')?.text).toBe('3계약');
    const filled = row({
      qty: 2,
      filledQty: 2,
      filledAmountCoin: '80',
      status: 'filled',
      rejectReason: null,
    });
    expect(byTestId(filled, 'history-order-filled')?.text).toBe('2계약');
    expect(byTestId(filled, 'history-order-cancelled')).toBeUndefined();
  });

  it("shows a Coin amount order's '쓰지 않고 푼 금액' beside what filled", () => {
    // A Coin amount order has no quantity to cancel: its rest is the Coin it did not spend.
    const html = row({
      qty: null,
      budgetCoin: '500',
      timeInForce: 'ioc',
      filledQty: 7,
      filledAmountCoin: '430',
      cancelledQty: 0,
      unspentCoin: '70',
      status: 'cancelled',
      rejectReason: null,
      cancelReason: 'ioc_remainder',
    });
    expect(byTestId(html, 'history-order-filled')?.text).toBe('7계약');
    expect(byTestId(html, 'history-order-unspent')?.text).toBe('70 Coin');
    expect(html).toContain(copy.orderUnspentReleased);
    expect(byTestId(html, 'history-order-cancelled')).toBeUndefined();
  });

  it('draws an unspent amount of 0 as 0 Coin, and a dash for an order that filled nothing', () => {
    const spent = row({
      qty: null,
      budgetCoin: '100',
      filledQty: 2,
      filledAmountCoin: '100',
      unspentCoin: '0',
      status: 'filled',
      rejectReason: null,
    });
    expect(byTestId(spent, 'history-order-unspent')?.text).toBe('0 Coin');
    const refused = row();
    expect(byTestId(refused, 'history-order-filled')?.text).toBe('0계약');
    // No fill, so no average and no amount to state: the dash, not a zero.
    expect(byTestId(refused, 'history-order-average')?.text).toBe('—');
    expect(byTestId(refused, 'history-order-amount')?.text).toBe('—');
    // …and a filled order states both.
    expect(byTestId(spent, 'history-order-average')?.text).not.toBe('—');
    expect(byTestId(spent, 'history-order-amount')?.text).toBe('100 Coin');
  });
});
