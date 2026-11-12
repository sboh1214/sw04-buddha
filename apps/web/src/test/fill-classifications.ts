import type {
  AdminClassifiableFill,
  FillClassificationRequest,
  FillClassificationWrite,
} from '@/lib/api';
export const classificationFill: AdminClassifiableFill = {
  id: '12',
  marketId: '11111111-1111-4111-8111-111111111111',
  marketTitle: '시험 시장',
  outcome: 'YES',
  priceCoin: 60,
  qty: 2,
  amountCoin: '120',
  createdAt: '2026-11-11T00:00:00.000Z',
  classificationRevision: '0',
  excluded: false,
  classification: null,
};
export const classificationRequest: FillClassificationRequest = {
  id: '22222222-2222-4222-8222-222222222222',
  payload: {
    fillId: classificationFill.id,
    marketId: classificationFill.marketId,
    action: 'mark',
    baseRevision: '0',
  },
  requestedBy: { id: 'requester', nickname: '요청 관리자' },
  reason: '인위적 참여 증거 확인',
  requestedAt: '2026-11-11T01:00:00.000Z',
  status: 'pending',
  decidedBy: null,
  decisionReason: null,
  decidedAt: null,
  retractedAt: null,
  execution: null,
};
export const classifiedWrite: FillClassificationWrite = (() => {
  const execution = {
    revision: '1',
    approvalId: classificationRequest.id,
    fillId: classificationFill.id,
    marketId: classificationFill.marketId,
    action: 'mark' as const,
    requestedBy: classificationRequest.requestedBy,
    approvedBy: { id: 'decider', nickname: '다른 관리자' },
    reason: classificationRequest.reason,
    decisionReason: '독립 확인',
    performedAt: '2026-11-11T02:00:00.000Z',
  };
  return {
    request: {
      ...classificationRequest,
      status: 'approved',
      decidedBy: execution.approvedBy,
      decisionReason: execution.decisionReason,
      decidedAt: execution.performedAt,
      execution,
    },
    fill: {
      ...classificationFill,
      classificationRevision: '1',
      excluded: true,
      classification: execution,
    },
  };
})();
