import {
  APPROVAL_REASON_MAX_LENGTH,
  APPROVAL_REFUSALS,
  APPROVAL_STATUSES,
  MARKET_PAUSE_END_KINDS,
  MARKET_PAUSE_PATHS,
  MARKET_PAUSE_REASONS,
  MARKET_PAUSE_REFUSALS,
  MARKET_PAUSE_REVIEW_RESULTS,
  MARKET_STATUSES,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  type AdminMarket,
  type AdminMarketPause,
  ApiError,
  type MarketPauseDecisionLogEntry,
  type MarketPauseDecisionPending,
  type MarketSupplementLogEntry,
} from './api';
import { formatKst, isoToKstLocal } from './datetime';
import {
  PAUSE_DECISION_STATUS_LABEL,
  PAUSE_DECISION_UNAPPROVABLE_NOTE,
  PAUSE_END_KIND_LABEL,
  PAUSE_PATH_LABEL,
  PAUSE_REASON_HINT,
  PAUSE_REVIEW_RESULT_HINT,
  currentPause,
  isPauseDecisionRequester,
  pauseActorName,
  pauseApprovalSuccess,
  pauseDecisionDraft,
  pauseDecisionLogRows,
  pauseDecisionUnapprovable,
  pauseDecisionUnavailable,
  pauseDraft,
  pauseEndLabel,
  pauseFailure,
  pauseOffer,
  pauseRows,
  pauseUnavailable,
  publishedAtWait,
  showsPausePanel,
} from './market-pause';

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);
const refused = (path: string, message: string) =>
  apiError(400, 'VALIDATION_ERROR', [{ path: [path], message }]);

const PAUSER = { id: 'pauser', nickname: '멈춘이' };
const REQUESTER = { id: 'requester', nickname: '요청한이' };
const APPROVER = { id: 'approver', nickname: '승인한이' };
const PAUSE_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const OLD_PAUSE_ID = 'a1b2c3d4-0000-4000-8000-000000000002';
const PAUSED_AT = '2026-11-05T03:00:00.000Z';
/** Before the close (11-29 15:00 UTC) and after it. */
const BEFORE_CLOSE = Date.parse('2026-11-10T00:00:00.000Z');
const AFTER_CLOSE = Date.parse('2026-11-29T15:00:00.000Z');

/** The pause lasting now: 실질 기준 변경, no end yet. */
const lasting: AdminMarketPause = {
  id: PAUSE_ID,
  reason: 'basis_change',
  note: '발표 일정이 앞당겨졌습니다.',
  resultPublishedAt: null,
  pausedAt: PAUSED_AT,
  pausedBy: PAUSER,
  reviewResult: null,
  endKind: null,
  endedAt: null,
  endedBy: null,
};

/** An earlier pause for an early result, resumed by an approval. */
const resumed: AdminMarketPause = {
  id: OLD_PAUSE_ID,
  reason: 'early_result',
  note: '결과가 먼저 보도되었습니다.',
  resultPublishedAt: '2026-11-03T00:30:00.000Z',
  pausedAt: '2026-11-03T01:00:00.000Z',
  pausedBy: PAUSER,
  reviewResult: null,
  endKind: 'resumed',
  endedAt: '2026-11-04T00:00:00.000Z',
  endedBy: APPROVER,
};

const pending: MarketPauseDecisionPending = {
  requestId: 'r1',
  pauseId: PAUSE_ID,
  path: 'early_close',
  reviewResult: 'judgeable',
  reason: '일정이 당겨져 마감을 당깁니다.',
  requestedBy: REQUESTER,
  requestedAt: '2026-11-05T04:00:00.000Z',
};

const open = {
  status: 'open',
  closeAt: '2026-11-29T15:00:00.000Z',
  pause: { history: [], pending: null, log: [] },
  supplement: { pending: null, log: [] },
} satisfies Pick<AdminMarket, 'status' | 'closeAt' | 'pause' | 'supplement'>;

type Market = Pick<AdminMarket, 'status' | 'closeAt' | 'pause' | 'supplement'>;

const paused: Market = {
  ...open,
  status: 'paused',
  pause: { history: [lasting, resumed], pending: null, log: [] },
};

const waiting: Market = {
  ...paused,
  pause: {
    ...paused.pause,
    pending,
    log: [
      {
        ...pending,
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        retractedAt: null,
      },
    ],
  },
};

