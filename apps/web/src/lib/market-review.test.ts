import {
  APPROVAL_REASON_MAX_LENGTH,
  MARKET_REJECT_REASONS,
  MARKET_REVIEW_CHECKLIST,
  MARKET_STATUSES,
  type MarketReviewChecklistItem,
  TIME_RULE_MESSAGES,
} from '@buddha/shared';
import { describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type MarketReviewLogEntry } from './api';
import { formatKst } from './datetime';
import { MARKET_STATUS_LABEL, REJECT_REASON_LABEL, REVIEW_CHECK_LABEL } from './market-admin';
import {
  REVIEW_CHECK_HINT,
  REVIEW_EXCLUSION_NOTE,
  type ReviewParties,
  approveDraft,
  excludedAdmins,
  rejectDraft,
  rejectReasonOf,
  rescheduleDraft,
  revertDraft,
  reviewActorName,
  reviewExclusion,
  reviewFailure,
  reviewLogRows,
  reviewReasonDraft,
  reviewWriteSuccess,
  scheduledCloseLapsed,
  showsExcludedAdmins,
} from './market-review';

const refused = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);

const CREATOR = { id: 'creator', nickname: '만든이' };
const EDITOR = { id: 'editor', nickname: '고친이' };
const SUBMITTER = { id: 'submitter', nickname: '낸이' };

/** A market in review: made by CREATOR, edited by EDITOR and CREATOR, submitted by SUBMITTER. */
const inReview: ReviewParties = {
  createdBy: CREATOR,
  editors: [EDITOR, CREATOR],
  pending: { requestId: 'r1', requestedBy: SUBMITTER, requestedAt: '2026-11-01T00:00:00.000Z' },
};

const entry = (fields: Partial<MarketReviewLogEntry>): MarketReviewLogEntry => ({
  type: 'submitted',
  actor: SUBMITTER,
  at: '2026-11-01T00:00:00.000Z',
  fromStatus: null,
  toStatus: null,
  reason: null,
  rejectReason: null,
  checklist: null,
  scheduledOpenBefore: null,
  scheduledOpenAfter: null,
  ...fields,
});

const rows = (fields: Partial<MarketReviewLogEntry>) =>
  reviewLogRows(entry(fields), MARKET_STATUS_LABEL, formatKst);

describe('the review checklist and its 반려 사유 (#78, #172 item 4)', () => {
  it('names every checklist item with a line of what to confirm, in the checklist order', () => {
    expect(Object.keys(REVIEW_CHECK_LABEL)).toEqual([...MARKET_REVIEW_CHECKLIST]);
    expect(Object.keys(REVIEW_CHECK_HINT)).toEqual([...MARKET_REVIEW_CHECKLIST]);
    expect(MARKET_REVIEW_CHECKLIST.map((item) => REVIEW_CHECK_LABEL[item])).toEqual([
      '결과가 이미 알려진 질문',
      '모호한 기준',
      '동일 조건의 중복',
      '필수 항목',
      '시각 순서',
      '선행 마감',
      '독립 판정',
    ]);
    for (const item of MARKET_REVIEW_CHECKLIST) {
      expect(REVIEW_CHECK_HINT[item], item).toMatch(/[가-힣]/);
      expect(REVIEW_CHECK_HINT[item], item).not.toBe(REVIEW_CHECK_LABEL[item]);
    }
    // 선행 마감's line (#172 item 13): the gap, '없음' for no release, the match and election rule.
    expect(REVIEW_CHECK_HINT.leadClose).toBe(
      "거래 마감이 발표 예정 시각보다 간격 이상 앞서는지, 발표 일정이 없으면 '없음'이 맞는지, 경기는 시작 전·선거는 투표 종료 전에 마감하는지",
    );
    // The open-items check's own names for the two time relations.
    expect(REVIEW_CHECK_LABEL.timeOrder).toBe(copy.openItemTimeOrder);
    expect(REVIEW_CHECK_LABEL.leadClose).toBe(copy.openItemLeadClose);
  });

  it('offers the checklist items and 기타 as the 반려 사유, nothing else', () => {
    expect(Object.keys(REJECT_REASON_LABEL)).toEqual([...MARKET_REJECT_REASONS]);
    expect(REJECT_REASON_LABEL.other).toBe('기타');
    for (const item of MARKET_REVIEW_CHECKLIST) {
      expect(REJECT_REASON_LABEL[item]).toBe(REVIEW_CHECK_LABEL[item]);
    }
    expect(rejectReasonOf('ambiguity')).toBe('ambiguity');
    expect(rejectReasonOf('other')).toBe('other');
    expect(rejectReasonOf('')).toBeNull();
    expect(rejectReasonOf('bot')).toBeNull();
  });
});

