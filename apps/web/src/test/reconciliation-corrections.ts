import type {
  ReconciliationCorrectionCandidate,
  ReconciliationCorrectionDetail,
  ReconciliationCorrectionRequest,
  MemberReconciliationCorrection,
} from '@/lib/api';

export const correctionCandidate: ReconciliationCorrectionCandidate = {
  accountId: '1',
  accountKind: 'user',
  userId: 'holder',
  marketId: null,
  holdId: '00000000-0000-4000-8000-000000000001',
  mode: 'restore_actual',
  amountCoin: '10',
  balanceDeltaCoin: '10',
  balanceBeforeCoin: '90',
  balanceAfterCoin: '100',
  ledgerBeforeCoin: '100',
  ledgerAfterCoin: '100',
  snapshotKey: 'a'.repeat(32),
};
export const correctionRequest: ReconciliationCorrectionRequest = {
  id: '00000000-0000-4000-8000-000000000002',
  resultId: '10',
  candidate: correctionCandidate,
  requestedBy: { id: 'admin-a', nickname: '요청 운영자' },
  reason: '내부 검사 사유',
  userReason: '누락된 잔고를 복원했습니다.',
  requestedAt: '2026-11-09T01:00:00.000Z',
  status: 'pending',
  decidedBy: null,
  decisionReason: null,
  decidedAt: null,
  retractedAt: null,
};
export const correctionDetail: ReconciliationCorrectionDetail = {
  result: {
    id: '10',
    scope: 'account',
    targetKey: 'user:holder',
    marketId: null,
    accountId: '1',
    userId: 'holder',
    source: 'manual',
    passed: false,
    checkedAt: '2026-11-09T01:00:00.000Z',
    ledgerCursor: '7',
    findings: [{ code: 'account_balance', expected: '100', actual: '90' }],
    facts: {},
  },
  candidates: [correctionCandidate],
  requests: [correctionRequest],
};
export const memberCorrection: MemberReconciliationCorrection = {
  id: '00000000-0000-4000-8000-000000000003',
  eventId: '9',
  mode: 'restore_actual',
  amountCoin: '10',
  balanceDeltaCoin: '10',
  balanceAfterCoin: '100',
  userReason: '누락된 잔고를 복원했습니다.',
  createdAt: '2026-11-09T01:01:00.000Z',
};
