import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError } from './api';
import { adminRoleChangeRefusal } from './admin-accounts';
import { disputeDecisionFailure } from './admin-disputes';
import { judgementFailure } from './market-judgement';
import { moderationFailure } from './moderation';

describe('market conflict decision refusals', () => {
  const conflict = new ApiError(403, {
    code: 'FORBIDDEN',
    message: 'conflict',
    details: [{ path: ['conflict'], message: 'market_conflict' }],
  });
  const confirmation = new ApiError(400, {
    code: 'VALIDATION_ERROR',
    message: 'required',
    details: [{ path: ['noConflictConfirmed'], message: 'required' }],
  });
  it('explains conflict eligibility separately from losing the administrator role', () => {
    expect(judgementFailure(conflict, 'register')).toEqual({
      kind: 'alert',
      message: copy.marketConflictRefused,
      refresh: true,
    });
    expect(judgementFailure(conflict, 'decision')).toEqual({
      kind: 'alert',
      message: copy.marketConflictRefused,
      refresh: true,
    });
    expect(disputeDecisionFailure(conflict)).toEqual({
      kind: 'alert',
      message: copy.marketConflictRefused,
      refresh: true,
    });
  });
  it('asks for the missing explicit confirmation without hiding it as an unknown failure', () => {
    expect(judgementFailure(confirmation, 'register')).toMatchObject({
      message: copy.marketConflictConfirmRequired,
    });
    expect(disputeDecisionFailure(confirmation)).toMatchObject({
      message: copy.marketConflictConfirmRequired,
    });
  });
  it('keeps role and moderation dialogs open for a bounded transaction retry', () => {
    const busy = new ApiError(409, { code: 'TRANSACTION_BUSY', message: 'busy' });
    expect(adminRoleChangeRefusal(busy)).toEqual({ alert: copy.errTransactionBusy });
    expect(moderationFailure(busy)).toEqual({ kind: 'alert', message: copy.errTransactionBusy });
  });
});
