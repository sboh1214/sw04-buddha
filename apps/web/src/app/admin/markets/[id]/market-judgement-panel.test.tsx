import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import {
  type AdminMarket,
  type AdminMarketJudgement,
  type AdminMarketPause,
  type MarketJudgementLogEntry,
  type MarketJudgementPending,
  type MarketRuleContent,
  type Me,
} from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { formatYesPrice } from '@/lib/market-admin';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { ApproveJudgementFields } from './market-judgement-dialogs';
import {
  JudgementPanelBody,
  JudgementRegisterForm,
  MarketJudgementPanel,
} from './market-judgement-panel';

const REGISTRANT = { id: 'registrant', nickname: '등록한이' };
const APPROVER = { id: 'approver', nickname: '승인한이' };
const THIRD = 'third';
const REQUEST_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SCHEDULED_JUDGEMENT_AT = '2026-12-01T01:00:00.000Z';
/** Before the scheduled judgement (12-01 01:00 UTC), and after it. */
const BEFORE_SCHEDULE = Date.parse('2026-11-30T00:00:00.000Z');
const AFTER_SCHEDULE = Date.parse('2026-12-02T00:00:00.000Z');

const RULES: MarketRuleContent = {
  title: '첫눈이 올까?',
  description: '배경',
  yesCondition: '관측되면 YES',
  noCondition: '11월 안에 관측되지 않으면 NO',
  eventDeadline: '2026-11-30T14:59:00.000Z',
  primarySource: { name: '기상청', url: 'https://www.weather.go.kr' },
  fallbackSources: [{ name: '통계청', url: 'https://kostat.go.kr' }],
  fallbackCondition: '기상청 발표가 없으면',
  longDelayDays: 14,
  delayHandling: '무효',
  scheduledOpenAt: '2026-11-01T00:00:00.000Z',
  closeAt: '2026-11-29T15:00:00.000Z',
  scheduledAnnouncementAt: null,
  scheduledJudgementAt: SCHEDULED_JUDGEMENT_AT,
  judgementTimeZone: 'Asia/Seoul',
};

/**
 * A CLOSED market, never judged — with a market price, a volume and counts, which no judgement
 * screen may show (#152 AC 8).
 */
const closed: AdminMarket = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  slug: 'first-snow',
  ...RULES,
  category: { slug: 'weather', nameKo: '날씨' },
  imageUrl: null,
  status: 'closed',
  judgementDelayed: false,
  disputeUnderReview: false,
  lastPrice: 63,
  volumeCoin: '123456',
  tradeCount: 789,
  traderCount: 321,
  openAt: '2026-11-01T00:00:00.000Z',
  resolvedResult: null,
  resolvedAt: null,
  settledAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-11-29T15:00:00.000Z',
  createdBy: 'creator',
  netCollectedCoin: '98765',
  openInterest: { yes: 4321, no: 8765 },
  settlementSteps: [],
  statusEventId: '3',
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
  ruleVersion: 2,
  ruleVersions: [],
  supplement: { pending: null, log: [] },
  pause: { history: [], pending: null, log: [] },
  judgementVersion: null,
  disputeDeadline: null,
  disputeOpen: false,
  disputes: { holding: 0, items: [] },
  judgement: { current: null, pending: null, log: [], disputeWindowUndecided: false },
};

const pending: MarketJudgementPending = {
  requestId: REQUEST_ID,
  result: 'NO',
  source: { priority: 1, name: '통계청', url: 'https://kostat.go.kr' },
  fallbackReason: '기상청 발표가 늦어졌습니다.',
  voidReason: null,
  evidence: {
    links: ['https://kostat.go.kr/a', 'https://kostat.go.kr/b'],
    collectedAt: '2026-11-30T01:00:00.000Z',
  },
  description: '11월 관측 기록이 없음을 확인했습니다.',
  ruleVersion: 2,
  requestedBy: REGISTRANT,
  requestedAt: '2026-11-30T02:00:00.000Z',
};

const pendingEntry: MarketJudgementLogEntry = {
  ...pending,
  status: 'pending',
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  retractedAt: null,
  version: null,
};

/** An earlier registration another admin rejected. */
const rejectedEntry: MarketJudgementLogEntry = {
  ...pending,
  requestId: 'a1b2c3d4-0000-4000-8000-000000000002',
  result: 'YES',
  source: { priority: 0, name: '기상청', url: 'https://www.weather.go.kr' },
  fallbackReason: null,
  requestedBy: APPROVER,
  requestedAt: '2026-11-30T00:30:00.000Z',
  status: 'rejected',
  decidedBy: REGISTRANT,
  decidedAt: '2026-11-30T01:30:00.000Z',
  decisionReason: '관측 기록과 다릅니다.',
  retractedAt: null,
  version: null,
};

