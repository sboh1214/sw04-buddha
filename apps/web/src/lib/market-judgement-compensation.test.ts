import { findExcludedText } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminMarket, ApiError } from './api';
import {
  COMPENSATION_DECISION_TEXTS,
  COMPENSATION_QUEUE_KIND_LABEL,
  COMPENSATION_RECIPIENT_STATE_LABEL,
  COMPENSATION_STATUS_LABEL,
  compensationFailure,
  compensationRequestDraft,
  compensationReviewUnavailable,
  compensationSummaryText,
  compensationUnrequestable,
  showsJudgementCompensationPanel,
} from './market-judgement-compensation';

type Compensation = NonNullable<AdminMarket['judgementIncident']['compensation']>;

const PAID_REGISTRANT = 'paid-registrant';
const REQUESTER = 'requester';
const OTHER = 'other';

const pending = {
  requestId: 'a1b2c3d4-0000-4000-8000-000000000001',
  requestedBy: { id: REQUESTER, nickname: '요청한이' },
  requestedAt: '2026-12-01T02:00:00.000Z',
  accountCount: 2,
  totalCoin: '150',
  reason: 'r',
  userReason: 'u',
};

const compensation = (fields: Partial<Compensation> = {}): Compensation => ({
  preview: { accountCount: 2, totalCoin: '150', closedCount: 0, blockedCount: 0 },
  held: false,
  pending: null,
  paid: null,
  log: [],
  ...fields,
});

const market = (fields: Partial<Compensation> | null) =>
  ({
    judgement: {
      current: { version: 1, result: 'YES', registeredBy: { id: PAID_REGISTRANT } },
    },
    judgementIncident: { compensation: fields === null ? null : compensation(fields) },
  }) as unknown as AdminMarket;

/** An API refusal as `unwrap` throws it: the code, the status and the details. */
const refusal = (code: string, status: number, path: string, message: string) =>
  new ApiError(status, {
    code,
    message: 'refused',
    details: [{ path: [path], message }],
  } as never);

