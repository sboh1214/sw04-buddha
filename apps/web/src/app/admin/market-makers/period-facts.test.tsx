import type { MarketMakerPeriodMetrics } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { metricsSeconds } from '@/lib/market-maker-metrics';
import { renderWithQueries, byTestId } from '@/test/render';
import { MakerPeriodFacts } from './period-facts';

const period: MarketMakerPeriodMetrics = {
  window: { from: '2026-11-10T00:00:00.000Z', to: '2026-11-11T00:00:00.000Z' },
  activity: {
    basis: 'recorded_orders',
    coverage: 'complete',
    bot: { postedQty: '100', filledQty: '25', fillBp: '2500' },
    humanIoc: { orders: '10', filledOrders: '8', fillBp: '8000' },
  },
  supply: {
    basis: 'posted_book',
    coverage: 'partial',
    observedFrom: '2026-11-10T12:00:00.000Z',
    observedTo: '2026-11-11T00:00:00.000Z',
    openMs: '3600000',
    botGapMs: '1250',
    combinedGapMs: '0',
  },
};
describe('cumulative posted-book metrics', () => {
  it('names the actual posted cohort, human IOC counts and partial observed window separately', () => {
    const text = byTestId(
      renderWithQueries(<MakerPeriodFacts period={period} />),
      'maker-period-metrics',
    )!.text;
    for (const label of [
      copy.makerPeriodFillRate,
      copy.makerPeriodIocRate,
      copy.makerPeriodPartialSupply,
      copy.makerPeriodSupplyLimits,
    ])
      expect(text).toContain(label);
    expect(text).toContain('25.00%');
    expect(text).toContain('80.00%');
    expect(text).toContain('3,600.000');
    expect(text).toContain('1.250');
    expect(text).toContain('0.000');
  });
  it('does not substitute zero seconds or a zero rate for unobserved history', () => {
    const missing: MarketMakerPeriodMetrics = {
      ...period,
      window: { ...period.window, from: null },
      activity: { basis: 'recorded_orders', coverage: 'unavailable', bot: null, humanIoc: null },
      supply: {
        basis: 'posted_book',
        coverage: 'unavailable',
        observedFrom: null,
        observedTo: null,
        openMs: null,
        botGapMs: null,
        combinedGapMs: null,
      },
    };
    const text = byTestId(
      renderWithQueries(<MakerPeriodFacts period={missing} />),
      'maker-period-metrics',
    )!.text;
    expect(text).toContain(copy.makerPeriodNotOpened);
    expect(text).toContain(copy.makerPeriodUnobserved);
    expect(text).not.toContain('0.000');
    expect(text).not.toContain('0.00%');
    expect(text).not.toContain(copy.makerPeriodObserved);
  });
  it('shows an actual empty denominator as a count of zero and an inapplicable rate', () => {
    const text = byTestId(
      renderWithQueries(
        <MakerPeriodFacts
          period={{
            ...period,
            activity: {
              ...period.activity,
              bot: { postedQty: '0', filledQty: '0', fillBp: null },
              humanIoc: { orders: '0', filledOrders: '0', fillBp: null },
            },
          }}
        />,
      ),
      'maker-period-metrics',
    )!.text;
    expect(text).toContain(copy.makerPeriodPosted + '0');
    expect(text).toContain(copy.makerPeriodFillRate + '—');
    expect(text).not.toContain('0.00%');
  });
  it('formats a duration beyond Number.MAX_SAFE_INTEGER without losing its milliseconds', () => {
    expect(metricsSeconds('9007199254740993')).toBe('9,007,199,254,740.993');
    expect(metricsSeconds(null)).toBe('—');
  });
});
