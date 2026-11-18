import { readFileSync } from 'node:fs';
import { MINUS_SIGN } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import type { LedgerEntry } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTestId, renderWithQueries } from '@/test/render';
import { LedgerRow } from './ledger-list';

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const ORDER = '9c858901-8a57-4791-81fe-4c455b099bc9';
const ONLY = `/my/wallet?market=${MARKET}`;

const FILL: LedgerEntry = {
  id: '4217',
  kind: 'BUY_FILL',
  amountCoin: '-120',
  balanceAfterCoin: '880',
  refType: 'fill',
  refId: '91',
  memo: null,
  marketId: MARKET,
  marketSlug: 'rate-cut-2026',
  marketTitle: '기준금리 인하?',
  orderId: ORDER,
  correctionEffect: null,
  createdAt: '2026-11-16T03:04:05.000Z',
};

function row(entry: Partial<LedgerEntry>, variant?: 'full' | 'preview', only?: string) {
  return renderWithQueries(
    <LedgerRow entry={{ ...FILL, ...entry }} variant={variant} onlyMarketHref={only} />,
  );
}

/**
 * 이용 내역 한 줄 (#69, ADR-0144 결정 2): the kind's name, the signed Coin, the server's time, the
 * market and the links to where the details are (ADR-0135 H2); the preview's shape on MY 요약.
 */
describe('LedgerRow', () => {
  it('draws a fill with its name, signed Coin, time, market and its own order’s detail', () => {
    const html = row({}, 'full', ONLY);
    expect(byTestId(html, 'ledger-type')?.text).toBe('매수 체결');
    expect(byTestId(html, 'ledger-amount')?.text).toBe(`${MINUS_SIGN}120 Coin`);
    expect(html).toContain(formatKst(FILL.createdAt));
    expect(byTestId(html, 'ledger-market')?.text).toBe(FILL.marketTitle);
    expect(html).toContain(`href="/markets/${FILL.marketSlug ?? ''}"`);
    expect(byTestId(html, 'ledger-order-link')?.attributes.href).toBe(`/my/orders/${ORDER}`);
    expect(byTestId(html, 'ledger-only-market')?.attributes.href).toBe(ONLY);
    expect(byTestId(html, 'ledger-settlement-link')).toBeUndefined();
    expect(byTestId(html, 'ledger-balance-after')?.text).toBe(
      `${copy.ledgerBalanceAfter} 880 Coin`,
    );
    // A sale reads '매도 체결'; a fill whose order is not the reader's links no order.
    expect(byTestId(row({ kind: 'SELL_FILL', amountCoin: '45' }), 'ledger-type')?.text).toBe(
      '매도 체결',
    );
    expect(byTestId(row({ orderId: null }), 'ledger-order-link')).toBeUndefined();
  });

  it('links a payout to that market’s settlement records, never calling it a refund', () => {
    const html = row({
      kind: 'SETTLEMENT_PAYOUT',
      amountCoin: '100',
      refType: 'market',
      refId: MARKET,
      orderId: null,
    });
    expect(byTestId(html, 'ledger-type')?.text).toBe(copy.ledgerTypeSettlement);
    expect(byTestId(html, 'ledger-settlement-link')?.attributes.href).toBe(
      `/my/history?kind=settlements&market=${MARKET}`,
    );
    expect(byTestId(html, 'ledger-order-link')).toBeUndefined();
    expect(html).not.toContain('환불');
  });

  it('gives the start Coin no market and no link', () => {
    const html = row({
      kind: 'START_GRANT',
      amountCoin: '1000000',
      refType: 'start_grant',
      marketId: null,
      marketSlug: null,
      marketTitle: null,
      orderId: null,
    });
    expect(byTestId(html, 'ledger-type')?.text).toBe('시작 지급');
    for (const testId of [
      'ledger-market',
      'ledger-order-link',
      'ledger-settlement-link',
      'ledger-only-market',
      'ledger-reason',
    ]) {
      expect(byTestId(html, testId), testId).toBeUndefined();
    }
  });

  it('names a market that is no longer public without a link, and none without a title', () => {
    const hidden = row({ marketSlug: null });
    expect(byTestId(hidden, 'ledger-market')?.text).toBe(FILL.marketTitle);
    expect(hidden).not.toContain('href="/markets/');
    expect(byTestId(row({ marketSlug: null, marketTitle: null }), 'ledger-market')).toBeUndefined();
  });

  it('draws the preview with the name, the Coin, the time and the market’s name only', () => {
    const html = row({}, 'preview', ONLY);
    expect(byTestId(html, 'ledger-type')?.text).toBe('매수 체결');
    expect(byTestId(html, 'ledger-amount')?.text).toBe(`${MINUS_SIGN}120 Coin`);
    expect(html).toContain(formatKst(FILL.createdAt));
    expect(byTestId(html, 'ledger-market')?.text).toBe(FILL.marketTitle);
    expect(html).not.toContain('href=');
    expect(byTestId(html, 'ledger-balance-after')).toBeUndefined();
    expect(html).not.toContain(copy.ledgerBalanceAfter);
  });

  it('keeps a correction’s effect line in the preview, without its reason', () => {
    // The effect says a replenishment added no Coin, so the preview does not read it as a real
    // increase (ADR-0144 결정 3 '미리보기'); the reason and every link are the wallet's.
    const correction: Partial<LedgerEntry> = {
      kind: 'RECONCILIATION_CORRECTION',
      amountCoin: '10',
      refType: 'reconciliation_correction',
      refId: '7',
      memo: '장부를 보충했습니다.',
      marketId: null,
      marketSlug: null,
      marketTitle: null,
      orderId: null,
      correctionEffect: 'ledger_only',
    };
    const preview = row(correction, 'preview');
    expect(byTestId(preview, 'ledger-type')?.text).toBe('Coin 보정');
    expect(byTestId(preview, 'ledger-correction-effect')?.text).toBe(
      copy.reconciliationCorrectionReplenishHint,
    );
    expect(byTestId(preview, 'ledger-reason')).toBeUndefined();
    expect(preview).not.toContain('장부를 보충했습니다.');
    expect(preview).not.toContain('href=');
    expect(byTestId(row(correction, 'full'), 'ledger-reason')?.text).toBe(
      `${copy.ledgerCorrectionReason}: 장부를 보충했습니다.`,
    );
  });
});

