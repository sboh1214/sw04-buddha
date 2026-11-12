import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { metricsCount, metricsPercent, metricsReason } from './market-maker-metrics';

describe('exact current-metrics presentation', () => {
  it('keeps counts and basis-point fractions beyond the JSON integer boundary exact', () => {
    expect(metricsCount('9007199254740993')).toBe('9,007,199,254,740,993');
    expect(metricsPercent('9007199254740993')).toBe('90,071,992,547,409.93%');
    expect(metricsPercent('1')).toBe('0.01%');
    expect(metricsPercent('10001')).toBe('100.01%');
  });
  it('explains known data failures and never passes through an unknown or inherited object key', () => {
    expect(metricsReason('coin_gap')).toBe(copy.makerMetricsCoinGap);
    expect(metricsReason('settlement_books')).toBe(copy.makerMetricsSettlementBooks);
    expect(metricsReason('missing_funds')).toBe(copy.marketMakerNotAllocated);
    expect(metricsReason('SELECT txid FROM funds')).toBe(copy.makerMetricsUnknownReason);
    expect(metricsReason('constructor')).toBe(copy.makerMetricsUnknownReason);
  });
});