describe('who may decide a review (#172 item 5)', () => {
  it('says why the admin on screen may not, in the server’s precedence', () => {
    // The creator, though also an editor: 'creator' first.
    expect(reviewExclusion(inReview, CREATOR.id)).toBe('creator');
    expect(reviewExclusion(inReview, EDITOR.id)).toBe('editor');
    expect(reviewExclusion(inReview, SUBMITTER.id)).toBe('requester');
    // An editor who also submitted: 'editor' before 'requester'.
    expect(
      reviewExclusion(
        { ...inReview, pending: { ...inReview.pending!, requestedBy: EDITOR } },
        EDITOR.id,
      ),
    ).toBe('editor');
    // A third admin decides.
    expect(reviewExclusion(inReview, 'third')).toBeNull();
    // Nothing is said until the admin on screen is known.
    expect(reviewExclusion(inReview, undefined)).toBeUndefined();
    // Every exclusion has its note, which says another admin decides.
    for (const note of Object.values(REVIEW_EXCLUSION_NOTE)) {
      expect(note).toContain('승인·반려할 수 없습니다');
    }
    expect(REVIEW_EXCLUSION_NOTE.creator).toBe(
      '이 시장을 만든 관리자는 승인·반려할 수 없습니다. 다른 관리자가 결정합니다.',
    );
  });

  it('lists every excluded account once, its places joined, the admin on screen marked', () => {
    expect(excludedAdmins(inReview, EDITOR.id)).toEqual([
      { id: CREATOR.id, name: '만든이', roles: '만든 관리자 · 수정한 관리자', viewer: false },
      { id: EDITOR.id, name: '고친이', roles: '수정한 관리자', viewer: true },
      { id: SUBMITTER.id, name: '낸이', roles: '제출한 관리자', viewer: false },
    ]);
    // A draft: no submitter yet. A closed account: '탈퇴한 사용자'.
    expect(
      excludedAdmins(
        { createdBy: { id: 'gone', nickname: null }, editors: [], pending: null },
        'x',
      ),
    ).toEqual([{ id: 'gone', name: copy.postAuthorFormer, roles: '만든 관리자', viewer: false }]);
    // The creator who also submitted: one row.
    expect(
      excludedAdmins(
        { ...inReview, editors: [], pending: { ...inReview.pending!, requestedBy: CREATOR } },
        undefined,
      ),
    ).toEqual([
      { id: CREATOR.id, name: '만든이', roles: '만든 관리자 · 제출한 관리자', viewer: false },
    ]);
  });

  it('shows that list while a draft or a review, and not past the decision', () => {
    expect(showsExcludedAdmins('draft')).toBe(true);
    expect(showsExcludedAdmins('review')).toBe(true);
    for (const status of ['scheduled', 'open', 'closed', 'cancelled'] as const) {
      expect(showsExcludedAdmins(status), status).toBe(false);
    }
  });
});

