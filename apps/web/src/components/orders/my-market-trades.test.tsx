import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MINUS_SIGN } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { MarketHistoryLink } from '@/components/market/settled-recap';
import { copy } from '@/copy';
import { type MyFill } from '@/lib/api';
import { marketHistoryLinks } from '@/lib/market-recap';
import { byTestId, renderWithQueries } from '@/test/render';
import { SRC } from '@/test/screen-text';
import { TradeRow } from './my-market-trades';

/**
 * 내 거래 한 줄 on the market detail (#123, ADR-0141; #34, ADR-0145): a sell line carries the
 * 실현 손익 the server kept for that fill (N02 §8: 순매도 수령액 − 처분 원가), '—' when it kept none,
 * and a buy line has no such cell; the card's last line goes to this market's fills on MY.
 */

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const SELL: MyFill = {
  id: '41',
  marketId: MARKET,
  marketSlug: 'rate-cut-2026',
  marketTitle: '기준금리 인하?',
  orderId: '9c858901-8a57-4791-81fe-4c455b099bc9',
  outcome: 'YES',
  side: 'sell',
  priceCoin: 45,
  yesPriceCoin: 45,
  qty: 1,
  amountCoin: '45',
  feeCoin: '0',
  realizedPnlCoin: '15',
  createdAt: '2026-11-16T00:00:00.000Z',
};

const row = (fill: MyFill) => renderWithQueries(<TradeRow fill={fill} />);

describe('TradeRow', () => {
  it('shows a sell line’s 실현 손익 as the server kept it, signed', () => {
    const html = row(SELL);
    // The positive control: the line itself is drawn.
    expect(byTestId(html, `market-my-trade-${SELL.id}`)).toBeDefined();
    expect(html).toContain(copy.positionRealizedPnl);
    expect(byTestId(html, 'market-my-trade-realized')?.text).toBe('15 Coin');
    expect(
      byTestId(row({ ...SELL, realizedPnlCoin: '-30' }), 'market-my-trade-realized')?.text,
    ).toBe(`${MINUS_SIGN}30 Coin`);
  });

  it('writes a dash for a sell with no record, never 0', () => {
    expect(
      byTestId(row({ ...SELL, realizedPnlCoin: null }), 'market-my-trade-realized')?.text,
    ).toBe('—');
  });

  it('has no 실현 손익 on a buy line', () => {
    const html = row({ ...SELL, side: 'buy', realizedPnlCoin: null });
    expect(byTestId(html, `market-my-trade-${SELL.id}`)).toBeDefined();
    expect(byTestId(html, 'market-my-trade-realized')).toBeUndefined();
    expect(html).not.toContain(copy.positionRealizedPnl);
  });
});

describe('the fills link', () => {
  it('opens this market’s fills on MY, drawn once there is a fill and without a prefetch', () => {
    const html = renderWithQueries(
      <MarketHistoryLink
        href={marketHistoryLinks(MARKET).fills}
        label={copy.marketHistoryFills}
        testId="market-history-fills"
      />,
    );
    const link = byTestId(html, 'market-history-fills');
    expect(link?.attributes.href).toBe(`/my/history?kind=fills&market=${MARKET}`);
    expect(link?.text).toBe(copy.marketHistoryFills);
    // The card draws it under its rows only: an empty card has none (the e2e, cancel.spec.ts).
    const source = readFileSync(path.join(SRC, 'components/orders/my-market-trades.tsx'), 'utf8');
    expect(source).toMatch(
      /rows\.length > 0 && \(\s*<MarketHistoryLink\s+href=\{marketHistoryLinks\(marketId\)\.fills\}/,
    );
    const open = readFileSync(path.join(SRC, 'components/orders/pending-orders.tsx'), 'utf8');
    expect(open).toMatch(/href=\{marketHistoryLinks\(marketId\)\.orders\}/);
    const links = readFileSync(path.join(SRC, 'components/market/settled-recap.tsx'), 'utf8');
    expect(links).toContain('prefetch={false}');
  });
});
