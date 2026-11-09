import { describe, expect, it } from 'vitest';
import {
  memberReconciliationCorrectionSchema,
  requestReconciliationCorrectionBodySchema,
} from './reconciliation-correction.js';

const request = {
  expectedAccountId: 'admin-a',
  accountId: '1',
  mode: 'restore_actual',
  amountCoin: '10',
  snapshotKey: 'a'.repeat(32),
  reason: '검증한 내부 사유',
  userReason: '복원 안내',
};
describe('reconciliation correction boundaries', () => {
  it('accepts server-pinned amounts and requires a separate nonblank user reason or explicit null', () => {
    expect(requestReconciliationCorrectionBodySchema.safeParse(request).success).toBe(true);
    expect(
      requestReconciliationCorrectionBodySchema.safeParse({ ...request, userReason: null }).success,
    ).toBe(true);
    expect(
      requestReconciliationCorrectionBodySchema.safeParse({ ...request, userReason: '  ' }).success,
    ).toBe(false);
    const { userReason: _, ...missing } = request;
    expect(requestReconciliationCorrectionBodySchema.safeParse(missing).success).toBe(false);
  });
  it.each([
    { amountCoin: '-1' },
    { amountCoin: '0' },
    { amountCoin: '1.5' },
    { accountId: '9007199254740992' },
    { snapshotKey: 'client-choice' },
    { mode: 'user_debit' },
    { reason: ' ' },
  ])('rejects malformed monetary evidence %j', (change) => {
    expect(
      requestReconciliationCorrectionBodySchema.safeParse({ ...request, ...change }).success,
    ).toBe(false);
  });
  it('keeps internal evidence, approval identities and private reasons out of the member DTO', () => {
    const publicRow = {
      id: '54de7857-c271-4630-bdab-93c18dd7c267',
      eventId: '10',
      mode: 'replenish_ledger',
      amountCoin: '10',
      balanceDeltaCoin: '0',
      balanceAfterCoin: '110',
      userReason: '계정 원장 차이를 바로잡았습니다.',
      createdAt: '2026-11-09T00:00:00.000Z',
    };
    expect(
      memberReconciliationCorrectionSchema.parse({
        ...publicRow,
        failureResultId: '33',
        auditFailureId: '44',
        approvalId: 'secret',
        requestedBy: 'admin-a',
        approvedBy: 'admin-b',
        reason: 'internal',
      }),
    ).toEqual(publicRow);
  });
});
