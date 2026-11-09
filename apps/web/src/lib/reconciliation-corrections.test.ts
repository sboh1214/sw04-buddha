import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { correctionCandidate, correctionRequest } from '@/test/reconciliation-corrections';
import { ApiError } from './api';
import {
  correctionFailure,
  correctionReasonDraft,
  correctionRequestState,
  sameCorrectionCandidate,
} from './reconciliation-corrections';

describe('fixed correction proposals and permissions', () => {
  it('requires separate bounded member and internal reasons, and sends no member text for system accounts', () => {
    expect(correctionReasonDraft(' internal ', ' member ', true)).toEqual({
      reason: 'internal',
      userReason: 'member',
      ready: true,
    });
    for (const [reason, userReason] of [
      ['', 'member'],
      ['internal', ' '],
      ['x'.repeat(501), 'member'],
      ['internal', 'x'.repeat(501)],
    ])
      expect(correctionReasonDraft(reason!, userReason!, true).ready).toBe(false);
    expect(correctionReasonDraft('internal', 'must not leak', false)).toEqual({
      reason: 'internal',
      userReason: null,
      ready: true,
    });
  });
  it('pins account, mode, amount and opaque snapshot rather than accepting a changed proposal', () => {
    expect(sameCorrectionCandidate(correctionCandidate, { ...correctionCandidate })).toBe(true);
    for (const changed of [
      { accountId: '2' },
      { mode: 'replenish_ledger' as const },
      { amountCoin: '11' },
      { snapshotKey: 'b'.repeat(32) },
    ])
      expect(
        sameCorrectionCandidate(correctionCandidate, { ...correctionCandidate, ...changed }),
      ).toBe(false);
  });
  it('separates the requester, another operator, an unknown account and ended requests', () => {
    expect(correctionRequestState(correctionRequest, 'admin-a')).toMatchObject({
      canApprove: false,
      canReject: false,
      canRetract: true,
    });
    expect(correctionRequestState(correctionRequest, 'admin-b')).toMatchObject({
      canApprove: true,
      canReject: true,
      canRetract: false,
    });
    expect(correctionRequestState(correctionRequest, undefined)).toMatchObject({
      canApprove: false,
      canReject: false,
      canRetract: false,
    });
    for (const status of ['approved', 'rejected', 'retracted'] as const)
      expect(correctionRequestState({ ...correctionRequest, status }, 'admin-b')).toMatchObject({
        canApprove: false,
        canReject: false,
        canRetract: false,
      });
  });
  it.each([
    ['insufficient_treasury', copy.reconciliationCorrectionTreasuryWait],
    ['stale', copy.reconciliationCorrectionStale],
    ['unsupported', copy.reconciliationCorrectionNotEligible],
    ['pending', copy.reconciliationCorrectionPending],
  ])('explains %s without losing the open request', (reason, message) => {
    const error = new ApiError(400, {
      code: 'VALIDATION_ERROR',
      message: 'refused',
      details: [{ path: ['reconciliationCorrection'], message: reason }],
    });
    expect(correctionFailure(error)).toEqual({ message, close: false });
  });
});
