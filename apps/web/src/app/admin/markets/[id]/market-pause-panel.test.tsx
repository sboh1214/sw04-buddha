import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  type AdminMarket,
  type AdminMarketPause,
  type MarketPauseDecisionPending,
  type MarketRuleContent,
  type MarketSupplementLogEntry,
} from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { PAUSE_REASON_HINT } from '@/lib/market-pause';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { PauseDecisionFields, PauseFields } from './market-pause-dialogs';
import { MarketPausePanel, PausePanelBody } from './market-pause-panel';

const PAUSER = { id: 'pauser', nickname: '멈춘이' };
const REQUESTER = { id: 'requester', nickname: '요청한이' };
const APPROVER = { id: 'approver', nickname: '승인한이' };
const THIRD = 'third';
const PAUSE_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const OLD_PAUSE_ID = 'a1b2c3d4-0000-4000-8000-000000000002';
/** Before the close (11-29 15:00 UTC), and after it. */
const BEFORE_CLOSE = Date.parse('2026-11-10T00:00:00.000Z');
const AFTER_CLOSE = Date.parse('2026-11-30T00:00:00.000Z');

const V1: MarketRuleContent = {
  title: '첫눈이 올까?',
  description: '배경',
  yesCondition: '관측되면 YES',
  noCondition: '아니면 NO',
  eventDeadline: '2026-11-29T14:59:00.000Z',
  primarySource: { name: '기상청', url: 'https://www.weather.go.kr' },
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: 14,
  delayHandling: '무효',
  scheduledOpenAt: '2026-11-01T00:00:00.000Z',
  closeAt: '2026-11-29T15:00:00.000Z',
  scheduledAnnouncementAt: null,
  scheduledJudgementAt: '2026-12-01T01:00:00.000Z',
  judgementTimeZone: 'Asia/Seoul',
};

/** An OPEN market, never paused. */
const open: AdminMarket = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  slug: 'first-snow',
  ...V1,
  category: { slug: 'weather', nameKo: '날씨' },
  imageUrl: null,
  status: 'open',
  judgementDelayed: false,
  disputeUnderReview: false,
  lastPrice: null,
  volumeCoin: '0',
  tradeCount: 0,
  traderCount: 0,
  openAt: '2026-11-01T00:00:00.000Z',
  resolvedResult: null,
  resolvedAt: null,
  settledAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  createdBy: 'creator',
  netCollectedCoin: '0',
  openInterest: { yes: 0, no: 0 },
  settlementSteps: [],
  statusEventId: '1',
  events: [],
  tags: ['날씨'],
  missingOpenItems: [],
  leadCloseGapMinutes: 60,
  review: {
    pending: null,
    createdBy: { id: 'creator', nickname: '만든이' },
    editors: [],
    sameCondition: [],
    log: [],
  },
  ruleVersion: 1,
  ruleVersions: [],
  supplement: { pending: null, log: [] },
  pause: { history: [], pending: null, log: [] },
  // Not judged (#152): no judgement, none waiting, the dispute window decided.
  judgementVersion: null,
  disputeDeadline: null,
  disputeOpen: false,
  disputes: { holding: 0, items: [] },
  judgement: { current: null, history: [], pending: null, log: [], disputeWindowUndecided: false },
};

/** The pause lasting now: an early result, with its publication instant. */
const lasting: AdminMarketPause = {
  id: PAUSE_ID,
  reason: 'early_result',
  note: '결과가 먼저 보도되었습니다.',
  resultPublishedAt: '2026-11-05T02:40:00.000Z',
  pausedAt: '2026-11-05T03:00:00.000Z',
  pausedBy: PAUSER,
  reviewResult: null,
  endKind: null,
  endedAt: null,
  endedBy: null,
};

/** An earlier pause, resumed by an approval. */
const earlier: AdminMarketPause = {
  id: OLD_PAUSE_ID,
  reason: 'ledger_failure',
  note: '원장 장애',
  resultPublishedAt: null,
  pausedAt: '2026-11-03T01:00:00.000Z',
  pausedBy: PAUSER,
  reviewResult: null,
  endKind: 'resumed',
  endedAt: '2026-11-04T00:00:00.000Z',
  endedBy: APPROVER,
};

