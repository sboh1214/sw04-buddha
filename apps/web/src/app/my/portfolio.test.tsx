import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type Order } from '@/lib/api';
import { byTestId, renderWithQueries } from '@/test/render';
import { OrderRow } from './portfolio';

const ORDER: Order = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
  requestId: 'request-1',
  marketId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
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

/**
 * 주문 이력 한 줄의 시장 칸 (#119; #78 되돌리기, ADR-0099, owner answer 2026-11-01): a SCHEDULED
 * market's rejected order reaches the row with no slug or title once the market went back to a
 * draft, and the line says only '공개되지 않은 시장' — no title or link — until it is public again.
 */
describe('OrderRow market line', () => {
  it('links to a public market by its title', () => {
    const html = renderWithQueries(<OrderRow order={ORDER} />);
    expect(html).toContain(ORDER.marketTitle);
    expect(html).toContain(`/markets/${ORDER.marketSlug}`);
    expect(html).not.toContain(copy.postMarketNotPublic);
  });

  it('says only that the market is not public when the API names none of it', () => {
    const html = renderWithQueries(
      <OrderRow order={{ ...ORDER, marketSlug: null, marketTitle: null }} />,
    );
    expect(html).toContain(copy.postMarketNotPublic);
    expect(html).toContain('data-testid="portfolio-order-market-hidden"');
    expect(html).not.toContain('/markets/');
  });
});

/**
 * 거래·정산 이력 한 줄's reason and 상세 (#123, ADR-0141; ADR-0140 넘긴 것 #123): an ended order's
 * reason by its short name — E3's names among them — and the way to its 주문 상세.
 */
describe('OrderRow reason and detail link', () => {
  it('names a 거절 reason and a 취소 reason short, and links the order’s detail', () => {
    const rejected = renderWithQueries(
      <OrderRow order={{ ...ORDER, rejectReason: 'ledger_hold' }} />,
    );
    expect(byTestId(rejected, 'portfolio-order-reason')?.text).toBe('계정 확인 중');
    expect(byTestId(rejected, 'portfolio-order-detail')?.attributes.href).toBe(
      `/my/orders/${ORDER.id}`,
    );
    const cancelled = renderWithQueries(
      <OrderRow
        order={{
          ...ORDER,
          status: 'cancelled',
          rejectReason: null,
          cancelReason: 'admin_role',
        }}
      />,
    );
    expect(byTestId(cancelled, 'portfolio-order-reason')?.text).toBe('관리자 권한');
  });

  it('draws no reason for 전량 체결 and 만료', () => {
    for (const status of ['filled', 'expired'] as const) {
      const html = renderWithQueries(
        <OrderRow order={{ ...ORDER, status, rejectReason: null, cancelReason: null }} />,
      );
      expect(byTestId(html, 'portfolio-order-reason'), status).toBeUndefined();
    }
  });
});
