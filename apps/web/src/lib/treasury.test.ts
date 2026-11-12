import { MAX_COIN_AMOUNT } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { treasuryRequest } from '@/test/treasury';
import { ApiError } from './api';
import {
  treasuryFailure,
  treasuryIssueDraft,
  treasuryReasonDraft,
  treasuryRequestState,
} from './treasury';

describe('treasury issuance proposals', () => {
  it('keeps integer Coin exact and requires a bounded, trimmed reason', () => {
    expect(treasuryIssueDraft(` ${MAX_COIN_AMOUNT} `, ' planned allocation ')).toEqual({
      amountCoin: String(MAX_COIN_AMOUNT),
      reason: 'planned allocation',
      validAmount: true,
      ready: true,
    });
    for (const amount of [
      '',
      '0',
      '-1',
      '1.5',
      '1e3',
      '01',
      String(MAX_COIN_AMOUNT + 1n),
      '9'.repeat(1000),
    ])
      expect(treasuryIssueDraft(amount, 'reason').ready, amount).toBe(false);
    for (const reason of ['', ' ', 'x'.repeat(501)]) {
      expect(treasuryIssueDraft('1', reason).ready).toBe(false);
      expect(treasuryReasonDraft(reason).ready).toBe(false);
    }
  });
  it('allows only another known admin to decide and only the requester to retract a pending proposal', () => {
    expect(treasuryRequestState(treasuryRequest, undefined)).toMatchObject({
      canApprove: false,
      canReject: false,
      canRetract: false,
    });
    expect(treasuryRequestState(treasuryRequest, 'admin-a')).toMatchObject({
      own: true,
      canApprove: false,
      canReject: false,
      canRetract: true,
    });
    expect(treasuryRequestState(treasuryRequest, 'admin-b')).toMatchObject({
      own: false,
      canApprove: true,
      canReject: true,
      canRetract: false,
    });
    for (const status of ['approved', 'rejected', 'retracted'] as const)
      for (const by of ['admin-a', 'admin-b'])
        expect(treasuryRequestState({ ...treasuryRequest, status }, by)).toMatchObject({
          canApprove: false,
          canReject: false,
          canRetract: false,
        });
  });
  it('maps issuance refusals by code and field, and distinguishes account changes and failed reads', () => {
    const validation = (path: string, message: string) =>
      new ApiError(400, {
        code: 'VALIDATION_ERROR',
        message,
        details: [{ path: [path], message }],
      });
    expect(treasuryFailure(validation('treasuryIssue', 'treasury_inconsistent')).message).toBe(
      copy.treasuryIssueLedgerMismatch,
    );
    expect(treasuryFailure(validation('anotherField', 'treasury_inconsistent')).message).toBe(
      copy.errUnknown,
    );
    expect(
      treasuryFailure(new ApiError(503, { code: 'INTERNAL', message: 'unavailable' })).message,
    ).toBe(copy.errUnknown);
    expect(
      treasuryFailure(new ApiError(404, { code: 'NOT_FOUND', message: 'missing' })).message,
    ).toBe(copy.treasuryIssueNotFound);
    expect(
      treasuryFailure(
        new ApiError(403, {
          code: 'FORBIDDEN',
          message: 'changed',
          details: [{ path: ['expectedAccountId'], message: 'mismatch' }],
        }),
      ),
    ).toEqual({ message: copy.sessionChanged, close: true });
  });
});