describe('the names', () => {
  it('names every reason hint, review result hint, path, end and request status', () => {
    expect(Object.keys(PAUSE_REASON_HINT)).toEqual([...MARKET_PAUSE_REASONS]);
    expect(Object.keys(PAUSE_REVIEW_RESULT_HINT)).toEqual([...MARKET_PAUSE_REVIEW_RESULTS]);
    expect(Object.keys(PAUSE_PATH_LABEL)).toEqual([...MARKET_PAUSE_PATHS]);
    expect(Object.keys(PAUSE_END_KIND_LABEL)).toEqual([...MARKET_PAUSE_END_KINDS]);
    expect(Object.keys(PAUSE_DECISION_STATUS_LABEL).sort()).toEqual([...APPROVAL_STATUSES].sort());
    expect(PAUSE_PATH_LABEL).toEqual({ resume: '재개', early_close: '조기 마감' });
    expect(PAUSE_END_KIND_LABEL).toEqual({
      resumed: '재개',
      early_closed: '조기 마감',
      closed_at_close: '예정 마감',
    });
    expect(pauseEndLabel(lasting)).toBe(copy.pauseOngoing);
    expect(pauseEndLabel(resumed)).toBe('재개');
  });

  it('says a schedule moved earlier belongs to 실질 기준 변경 (Q2), and 판정 불가 is early close only', () => {
    expect(PAUSE_REASON_HINT.basis_change).toContain('사건 일정이 앞당겨져');
    expect(PAUSE_REVIEW_RESULT_HINT.not_judgeable).toContain('조기 마감만');
    expect(PAUSE_REVIEW_RESULT_HINT.not_judgeable).toContain('무효 규칙');
    // A market no person traded is cancelled at the early close instead, with no judgement (#20).
    expect(PAUSE_REVIEW_RESULT_HINT.not_judgeable).toContain('판정 없이 취소됩니다');
    // VOID is the judgement's, after the close, and pays nothing back (#173 item 4, N03 §6).
    for (const text of Object.values(copy).filter((value) => value.includes('무효'))) {
      expect(text).not.toMatch(/환불|원금/);
    }
  });

  it('says a request changes nothing but the close still comes on schedule (#173 items 1·3)', () => {
    // The worker closes a paused market at its close without an approval; the request then
    // waits for its 반려 or 철회 — so nothing may say the market stays as it is until approved.
    expect(copy.adminMarketPauseRequestBody).toContain('승인되기 전에는 일시 중단이 이어지고');
    expect(copy.adminMarketPauseRequestBody).toContain('승인 없이도 시장이 마감됩니다');
    expect(copy.adminMarketPauseRequestBody).not.toContain('아무것도 바뀌지 않습니다');
  });

  it('says the approved early close and the close at close_at cancel a market no person traded (#20)', () => {
    // endMarketPause and the close job both go PAUSED → CANCELLED with no human fill, whatever
    // the review result; the request side may not promise only a close and a judgement.
    expect(copy.adminMarketPauseRequestBody).toContain(
      '사용자가 낀 체결이 한 건도 없던 시장은 어느 쪽이든 마감 대신 취소되어',
    );
    expect(copy.adminMarketPauseRequestUnavailableClosed).toContain(
      '사용자가 낀 체결이 없던 시장은 취소됩니다',
    );
    expect(copy.adminMarketPauseApproveEarlyCloseBody).toContain('마감 대신 취소되어');
  });
});