const paused: AdminMarket = {
  ...open,
  status: 'paused',
  pause: { history: [lasting, earlier], pending: null, log: [] },
};

const pending: MarketPauseDecisionPending = {
  requestId: 'r2',
  pauseId: PAUSE_ID,
  path: 'early_close',
  reviewResult: null,
  reason: '결과가 나와 마감합니다.',
  requestedBy: REQUESTER,
  requestedAt: '2026-11-05T04:00:00.000Z',
};

/** The paused market with `pending` waiting; the earlier pause's request approved. */
const waiting: AdminMarket = {
  ...paused,
  pause: {
    history: [lasting, earlier],
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
      {
        requestId: 'r1',
        pauseId: OLD_PAUSE_ID,
        path: 'resume',
        reviewResult: null,
        reason: '복구했습니다.',
        requestedBy: REQUESTER,
        requestedAt: '2026-11-03T05:00:00.000Z',
        status: 'approved',
        decidedBy: APPROVER,
        decidedAt: '2026-11-04T00:00:00.000Z',
        decisionReason: '확인',
        retractedAt: null,
      },
    ],
  },
};

const draw = (market: AdminMarket, operatorId: string | undefined, readAt = BEFORE_CLOSE) =>
  renderWithQueries(
    <PausePanelBody market={market} readAt={readAt} operatorId={operatorId} onOpen={() => {}} />,
  );

const isOff = (html: string, testId: string) => {
  const element = byTestId(html, testId);
  expect(element, testId).toBeDefined();
  return Object.hasOwn(element?.attributes ?? {}, 'disabled');
};

/**
 * 거래 일시 중단 as drawn (#114, ADR-0102; ADR-0093 decision 1 #173 items 1–4, the owner's answers
 * Q1·Q2), per state and per admin on screen. What each write may send and what a refusal says are
 * lib/market-pause.ts' (market-pause.test.ts), which the API refuses again; the e2e (pause.spec.ts)
 * drives the dialogs.
 */
