import { describe, expect, it } from 'vitest';
import { RECONCILIATION_FINDING_CODES } from '@buddha/shared';
import { copy } from '@/copy';
import { ApiError, type ReconciliationHoldDetail } from './api';
import {
  RECONCILIATION_FINDING_LABEL,
  reconciliationFailure,
  reconciliationHoldTarget,
  reconciliationRecoveryState,
  reconciliationTargetDraft,
} from './reconciliation';

const AT = '2026-11-09T01:00:00.000Z';
export const cleanHold: ReconciliationHoldDetail = {
  hold: {
    id: '00000000-0000-4000-8000-000000000001',
    scope: 'account',
    targetKey: 'user:holder',
    marketId: null,
    userId: 'holder',
    failureResultId: '10',
    legacyPauseId: null,
    startedAt: AT,
    recoveredAt: null,
  },
  latestResult: {
    id: '11',
    scope: 'account',
    targetKey: 'user:holder',
    marketId: null,
    accountId: '1',
    userId: 'holder',
    source: 'manual',
    passed: true,
    checkedAt: AT,
    ledgerCursor: '3',
    findings: [],
    facts: {},
  },
  requests: [],
  market: null,
  user: { id: 'holder', nickname: '보유자' },
};
const pending: ReconciliationHoldDetail = {
  ...cleanHold,
  requests: [
    {
      id: '00000000-0000-4000-8000-000000000002',
      holdId: cleanHold.hold.id,
      failureResultId: '10',
      requestedBy: { id: 'requester', nickname: '요청자' },
      reason: '복구 원인 확인',
      requestedAt: AT,
      status: 'pending',
      decidedBy: null,
      decisionReason: null,
      decidedAt: null,
      retractedAt: null,
    },
  ],
};

describe('reconciliation recovery decisions', () => {
  it('requires a current operator and clean audit before a new request', () => {
    expect(reconciliationRecoveryState(cleanHold, undefined).canRequest).toBe(false);
    expect(
      reconciliationRecoveryState({ ...cleanHold, latestResult: null }, 'admin').canRequest,
    ).toBe(false);
    expect(
      reconciliationRecoveryState(
        { ...cleanHold, latestResult: { ...cleanHold.latestResult!, passed: false } },
        'admin',
      ).canRequest,
    ).toBe(false);
    expect(reconciliationRecoveryState(cleanHold, 'admin').canRequest).toBe(true);
  });
  it('lets only another operator approve or reject, and only the requester retract', () => {
    expect(reconciliationRecoveryState(pending, 'requester')).toMatchObject({
      canRequest: false,
      canApprove: false,
      canReject: false,
      canRetract: true,
    });
    expect(reconciliationRecoveryState(pending, 'other')).toMatchObject({
      canApprove: true,
      canReject: true,
      canRetract: false,
    });
    expect(reconciliationRecoveryState(pending, undefined)).toMatchObject({
      canApprove: false,
      canReject: false,
      canRetract: false,
    });
  });
  it('keeps cleanup paths when a new failure makes the pending request stale', () => {
    const newer = { ...pending, hold: { ...pending.hold, failureResultId: '12' } };
    expect(reconciliationRecoveryState(newer, 'other')).toMatchObject({
      stale: true,
      canApprove: false,
      canReject: true,
    });
    expect(reconciliationRecoveryState(newer, 'requester').canRetract).toBe(true);
  });
  it('routes paused markets to the existing pause approval; a recovered hold is not reopened', () => {
    const paused = {
      ...pending,
      market: {
        id: '00000000-0000-4000-8000-000000000004',
        title: '시장',
        status: 'paused' as const,
      },
    };
    expect(reconciliationRecoveryState(paused, 'other')).toMatchObject({
      paused: true,
      canApprove: false,
      canReject: true,
    });
    expect(
      reconciliationRecoveryState(
        { ...cleanHold, hold: { ...cleanHold.hold, recoveredAt: AT } },
        'admin',
      ).canRequest,
    ).toBe(false);
  });
});

describe('reconciliation input and errors', () => {
  it('validates explicit targets and never rounds an unsafe ledger account identifier', () => {
    expect(reconciliationTargetDraft('account', '9007199254740993')).toBeNull();
    expect(reconciliationTargetDraft('account', '0')).toBeNull();
    expect(reconciliationTargetDraft('market', 'not-a-market')).toBeNull();
    expect(reconciliationTargetDraft('user', '  ')).toBeNull();
    expect(reconciliationTargetDraft('supply', '')).toEqual({ scope: 'supply' });
    expect(reconciliationTargetDraft('account', ' 42 ')).toEqual({
      scope: 'account',
      accountId: '42',
    });
    expect(reconciliationHoldTarget(cleanHold)).toEqual({ scope: 'account', userId: 'holder' });
    expect(
      reconciliationHoldTarget({ ...cleanHold, hold: { ...cleanHold.hold, userId: null } }),
    ).toBeNull();
  });
  it('explains a new failure, failed reaudit, and two-person refusal', () => {
    for (const [reason, message] of [
      ['stale', copy.reconciliationStale],
      ['not_passed', copy.reconciliationNotPassed],
      ['requester', copy.reconciliationOwnRequest],
    ]) {
      const error = new ApiError(400, {
        code: 'VALIDATION_ERROR',
        message: 'x',
        details: [{ path: ['reconciliation'], message: reason }],
      });
      expect(reconciliationFailure(error)).toEqual({ message, close: false });
    }
    expect(reconciliationFailure(new Error('offline')).message).toBe(copy.errNetwork);
    expect(
      reconciliationFailure(
        new ApiError(403, {
          code: 'FORBIDDEN',
          message: 'x',
          details: [{ path: ['expectedAccountId'], message: 'another account' }],
        }),
      ).close,
    ).toBe(true);
  });
  it('labels every finding in Korean', () => {
    expect(Object.keys(RECONCILIATION_FINDING_LABEL).sort()).toEqual(
      [...RECONCILIATION_FINDING_CODES].sort(),
    );
    for (const text of Object.values(RECONCILIATION_FINDING_LABEL)) expect(text).toMatch(/[가-힣]/);
  });
});