describe('what the panel offers', () => {
  it('draws on an open or paused market, and on any with a pause or a request', () => {
    for (const status of MARKET_STATUSES) {
      expect(showsPausePanel({ status, pause: open.pause }), status).toBe(
        status === 'open' || status === 'paused',
      );
    }
    expect(showsPausePanel({ status: 'closed', pause: paused.pause })).toBe(true);
    expect(
      showsPausePanel({
        status: 'closed',
        pause: {
          history: [],
          pending: null,
          log: [{ ...waiting.pause.log[0]!, status: 'retracted' }],
        },
      }),
    ).toBe(true);
  });

  it('reads the current pause as the newest while it has no end', () => {
    expect(currentPause(paused)).toEqual(lasting);
    expect(currentPause({ pause: { ...paused.pause, history: [resumed] } })).toBeNull();
    expect(currentPause(open)).toBeNull();
  });

  it('offers 거래 일시 중단 on an open market before its close, judged at the row’s read', () => {
    expect(pauseUnavailable(open, BEFORE_CLOSE)).toBeNull();
    expect(pauseUnavailable(open, AFTER_CLOSE)).toBe('closed');
    expect(pauseUnavailable({ ...open, closeAt: 'nope' }, BEFORE_CLOSE)).toBe('closed');
    for (const status of MARKET_STATUSES.filter((value) => value !== 'open')) {
      expect(pauseUnavailable({ ...open, status }, BEFORE_CLOSE), status).toBe('status');
    }
  });

  it('offers 재개·조기 마감 요청 on a paused market before its close, one at a time', () => {
    expect(pauseDecisionUnavailable(paused, BEFORE_CLOSE)).toBeNull();
    expect(pauseDecisionUnavailable(paused, AFTER_CLOSE)).toBe('closed');
    expect(pauseDecisionUnavailable(waiting, BEFORE_CLOSE)).toBe('pending');
    expect(pauseDecisionUnavailable(open, BEFORE_CLOSE)).toBe('status');
    // A paused row with no pause lasting (only a factory makes one): nothing to decide.
    expect(
      pauseDecisionUnavailable(
        { ...paused, pause: { ...paused.pause, history: [] } },
        BEFORE_CLOSE,
      ),
    ).toBe('status');
  });

  it('approves the waiting request only while paused, before the close, on the current pause', () => {
    expect(pauseDecisionUnapprovable(waiting, pending, BEFORE_CLOSE)).toBeNull();
    // Closed at its close by the worker, or the close come: moot, 반려 or 철회 ends it.
    expect(pauseDecisionUnapprovable(waiting, pending, AFTER_CLOSE)).toBe('closed');
    expect(pauseDecisionUnapprovable({ ...waiting, status: 'closed' }, pending, BEFORE_CLOSE)).toBe(
      'closed',
    );
    expect(pauseDecisionUnapprovable(waiting, { pauseId: OLD_PAUSE_ID }, BEFORE_CLOSE)).toBe(
      'stale',
    );
    expect(PAUSE_DECISION_UNAPPROVABLE_NOTE.closed).toBe(copy.adminMarketPausePendingClosed);
    expect(PAUSE_DECISION_UNAPPROVABLE_NOTE.stale).toBe(copy.adminMarketPausePendingStale);
  });

  it('tells the requester apart once the admin on screen is known', () => {
    expect(isPauseDecisionRequester(pending, REQUESTER.id)).toBe(true);
    // The admin who paused is not excluded (#173 item 2: the requester alone is).
    expect(isPauseDecisionRequester(pending, PAUSER.id)).toBe(false);
    expect(isPauseDecisionRequester(pending, undefined)).toBeUndefined();
    expect(pauseActorName({ nickname: null })).toBe(copy.postAuthorFormer);
    expect(pauseActorName(null)).toBe(copy.eventSystem);
  });
});