describe('PausePanelBody', () => {
  it('offers 거래 일시 중단 on an open market before its close, once the admin is known', () => {
    const html = draw(open, THIRD);
    expect(byTestId(html, 'market-pause')?.attributes['data-status']).toBe('open');
    expect(byTestId(html, 'market-pause-start')?.text).toBe(copy.adminMarketPause);
    expect(isOff(html, 'market-pause-start')).toBe(false);
    expect(isOff(draw(open, undefined), 'market-pause-start')).toBe(true);
    expect(byTestId(html, 'market-pause-current')).toBeUndefined();
    expect(byTestId(html, 'market-pause-request')).toBeUndefined();
    expect(byTestId(html, 'market-pause-history-empty')?.text).toBe(
      copy.adminMarketPauseHistoryEmpty,
    );
    // Past its close (the worker about to close it), none, and why.
    const late = draw(open, THIRD, AFTER_CLOSE);
    expect(byTestId(late, 'market-pause-start')).toBeUndefined();
    expect(byTestId(late, 'market-pause-unavailable')?.attributes['data-reason']).toBe('closed');
  });

  it('offers the pause a 의미 변경 반려 suggests in the button’s place (#172 item 15)', () => {
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
    const market = { ...open, supplement: { pending: null, log: [rejected] } };
    const html = draw(market, THIRD);
    expect(byTestId(html, 'market-pause-offer')?.text).toContain(copy.adminMarketPauseOffer);
    expect(isOff(html, 'market-pause-offer-pause')).toBe(false);
    expect(isOff(draw(market, undefined), 'market-pause-offer-pause')).toBe(true);
    expect(byTestId(html, 'market-pause-start')).toBeUndefined();
  });

  it('shows the current pause whole and offers 재개·조기 마감 요청 on a paused market', () => {
    const html = draw(paused, THIRD);
    expect(byTestId(html, 'market-pause')?.attributes['data-status']).toBe('paused');
    expect(byTestId(html, 'market-pause-start')).toBeUndefined();
    expect(byTestId(html, 'market-pause-current-reason')?.text).toBe('사건 선공개(조기 결과)');
    expect(byTestId(html, 'market-pause-current-note')?.text).toBe(lasting.note);
    expect(byTestId(html, 'market-pause-current-by')?.text).toBe('멈춘이');
    expect(byTestId(html, 'market-pause-current-at')?.text).toBe(formatKst(lasting.pausedAt));
    expect(byTestId(html, 'market-pause-current-published-at')?.text).toBe(
      formatKst('2026-11-05T02:40:00.000Z'),
    );
    expect(byTestId(html, 'market-pause-request')?.text).toBe(copy.adminMarketPauseRequest);
    expect(isOff(html, 'market-pause-request')).toBe(false);
    expect(isOff(draw(paused, undefined), 'market-pause-request')).toBe(true);
    // Not an early result: no publication instant.
    const ledger = draw({ ...paused, pause: { ...paused.pause, history: [earlier] } }, THIRD);
    expect(byTestId(ledger, 'market-pause-current')).toBeUndefined();
    const other = draw(
      {
        ...paused,
        pause: {
          ...paused.pause,
          history: [{ ...lasting, reason: 'ledger_failure', resultPublishedAt: null }],
        },
      },
      THIRD,
    );
    expect(byTestId(other, 'market-pause-current-published-at')).toBeUndefined();
    // Past its close: no request, and why — the worker closes it on schedule (#173 item 3).
    const late = draw(paused, THIRD, AFTER_CLOSE);
    expect(byTestId(late, 'market-pause-request')).toBeUndefined();
    expect(byTestId(late, 'market-pause-request-unavailable')?.attributes['data-reason']).toBe(
      'closed',
    );
  });

  it('shows the waiting request to another admin, with 승인 and 반려; one at a time', () => {
    const html = draw(waiting, THIRD);
    expect(byTestId(html, 'market-pause-pending-by')?.text).toBe('요청한이');
    expect(byTestId(html, 'market-pause-pending-at')?.text).toBe(formatKst(pending.requestedAt));
    expect(byTestId(html, 'market-pause-pending-path')?.text).toBe('조기 마감');
    expect(byTestId(html, 'market-pause-pending-review')).toBeUndefined();
    expect(byTestId(html, 'market-pause-pending-reason')?.text).toBe(pending.reason);
    expect(isOff(html, 'market-pause-approve')).toBe(false);
    expect(isOff(html, 'market-pause-reject')).toBe(false);
    expect(byTestId(html, 'market-pause-retract')).toBeUndefined();
    expect(byTestId(html, 'market-pause-requester-note')).toBeUndefined();
    expect(byTestId(html, 'market-pause-request')).toBeUndefined();
    // The admin who paused decides like any other (#173 item 2: the requester alone is excluded).
    expect(isOff(draw(waiting, PAUSER.id), 'market-pause-approve')).toBe(false);
    const reviewed = draw(
      {
        ...waiting,
        pause: { ...waiting.pause, pending: { ...pending, reviewResult: 'judgeable' } },
      },
      THIRD,
    );
    expect(byTestId(reviewed, 'market-pause-pending-review')?.text).toBe('기존 규칙으로 판정 가능');
  });

  it('turns 승인 and 반려 off for the requester with the note why, and offers 철회 alone', () => {
    const html = draw(waiting, REQUESTER.id);
    expect(byTestId(html, 'market-pause-requester-note')?.text).toContain(
      copy.adminMarketPauseExcludedRequester,
    );
    expect(isOff(html, 'market-pause-approve')).toBe(true);
    expect(isOff(html, 'market-pause-reject')).toBe(true);
    expect(isOff(html, 'market-pause-retract')).toBe(false);
    const unknown = draw(waiting, undefined);
    expect(isOff(unknown, 'market-pause-approve')).toBe(true);
    expect(isOff(unknown, 'market-pause-reject')).toBe(true);
    expect(byTestId(unknown, 'market-pause-retract')).toBeUndefined();
  });

  it('leaves a request moot at the close to its 반려 or 철회, whatever the status', () => {
    const closed: AdminMarket = {
      ...waiting,
      status: 'closed',
      pause: {
        ...waiting.pause,
        history: [
          { ...lasting, endKind: 'closed_at_close', endedAt: '2026-11-29T15:00:00.000Z' },
          earlier,
        ],
      },
    };
    for (const [market, readAt] of [
      [waiting, AFTER_CLOSE],
      [closed, BEFORE_CLOSE],
    ] as const) {
      const html = draw(market, THIRD, readAt);
      expect(byTestId(html, 'market-pause-pending-closed')?.text).toContain(
        copy.adminMarketPausePendingClosed,
      );
      expect(isOff(html, 'market-pause-approve')).toBe(true);
      expect(isOff(html, 'market-pause-reject')).toBe(false);
      expect(isOff(draw(market, REQUESTER.id, readAt), 'market-pause-retract')).toBe(false);
    }
    // Closed: no current pause, no pause to start, and the history says how it ended.
    const html = draw(closed, THIRD);
    expect(byTestId(html, 'market-pause-current')).toBeUndefined();
    expect(byTestId(html, 'market-pause-start')).toBeUndefined();
    expect(byTestId(html, 'market-pause-history-0')?.attributes['data-end']).toBe(
      'closed_at_close',
    );
    expect(byTestId(html, 'market-pause-history-0-end')?.text).toBe('예정 마감');
  });

  it('approves no request for another pause, and says so', () => {
    const stale = draw(
      { ...waiting, pause: { ...waiting.pause, pending: { ...pending, pauseId: OLD_PAUSE_ID } } },
      THIRD,
    );
    expect(byTestId(stale, 'market-pause-pending-stale')?.text).toContain(
      copy.adminMarketPausePendingStale,
    );
    expect(isOff(stale, 'market-pause-approve')).toBe(true);
    expect(isOff(stale, 'market-pause-reject')).toBe(false);
  });

  it('lists every pause newest first with how it ended, and under each its requests', () => {
    const html = draw(waiting, THIRD);
    expect(
      testIdsStartingWith(html, 'market-pause-history-').filter((id) => /-history-\d+$/.test(id)),
    ).toEqual(['market-pause-history-0', 'market-pause-history-1']);
    expect(byTestId(html, 'market-pause-history-0')?.attributes['data-end']).toBe('ongoing');
    expect(byTestId(html, 'market-pause-history-0-end')?.text).toBe(copy.pauseOngoing);
    expect(byTestId(html, 'market-pause-history-1-end')?.text).toBe('재개');
    expect(byTestId(html, 'market-pause-history-1-rows')?.text).toContain('승인한이');
    // Each request under its own pause: the waiting one under the current, the approved one under
    // the earlier.
    expect(byTestId(html, 'market-pause-history-0-log-0')?.attributes['data-status']).toBe(
      'pending',
    );
    expect(byTestId(html, 'market-pause-history-0-log-1')).toBeUndefined();
    expect(byTestId(html, 'market-pause-history-1-log-0-status')?.text).toBe('승인');
    expect(byTestId(html, 'market-pause-history-1-log-0-by')?.text).toBe('요청한이');
    expect(byTestId(html, 'market-pause-history-1-log-0-rows')?.text).toContain('복구했습니다.');
    // No account id is printed (ADR-0101 9-11's way): nicknames only.
    for (const id of [PAUSER.id, REQUESTER.id, APPROVER.id]) {
      expect(byTestId(html, 'market-pause-history')?.text).not.toContain(id);
    }
  });

  it('draws the headings focus comes back to out of the tab order (WCAG 2.4.3)', () => {
    const targets = {
      title: createRef<HTMLParagraphElement>(),
      current: createRef<HTMLParagraphElement>(),
      pending: createRef<HTMLParagraphElement>(),
    };
    const html = renderWithQueries(
      <PausePanelBody
        market={waiting}
        readAt={BEFORE_CLOSE}
        operatorId={THIRD}
        onOpen={() => {}}
        targets={targets}
      />,
    );
    for (const id of [
      'market-pause-title',
      'market-pause-current-title',
      'market-pause-pending-title',
    ]) {
      expect(byTestId(html, id)?.attributes.tabindex, id).toBe('-1');
    }
  });
});

