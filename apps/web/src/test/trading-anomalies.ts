import type { TradingAnomalyCandidate, TradingAnomalyReport } from '@/lib/api';

export const anomalyCandidate: TradingAnomalyCandidate = {
  id: 'pair-market-a-b',
  kind: 'human_pair',
  market: { id: '00000000-0000-4000-8000-000000000001', title: '검토할 시장', status: 'open' },
  actors: [
    { userId: 'person-a', nickname: '첫 회원' },
    { userId: 'person-b', nickname: '둘째 회원' },
  ],
  outcome: null,
  count: '2',
  quantity: '9007199254740993',
  windowStartedAt: '2026-11-11T01:00:00.000Z',
  windowEndedAt: '2026-11-11T01:01:00.000Z',
  evidenceTotal: '1',
  evidenceTruncated: false,
  evidence: [
    {
      first: {
        fillId: '9007199254740993',
        orderId: '00000000-0000-4000-8000-000000000002',
        userId: 'person-a',
        at: '2026-11-11T01:00:00.000Z',
        outcome: 'YES',
        side: 'buy',
        priceCoin: 37,
        qty: '3',
      },
      second: {
        fillId: '9007199254740993',
        orderId: '00000000-0000-4000-8000-000000000003',
        userId: 'person-b',
        at: '2026-11-11T01:00:00.000Z',
        outcome: 'NO',
        side: 'buy',
        priceCoin: 63,
        qty: '3',
      },
      matchedQty: '3',
    },
  ],
};
export const anomalyReport: TradingAnomalyReport = {
  asOf: '2026-11-11T02:00:00.000Z',
  marketId: null,
  rangeStartedAt: '2026-11-10T02:00:00.000Z',
  source: {
    scannedFills: 2,
    limit: 10000,
    truncated: false,
    complete: true,
    oldestScannedAt: anomalyCandidate.windowStartedAt,
  },
  signals: (['human_pair', 'round_trip'] as const).map((kind) => ({
    kind,
    status: 'ready',
    rangeStartedAt: '2026-11-10T02:00:00.000Z',
    observedCandidates: kind === 'human_pair' ? '1' : '0',
    candidatesTruncated: false,
    settings: {
      count: { key: `${kind}.count`, status: 'approved', value: 2 },
      windowSeconds: { key: `${kind}.window`, status: 'approved', value: 60 },
      lookbackSeconds: { key: `${kind}.lookback`, status: 'approved', value: 86400 },
    },
  })),
  candidates: [anomalyCandidate],
};