describe('pauseOffer (#172 item 15: the 의미 변경 반려 leads to the pause)', () => {
  const rejected: MarketSupplementLogEntry = {
    requestId: 's1',
    requestedBy: REQUESTER,
    requestedAt: '2026-11-06T00:00:00.000Z',
    baseVersion: 1,
    items: ['yesCondition'],
    changes: { yesCondition: '새 조건' },
    reason: '조건을 고칩니다.',
    settlementImpact: '없음',
    status: 'rejected',
    decidedBy: APPROVER,
    decidedAt: '2026-11-06T01:00:00.000Z',
    decisionReason: '조건의 뜻이 바뀝니다.',
    rejectReason: 'meaning_change',
    retractedAt: null,
    version: null,
  };
  const afterReject: Market = { ...open, supplement: { pending: null, log: [rejected] } };

  it('suggests 실질 기준 변경 with the 반려’s 설명 on an open market not paused since', () => {
    expect(pauseOffer(afterReject, BEFORE_CLOSE)).toEqual({
      reason: 'basis_change',
      note: '조건의 뜻이 바뀝니다.',
    });
    // A pause before the 반려 (resumed since) does not answer it.
    expect(
      pauseOffer({ ...afterReject, pause: { ...open.pause, history: [resumed] } }, BEFORE_CLOSE),
    ).not.toBeNull();
  });

  it('suggests nothing once paused after it, for another reason, behind a newer request, or past the close', () => {
    const pausedSince = {
      ...resumed,
      pausedAt: '2026-11-06T02:00:00.000Z',
      endedAt: '2026-11-06T03:00:00.000Z',
    };
    expect(
      pauseOffer(
        { ...afterReject, pause: { ...open.pause, history: [pausedSince] } },
        BEFORE_CLOSE,
      ),
    ).toBeNull();
    // A 반려 while paused (resumed since): whoever approved the 재개 decided after it.
    const resumedSince = { ...resumed, endedAt: '2026-11-06T02:00:00.000Z' };
    expect(
      pauseOffer(
        { ...afterReject, pause: { ...open.pause, history: [resumedSince] } },
        BEFORE_CLOSE,
      ),
    ).toBeNull();
    expect(
      pauseOffer(
        { ...open, supplement: { pending: null, log: [{ ...rejected, rejectReason: 'other' }] } },
        BEFORE_CLOSE,
      ),
    ).toBeNull();
    expect(
      pauseOffer(
        {
          ...open,
          supplement: { pending: null, log: [{ ...rejected, status: 'pending' }, rejected] },
        },
        BEFORE_CLOSE,
      ),
    ).toBeNull();
    expect(pauseOffer(afterReject, AFTER_CLOSE)).toBeNull();
    expect(pauseOffer({ ...afterReject, status: 'paused' }, BEFORE_CLOSE)).toBeNull();
    expect(pauseOffer(open, BEFORE_CLOSE)).toBeNull();
  });
});

describe('the 일시 중단 기록’s rows', () => {
  it('says a pause: reason, note, publication instant, who and when, then how it ended', () => {
    const time = (iso: string) => formatKst(iso);
    expect(pauseRows(resumed, time)).toEqual([
      { label: '중단 사유', value: '사건 선공개(조기 결과)' },
      { label: '설명', value: resumed.note },
      { label: '결과 공개 시각', value: formatKst('2026-11-03T00:30:00.000Z') },
      { label: '중단한 관리자', value: '멈춘이' },
      { label: '중단 시각', value: formatKst(resumed.pausedAt) },
      { label: '끝난 시각', value: formatKst('2026-11-04T00:00:00.000Z') },
      { label: '승인한 관리자', value: '승인한이' },
    ]);
    // Lasting: no end. Closed by the worker at its close: an end with no approver.
    expect(pauseRows(lasting, time).map((row) => row.label)).toEqual([
      '중단 사유',
      '설명',
      '중단한 관리자',
      '중단 시각',
    ]);
    const closedAtClose: AdminMarketPause = {
      ...lasting,
      reviewResult: null,
      endKind: 'closed_at_close',
      endedAt: '2026-11-29T15:00:00.000Z',
    };
    expect(pauseRows(closedAtClose, time).map((row) => row.label)).toEqual([
      '중단 사유',
      '설명',
      '중단한 관리자',
      '중단 시각',
      '끝난 시각',
    ]);
    const earlyClosed: AdminMarketPause = {
      ...lasting,
      reviewResult: 'not_judgeable',
      endKind: 'early_closed',
      endedAt: '2026-11-06T00:00:00.000Z',
      endedBy: APPROVER,
    };
    expect(pauseRows(earlyClosed, time)).toContainEqual({ label: '검토 결과', value: '판정 불가' });
  });

  it('says a request: path, review result, reason, then how it ended', () => {
    const time = (iso: string) => formatKst(iso);
    const approved: MarketPauseDecisionLogEntry = {
      ...pending,
      status: 'approved',
      decidedBy: APPROVER,
      decidedAt: '2026-11-05T05:00:00.000Z',
      decisionReason: '확인했습니다.',
      retractedAt: null,
    };
    expect(pauseDecisionLogRows(approved, time)).toEqual([
      { label: '경로', value: '조기 마감' },
      { label: '검토 결과', value: '기존 규칙으로 판정 가능' },
      { label: '요청 사유', value: pending.reason },
      { label: '결정한 관리자', value: '승인한이' },
      { label: '결정 시각', value: formatKst('2026-11-05T05:00:00.000Z') },
      { label: '결정 사유', value: '확인했습니다.' },
    ]);
    const retracted: MarketPauseDecisionLogEntry = {
      ...pending,
      path: 'resume',
      reviewResult: null,
      status: 'retracted',
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      retractedAt: '2026-11-05T05:00:00.000Z',
    };
    expect(pauseDecisionLogRows(retracted, time)).toEqual([
      { label: '경로', value: '재개' },
      { label: '요청 사유', value: pending.reason },
      { label: '철회 시각', value: formatKst('2026-11-05T05:00:00.000Z') },
    ]);
  });
});