const waiting: AdminMarket = {
  ...closed,
  judgement: { ...closed.judgement, pending, log: [pendingEntry, rejectedEntry] },
};

const current: AdminMarketJudgement = {
  version: 1,
  result: 'NO',
  source: pending.source,
  fallbackReason: pending.fallbackReason,
  voidReason: null,
  evidence: pending.evidence,
  description: pending.description,
  ruleVersion: 2,
  eventDeadlineConfirmed: true,
  disputeWindowMinutes: 1440,
  publishedAt: '2026-11-30T03:00:00.000Z',
  disputeDeadline: '2026-12-01T03:00:00.000Z',
  approvalId: REQUEST_ID,
  registeredBy: REGISTRANT,
  approvedBy: APPROVER,
};

const provisional: AdminMarket = {
  ...closed,
  status: 'provisional',
  resolvedResult: 'NO',
  judgementVersion: 1,
  disputeDeadline: current.disputeDeadline,
  judgement: {
    current,
    pending: null,
    log: [
      {
        ...pendingEntry,
        status: 'approved',
        decidedBy: APPROVER,
        decidedAt: current.publishedAt,
        decisionReason: '확인했습니다.',
        version: 1,
      },
      rejectedEntry,
    ],
    disputeWindowUndecided: false,
  },
};

const draw = (market: AdminMarket, operatorId: string | undefined, readAt = AFTER_SCHEDULE) =>
  renderWithQueries(
    <JudgementPanelBody
      market={market}
      readAt={readAt}
      operatorId={operatorId}
      onOpen={() => {}}
      registerForm={null}
    />,
  );

const isOff = (html: string, testId: string) => {
  const element = byTestId(html, testId);
  expect(element, testId).toBeDefined();
  return Object.hasOwn(element?.attributes ?? {}, 'disabled');
};

/**
 * No price, volume, count or holding of the market is drawn, nor its label (#152 AC 8: the
 * judgement follows the rule's source, never the market's majority).
 */
const expectNoMarketSignal = (html: string) => {
  for (const text of [
    copy.tradeStatsLastPrice,
    copy.tradeStatsNetCollected,
    copy.tradeStatsOpenInterestYes,
    copy.tradeStatsOpenInterestNo,
    copy.marketVolume,
    copy.marketTradeCount,
    copy.marketTraderCount,
    formatYesPrice(closed.lastPrice),
    '63%',
    '123456',
    '123,456',
    '98,765',
    '4321',
    '8765',
    '789',
    '321',
    'Coin',
  ]) {
    expect(html, text).not.toContain(text);
  }
};

/**
 * 판정 as drawn (#152, ADR-0103; ADR-0093 decision 1 #173 items 1·5·9, decision 3 the #152 rows),
 * per state and per admin on screen. What each write may send and what a refusal says are
 * lib/market-judgement.ts' (market-judgement.test.ts), which the API refuses again; the e2e
 * (judgement.spec.ts) drives the form and the dialogs.
 */
