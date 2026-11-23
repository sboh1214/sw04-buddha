import { MINUS_SIGN } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type MySettlement } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTestId, renderWithQueries } from '@/test/render';
import { SettlementHistoryRow } from './settlement-history-list';

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

/** A winning YES: 3 contracts bought for 120, paid 100 each. */
const WON: MySettlement = {
  marketId: MARKET,
  marketSlug: 'rate-cut-2026',
  marketTitle: '기준금리 인하?',
  outcome: 'YES',
  result: 'YES',
  qty: 3,
  costBasisCoin: '120',
  payoutPerContractCoin: 100,
  payoutCoin: '300',
  settlementPnlCoin: '180',
  resolvedAt: '2026-11-15T01:00:00.000Z',
  settledAt: '2026-11-16T02:00:00.000Z',
  correctedResult: null,
};

const ONLY = `/my/history?kind=settlements&market=${MARKET}`;

function row(over: Partial<MySettlement> = {}, only = true) {
  return renderWithQueries(
    <SettlementHistoryRow record={{ ...WON, ...over }} onlyMarketHref={only ? ONLY : undefined} />,
  );
}

const cell = (html: string, name: string) => byTestId(html, `history-settlement-${name}`)?.text;

/**
 * 정산 한 줄 (#124, ADR-0143 결정 6): every figure is the settlement record's own column — the
 * result, the quantity held then, the remaining cost, the payout per contract, the payout and
 * 정산 손익 — with the two times, each its own.
 */
describe('SettlementHistoryRow', () => {
  it('draws a winning contract: 100 a contract, the payout and the gain', () => {
    const html = row();
    expect(byTestId(html, `history-settlement-${MARKET}-YES`)).toBeDefined();
    expect(html).toContain(`/markets/${WON.marketSlug}`);
    expect(cell(html, 'result')).toBe(copy.yes);
    expect(cell(html, 'qty')).toBe('3계약');
    expect(cell(html, 'cost')).toBe('120 Coin');
    expect(cell(html, 'each')).toBe('100 Coin');
    expect(cell(html, 'payout')).toBe('300 Coin');
    expect(cell(html, 'pnl')).toBe('180 Coin');
    expect(cell(html, 'resolved-at')).toBe(formatKst(WON.resolvedAt ?? ''));
    expect(cell(html, 'settled-at')).toBe(formatKst(WON.settledAt));
    for (const label of [
      copy.marketResolvedResult,
      copy.historySettlementQty,
      copy.positionCostBasis,
      copy.historyPayoutPerContract,
      copy.historyPayout,
      copy.historySettlementPnl,
      copy.historyResolvedAt,
      copy.historySettledAt,
    ]) {
      expect(html, label).toContain(label);
    }
  });

  it('marks a corrected market’s row with the corrected result alone, its figures the paid ones (#144, 144-17)', () => {
    expect(byTestId(row(), 'history-settlement-corrected')).toBeUndefined();
    const html = row({ correctedResult: 'NO' });
    expect(byTestId(html, 'history-settlement-corrected')?.text).toBe('판정 정정 · 결과 NO');
    // The record's own columns stay the paid result's: YES, 100 a contract, 300 paid.
    expect(cell(html, 'result')).toBe(copy.yes);
    expect(cell(html, 'each')).toBe('100 Coin');
    expect(cell(html, 'payout')).toBe('300 Coin');
    // No amount in the mark (the compensation is the wallet's and the recap's).
    expect(byTestId(html, 'history-settlement-corrected')?.text).not.toMatch(/\d|Coin|보상/);
    expect(byTestId(row({ correctedResult: 'VOID' }), 'history-settlement-corrected')?.text).toBe(
      '판정 정정 · 결과 무효',
    );
    // 판정 기록 still leads to the record, where the correction is.
    expect(byTestId(html, 'history-settlement-judging')?.attributes.href).toBe(
      `/markets/${WON.marketSlug}#judging-record`,
    );
  });

  it('keeps a losing contract’s line: a payout of 0 Coin and the cost as its loss', () => {
    const html = row({
      outcome: 'NO',
      result: 'YES',
      qty: 2,
      costBasisCoin: '90',
      payoutPerContractCoin: 0,
      payoutCoin: '0',
      settlementPnlCoin: '-90',
    });
    expect(byTestId(html, `history-settlement-${MARKET}-NO`)).toBeDefined();
    expect(cell(html, 'result')).toBe(copy.yes);
    expect(cell(html, 'each')).toBe('0 Coin');
    expect(cell(html, 'payout')).toBe('0 Coin');
    expect(cell(html, 'pnl')).toBe(`${MINUS_SIGN}90 Coin`);
  });

  it('draws 무효 as 50 a contract with its own P&L, and never as money given back', () => {
    const html = row({
      result: 'VOID',
      qty: 4,
      costBasisCoin: '240',
      payoutPerContractCoin: 50,
      payoutCoin: '200',
      settlementPnlCoin: '-40',
    });
    expect(cell(html, 'result')).toBe(copy.marketResultVoid);
    expect(cell(html, 'each')).toBe('50 Coin');
    expect(cell(html, 'payout')).toBe('200 Coin');
    expect(cell(html, 'pnl')).toBe(`${MINUS_SIGN}40 Coin`);
    expect(html).not.toMatch(/환불|원금/);
  });

  it('shows a dash for a 결과 확정 time the market row does not carry', () => {
    const html = row({ resolvedAt: null });
    expect(cell(html, 'resolved-at')).toBe('—');
    expect(cell(html, 'settled-at')).toBe(formatKst(WON.settledAt));
  });

  it('links the public judging record, the market and this market’s history', () => {
    const html = row();
    const judging = byTestId(html, 'history-settlement-judging');
    expect(judging?.text).toBe(copy.historyJudgingRecord);
    expect(judging?.attributes.href).toBe(`/markets/${WON.marketSlug}#judging-record`);
    expect(byTestId(html, 'history-only-market')?.attributes.href).toBe(ONLY);
    expect(byTestId(row({}, false), 'history-only-market')).toBeUndefined();
  });
});