describe('what each write may send', () => {
  const NOW = Date.parse('2026-11-05T03:00:30.000Z');
  const local = (iso: string) => isoToKstLocal(iso);

  it('pauses with a reason and a note, the note trimmed and 1..500', () => {
    expect(pauseDraft('ledger_failure', '  원장 장애  ', '', NOW)).toEqual({
      ready: true,
      reason: 'ledger_failure',
      note: '원장 장애',
      resultPublishedAt: null,
      publishedAtError: null,
    });
    expect(pauseDraft('', '원장 장애', '', NOW).ready).toBe(false);
    expect(pauseDraft('bot_stop', '원장 장애', '', NOW).reason).toBeNull();
    expect(pauseDraft('ledger_failure', ' ', '', NOW).ready).toBe(false);
    expect(
      pauseDraft('ledger_failure', 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1), '', NOW).ready,
    ).toBe(false);
  });

  it('takes the publication instant for an early result alone, in KST, not after now (decision 3)', () => {
    const published = '2026-11-05T02:40:00.000Z';
    expect(pauseDraft('early_result', '보도', local(published), NOW)).toMatchObject({
      ready: true,
      resultPublishedAt: published,
      publishedAtError: null,
    });
    // Required: blank says nothing, the confirm stays off.
    expect(pauseDraft('early_result', '보도', '', NOW)).toMatchObject({
      ready: false,
      resultPublishedAt: null,
      publishedAtError: null,
    });
    // The minute now is in is not after it; the next one is.
    expect(pauseDraft('early_result', '보도', local('2026-11-05T03:00:00.000Z'), NOW).ready).toBe(
      true,
    );
    expect(
      pauseDraft('early_result', '보도', local('2026-11-05T03:01:00.000Z'), NOW),
    ).toMatchObject({
      ready: false,
      resultPublishedAt: null,
      publishedAtError: copy.errMarketPausePublishedAtAfter,
    });
    expect(pauseDraft('early_result', '보도', 'garbage', NOW).publishedAtError).toBe(
      copy.errMarketPausePublishedAtTime,
    );
    expect(pauseDraft('early_result', '보도', '0099-12-31T23:00', NOW).publishedAtError).toBe(
      copy.errMarketPausePublishedAtTime,
    );
    // Any other reason sends none, whatever the field held before the reason changed.
    for (const reason of ['ledger_failure', 'basis_change']) {
      expect(pauseDraft(reason, '보도', local(published), NOW)).toMatchObject({
        ready: true,
        resultPublishedAt: null,
        publishedAtError: null,
      });
    }
  });

  it('asks a 실질 기준 변경 pause’s review result, and 판정 불가 closes early only (Q1, #173 item 4)', () => {
    expect(pauseDecisionDraft('basis_change', 'resume', '', '재개합니다')).toMatchObject({
      ready: false,
      reviewResult: null,
      refusal: { path: 'reviewResult', message: MARKET_PAUSE_REFUSALS.reviewResult.required },
      resumeOff: false,
    });
    expect(pauseDecisionDraft('basis_change', 'resume', 'judgeable', '재개합니다')).toMatchObject({
      ready: true,
      path: 'resume',
      reviewResult: 'judgeable',
      refusal: null,
    });
    expect(
      pauseDecisionDraft('basis_change', 'early_close', 'judgeable', '마감합니다'),
    ).toMatchObject({ ready: true, path: 'early_close' });
    expect(
      pauseDecisionDraft('basis_change', 'resume', 'not_judgeable', '재개합니다'),
    ).toMatchObject({
      ready: false,
      refusal: { path: 'path', message: MARKET_PAUSE_REFUSALS.path.earlyCloseOnly },
      resumeOff: true,
    });
    expect(
      pauseDecisionDraft('basis_change', 'early_close', 'not_judgeable', '마감합니다'),
    ).toMatchObject({ ready: true, resumeOff: true });
  });

  it('lets the operator pick either path for the other two reasons, with no review result', () => {
    for (const reason of ['early_result', 'ledger_failure'] as const) {
      for (const path of MARKET_PAUSE_PATHS) {
        // A review result left in the control is not sent.
        expect(pauseDecisionDraft(reason, path, 'judgeable', '사유'), `${reason} ${path}`).toEqual({
          ready: true,
          path,
          reviewResult: null,
          reason: '사유',
          refusal: null,
          resumeOff: false,
        });
      }
    }
    expect(pauseDecisionDraft('ledger_failure', '', '', '사유').ready).toBe(false);
    expect(pauseDecisionDraft('ledger_failure', 'resume', '', ' ').ready).toBe(false);
  });

  it('waits for the minute typed when it is after now, so the dialog draws again as it comes', () => {
    const published = '2026-11-05T03:01:00.000Z';
    // After now by 30 s: drawn again a second past it, and then the draft is ready.
    const wait = publishedAtWait(local(published), NOW);
    expect(wait).toBe(30_000 + 1_000);
    expect(pauseDraft('early_result', '보도', local(published), NOW + (wait ?? 0))).toMatchObject({
      ready: true,
      resultPublishedAt: published,
      publishedAtError: null,
    });
    // Not after now (the minute now is in, or earlier), or unreadable: nothing to wait for.
    expect(publishedAtWait(local('2026-11-05T03:00:00.000Z'), NOW)).toBeNull();
    expect(publishedAtWait(local(published), Date.parse(published))).toBeNull();
    expect(publishedAtWait('garbage', NOW)).toBeNull();
    expect(publishedAtWait('', NOW)).toBeNull();
    // Far ahead: a day at most, waited again from the draw it ends in.
    expect(publishedAtWait(local('2026-11-09T03:00:00.000Z'), NOW)).toBe(24 * 60 * 60 * 1_000);
  });

  it('says what an approval did by the status it answered', () => {
    expect(pauseApprovalSuccess('open')).toBe(copy.adminMarketPauseResumed);
    expect(pauseApprovalSuccess('closed')).toBe(copy.adminMarketPauseEarlyClosed);
    // #20: an early close with no fill of a person's account cancels the market.
    expect(pauseApprovalSuccess('cancelled')).toBe(copy.adminMarketPauseEarlyCancelled);
  });
});