describe('the 검수 기록 (#78)', () => {
  it('says each record with its status change and what it carries', () => {
    expect(rows({ type: 'submitted', fromStatus: 'draft', toStatus: 'review' })).toEqual([
      { label: '상태', value: '초안 → 검수 중' },
    ]);
    expect(
      rows({
        type: 'approved',
        fromStatus: 'review',
        toStatus: 'scheduled',
        checklist: [...MARKET_REVIEW_CHECKLIST],
        reason: '기준이 분명합니다',
      }),
    ).toEqual([
      { label: '상태', value: '검수 중 → 개장 예정' },
      { label: '체크리스트', value: '7/7개 항목 확인' },
      { label: '사유', value: '기준이 분명합니다' },
    ]);
    // A 반려: the reason from the list, then its 설명.
    expect(
      rows({
        type: 'rejected',
        fromStatus: 'review',
        toStatus: 'draft',
        rejectReason: 'leadClose',
        reason: '발표 직전에 마감합니다',
      }),
    ).toEqual([
      { label: '상태', value: '검수 중 → 초안' },
      { label: '반려 사유', value: '선행 마감' },
      { label: '설명', value: '발표 직전에 마감합니다' },
    ]);
    expect(
      rows({ type: 'reverted', fromStatus: 'scheduled', toStatus: 'draft', reason: '출처 교체' }),
    ).toEqual([
      { label: '상태', value: '개장 예정 → 초안' },
      { label: '사유', value: '출처 교체' },
    ]);
    // A reschedule changes no status: its times in KST, then why.
    expect(
      rows({
        type: 'open_rescheduled',
        scheduledOpenBefore: '2026-11-10T00:00:00.000Z',
        scheduledOpenAfter: '2026-11-09T03:00:00.000Z',
        reason: '일찍 엽니다',
      }),
    ).toEqual([
      { label: '이전 예정 개장', value: formatKst('2026-11-10T00:00:00.000Z') },
      { label: '이후 예정 개장', value: formatKst('2026-11-09T03:00:00.000Z') },
      { label: '사유', value: '일찍 엽니다' },
    ]);
    // A reschedule of a market that had none: '—'.
    expect(
      rows({ type: 'open_rescheduled', scheduledOpenAfter: '2026-11-09T03:00:00.000Z' })[0],
    ).toEqual({ label: '이전 예정 개장', value: '—' });
  });

  it('names who wrote it by nickname, a gone account as every byline names it', () => {
    expect(reviewActorName(SUBMITTER)).toBe('낸이');
    expect(reviewActorName({ id: 'x', nickname: null })).toBe(copy.postAuthorFormer);
    expect(reviewActorName(null)).toBe(copy.postAuthorFormer);
  });
});

describe('what the review dialogs may send', () => {
  const everything: MarketReviewChecklistItem[] = [...MARKET_REVIEW_CHECKLIST];

  it('takes a reason of 1 to 500 characters, trimmed', () => {
    expect(reviewReasonDraft('  이유  ')).toEqual({ reason: '이유', error: null });
    expect(reviewReasonDraft('   ').error).toBe(copy.errMarketReviewReason);
    expect(reviewReasonDraft('가'.repeat(APPROVAL_REASON_MAX_LENGTH)).error).toBeNull();
    expect(reviewReasonDraft('가'.repeat(APPROVAL_REASON_MAX_LENGTH + 1)).error).toBe(
      copy.errMarketReviewReason,
    );
  });

  it('approves only once every checklist item is confirmed and a reason is typed', () => {
    expect(approveDraft([], '이유').ready).toBe(false);
    for (const left of MARKET_REVIEW_CHECKLIST) {
      expect(
        approveDraft(
          everything.filter((item) => item !== left),
          '이유',
        ).ready,
        left,
      ).toBe(false);
    }
    expect(approveDraft(everything, '  ').ready).toBe(false);
    // Checked in any order, sent in the checklist's.
    const draft = approveDraft([...everything].reverse(), '  모두 확인 ');
    expect(draft).toEqual({ ready: true, checklist: everything, reason: '모두 확인' });
  });

  it('rejects once a reason is picked from the list and a 설명 typed', () => {
    expect(rejectDraft('', '설명').ready).toBe(false);
    expect(rejectDraft('ambiguity', ' ').ready).toBe(false);
    expect(rejectDraft('ambiguity', ' 기준이 모호 ')).toEqual({
      ready: true,
      rejectReason: 'ambiguity',
      reason: '기준이 모호',
    });
    expect(rejectDraft('other', '그 밖의 이유').ready).toBe(true);
  });

  it('reverts once a reason is typed', () => {
    expect(revertDraft('').ready).toBe(false);
    expect(revertDraft(' 고칩니다 ')).toEqual({ ready: true, reason: '고칩니다' });
  });

  describe('예정 개장 시각 변경', () => {
    // Opens 2026-11-10 09:00 KST, closes 2026-11-20 09:00 KST, judged 2026-11-21 09:00 KST.
    const scheduled = {
      scheduledOpenAt: '2026-11-10T00:00:00.000Z',
      closeAt: '2026-11-20T00:00:00.000Z',
      scheduledAnnouncementAt: null,
      scheduledJudgementAt: '2026-11-21T00:00:00.000Z',
      judgementTimeZone: 'Asia/Seoul',
      eventDeadline: '2026-11-19T00:00:00.000Z',
      leadCloseGapMinutes: 60,
    };

    it('waits until the time moves, and the reason is typed', () => {
      // The field opens on the stored time: not sendable, and nothing said.
      const same = rescheduleDraft('2026-11-10T09:00', '이유', scheduled);
      expect(same).toMatchObject({ ready: false, unchanged: true, atError: null });
      expect(rescheduleDraft('2026-11-09T12:00', ' ', scheduled).ready).toBe(false);
      expect(rescheduleDraft('', '이유', scheduled)).toMatchObject({
        ready: false,
        scheduledOpenAt: null,
        atError: null,
      });
      expect(rescheduleDraft('2026-11-09T12:00', ' 앞당김 ', scheduled)).toEqual({
        ready: true,
        scheduledOpenAt: '2026-11-09T03:00:00.000Z',
        atError: null,
        unchanged: false,
        reason: '앞당김',
      });
    });

    it('says the order rule under the field once the open is not before the close (A1)', () => {
      for (const local of ['2026-11-20T09:00', '2026-11-20T09:00:30', '2026-11-25T09:00']) {
        const draft = rescheduleDraft(local, '이유', scheduled);
        expect(draft.atError, local).toBe(copy.errMarketTimeOpenBeforeClose);
        expect(draft.ready, local).toBe(false);
      }
      // A minute before the close is in order.
      expect(rescheduleDraft('2026-11-20T08:59', '이유', scheduled).ready).toBe(true);
    });

    it('allows a past instant: the reschedule then opens the market at once (#21)', () => {
      expect(rescheduleDraft('2020-01-01T00:00', '이유', scheduled).ready).toBe(true);
    });

    it('says an unreadable time under the field', () => {
      expect(rescheduleDraft('not a time', '이유', scheduled).atError).toBe(
        copy.errMarketReviewRescheduleTime,
      );
    });
  });
});

