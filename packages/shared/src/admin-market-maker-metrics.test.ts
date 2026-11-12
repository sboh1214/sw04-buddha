import { describe, expect, it } from 'vitest';
import {
  adminMarketMakerMetricsOverviewSchema,
  listMarketMakerMetricsQuerySchema,
} from './admin-market-maker-metrics.js';
import {
  MARKET_MAKER_CONCENTRATION_TOP_N_SETTING,
  RELEASE_SETTINGS,
  readReleaseSetting,
} from './release-settings.js';

describe('current market maker metric contracts', () => {
  it('keeps N initially undecided and accepts positive safe integers without a launch cap', () => {
    expect(
      readReleaseSetting(RELEASE_SETTINGS, MARKET_MAKER_CONCENTRATION_TOP_N_SETTING, undefined),
    ).toEqual({ key: 'market_maker.concentration_top_n', status: 'undecided', value: null });
    for (const n of [1, 5, 101, Number.MAX_SAFE_INTEGER])
      expect(MARKET_MAKER_CONCENTRATION_TOP_N_SETTING.schema.safeParse(n).success).toBe(true);
    for (const n of [0, -1, 1.5, '5', Number.MAX_SAFE_INTEGER + 1, null])
      expect(MARKET_MAKER_CONCENTRATION_TOP_N_SETTING.schema.safeParse(n).success).toBe(false);
  });
  it('carries exact aggregate amounts and counts beyond Number.MAX_SAFE_INTEGER', () => {
    const big = '90071992547409930000';
    const data = {
      asOf: '2026-11-10T00:00:00.000Z',
      scope: 'funded_markets',
      marketCount: big,
      readyCount: big,
      complete: true,
      treasury: {
        accountId: null,
        status: 'uninitialized',
        availableCoin: null,
        lockedCoin: null,
        ledgerCoin: null,
        issuedCoin: '0',
      },
      totals: {
        worstLossCoin: big,
        reservedWorstLossCoin: big,
        maxLossCoin: big,
        investedCoin: big,
        recoveredCoin: big,
        fundsCoin: big,
      },
      missing: [],
    };
    expect(adminMarketMakerMetricsOverviewSchema.parse(data)).toEqual(data);
    expect(
      adminMarketMakerMetricsOverviewSchema.safeParse({ ...data, marketCount: 42 }).success,
    ).toBe(false);
    expect(
      adminMarketMakerMetricsOverviewSchema.safeParse({ ...data, marketCount: '-1' }).success,
    ).toBe(false);
  });
  it('uses the existing bounded page convention without a metric time window', () => {
    expect(listMarketMakerMetricsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(listMarketMakerMetricsQuerySchema.parse({ limit: '100', cursor: 'next' })).toEqual({
      limit: 100,
      cursor: 'next',
    });
    expect(listMarketMakerMetricsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
