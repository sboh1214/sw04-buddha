import { MINUS_SIGN } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type MyFill } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTestId, renderWithQueries } from '@/test/render';
import { FillHistoryRow } from './fill-history-list';

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const ORDER = '9c858901-8a57-4791-81fe-4c455b099bc9';

const FILL: MyFill = {
  id: '4217',
  orderId: ORDER,
  marketId: MARKET,
  marketSlug: 'rate-cut-2026',
  marketTitle: '기준금리 인하?',
  outcome: 'YES',
  side: 'sell',
  qty: 2,
  priceCoin: 60,
  amountCoin: '120',
  yesPriceCoin: 60,
  feeCoin: '0',
  realizedPnlCoin: '23',
  createdAt: '2026-11-16T03:04:05.000Z',
};

const ONLY = `/my/history?kind=fills&market=${MARKET}`;

function row(over: Partial<MyFill> = {}, only = true) {
  return renderWithQueries(
    <FillHistoryRow fill={{ ...FILL, ...over }} onlyMarketHref={only ? ONLY : undefined} />,
  );
}

/**
 * 체결 한 줄 (#124, ADR-0143 결정 6): the contract, 매수/매도, the price, the quantity, the Coin and
 * the server's time; 실현 손익 on a sell line alone, from the record the server kept.
 */
describe('FillHistoryRow', () => {
  it('draws the fill as its own order took it, with the server time', () => {
    const html = row();
    expect(html).toContain(FILL.marketTitle);
    expect(html).toContain(`/markets/${FILL.marketSlug}`);
    expect(html).toContain(copy.sell);
    expect(byTestId(html, 'history-fill-price')?.text).toBe('60.00 Coin');
    expect(byTestId(html, 'history-fill-qty')?.text).toBe('2계약');
    expect(byTestId(html, 'history-fill-amount')?.text).toBe('120 Coin');
    expect(byTestId(html, 'history-fill-at')?.text).toBe(formatKst(FILL.createdAt));
    expect(byTestId(html, `history-fill-${FILL.id}`)?.attributes['data-fill-side']).toBe('sell');
  });

  it('shows a sell line’s 실현 손익 as the server recorded it, a gain and a loss', () => {
    const gain = byTestId(row(), 'history-fill-pnl');
    expect(gain?.text).toBe('23 Coin');
    const loss = byTestId(row({ realizedPnlCoin: '-18' }), 'history-fill-pnl');
    expect(loss?.text).toBe(`${MINUS_SIGN}18 Coin`);
    // Exactly 0 is a recorded figure, and reads as one.
    expect(byTestId(row({ realizedPnlCoin: '0' }), 'history-fill-pnl')?.text).toBe('0 Coin');
    expect(row()).toContain(copy.positionRealizedPnl);
  });

  it('shows a dash for a sell with no record — never 0, which would be a claim', () => {
    const html = row({ realizedPnlCoin: null });
    expect(byTestId(html, 'history-fill-pnl')?.text).toBe('—');
  });

  it('gives a buy line no 실현 손익 cell at all', () => {
    const html = row({ side: 'buy', realizedPnlCoin: null });
    expect(byTestId(html, 'history-fill-pnl')).toBeUndefined();
    expect(html).not.toContain(copy.positionRealizedPnl);
    expect(html).toContain(copy.buy);
  });

  it('links its order’s detail and this market’s history, and names no counterparty', () => {
    const html = row();
    expect(byTestId(html, 'history-fill-detail')?.attributes.href).toBe(`/my/orders/${ORDER}`);
    expect(byTestId(html, 'history-only-market')?.attributes.href).toBe(ONLY);
    expect(byTestId(row({}, false), 'history-only-market')).toBeUndefined();
    // B4, N01 §5: nothing of the other side, and nothing that marks a 운영 유동성 fill.
    expect(html).not.toMatch(/상대|운영 유동성|마켓메이커/);
  });
});
