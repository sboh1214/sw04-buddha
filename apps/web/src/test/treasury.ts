import type { AdminTreasury, TreasuryIssueRequest, TreasuryIssuance } from '@/lib/api';

export const treasury: AdminTreasury = {
  accountId: '1',
  status: 'ready',
  availableCoin: '1000',
  lockedCoin: '0',
  ledgerCoin: '1000',
  issuedCoin: '1200',
};
export const treasuryRequest: TreasuryIssueRequest = {
  id: '00000000-0000-4000-8000-000000000001',
  amountCoin: '1000',
  requestedBy: { id: 'admin-a', nickname: '요청 운영자' },
  reason: '시장 개장 배정에 필요한 금고 재원',
  requestedAt: '2026-11-10T01:00:00.000Z',
  status: 'pending',
  decidedBy: null,
  decisionReason: null,
  decidedAt: null,
  retractedAt: null,
  ledgerEntryId: null,
};
export const treasuryApproved: TreasuryIssueRequest = {
  ...treasuryRequest,
  status: 'approved',
  decidedBy: { id: 'admin-b', nickname: '승인 운영자' },
  decisionReason: '개장 예정 시장과 배정액을 확인했습니다.',
  decidedAt: '2026-11-10T01:01:00.000Z',
  ledgerEntryId: '20',
};
export const treasuryIssuance: TreasuryIssuance = {
  id: treasuryRequest.id,
  approvalId: treasuryRequest.id,
  amountCoin: treasuryRequest.amountCoin,
  ledgerEntryId: '20',
  issuedAt: '2026-11-10T01:01:00.000Z',
  requestedBy: treasuryRequest.requestedBy,
  approvedBy: treasuryApproved.decidedBy!,
  requestReason: treasuryRequest.reason,
  approvalReason: treasuryApproved.decisionReason!,
};