describe('pauseFailure', () => {
  it('closes on another account’s cookie, and says a session or a role gone', () => {
    const another = apiError(403, 'FORBIDDEN', [
      { path: ['expectedAccountId'], message: 'session belongs to another account' },
    ]);
    expect(pauseFailure(another, 'pause')).toEqual({ kind: 'toast', message: copy.sessionChanged });
    expect(pauseFailure(apiError(401, 'UNAUTHENTICATED'), 'decision')).toEqual({
      kind: 'alert',
      message: copy.errUnauthenticated,
      refresh: false,
    });
    expect(pauseFailure(apiError(403, 'FORBIDDEN'), 'decision')).toEqual({
      kind: 'alert',
      message: copy.adminOnly,
      refresh: false,
    });
    expect(pauseFailure(apiError(404, 'NOT_FOUND'), 'pause')).toEqual({
      kind: 'alert',
      message: copy.adminMarketNotFound,
      refresh: true,
    });
    expect(pauseFailure(new Error('offline'), 'pause')).toEqual({
      kind: 'alert',
      message: copy.errNetwork,
      refresh: false,
    });
  });

  it('says each two-person refusal, the requester’s in the panel’s words, and reads again', () => {
    for (const refusal of APPROVAL_REFUSALS) {
      const failure = pauseFailure(
        apiError(409, 'APPROVAL_NOT_ALLOWED', [{ path: ['request'], message: refusal }]),
        'decision',
      );
      expect(failure, refusal).toMatchObject({ kind: 'alert', refresh: true });
    }
    expect(
      pauseFailure(
        apiError(409, 'APPROVAL_NOT_ALLOWED', [{ path: ['request'], message: 'requester' }]),
        'decision',
      ),
    ).toMatchObject({ message: copy.adminMarketPauseExcludedRequester });
    expect(
      pauseFailure(
        apiError(409, 'APPROVAL_NOT_ALLOWED', [{ path: ['request'], message: 'no_decider' }]),
        'decision',
      ),
    ).toMatchObject({ message: copy.errApprovalNoDecider });
  });

  it('says the market’s state as the pause and the next path each meet it, and reads again', () => {
    const { status, closeAt, pause } = MARKET_PAUSE_REFUSALS;
    expect(pauseFailure(refused('status', status.notOpen), 'pause')).toEqual({
      kind: 'alert',
      message: copy.errMarketPauseStatus,
      refresh: true,
    });
    expect(pauseFailure(refused('closeAt', closeAt.closed), 'pause')).toMatchObject({
      message: copy.errMarketPauseClosed,
      refresh: true,
    });
    // The request meets the market's state as its approval does.
    for (const write of ['request', 'decision'] as const) {
      expect(pauseFailure(refused('status', status.notPaused), write), write).toEqual({
        kind: 'alert',
        message: copy.errMarketPauseDecisionStatus,
        refresh: true,
      });
      expect(pauseFailure(refused('closeAt', closeAt.closed), write), write).toMatchObject({
        message: copy.errMarketPauseDecisionClosed,
        refresh: true,
      });
    }
    expect(pauseFailure(refused('pause', pause.pending), 'request')).toMatchObject({
      message: copy.errMarketPauseDecisionPending,
      refresh: true,
    });
    // 'stale' in each one's words: the approval's request was asked on another pause (반려 or 철회
    // ends it); the request's dialog opened before a resume and another pause (ask again).
    expect(pauseFailure(refused('pause', pause.stale), 'decision')).toMatchObject({
      message: copy.errMarketPauseDecisionStale,
      refresh: true,
    });
    expect(pauseFailure(refused('pause', pause.stale), 'request')).toEqual({
      kind: 'alert',
      message: copy.errMarketPauseRequestStale,
      refresh: true,
    });
    expect(copy.errMarketPauseRequestStale).not.toContain('승인');
    expect(pauseFailure(refused('requestId', 'unknown'), 'decision')).toMatchObject({
      message: copy.errMarketPauseUnknown,
      refresh: true,
    });
  });

  it('puts a field’s refusal under its input', () => {
    const { resultPublishedAt, path, reviewResult } = MARKET_PAUSE_REFUSALS;
    expect(pauseFailure(refused('reason', 'Invalid option'), 'pause')).toEqual({
      kind: 'field',
      field: 'pauseReason',
      message: copy.errMarketPauseReason,
    });
    for (const write of ['request', 'decision'] as const) {
      expect(pauseFailure(refused('reason', 'Too small'), write), write).toEqual({
        kind: 'field',
        field: 'reason',
        message: copy.errMarketReviewReason,
      });
    }
    expect(pauseFailure(refused('note', 'Too small'), 'pause')).toEqual({
      kind: 'field',
      field: 'note',
      message: copy.errMarketPauseNote,
    });
    for (const [message, said] of [
      [resultPublishedAt.required, copy.errMarketPausePublishedAtRequired],
      [resultPublishedAt.earlyResultOnly, copy.errMarketPausePublishedAtOnly],
      [resultPublishedAt.afterPause, copy.errMarketPausePublishedAtAfter],
      ['Invalid ISO datetime', copy.errMarketPausePublishedAtTime],
    ] as const) {
      expect(pauseFailure(refused('resultPublishedAt', message), 'pause'), message).toEqual({
        kind: 'field',
        field: 'resultPublishedAt',
        message: said,
      });
    }
    expect(pauseFailure(refused('path', path.earlyCloseOnly), 'request')).toEqual({
      kind: 'field',
      field: 'path',
      message: copy.errMarketPauseEarlyCloseOnly,
    });
    expect(pauseFailure(refused('path', 'Invalid option'), 'request')).toEqual({
      kind: 'field',
      field: 'path',
      message: copy.errMarketPausePath,
    });
    // The dialog asks for a review result exactly on a 실질 기준 변경 pause and names it: either
    // refusal says the screen and the server disagree on the pause, so no field takes it.
    expect(pauseFailure(refused('reviewResult', reviewResult.required), 'request')).toEqual({
      kind: 'alert',
      message: copy.errMarketPauseReviewRequired,
      refresh: true,
    });
    expect(pauseFailure(refused('reviewResult', reviewResult.basisChangeOnly), 'request')).toEqual({
      kind: 'alert',
      message: copy.errMarketPauseReviewOnly,
      refresh: true,
    });
    expect(pauseFailure(refused('somethingElse', 'x'), 'decision')).toEqual({
      kind: 'alert',
      message: copy.errMarketInvalid,
      refresh: false,
    });
  });
});
