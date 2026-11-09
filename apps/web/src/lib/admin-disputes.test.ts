import { type ErrorCode } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  ADMIN_DISPUTES_PATH,
  ADMIN_DISPUTE_QUEUES,
  DISPUTE_DECISION_DIALOG,
  adminDisputeQueueOf,
  adminDisputeQueuePath,
  disputeDecisionFailure,
  disputeDecisionUnavailable,
  disputeHoldingText,
  disputeSubmitterName,
} from './admin-disputes';
import { ApiError, type AdminMarket, type AdminMarketDispute } from './api';

function refused(status: number, code: ErrorCode, details?: unknown): ApiError {
  return new ApiError(status, { code, message: code, details });
}

const REGISTRANT = 'registrant';
const APPROVER = 'approver';

/** Just what the decision's availability reads of the market: its current judgement. */
const judged = {
  judgement: { current: { registeredBy: { id: REGISTRANT } } },
} as unknown as Pick<AdminMarket, 'judgement'>;

/**
 * 판정 이의's operator side (#175, ADR-0104; ADR-0093 decision 1 #173 items 2·7·13): 이의 접수's
 * halves, who may dismiss or accept a dispute, and what a refused decision says.
 */
describe('이의 접수’s two halves', () => {
  it('reads 처리됨 from ?status=decided and 검토 대기 from anything else', () => {
    expect(adminDisputeQueueOf('decided')).toBe('decided');
    for (const param of [undefined, null, '', 'pending', 'resolved', ['decided']]) {
      expect(adminDisputeQueueOf(param), String(param)).toBe('pending');
    }
    expect(adminDisputeQueuePath('pending')).toBe(ADMIN_DISPUTES_PATH);
    expect(adminDisputeQueuePath('decided')).toBe('/admin/disputes?status=decided');
    expect(ADMIN_DISPUTE_QUEUES.map((queue) => [queue.status, queue.label])).toEqual([
      ['pending', '검토 대기'],
      ['decided', '처리됨'],
    ]);
  });

  it('names a submitter by nickname, a closed account as 탈퇴한 사용자', () => {
    expect(disputeSubmitterName({ submitter: { id: 'a', nickname: '낸이' } })).toBe('낸이');
    expect(disputeSubmitterName({ submitter: { id: 'a', nickname: null } })).toBe(
      copy.postAuthorFormer,
    );
  });
});

describe('who may dismiss or accept (#173 item 2)', () => {
  const submitter = { id: 'member', nickname: '낸이' };
  const of = (status: AdminMarketDispute['status']) => ({ status, submitter });

  it('is any admin but the version’s registrant — its approver included — while it is pending', () => {
    expect(disputeDecisionUnavailable(of('pending'), judged, APPROVER)).toBeNull();
    expect(disputeDecisionUnavailable(of('pending'), judged, 'third')).toBeNull();
    expect(disputeDecisionUnavailable(of('pending'), judged, REGISTRANT)).toBe('registrant');
    // Nor its submitter, given the admin role after disputing.
    expect(disputeDecisionUnavailable(of('pending'), judged, submitter.id)).toBe('own');
    // Its status first, as the API asks.
    expect(disputeDecisionUnavailable(of('retracted'), judged, REGISTRANT)).toBe('retracted');
    for (const status of ['dismissed', 'accepted'] as const) {
      expect(disputeDecisionUnavailable(of(status), judged, APPROVER), status).toBe('decided');
    }
  });

  it('offers nothing until the admin on screen is known, nor with no judgement read', () => {
    expect(disputeDecisionUnavailable(of('pending'), judged, undefined)).toBeUndefined();
    const none = { judgement: { current: null } } as unknown as Pick<AdminMarket, 'judgement'>;
    expect(disputeDecisionUnavailable(of('pending'), none, APPROVER)).toBeUndefined();
  });

  it('counts what holds the confirmation in words', () => {
    expect(disputeHoldingText(2)).toBe('결과 확정을 기다리게 하는 이의 2건');
  });

  it('says what each decision does: a 기각 confirms soon past the deadline, a 수용 is a correction', () => {
    expect(DISPUTE_DECISION_DIALOG.dismiss.confirm).toBe('기각');
    expect(DISPUTE_DECISION_DIALOG.accept.confirm).toBe('수용');
    // #173 item 7: 수용은 곧 정정 — the market waits until the correction (#176).
    expect(DISPUTE_DECISION_DIALOG.accept.body).toContain('정정');
    expect(DISPUTE_DECISION_DIALOG.accept.body).toContain('잠정 결과에 머물고');
    // A rejected or retracted correction sends it back to 검토 중 (owner answer 2026-11-02, #176):
    // the 수용 is no longer said to be final.
    expect(DISPUTE_DECISION_DIALOG.accept.body).toContain('검토 중으로 돌아갑니다');
    expect(DISPUTE_DECISION_DIALOG.accept.body).not.toContain('되돌릴 수 없습니다');
    // #24 makes the decision reason public to every visitor, including the submitter; the
    // operator's identity stays private even though the reason is no longer submitter-only.
    expect(copy.adminMarketDisputeDecisionHint).toContain('공개 판정 기록');
    expect(copy.adminMarketDisputeDecisionHint).toContain('모든 방문자');
    expect(copy.adminMarketDisputeDecisionHint).toContain('관리자는 공개하지 않습니다');
  });
});

describe('a refused decision (disputeDecisionFailure)', () => {
  it('says DISPUTE_NOT_ALLOWED by its reason in the dialog and reads the detail again', () => {
    const notAllowed = (reason: string) => refused(409, 'DISPUTE_NOT_ALLOWED', { reason });
    expect(disputeDecisionFailure(notAllowed('retracted'))).toEqual({
      kind: 'alert',
      message: copy.errAdminDisputeRetracted,
      refresh: true,
    });
    expect(disputeDecisionFailure(notAllowed('decided'))).toEqual({
      kind: 'alert',
      message: copy.errAdminDisputeDecided,
      refresh: true,
    });
    expect(disputeDecisionFailure(notAllowed('registrant'))).toEqual({
      kind: 'alert',
      message: copy.adminMarketDisputesRegistrant,
      refresh: true,
    });
    expect(disputeDecisionFailure(notAllowed('own'))).toEqual({
      kind: 'alert',
      message: copy.adminMarketDisputesOwn,
      refresh: true,
    });
    expect(disputeDecisionFailure(refused(404, 'NOT_FOUND'))).toEqual({
      kind: 'alert',
      message: copy.errAdminDisputeNotFound,
      refresh: true,
    });
  });

  it('puts the reason’s refusal under it, and another account’s cookie in a toast', () => {
    expect(
      disputeDecisionFailure(
        refused(400, 'VALIDATION_ERROR', [{ path: ['reason'], message: 'too long' }]),
      ),
    ).toEqual({ kind: 'field', message: copy.errMarketReviewReason });
    expect(
      disputeDecisionFailure(
        refused(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'x' }]),
      ),
    ).toEqual({ kind: 'toast', message: copy.sessionChanged });
    // AdminGuard's FORBIDDEN (a role revoked meanwhile) is no account check.
    expect(disputeDecisionFailure(refused(403, 'FORBIDDEN'))).toEqual({
      kind: 'alert',
      message: copy.adminOnly,
      refresh: false,
    });
    expect(disputeDecisionFailure(new TypeError('fetch failed'))).toEqual({
      kind: 'alert',
      message: copy.errNetwork,
      refresh: false,
    });
  });
});
