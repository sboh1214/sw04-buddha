import type {
  AdminMarketMakerMetrics,
  AdminMarketMakerMetricsListItem,
  AdminMarketMakerMetricsOverview,
} from '@/lib/api';
import { treasury } from './treasury';

export const makerMetrics: AdminMarketMakerMetrics = {
  marketId: '00000000-0000-4000-8000-000000000001',
  title: '시험 시장',
  status: 'provisional',
  asOf: '2026-11-11T01:00:00.000Z',
  configVersion: 2,
  openedVersion: 1,
  risk: {
    kind: 'ready',
    assets: {
      coin: '900',
      availableCoin: '700',
      lockedCoin: '200',
      yesQty: '4',
      noQty: '1',
      yesLockedQty: '2',
      noLockedQty: '0',
    },
    capital: { investedCoin: '1000', recoveredCoin: '0' },
    maxLossCoin: '500',
    worstLossCoin: '100',
    reservedWorstLossCoin: '200',
    utilizationBp: '2000',
    stage: null,
    stageStatus: 'undecided',
    pnl: {
      kind: 'scenarios',
      holdings: { YES: '300', NO: '0', VOID: '150' },
      reserved: { YES: '-200', NO: '50', VOID: '-75' },
      provisionalResult: 'YES',
    },
  },
  depth: {
    bot: {
      YES: {
        bids: [
          { priceCoin: 1, qty: '6' },
          { priceCoin: 49, qty: '12' },
        ],
        asks: [{ priceCoin: 99, qty: '2' }],
      },
      NO: { bids: [], asks: [{ priceCoin: 51, qty: '3' }] },
    },
    human: {
      YES: { bids: [{ priceCoin: 48, qty: '9007199254740993' }], asks: [] },
      NO: { bids: [{ priceCoin: 47, qty: '9' }], asks: [{ priceCoin: 53, qty: '8' }] },
    },
  },
  concentration: {
    setting: { key: 'market_maker.concentration_top_n', status: 'undecided', value: null },
    YES: { totalQty: '100', topQty: null, topShareBp: null, holders: null },
    NO: { totalQty: '0', topQty: null, topShareBp: null, holders: null },
  },
};
export const makerMetricsRow: AdminMarketMakerMetricsListItem = {
  marketId: makerMetrics.marketId,
  title: makerMetrics.title,
  status: makerMetrics.status,
  asOf: makerMetrics.asOf,
  configVersion: 2,
  openedVersion: 1,
  risk: makerMetrics.risk,
  runtime: { desiredEnabled: true, state: 'error', reason: 'private SQL trace' },
};
export const makerOverview: AdminMarketMakerMetricsOverview = {
  asOf: makerMetrics.asOf,
  scope: 'funded_markets',
  marketCount: '2',
  readyCount: '1',
  complete: false,
  treasury,
  totals: {
    worstLossCoin: '100',
    reservedWorstLossCoin: '200',
    maxLossCoin: '500',
    investedCoin: '1000',
    recoveredCoin: '0',
    fundsCoin: '900',
  },
  missing: [
    { marketId: '00000000-0000-4000-8000-000000000002', kind: 'inconsistent', reason: 'coin_gap' },
  ],
};