describe('what a review write that went through says (#21, ADR-0100)', () => {
  it('says the approval opened the market when the answer is OPEN, else that it waits', () => {
    // ADR-0093 decision 2 #172 item 6: an approval past the scheduled open opens it at once.
    expect(reviewWriteSuccess('approve', 'open')).toBe(copy.adminMarketReviewApprovedOpened);
    expect(reviewWriteSuccess('approve', 'scheduled')).toBe(copy.adminMarketReviewApproved);
    expect(copy.adminMarketReviewApprovedOpened).toBe('승인해 거래를 열었습니다.');
  });

  it('says the reschedule opened the market when the answer is OPEN, else that it moved', () => {
    // Decision 3 '#21 앞당긴 개장': to open sooner, the scheduled open moves to now or earlier.
    expect(reviewWriteSuccess('reschedule', 'open')).toBe(copy.adminMarketReviewRescheduledOpened);
    expect(reviewWriteSuccess('reschedule', 'scheduled')).toBe(copy.adminMarketReviewRescheduled);
    expect(copy.adminMarketReviewRescheduledOpened).toBe(
      '예정 개장 시각을 바꿔 거래를 열었습니다.',
    );
  });

  it('says the market opens by itself at its scheduled open, and at once past it', () => {
    expect(copy.adminMarketReviewScheduledNote).toContain('예정 개장 시각에 자동으로 열립니다');
    expect(copy.adminMarketReviewApproveBody).toContain('승인하는 즉시 열립니다');
    expect(copy.adminMarketReviewRescheduleAtHint).toContain('바로 열립니다');
  });
});

