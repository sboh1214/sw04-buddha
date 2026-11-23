import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MINUS_SIGN } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type MySettlement } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { type RecapEntry } from '@/lib/market-recap';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { SRC } from '@/test/screen-text';
import { MarketHistoryLink, SettledRecap } from './settled-recap';

/**
 * 지급 완료 시장의 내 포지션 (#34, ADR-0145; ADR-0135 I1, 결과 4): the recap as drawn — each
 * contract's settlement record with its result, the two times and the row's cumulative 실현 손익, no
 * total line; a contract sold out before the payout as '보유 없음' with its 실현 손익 alone; and the
 * way to this market's records on MY. Props alone, so the static render is what the browser draws.
 */

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

/** A winning YES held at 2 for 60 at the payout: 200 paid, +140, and 152 realised in all. */
const WON: MySettlement = {
  marketId: MARKET,
  marketSlug: 'rate-cut-2026',
  marketTitle: '기준금리 인하?',
  outcome: 'YES',
  result: 'YES',
  qty: 2,
  costBasisCoin: '60',
  payoutPerContractCoin: 100,
  payoutCoin: '200',
  settlementPnlCoin: '140',
  resolvedAt: '2026-11-15T01:00:00.000Z',
  settledAt: '2026-11-16T02:00:00.000Z',
  correctedResult: null,
};

const record = (over: Partial<MySettlement> = {}, realized: string | null = '152'): RecapEntry => {
  const settled = { ...WON, ...over };
  return { kind: 'record', outcome: settled.outcome, record: settled, realizedPnlCoin: realized };
};

const draw = (entries: RecapEntry[]) =>
  renderWithQueries(<SettledRecap entries={entries} marketId={MARKET} />);

/** One cell of one contract's block: the block's own markup, so a cell is never the other's. */
function cell(html: string, outcome: 'yes' | 'no', name: string): string | undefined {
  const at = html.indexOf(`data-testid="market-settled-${outcome}"`);
  expect(at, `market-settled-${outcome}`).toBeGreaterThanOrEqual(0);
  // YES is drawn first, so the YES block ends where the NO block starts.
  const no = outcome === 'yes' ? html.indexOf('data-testid="market-settled-no"') : -1;
  const own = html.slice(
    html.lastIndexOf('<', at),
    no === -1 ? undefined : html.lastIndexOf('<', no),
  );
  return byTestId(own, `market-settled-${name}`)?.text;
}