describe('MarketPausePanel', () => {
  it('draws nothing before the open, and a closed market’s history after it', () => {
    for (const status of ['draft', 'review', 'scheduled', 'closed', 'resolved'] as const) {
      expect(
        renderWithQueries(<MarketPausePanel market={{ ...open, status }} readAt={BEFORE_CLOSE} />),
        status,
      ).toBe('');
    }
    const closed = renderWithQueries(
      <MarketPausePanel
        market={{ ...paused, status: 'closed', pause: { ...paused.pause, history: [earlier] } }}
        readAt={BEFORE_CLOSE}
      />,
    );
    expect(byTestId(closed, 'market-pause-history-0')).toBeDefined();
  });
});

describe('PauseFields', () => {
  const fields = (value: string) =>
    renderWithQueries(
      <PauseFields
        value={value}
        onValue={() => {}}
        reasonError={null}
        note=""
        onNote={() => {}}
        noteError={null}
        publishedLocal=""
        onPublishedLocal={() => {}}
        publishedAtError={null}
        disabled={false}
      />,
    );

  it('lists the three reasons with their lines, the note, and the instant for an early result alone', () => {
    const html = fields('');
    for (const reason of ['early_result', 'ledger_failure', 'basis_change'] as const) {
      expect(byTestId(html, `market-pause-reason-${reason}`)?.text).toContain(
        PAUSE_REASON_HINT[reason],
      );
    }
    expect(byTestId(html, 'market-pause-note')).toBeDefined();
    expect(html).toContain(copy.adminMarketPauseNoteHint);
    expect(byTestId(html, 'market-pause-published-at')).toBeUndefined();
    expect(byTestId(fields('ledger_failure'), 'market-pause-published-at')).toBeUndefined();
    const early = fields('early_result');
    expect(byTestId(early, 'market-pause-published-at')?.attributes.type).toBe('datetime-local');
    expect(early).toContain(copy.adminMarketPauseResultPublishedAtHint);
  });
});