describe('scheduledCloseLapsed (#21, ADR-0100; #172 item 6)', () => {
  const closeAt = '2026-11-20T00:00:00.000Z';
  const at = (iso: string) => new Date(iso).getTime();

  it('is a scheduled market read once its close had come: it never opens, back to a draft', () => {
    const scheduled = { status: 'scheduled' as const, closeAt };
    expect(scheduledCloseLapsed(scheduled, at('2026-11-19T23:59:59.999Z'))).toBe(false);
    // Read at the close itself: the open needs the close ahead (`close_at > now`).
    expect(scheduledCloseLapsed(scheduled, at(closeAt))).toBe(true);
    expect(scheduledCloseLapsed(scheduled, at('2026-12-01T00:00:00.000Z'))).toBe(true);
  });

  it('judges when the row was read, not the clock now: a row read before says nothing', () => {
    // Codex review on #21: the page left open across the close still holds the row read before
    // it, which the worker may have opened and the close job closed since. Only a read from
    // after the close counts, whatever the clock says now.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-12-01T00:00:00.000Z'));
      const readBefore = at('2026-11-19T00:00:00.000Z');
      expect(scheduledCloseLapsed({ status: 'scheduled', closeAt }, readBefore)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is never another status’s, nor an unreadable close', () => {
    const later = at('2026-12-01T00:00:00.000Z');
    for (const status of MARKET_STATUSES.filter((value) => value !== 'scheduled')) {
      expect(scheduledCloseLapsed({ status, closeAt }, later), status).toBe(false);
    }
    expect(scheduledCloseLapsed({ status: 'scheduled', closeAt: 'nope' }, later)).toBe(false);
  });
});

describe('reviewFailure', () => {
  const approval = (message: string) =>
    reviewFailure(refused(409, 'APPROVAL_NOT_ALLOWED', [{ path: ['request'], message }]));
  const invalid = (path: string, message = 'bad') =>
    reviewFailure(refused(400, 'VALIDATION_ERROR', [{ path: [path], message }]));

  it('says the exclusions as the panel does, and asks the screen again', () => {
    expect(approval('creator')).toEqual({
      kind: 'alert',
      message: copy.adminMarketReviewExcludedCreator,
      refresh: true,
    });
    expect(approval('editor')).toEqual({
      kind: 'alert',
      message: copy.adminMarketReviewExcludedEditor,
      refresh: true,
    });
    expect(approval('requester')).toEqual({
      kind: 'alert',
      message: copy.adminMarketReviewExcludedRequester,
      refresh: true,
    });
    expect(approval('decided')).toMatchObject({ message: copy.errApprovalDecided });
    expect(approval('something new')).toMatchObject({ message: copy.errUnknown });
  });

  it('names what the approval found missing, and the close already passed', () => {
    expect(
      reviewFailure(
        refused(422, 'OPEN_ITEMS_MISSING', [{ path: ['category'], message: 'inactive' }]),
      ),
    ).toEqual({
      kind: 'alert',
      message: `${copy.errMarketReviewOpenItems}: ${copy.openItemCategory}`,
      refresh: true,
    });
    expect(reviewFailure(refused(422, 'OPEN_ITEMS_MISSING'))).toMatchObject({
      message: `${copy.errMarketReviewOpenItems}.`,
    });
    expect(invalid('closeAt', 'must be in the future')).toEqual({
      kind: 'alert',
      message: copy.errMarketReviewCloseAtPassed,
      refresh: true,
    });
    expect(invalid('status', 'market is draft')).toEqual({
      kind: 'alert',
      message: copy.errMarketStatus,
      refresh: true,
    });
    expect(reviewFailure(refused(404, 'NOT_FOUND'))).toMatchObject({
      message: copy.adminMarketNotFound,
      refresh: true,
    });
  });

  it('puts a field’s refusal under that field', () => {
    expect(invalid('reason')).toEqual({
      kind: 'field',
      field: 'reason',
      message: copy.errMarketReviewReason,
      refresh: false,
    });
    expect(invalid('rejectReason')).toMatchObject({ field: 'rejectReason' });
    expect(invalid('checklist', 'every item must be confirmed')).toEqual({
      kind: 'field',
      field: 'checklist',
      message: copy.errMarketReviewChecklist,
      refresh: false,
    });
    // 'unchanged': the time on screen is out of date, so the detail is read again.
    expect(invalid('scheduledOpenAt', 'unchanged')).toEqual({
      kind: 'field',
      field: 'scheduledOpenAt',
      message: copy.errMarketReviewRescheduleUnchanged,
      refresh: true,
    });
    expect(invalid('scheduledOpenAt', TIME_RULE_MESSAGES.openBeforeClose.scheduledOpenAt)).toEqual({
      kind: 'field',
      field: 'scheduledOpenAt',
      message: copy.errMarketTimeOpenBeforeClose,
      refresh: false,
    });
    expect(invalid('scheduledOpenAt', 'Invalid input')).toMatchObject({
      message: copy.errMarketReviewRescheduleTime,
    });
    expect(invalid('somethingElse')).toEqual({
      kind: 'alert',
      message: copy.errMarketInvalid,
      refresh: false,
    });
  });

  it('closes on another account’s cookie, and says a revoked role or an unreachable API', () => {
    expect(
      reviewFailure(
        refused(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'another account' }]),
      ),
    ).toEqual({ kind: 'toast', message: copy.sessionChanged });
    expect(reviewFailure(refused(403, 'FORBIDDEN'))).toMatchObject({ message: copy.adminOnly });
    expect(reviewFailure(refused(401, 'UNAUTHENTICATED'))).toMatchObject({
      message: copy.errUnauthenticated,
    });
    expect(reviewFailure(new TypeError('fetch failed'))).toMatchObject({
      message: copy.errNetwork,
    });
  });
});