describe('SettledRecap', () => {
  it('draws a record’s seven figures and two times, the quantity being the record’s', () => {
    const html = draw([record()]);
    expect(cell(html, 'yes', 'result')).toBe(copy.yes);
    // The payout left the row at 0; the recap shows what was held then.
    expect(cell(html, 'yes', 'qty')).toBe('2계약');
    expect(cell(html, 'yes', 'cost')).toBe('60 Coin');
    expect(cell(html, 'yes', 'each')).toBe('100 Coin');
    expect(cell(html, 'yes', 'payout')).toBe('200 Coin');
    expect(cell(html, 'yes', 'settlement-pnl')).toBe('140 Coin');
    // The row's own 실현 손익, the cumulative one — never the record's 정산 손익 taken off it.
    expect(cell(html, 'yes', 'realized')).toBe('152 Coin');
    expect(cell(html, 'yes', 'resolved-at')).toBe(formatKst(WON.resolvedAt ?? ''));
    expect(cell(html, 'yes', 'settled-at')).toBe(formatKst(WON.settledAt));
    for (const label of [
      copy.marketResolvedResult,
      copy.historySettlementQty,
      copy.positionCostBasis,
      copy.historyPayoutPerContract,
      copy.historyPayout,
      copy.historySettlementPnl,
      copy.positionRealizedPnl,
      copy.historyResolvedAt,
      copy.historySettledAt,
    ]) {
      expect(html, label).toContain(label);
    }
    // Nine cells and no tenth: no total line beside the two P&Ls (ADR-0135 결과 4).
    expect(
      testIdsStartingWith(html, 'market-settled-').filter((id) => id !== 'market-settled-yes'),
    ).toEqual([
      'market-settled-result',
      'market-settled-qty',
      'market-settled-cost',
      'market-settled-each',
      'market-settled-payout',
      'market-settled-settlement-pnl',
      'market-settled-realized',
      'market-settled-resolved-at',
      'market-settled-settled-at',
    ]);
    expect(html).not.toMatch(/합계|환불|원금|순위|점수|실력/);
  });

  it('keeps a losing contract’s line with a payout of 0 and its loss', () => {
    const html = draw([
      record(
        {
          outcome: 'NO',
          costBasisCoin: '140',
          payoutPerContractCoin: 0,
          payoutCoin: '0',
          settlementPnlCoin: '-140',
        },
        '-140',
      ),
    ]);
    expect(cell(html, 'no', 'each')).toBe('0 Coin');
    expect(cell(html, 'no', 'payout')).toBe('0 Coin');
    expect(cell(html, 'no', 'settlement-pnl')).toBe(`${MINUS_SIGN}140 Coin`);
    expect(cell(html, 'no', 'realized')).toBe(`${MINUS_SIGN}140 Coin`);
  });

  it('draws 무효 as 50 a contract with the P&L its price makes, never as money given back', () => {
    const html = draw([
      record({
        result: 'VOID',
        costBasisCoin: '140',
        payoutPerContractCoin: 50,
        payoutCoin: '100',
        settlementPnlCoin: '-40',
      }),
    ]);
    expect(cell(html, 'yes', 'result')).toBe(copy.marketResultVoid);
    expect(cell(html, 'yes', 'each')).toBe('50 Coin');
    expect(cell(html, 'yes', 'settlement-pnl')).toBe(`${MINUS_SIGN}40 Coin`);
    expect(html).not.toMatch(/환불|원금/);
  });

  it('shows a contract sold out before the payout as 보유 없음 and its 실현 손익 alone', () => {
    const html = draw([
      record(),
      { kind: 'soldOut', outcome: 'NO', result: 'YES', realizedPnlCoin: '-15' },
    ]);
    expect(byTestId(html, 'market-settled-no-holding')?.text).toBe(copy.positionNoHolding);
    expect(cell(html, 'no', 'result')).toBe(copy.yes);
    expect(cell(html, 'no', 'realized')).toBe(`${MINUS_SIGN}15 Coin`);
    for (const name of ['qty', 'payout', 'settlement-pnl', 'settled-at', 'resolved-at']) {
      expect(cell(html, 'no', name), name).toBeUndefined();
    }
    // YES first, each block its own.
    expect(html.indexOf('market-settled-yes')).toBeLessThan(html.indexOf('market-settled-no'));
  });

  it('draws no settlement line and no records link when no contract has a record', () => {
    const html = draw([{ kind: 'soldOut', outcome: 'YES', result: null, realizedPnlCoin: '0' }]);
    // The positive control first: the block is there.
    expect(byTestId(html, 'market-settled-yes')).toBeDefined();
    expect(cell(html, 'yes', 'result')).toBe('—');
    expect(testIdsStartingWith(html, 'market-settled-settlement-pnl')).toEqual([]);
    expect(testIdsStartingWith(html, 'market-settled-settled-at')).toEqual([]);
    expect(byTestId(html, 'market-history-settlements')).toBeUndefined();
  });

  it('writes a dash for a 실현 손익 or a 결과 확정 time it does not have', () => {
    const html = draw([record({ resolvedAt: null }, null)]);
    expect(cell(html, 'yes', 'realized')).toBe('—');
    expect(cell(html, 'yes', 'resolved-at')).toBe('—');
    expect(cell(html, 'yes', 'settled-at')).toBe(formatKst(WON.settledAt));
  });

  it('links this market’s settlement records on MY, without a prefetch', () => {
    const link = byTestId(draw([record()]), 'market-history-settlements');
    expect(link?.text).toBe(copy.marketHistorySettlements);
    expect(link?.attributes.href).toBe(`/my/history?kind=settlements&market=${MARKET}`);
    const source = readFileSync(path.join(SRC, 'components/market/settled-recap.tsx'), 'utf8');
    expect(source).toMatch(/<NextLink href=\{href as Route\} prefetch=\{false\}/);
  });
});

describe('MarketHistoryLink', () => {
  it('draws one link with its label and address', () => {
    const html = renderWithQueries(
      <MarketHistoryLink href="/my/history?market=x" label="이 시장 끝난 주문" testId="t" />,
    );
    expect(byTestId(html, 't')?.attributes.href).toBe('/my/history?market=x');
    expect(byTestId(html, 't')?.text).toBe('이 시장 끝난 주문');
  });
});

describe('the detail’s 내 포지션 (my-position.tsx)', () => {
  it('reads records through the recap’s hook and draws the recap for a paid-out market', () => {
    // The whole card is the session's (useSession is pending in a static render), so its wiring is
    // pinned here and its drawing by the e2e (settlement.spec.ts).
    const source = readFileSync(path.join(SRC, 'components/market/my-position.tsx'), 'utf8');
    expect(source).toContain('useMarketSettlements(marketId, status, accountId)');
    expect(source).toContain('recapViewOf({');
    expect(source).toContain('records: recordsReadingOf(records, mountedAt, recordRows.length)');
    expect(source).not.toContain('isFetchedAfterMount');
    expect(source).toContain('positionEmptyCopy(status)');
    expect(source).not.toContain('SettledPositionRows');
    const hook = readFileSync(path.join(SRC, 'hooks/use-market-recap.ts'), 'utf8');
    expect(hook).toContain("const enabled = base.enabled && status === 'settled';");
    // The cancel of a read already out runs before the query's own effects (hook order): on
    // mount, and again when the query turns on (`enabled` in its deps).
    const cancel = hook.indexOf('cancelEarlierRecordReads(');
    expect(cancel).toBeGreaterThan(-1);
    expect(cancel).toBeLessThan(hook.indexOf('useInfiniteQuery({'));
    expect(hook).toContain('[queryClient, marketId, accountId, enabled]');
    expect(hook).toContain("refetchOnMount: 'always'");
    expect(hook).toContain('staleTime: recordsStaleTime(mountedAt)');
    expect(hook).toContain('const [mountedAt] = useState(() => Date.now());');
  });
});