describe('JudgementPanelBody', () => {
  it('offers 판정 등록 on a closed market with none waiting, once the admin is known', () => {
    const html = draw(closed, THIRD);
    expect(byTestId(html, 'market-judgement')?.attributes['data-status']).toBe('closed');
    expect(byTestId(html, 'market-judgement-register')?.text).toBe(
      copy.adminMarketJudgementRegister,
    );
    expect(isOff(html, 'market-judgement-register')).toBe(false);
    expect(isOff(draw(closed, undefined), 'market-judgement-register')).toBe(true);
    expect(byTestId(html, 'market-judgement-pending')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-current')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-window-undecided')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-log-empty')?.text).toBe(
      copy.adminMarketJudgementLogEmpty,
    );
  });

  it('turns 판정 등록 off while the dispute window is undecided, and points to the settings', () => {
    const undecided: AdminMarket = {
      ...closed,
      judgement: { ...closed.judgement, disputeWindowUndecided: true },
    };
    const html = draw(undecided, THIRD);
    expect(byTestId(html, 'market-judgement-window-undecided')?.text).toContain(
      copy.adminMarketJudgementWindowUndecided,
    );
    expect(byTestId(html, 'market-judgement-window-undecided-link')?.attributes.href).toBe(
      '/admin/settings',
    );
    expect(isOff(html, 'market-judgement-register')).toBe(true);
    // A registration waiting then cannot be approved either; its 반려 still ends it.
    const stuck = draw(
      { ...undecided, judgement: { ...undecided.judgement, pending, log: [pendingEntry] } },
      THIRD,
    );
    expect(isOff(stuck, 'market-judgement-approve')).toBe(true);
    expect(isOff(stuck, 'market-judgement-reject')).toBe(false);
  });

  it('shows the waiting registration whole to another admin, with 승인 and 반려; one at a time', () => {
    const html = draw(waiting, THIRD);
    expect(byTestId(html, 'market-judgement-register')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-pending-by')?.text).toBe('등록한이');
    expect(byTestId(html, 'market-judgement-pending-at')?.text).toBe(
      formatKst(pending.requestedAt),
    );
    expect(byTestId(html, 'market-judgement-pending-result')?.text).toBe('NO');
    expect(byTestId(html, 'market-judgement-pending-source')?.text).toBe(
      '대체 출처 1 · 통계청 (https://kostat.go.kr)',
    );
    expect(byTestId(html, 'market-judgement-pending-fallback-reason')?.text).toBe(
      pending.fallbackReason,
    );
    expect(byTestId(html, 'market-judgement-pending-void-reason')).toBeUndefined();
    expect(
      byTagName(html, 'a')
        .filter((link) => link.attributes.href?.startsWith('https://kostat.go.kr/'))
        .map((link) => link.attributes.href),
    ).toEqual(pending.evidence.links);
    expect(byTestId(html, 'market-judgement-pending-collected-at')?.text).toBe(
      formatKst(pending.evidence.collectedAt),
    );
    expect(byTestId(html, 'market-judgement-pending-description')?.text).toBe(pending.description);
    expect(byTestId(html, 'market-judgement-pending-rule-version')?.text).toBe('v2');
    expect(isOff(html, 'market-judgement-approve')).toBe(false);
    expect(isOff(html, 'market-judgement-reject')).toBe(false);
    expect(byTestId(html, 'market-judgement-retract')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-requester-note')).toBeUndefined();
    // The admin who rejected an earlier registration decides this one like any other (Q11).
    expect(isOff(draw(waiting, APPROVER.id), 'market-judgement-approve')).toBe(false);
  });

  it('turns 승인 and 반려 off for the registrant with the note why, and offers 철회 alone', () => {
    const html = draw(waiting, REGISTRANT.id);
    expect(byTestId(html, 'market-judgement-requester-note')?.text).toContain(
      copy.adminMarketJudgementExcludedRequester,
    );
    expect(isOff(html, 'market-judgement-approve')).toBe(true);
    expect(isOff(html, 'market-judgement-reject')).toBe(true);
    expect(isOff(html, 'market-judgement-retract')).toBe(false);
    const unknown = draw(waiting, undefined);
    expect(isOff(unknown, 'market-judgement-approve')).toBe(true);
    expect(isOff(unknown, 'market-judgement-reject')).toBe(true);
    expect(byTestId(unknown, 'market-judgement-retract')).toBeUndefined();
  });

  it('warns before the scheduled judgement, with its time, and not after it (decision 3 등록 시점)', () => {
    const early = draw(waiting, THIRD, BEFORE_SCHEDULE);
    expect(byTestId(early, 'market-judgement-pending-early')?.text).toContain(
      copy.adminMarketJudgementEarly,
    );
    expect(byTestId(early, 'market-judgement-pending-early-at')?.text).toBe(
      formatKst(SCHEDULED_JUDGEMENT_AT),
    );
    // No server refusal of a NO before then: 승인 stays on, the dialog asks the confirmation.
    expect(isOff(early, 'market-judgement-approve')).toBe(false);
    expect(byTestId(draw(waiting, THIRD), 'market-judgement-pending-early')).toBeUndefined();
    // A market opened before #22 has no scheduled judgement: no warning.
    expect(
      byTestId(
        draw({ ...waiting, scheduledJudgementAt: null }, THIRD, BEFORE_SCHEDULE),
        'market-judgement-pending-early',
      ),
    ).toBeUndefined();
  });

  it('leaves a registration on a market no longer closed to its 반려 or 철회', () => {
    const moved: AdminMarket = { ...waiting, status: 'cancelled' };
    const html = draw(moved, THIRD);
    expect(byTestId(html, 'market-judgement-pending-status')?.text).toContain(
      copy.adminMarketJudgementPendingStatus,
    );
    expect(isOff(html, 'market-judgement-approve')).toBe(true);
    expect(isOff(html, 'market-judgement-reject')).toBe(false);
    expect(isOff(draw(moved, REGISTRANT.id), 'market-judgement-retract')).toBe(false);
    expect(byTestId(html, 'market-judgement-register')).toBeUndefined();
  });

  it('shows the 잠정 결과’s judgement with its dispute deadline, read-only (#173 item 5)', () => {
    const html = draw(provisional, THIRD);
    expect(byTestId(html, 'market-judgement')?.attributes['data-status']).toBe('provisional');
    expect(byTestId(html, 'market-judgement-register')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-pending')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-current-badge')?.text).toBe('NO');
    expect(byTestId(html, 'market-judgement-current-result')?.text).toBe('NO');
    expect(byTestId(html, 'market-judgement-current-deadline')?.text).toBe(
      formatKst(current.disputeDeadline),
    );
    expect(byTestId(html, 'market-judgement-current-deadline-note')?.text).toContain(
      copy.adminMarketJudgementProvisionalNote,
    );
    expect(byTestId(html, 'market-judgement-current-source')?.text).toContain('통계청');
    const rows = byTestId(html, 'market-judgement-current-rows')?.text ?? '';
    for (const text of ['v1', '등록한이', '승인한이', '1,440분', formatKst(current.publishedAt)]) {
      expect(rows, text).toContain(text);
    }
    expect(rows).toContain(copy.adminMarketJudgementDeadlineConfirmedDone);
    // Once confirmed, the record stays and the deadline note goes.
    const resolved = draw({ ...provisional, status: 'resolved' }, THIRD);
    expect(byTestId(resolved, 'market-judgement-current')).toBeDefined();
    expect(byTestId(resolved, 'market-judgement-current-deadline-note')).toBeUndefined();
  });

  it('lists every registration newest first with how it ended, never an account id', () => {
    const html = draw(provisional, THIRD);
    expect(
      testIdsStartingWith(html, 'market-judgement-log-').filter((id) => /-log-\d+$/.test(id)),
    ).toEqual(['market-judgement-log-0', 'market-judgement-log-1']);
    expect(byTestId(html, 'market-judgement-log-0')?.attributes['data-status']).toBe('approved');
    expect(byTestId(html, 'market-judgement-log-0-status')?.text).toBe('승인');
    expect(byTestId(html, 'market-judgement-log-0-rows')?.text).toContain('v1');
    expect(byTestId(html, 'market-judgement-log-1-status')?.text).toBe('반려');
    expect(byTestId(html, 'market-judgement-log-1-by')?.text).toBe('승인한이');
    expect(byTestId(html, 'market-judgement-log-1-rows')?.text).toContain('관측 기록과 다릅니다.');
    for (const id of [REGISTRANT.id, APPROVER.id]) {
      expect(byTestId(html, 'market-judgement')?.text).not.toContain(id);
    }
  });

  it('names each element once, so a selector finds one (the e2e drives these ids)', () => {
    const html = draw(
      { ...provisional, judgement: { ...provisional.judgement, pending } },
      REGISTRANT.id,
      BEFORE_SCHEDULE,
    );
    const ids = testIdsStartingWith(html, 'market-judgement');
    expect(ids.length).toBeGreaterThan(20);
    expect(ids.filter((id, at) => ids.indexOf(id) !== at)).toEqual([]);
  });

  it('draws no market price, volume or count in any state (#152 AC 8)', () => {
    for (const market of [closed, waiting, provisional]) {
      expectNoMarketSignal(draw(market, THIRD, BEFORE_SCHEDULE));
    }
  });

  it('draws the headings focus comes back to out of the tab order (WCAG 2.4.3)', () => {
    const targets = {
      title: createRef<HTMLParagraphElement>(),
      register: createRef<HTMLButtonElement>(),
      current: createRef<HTMLParagraphElement>(),
      pending: createRef<HTMLParagraphElement>(),
    };
    const html = renderWithQueries(
      <JudgementPanelBody
        market={{ ...provisional, judgement: { ...provisional.judgement, pending } }}
        readAt={AFTER_SCHEDULE}
        operatorId={THIRD}
        onOpen={() => {}}
        registerForm={null}
        targets={targets}
      />,
    );
    for (const id of [
      'market-judgement-title',
      'market-judgement-current-title',
      'market-judgement-pending-title',
    ]) {
      expect(byTestId(html, id)?.attributes.tabindex, id).toBe('-1');
    }
  });
});