describe('the 판정 오류 보상’s pure half (#144 part 2, ADR-0166)', () => {
  it('draws the panel once an incident is confirmed', () => {
    expect(showsJudgementCompensationPanel(market(null))).toBe(false);
    expect(showsJudgementCompensationPanel(market({}))).toBe(true);
  });

  it('takes a request only when nothing stops it, in the server’s order', () => {
    expect(compensationUnrequestable(compensation())).toBeNull();
    expect(compensationUnrequestable(compensation({ held: true, pending }))).toBe('held');
    expect(compensationUnrequestable(compensation({ pending }))).toBe('pending');
    expect(
      compensationUnrequestable(
        compensation({
          preview: null,
          paid: {
            ...pending,
            approvedBy: { id: OTHER, nickname: null },
            approvedAt: '2026-12-01T03:00:00.000Z',
            paidCount: 2,
            paidCoin: '150',
            closedCount: 0,
          },
        }),
      ),
    ).toBe('paid');
    expect(
      compensationUnrequestable(
        compensation({
          preview: { accountCount: 0, totalCoin: '0', closedCount: 0, blockedCount: 0 },
        }),
      ),
    ).toBe('none');
  });

  it('keeps each decision from whom the server refuses it, the 반려 from the requester alone', () => {
    const waiting = market({ pending });
    expect(compensationReviewUnavailable(waiting, 'approve', undefined)).toBe('operator');
    expect(compensationReviewUnavailable(waiting, 'reject', undefined)).toBe('operator');
    expect(compensationReviewUnavailable(waiting, 'approve', REQUESTER)).toBe('own');
    expect(compensationReviewUnavailable(waiting, 'reject', REQUESTER)).toBe('own');
    // 144-4: the paid registrant does not approve, but a 반려 is a 정리 목적의 반려.
    expect(compensationReviewUnavailable(waiting, 'approve', PAID_REGISTRANT)).toBe('registrant');
    expect(compensationReviewUnavailable(waiting, 'reject', PAID_REGISTRANT)).toBeNull();
    expect(compensationReviewUnavailable(waiting, 'approve', OTHER)).toBeNull();
    // A ledger hold and an account needing a ledger check stop the approval only (144-16).
    expect(compensationReviewUnavailable(market({ pending, held: true }), 'approve', OTHER)).toBe(
      'held',
    );
    const blocked = market({
      pending,
      preview: { accountCount: 2, totalCoin: '150', closedCount: 0, blockedCount: 1 },
    });
    expect(compensationReviewUnavailable(blocked, 'approve', OTHER)).toBe('blocked');
    expect(compensationReviewUnavailable(blocked, 'reject', OTHER)).toBeNull();
  });

  it('checks the two reasons as the API does, each said under its own field', () => {
    const blank = compensationRequestDraft({ reason: '  ', userReason: '' });
    expect(blank.request).toBeNull();
    expect(blank.errors).toEqual({
      reason: copy.errMarketJudgementCompensationReason,
      userReason: copy.errMarketJudgementCompensationUserReason,
    });
    expect(compensationRequestDraft({ reason: 'x'.repeat(501), userReason: 'u' }).request).toBe(
      null,
    );
    expect(compensationRequestDraft({ reason: ' 내부 ', userReason: ' 회원 ' })).toEqual({
      request: { reason: '내부', userReason: '회원' },
      errors: { reason: null, userReason: null },
    });
  });

  it('says every refusal where it belongs', () => {
    const at = (error: unknown) => compensationFailure(error);
    expect(at(refusal('VALIDATION_ERROR', 400, 'incident', 'not confirmed'))).toEqual({
      kind: 'alert',
      message: copy.errMarketJudgementCompensationIncident,
      refresh: true,
    });
    expect(at(refusal('VALIDATION_ERROR', 400, 'market', 'held'))).toMatchObject({
      message: copy.errMarketJudgementCompensationHeld,
    });
    expect(at(refusal('VALIDATION_ERROR', 400, 'compensation', 'pending'))).toMatchObject({
      message: copy.errMarketJudgementCompensationPending,
    });
    expect(at(refusal('VALIDATION_ERROR', 400, 'compensation', 'paid'))).toMatchObject({
      message: copy.errMarketJudgementCompensationPaid,
    });
    expect(at(refusal('VALIDATION_ERROR', 400, 'recipients', 'none'))).toMatchObject({
      message: copy.errMarketJudgementCompensationNone,
    });
    expect(at(refusal('VALIDATION_ERROR', 400, 'recipients', 'stale'))).toMatchObject({
      message: copy.errMarketJudgementCompensationStale,
    });
    expect(at(refusal('VALIDATION_ERROR', 400, 'recipients', 'blocked'))).toMatchObject({
      message: copy.errMarketJudgementCompensationBlocked,
      refresh: true,
    });
    expect(at(refusal('VALIDATION_ERROR', 400, 'decider', 'registrant'))).toMatchObject({
      message: copy.errMarketJudgementCompensationRegistrant,
    });
    expect(at(refusal('VALIDATION_ERROR', 400, 'requestId', 'unknown'))).toMatchObject({
      message: copy.errMarketJudgementCompensationUnknown,
    });
    expect(at(refusal('VALIDATION_ERROR', 400, 'reason', 'too_small'))).toEqual({
      kind: 'field',
      field: 'reason',
      message: copy.errMarketJudgementCompensationReason,
    });
    expect(at(refusal('VALIDATION_ERROR', 400, 'userReason', 'too_small'))).toEqual({
      kind: 'field',
      field: 'userReason',
      message: copy.errMarketJudgementCompensationUserReason,
    });
    expect(at(refusal('VALIDATION_ERROR', 400, 'noConflictConfirmed', 'x'))).toMatchObject({
      message: copy.marketConflictConfirmRequired,
    });
    expect(at(refusal('APPROVAL_NOT_ALLOWED', 409, 'request', 'no_decider'))).toMatchObject({
      message: copy.errMarketJudgementCompensationNoDecider,
      refresh: true,
    });
    expect(at(refusal('APPROVAL_NOT_ALLOWED', 409, 'request', 'requester'))).toMatchObject({
      message: copy.errMarketJudgementCompensationRequester,
    });
    expect(at(refusal('APPROVAL_NOT_ALLOWED', 409, 'request', 'decided'))).toMatchObject({
      message: copy.errApprovalDecided,
    });
    expect(at(refusal('FORBIDDEN', 403, 'market', 'market_conflict'))).toEqual({
      kind: 'alert',
      message: copy.marketConflictRefused,
      refresh: true,
    });
    expect(at(new Error('boom'))).toMatchObject({ kind: 'alert', refresh: false });
  });

  it('words the screens as 144-19 approved, with no refund, P&L or excluded feature', () => {
    expect([
      copy.adminMarketJudgementCompensationRequest,
      copy.adminMarketJudgementCompensationUserReason,
      copy.adminMarketJudgementCompensationApprove,
      copy.adminMarketJudgementCompensationReject,
      copy.adminMarketJudgementCompensationRecipients,
      COMPENSATION_RECIPIENT_STATE_LABEL.closed,
      COMPENSATION_RECIPIENT_STATE_LABEL.blocked,
    ]).toEqual([
      '보상 요청',
      '회원에게 보일 사유',
      '보상 승인',
      '보상 반려',
      '대상 계정',
      '탈퇴로 지급 못 함',
      '원장 확인 필요',
    ]);
    expect(compensationSummaryText(1234, '5,678 Coin')).toBe('대상 계정 1,234개 · 총 5,678 Coin');
    expect(COMPENSATION_QUEUE_KIND_LABEL).toEqual({
      incident: '사건 검토',
      compensation: '보상 승인',
    });
    const decisions: string[] = Object.values(COMPENSATION_DECISION_TEXTS).flatMap(
      (each): string[] => [each.title, each.body, each.confirm, each.done],
    );
    const texts: string[] = [
      ...Object.values(COMPENSATION_STATUS_LABEL),
      ...Object.values(COMPENSATION_RECIPIENT_STATE_LABEL),
      ...decisions,
      ...Object.entries(copy)
        .filter(
          ([key]) =>
            key.startsWith('adminMarketJudgementCompensation') ||
            key.startsWith('errMarketJudgementCompensation') ||
            key.startsWith('adminMarketWorkCompensation'),
        )
        .map(([, text]) => text),
    ];
    expect(texts.length).toBeGreaterThan(80);
    for (const text of texts) {
      expect(findExcludedText(text), text).toEqual([]);
      expect(text, text).not.toMatch(/환불|원금|송금|이체|리워드|적립|정산 오류|손익|정답|맞힌/);
    }
  });
});