describe('PauseDecisionFields', () => {
  const fields = (pauseReason: 'early_result' | 'basis_change', resumeOff = false) =>
    renderWithQueries(
      <PauseDecisionFields
        pauseReason={pauseReason}
        path=""
        onPath={() => {}}
        pathError={null}
        review={resumeOff ? 'not_judgeable' : ''}
        onReview={() => {}}
        resumeOff={resumeOff}
        reason=""
        onReason={() => {}}
        reasonError={null}
        disabled={false}
      />,
    );

  it('asks the review result of a 실질 기준 변경 pause alone (Q1)', () => {
    const basis = fields('basis_change');
    expect(byTestId(basis, 'market-pause-request-review-judgeable')).toBeDefined();
    expect(byTestId(basis, 'market-pause-request-review-not_judgeable')).toBeDefined();
    expect(byTestId(basis, 'market-pause-request-pause-reason')?.text).toContain('실질 기준 변경');
    const early = fields('early_result');
    expect(byTestId(early, 'market-pause-request-review-judgeable')).toBeUndefined();
    expect(byTestId(early, 'market-pause-request-path-resume')).toBeDefined();
    expect(byTestId(early, 'market-pause-request-path-early_close')).toBeDefined();
    expect(byTestId(early, 'market-pause-request-reason')).toBeDefined();
  });

  it('turns 재개 off under 판정 불가 and says the judgement applies the VOID rule (#173 item 4)', () => {
    const html = fields('basis_change', true);
    expect(byTestId(html, 'market-pause-request-path-resume')?.attributes).toHaveProperty(
      'data-disabled',
    );
    expect(byTestId(html, 'market-pause-request-path-early_close')?.attributes).not.toHaveProperty(
      'data-disabled',
    );
    expect(byTestId(html, 'market-pause-request-early-close-only')?.text).toBe(
      copy.pauseReviewNotJudgeableHint,
    );
    expect(
      byTestId(fields('basis_change'), 'market-pause-request-early-close-only'),
    ).toBeUndefined();
    // Each choice is a radio of its group.
    expect(
      byTagName(html, 'input').filter((input) => input.attributes.type === 'radio').length,
    ).toBe(4);
  });
});
