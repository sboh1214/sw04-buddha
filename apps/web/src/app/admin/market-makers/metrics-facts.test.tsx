import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import type { AdminMarketMakerMetrics } from '@/lib/api';
import { makerMetrics, makerMetricsRow, makerOverview } from '@/test/market-maker-metrics';
import { byTestId, renderWithQueries } from '@/test/render';
import { MakerMetricsRow, MakerOverview } from './admin-market-makers';
import { MarketMakerMetricsFacts } from '../markets/[id]/market-maker-metrics-panel';
import { MakerConcentration, MakerRiskFacts } from './metrics-facts';

describe('current private MM observations', () => {
  it('separates all result scenarios and reserved risk from an undecided stage', () => {
    const html = renderWithQueries(<MarketMakerMetricsFacts data={makerMetrics} />);
    const risk = byTestId(html, 'maker-metrics-risk')!.text;
    expect(risk).toContain(copy.marketMakerStageUndecided);
    expect(risk).not.toContain(copy.makerMetricsNormal);
    expect(risk).toContain('20.00%');
    expect(risk).toContain('200 Coin');
    expect(byTestId(html, 'maker-metrics-scenario-pnl')?.text).toContain('−200 Coin');
    expect(byTestId(html, 'maker-metrics-scenario-pnl')?.text).toContain('−75 Coin');
    expect(byTestId(html, 'maker-metrics-scenario-pnl')?.text).toContain('VOID');
    expect(byTestId(html, 'maker-metrics-actual-pnl')).toBeUndefined();
  });
  it('shows every bot/human level and exact large quantities without a fixed best-price truncation', () => {
    const html = renderWithQueries(<MarketMakerMetricsFacts data={makerMetrics} />);
    expect(byTestId(html, 'maker-depth-bot-YES')?.text).toContain('16');
    expect(byTestId(html, 'maker-depth-bot-YES')?.text).toContain('4912');
    expect(byTestId(html, 'maker-depth-bot-YES')?.text).toContain('992');
    expect(byTestId(html, 'maker-depth-human-YES')?.text).toContain('489,007,199,254,740,993');
    expect(byTestId(html, 'maker-depth-bot-NO')?.text).toContain(copy.makerMetricsNoOrders);
    expect(byTestId(html, 'maker-depth-human-NO')?.text).toContain('538');
  });
  it.each(['unavailable', 'inconsistent'] as const)(
    'keeps %s values absent and never renders an internal reason',
    (kind) => {
      const html = renderWithQueries(
        <MakerRiskFacts risk={{ kind, reason: 'SELECT txid funds_account_secret' }} />,
      );
      expect(html).toContain(
        kind === 'inconsistent' ? copy.makerMetricsInconsistent : copy.makerMetricsUnavailable,
      );
      expect(html).toContain(copy.makerMetricsUnknownReason);
      expect(html).not.toContain('0 Coin');
      expect(html).not.toContain('SELECT');
      expect(html).not.toContain('funds_account_secret');
      expect(byTestId(html, 'maker-metrics-risk')).toBeUndefined();
    },
  );
  it('keeps unknown concentration N undecided even if an inconsistent cached DTO carries a list', () => {
    const html = renderWithQueries(
      <MakerConcentration
        concentration={{
          ...makerMetrics.concentration,
          YES: {
            totalQty: '100',
            topQty: '90',
            topShareBp: '9000',
            holders: [{ userId: 'private-user', nickname: '숨길명단', qty: '90', shareBp: '9000' }],
          },
        }}
      />,
    );
    expect(html).toContain(copy.makerMetricsTopNUndecided);
    expect(html).toContain(copy.makerMetricsTotalQty);
    expect(html).not.toContain('90.00%');
    expect(html).not.toContain('숨길명단');
    expect(html).not.toContain('private-user');
    expect(html).not.toContain('시험값 5');
  });
  it('shows configured concentration with nicknames and admin links only, separating YES/NO and empty holders', () => {
    const html = renderWithQueries(
      <MakerConcentration
        concentration={{
          setting: { ...makerMetrics.concentration.setting, status: 'test', value: 2 },
          YES: {
            totalQty: '100',
            topQty: '80',
            topShareBp: '8000',
            holders: [{ userId: 'member-a', nickname: '첫보유자', qty: '80', shareBp: '8000' }],
          },
          NO: { totalQty: '0', topQty: '0', topShareBp: null, holders: [] },
        }}
      />,
    );
    expect(html).toContain('시험값 2');
    expect(byTestId(html, 'maker-concentration-YES')?.text).toContain('첫보유자');
    expect(byTestId(html, 'maker-concentration-YES')?.text).toContain('80.00%');
    expect(html).toContain('href="/admin/moderation/users/member-a"');
    expect(byTestId(html, 'maker-concentration-YES')?.text).not.toContain('member-a');
    expect(byTestId(html, 'maker-concentration-NO')?.text).toContain(copy.makerMetricsNoHolders);
    expect(byTestId(html, 'maker-concentration-NO')?.text).toContain('—');
    expect(byTestId(html, 'maker-concentration-NO')?.text).not.toContain(
      copy.makerMetricsTopUnavailable,
    );
    expect(byTestId(html, 'maker-concentration-NO')?.text).not.toContain('0.00%');
  });
  it.each(['paid', 'cancelled'] as const)(
    'shows %s actual PnL instead of hypothetical outcomes',
    (reason) => {
      const risk = makerMetrics.risk as Extract<AdminMarketMakerMetrics['risk'], { kind: 'ready' }>;
      const html = renderWithQueries(
        <MakerRiskFacts
          risk={{
            ...risk,
            pnl: {
              kind: 'actual',
              amountCoin: '-100',
              reason,
              result: reason === 'paid' ? 'NO' : null,
            },
          }}
        />,
      );
      expect(byTestId(html, 'maker-metrics-actual-pnl')?.text).toContain('−100 Coin');
      expect(byTestId(html, 'maker-metrics-actual-pnl')?.text).toContain(
        reason === 'paid' ? copy.makerMetricsPaid : copy.makerMetricsCancelled,
      );
      expect(byTestId(html, 'maker-metrics-scenario-pnl')).toBeUndefined();
    },
  );
  it('labels server-wide partial totals and the same-snapshot treasury without claiming missing markets are zero', () => {
    const html = renderWithQueries(<MakerOverview data={makerOverview} />);
    expect(byTestId(html, 'maker-overview-completeness')?.text).toBe(copy.makerMetricsPartial);
    expect(html).toContain('1 / 2');
    expect(html).toContain(copy.makerMetricsCoinGap);
    expect(html).toContain('1,000 Coin');
    expect(byTestId(html, 'treasury-availableCoin')?.text).toContain('1,000 Coin');
    expect(html).not.toContain(copy.makerMetricsComplete);
    expect(html).not.toContain('<button');
  });
  it('preserves missing treasury readings and runtime failure independently from ready risk', () => {
    const overview = renderWithQueries(
      <MakerOverview
        data={{
          ...makerOverview,
          treasury: {
            accountId: null,
            status: 'uninitialized',
            availableCoin: null,
            lockedCoin: null,
            ledgerCoin: null,
            issuedCoin: '0',
          },
        }}
      />,
    );
    expect(byTestId(overview, 'treasury-availableCoin')?.text).toContain('—');
    const html = renderWithQueries(<MakerMetricsRow data={makerMetricsRow} />);
    expect(html).toContain(copy.marketMakerError);
    expect(html).toContain(copy.marketMakerUnknownReason);
    expect(html).not.toContain('private SQL trace');
    expect(byTestId(html, 'maker-metrics-risk')).toBeDefined();
    expect(html).not.toContain('<button');
  });
});