describe('MarketJudgementPanel', () => {
  it('draws nothing before the close, nor for a market judged before #152', () => {
    for (const status of ['draft', 'review', 'scheduled', 'open', 'paused'] as const) {
      expect(
        renderWithQueries(
          <MarketJudgementPanel market={{ ...closed, status }} readAt={AFTER_SCHEDULE} />,
        ),
        status,
      ).toBe('');
    }
    // ADR-0046's one-admin 판정 left no judgement and no registration.
    expect(
      renderWithQueries(
        <MarketJudgementPanel
          market={{ ...closed, status: 'settled', resolvedResult: 'YES' }}
          readAt={AFTER_SCHEDULE}
        />,
      ),
    ).toBe('');
    expect(
      byTestId(
        renderWithQueries(<MarketJudgementPanel market={closed} readAt={AFTER_SCHEDULE} />),
        'market-judgement',
      ),
    ).toBeDefined();
  });
});

describe('JudgementRegisterForm', () => {
  const me = { id: THIRD } as Me;
  const drawn = (market: AdminMarket, admin: Me | null = me) =>
    renderWithQueries(
      <JudgementRegisterForm market={market} onClose={() => {}} />,
      admin === null ? [] : [[ME_QUERY_KEY, admin]],
    );
  /** After the scheduled judgement whatever the clock: no warning. */
  const late: AdminMarket = { ...closed, scheduledJudgementAt: '2000-01-01T00:00:00.000Z' };

  it('opens with the result, the rule’s sources, the links, the instant and the description', () => {
    const html = drawn(late);
    for (const result of ['yes', 'no', 'void']) {
      expect(byTestId(html, `market-judgement-result-${result}`), result).toBeDefined();
      expect(
        byTestId(html, `market-judgement-result-${result}`)?.attributes,
        result,
      ).not.toHaveProperty('data-disabled');
    }
    expect(byTestId(html, 'market-judgement-source-0')?.text).toContain('1차 출처 · 기상청');
    expect(byTestId(html, 'market-judgement-source-0')?.text).toContain(
      'https://www.weather.go.kr',
    );
    expect(byTestId(html, 'market-judgement-source-1')?.text).toContain('대체 출처 1 · 통계청');
    // 규칙의 출처 없음 is a VOID's alone: not offered until 무효 is picked.
    expect(byTestId(html, 'market-judgement-source-none')).toBeUndefined();
    // The reasons appear with what asks for them.
    expect(byTestId(html, 'market-judgement-fallback-reason')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-void-reason')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-link-0')?.attributes.type).toBe('url');
    expect(byTestId(html, 'market-judgement-link-0-remove')).toBeUndefined();
    expect(isOff(html, 'market-judgement-link-add')).toBe(false);
    expect(byTestId(html, 'market-judgement-collected-at')?.attributes.type).toBe('datetime-local');
    expect(html).toContain(copy.adminMarketJudgementCollectedAtHint);
    expect(byTestId(html, 'market-judgement-description')).toBeDefined();
    expect(isOff(html, 'market-judgement-submit')).toBe(false);
    expect(byTestId(html, 'market-judgement-form-early')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-form-void-only')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-form-unavailable')).toBeUndefined();
    // Focus goes into the form as it opens, at its heading (out of the tab order).
    expect(byTestId(html, 'market-judgement-form-title')?.attributes.tabindex).toBe('-1');
  });

  it('warns before the scheduled judgement, with its time', () => {
    const html = drawn({ ...closed, scheduledJudgementAt: '2999-01-01T00:00:00.000Z' });
    expect(byTestId(html, 'market-judgement-form-early')?.text).toContain(
      copy.adminMarketJudgementEarly,
    );
    expect(isOff(html, 'market-judgement-submit')).toBe(false);
  });

  it('takes 무효 alone after an early close reviewed 판정 불가, and says why (ADR-0102)', () => {
    const earlyClosed: AdminMarketPause = {
      id: 'p1',
      reason: 'basis_change',
      note: '규칙이 사건을 담지 못합니다.',
      resultPublishedAt: null,
      pausedAt: '2026-11-20T00:00:00.000Z',
      pausedBy: APPROVER,
      reviewResult: 'not_judgeable',
      endKind: 'early_closed',
      endedAt: '2026-11-21T00:00:00.000Z',
      endedBy: REGISTRANT,
    };
    const html = drawn({ ...late, pause: { history: [earlyClosed], pending: null, log: [] } });
    expect(byTestId(html, 'market-judgement-form-void-only')?.text).toContain(
      copy.adminMarketJudgementVoidOnly,
    );
    expect(byTestId(html, 'market-judgement-form-void-only')?.text).toContain('판정 불가');
    expect(byTestId(html, 'market-judgement-result-yes')?.attributes).toHaveProperty(
      'data-disabled',
    );
    expect(byTestId(html, 'market-judgement-result-no')?.attributes).toHaveProperty(
      'data-disabled',
    );
    // 무효 preselected: its reason and 규칙의 출처 없음 are there from the first draw.
    expect(byTestId(html, 'market-judgement-result-void')?.attributes).toHaveProperty(
      'data-state',
      'checked',
    );
    expect(byTestId(html, 'market-judgement-source-none')).toBeDefined();
    expect(byTestId(html, 'market-judgement-void-reason')).toBeDefined();
  });

  it('says a market with no rule source is judged 무효 alone', () => {
    const html = drawn({ ...late, primarySource: null, fallbackSources: [] });
    expect(byTestId(html, 'market-judgement-no-sources')?.text).toBe(
      copy.adminMarketJudgementNoSources,
    );
    expect(testIdsStartingWith(html, 'market-judgement-source-')).not.toContain(
      'market-judgement-source-0',
    );
  });

  it.each([
    ['pending', waiting],
    ['status', { ...late, status: 'provisional' as const }],
    ['undecided', { ...late, judgement: { ...late.judgement, disputeWindowUndecided: true } }],
  ] as const)(
    'stays once the market takes no registration, says why and sends nothing: %s',
    (reason, market) => {
      const html = drawn(market);
      expect(byTestId(html, 'market-judgement-form-unavailable')?.attributes['data-reason']).toBe(
        reason,
      );
      expect(isOff(html, 'market-judgement-submit')).toBe(true);
      // 취소 closes it; what was typed stays until then.
      expect(isOff(html, 'market-judgement-cancel')).toBe(false);
      // An undecided window says where it is decided.
      expect(byTestId(html, 'market-judgement-form-settings-link')?.attributes.href).toBe(
        reason === 'undecided' ? '/admin/settings' : undefined,
      );
    },
  );

  it('holds every field off until the admin on screen is known', () => {
    const html = drawn(late, null);
    expect(byTagName(html, 'fieldset')[0]?.attributes).toHaveProperty('disabled');
    expect(isOff(html, 'market-judgement-submit')).toBe(true);
  });

  it('draws no market price, volume or count (#152 AC 8)', () => {
    expectNoMarketSignal(drawn({ ...closed, scheduledJudgementAt: '2999-01-01T00:00:00.000Z' }));
  });
});