/**
 * What node cannot mount of the section (the session, the router and the socket), read off the
 * source: the list semantics of both lists that draw a row, and MY's signed-out ladder.
 */
describe('LedgerSection and the lists of rows', () => {
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

  it('draws each row as a list item inside a list, on the wallet and in the MY preview', () => {
    // The same '주문 상세' and '이 시장만 보기' on every row are told apart by their row (WCAG 2.4.4).
    expect(row({}, 'full', ONLY)).toMatch(/^<li\b/);
    expect(row({}, 'preview')).toMatch(/^<li\b/);
    const list = '<Stack as="ul" listStyleType="none" m="0" p="0" gap="3" divideY="1px">';
    for (const file of ['./ledger-list.tsx', '../summary.tsx']) {
      const text = source(file);
      expect(text, file).toContain(list);
      expect(text.indexOf('<LedgerRow', text.indexOf(list)), file).toBeGreaterThan(0);
    }
  });

  it('takes the section away once the session ends, instead of waiting for a profile', () => {
    // `['me']` is reset and never read again after a sign-out elsewhere (ADR-0144 결정 2-10).
    const text = source('./ledger-list.tsx');
    const section = text.slice(text.indexOf('export function LedgerSection'));
    const ended = section.indexOf('if (ended) return null;');
    expect(section).toContain('const ended = useSessionEnded();');
    expect(ended).toBeGreaterThan(0);
    expect(ended).toBeLessThan(section.indexOf('<ProfileUnavailable'));
    expect(ended).toBeGreaterThan(section.indexOf('useWalletLockWatch(accountId);'));
  });
});
