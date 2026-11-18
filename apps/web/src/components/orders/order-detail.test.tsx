import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type Order } from '@/lib/api';
import { byTestId, renderWithQueries } from '@/test/render';
import { SRC } from '@/test/screen-text';
import { OrderDetailBody } from './order-detail';

/**
 * 주문 상세 (#123, ADR-0141 결정 3): a read again of the order that failed keeps the last reading
 * drawn and says so, with '다시 시도', as the lists do (`listSection`'s `stale`).
 */

const HELD: Order = {
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
  filledQty: 0,
  filledAmountCoin: '0',
  cancelledQty: 0,
  unspentCoin: null,
  status: 'open',
  rejectReason: null,
  cancelReason: null,
  createdAt: '2026-11-16T00:00:00.000Z',
  endedAt: null,
  // The reading before the market's recovery: 주문 취소 off and the line saying why.
  awaitingRecovery: true,
};

function body(refreshFailed: boolean) {
  return renderWithQueries(
    <OrderDetailBody
      order={HELD}
      accountId="account-a"
      watched
      refreshFailed={refreshFailed}
      refetchOrder={() => Promise.resolve()}
    />,
  );
}

describe('OrderDetailBody', () => {
  it('says a failed refresh above the held reading, with 다시 시도', () => {
    const html = body(true);
    const notice = byTestId(html, 'order-detail-stale');
    expect(notice?.text).toContain(copy.marketRefreshFailed);
    expect(notice?.text).toContain(copy.retry);
    // The held reading stays drawn under it.
    expect(byTestId(html, 'order-detail-held')?.text).toBe(copy.orderHeldMarket);
  });

  it('says nothing while the reading is current', () => {
    expect(byTestId(body(false), 'order-detail-stale')).toBeUndefined();
  });

  it('is told by the query’s own refresh failure (`refreshFailed`)', () => {
    const source = readFileSync(path.join(SRC, 'components/orders/order-detail.tsx'), 'utf8');
    expect(source).toContain('refreshFailed={refreshFailed(query)}');
  });
});