describe('ApproveJudgementFields', () => {
  const fields = (asked: boolean, confirmError: string | null = null) =>
    renderWithQueries(
      <ApproveJudgementFields
        asked={asked}
        noCondition={closed.noCondition}
        eventDeadline={closed.eventDeadline}
        confirmed={false}
        onConfirmed={() => {}}
        confirmError={confirmError}
        reason=""
        onReason={() => {}}
        reasonError={null}
        disabled={false}
      />,
    );

  it('asks the event deadline’s confirmation before the scheduled judgement, with the NO condition', () => {
    const html = fields(true);
    expect(byTestId(html, 'market-judgement-approve-no-condition')?.text).toBe(closed.noCondition);
    expect(byTestId(html, 'market-judgement-approve-event-deadline')?.text).toBe(
      formatKst(closed.eventDeadline ?? ''),
    );
    expect(byTestId(html, 'market-judgement-approve-confirm-deadline')?.text).toContain(
      copy.adminMarketJudgementConfirmDeadline,
    );
    expect(byTestId(html, 'market-judgement-approve-reason')).toBeDefined();
    expect(
      byTestId(
        fields(true, copy.errMarketJudgementDeadlineConfirm),
        'market-judgement-approve-confirm-deadline-error',
      )?.text,
    ).toBe(copy.errMarketJudgementDeadlineConfirm);
    // After it, the reason alone.
    const late = fields(false);
    expect(byTestId(late, 'market-judgement-approve-deadline')).toBeUndefined();
    expect(byTestId(late, 'market-judgement-approve-reason')).toBeDefined();
  });

  it('draws no market price, volume or count (#152 AC 8)', () => {
    expectNoMarketSignal(fields(true));
  });
});
