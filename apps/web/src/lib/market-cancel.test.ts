import { APPROVAL_REFUSALS, MARKET_CANCEL_REFUSALS, MARKET_STATUSES } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type MarketCancelLogEntry } from './api';
import { formatKst } from './datetime';
import {
  cancelFailure,
  cancelLogRows,
  cancelRequestApprovable,
  cancelRequestOffered,
  isCancelRequester,
  showsCancelPanel,
} from './market-cancel';

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);
const refused = (path: string, message: string) =>
  apiError(400, 'VALIDATION_ERROR', [{ path: [path], message }]);

const REQUESTER = { id: 'requester', nickname: '요청한이' };
const APPROVER = { id: 'approver', nickname: '승인한이' };

const entry: MarketCancelLogEntry = {
  requestId: 'a1b2c3d4-0000-4000-8000-000000000001',
  reason: '출처가 사라졌습니다.',
  requestedBy: REQUESTER,
  requestedAt: '2026-11-05T04:00:00.000Z',
  status: 'pending',
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  retractedAt: null,
};
const none = { pending: null, log: [] };
const one = { pending: entry, log: [entry] };

/** 시장 취소's pure half (#20, ADR-0117): what the panel offers and what a refusal says. */
describe('the 시장 취소 panel’s rules', () => {
  it('is drawn on a scheduled market and on any with a request; offers a request when none waits', () => {
    for (const status of MARKET_STATUSES) {
      expect(showsCancelPanel({ status, cancel: none }), status).toBe(status === 'scheduled');
      expect(showsCancelPanel({ status, cancel: one }), status).toBe(true);
      expect(cancelRequestOffered({ status, cancel: none }), status).toBe(status === 'scheduled');
      expect(cancelRequestOffered({ status, cancel: one }), status).toBe(false);
      expect(cancelRequestApprovable({ status }), status).toBe(status === 'scheduled');
    }
  });

  it('knows the requester once the admin on screen is known', () => {
    expect(isCancelRequester(entry, undefined)).toBeUndefined();
    expect(isCancelRequester(entry, REQUESTER.id)).toBe(true);
    expect(isCancelRequester(entry, APPROVER.id)).toBe(false);
  });

  it('rows a request: its reason, then how it ended', () => {
    expect(cancelLogRows(entry, formatKst)).toEqual([
      { label: copy.adminMarketCancelReason, value: entry.reason },
    ]);
    expect(
      cancelLogRows(
        {
          ...entry,
          status: 'approved',
          decidedBy: APPROVER,
          decidedAt: '2026-11-06T00:00:00.000Z',
          decisionReason: '확인',
        },
        formatKst,
      ),
    ).toEqual([
      { label: copy.adminMarketCancelReason, value: entry.reason },
      { label: copy.pauseLogDecidedBy, value: '승인한이' },
      { label: copy.pauseLogDecidedAt, value: formatKst('2026-11-06T00:00:00.000Z') },
      { label: copy.pauseLogDecisionReason, value: '확인' },
    ]);
    expect(
      cancelLogRows(
        { ...entry, status: 'retracted', retractedAt: '2026-11-06T00:00:00.000Z' },
        formatKst,
      ).at(-1),
    ).toEqual({ label: copy.pauseLogRetractedAt, value: formatKst('2026-11-06T00:00:00.000Z') });
  });
});

describe('cancelFailure', () => {
  it('closes on another account’s cookie, and says a session, a role or the market gone', () => {
    const another = apiError(403, 'FORBIDDEN', [
      { path: ['expectedAccountId'], message: 'session belongs to another account' },
    ]);
    expect(cancelFailure(another, 'request')).toEqual({
      kind: 'toast',
      message: copy.sessionChanged,
    });
    expect(cancelFailure(apiError(401, 'UNAUTHENTICATED'), 'decision')).toEqual({
      kind: 'alert',
      message: copy.errUnauthenticated,
      refresh: false,
    });
    expect(cancelFailure(apiError(403, 'FORBIDDEN'), 'decision')).toMatchObject({
      message: copy.adminOnly,
    });
    expect(cancelFailure(apiError(404, 'NOT_FOUND'), 'request')).toEqual({
      kind: 'alert',
      message: copy.adminMarketNotFound,
      refresh: true,
    });
    expect(cancelFailure(new Error('offline'), 'request')).toMatchObject({
      message: copy.errNetwork,
    });
  });

  it('says each two-person refusal and reads again', () => {
    for (const refusal of APPROVAL_REFUSALS) {
      expect(
        cancelFailure(
          apiError(409, 'APPROVAL_NOT_ALLOWED', [{ path: ['request'], message: refusal }]),
          'decision',
        ),
        refusal,
      ).toMatchObject({ kind: 'alert', refresh: true });
    }
    expect(
      cancelFailure(
        apiError(409, 'APPROVAL_NOT_ALLOWED', [{ path: ['request'], message: 'requester' }]),
        'decision',
      ),
    ).toMatchObject({ message: copy.adminMarketPauseExcludedRequester });
    expect(
      cancelFailure(
        apiError(409, 'APPROVAL_NOT_ALLOWED', [{ path: ['request'], message: 'no_decider' }]),
        'request',
      ),
    ).toMatchObject({ message: copy.errApprovalNoDecider });
  });

  it('says the market’s state, a request waiting, a stale one and an unknown one, and reads again', () => {
    const { status, cancel } = MARKET_CANCEL_REFUSALS;
    for (const write of ['request', 'decision'] as const) {
      expect(cancelFailure(refused('status', status.notScheduled), write), write).toEqual({
        kind: 'alert',
        message: copy.errMarketCancelStatus,
        refresh: true,
      });
    }
    expect(cancelFailure(refused('cancel', cancel.pending), 'request')).toEqual({
      kind: 'alert',
      message: copy.errMarketCancelPending,
      refresh: true,
    });
    expect(cancelFailure(refused('cancel', cancel.stale), 'decision')).toEqual({
      kind: 'alert',
      message: copy.errMarketCancelStale,
      refresh: true,
    });
    expect(cancelFailure(refused('requestId', 'unknown'), 'decision')).toMatchObject({
      message: copy.errMarketCancelUnknown,
      refresh: true,
    });
  });

  it('puts a refused reason under the field, and anything else as invalid', () => {
    expect(cancelFailure(refused('reason', 'Too small'), 'request')).toEqual({
      kind: 'field',
      message: copy.errMarketReviewReason,
    });
    expect(cancelFailure(refused('other', 'x'), 'request')).toEqual({
      kind: 'alert',
      message: copy.errMarketInvalid,
      refresh: false,
    });
  });
});
