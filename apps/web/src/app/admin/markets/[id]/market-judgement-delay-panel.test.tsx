import { readFileSync } from 'node:fs';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import {
  type AdminJudgementDelay,
  type AdminMarket,
  type AdminMarketJudgement,
  type MarketJudgementPending,
  type Me,
} from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { JudgementDelayFields } from './market-judgement-delay-dialogs';
import {
  JudgementDelaysBody,
  JudgementLongDelay,
  MarketJudgementDelays,
} from './market-judgement-delay-panel';
import { JudgementPanelBody } from './market-judgement-panel';

const RECORDER = { id: 'recorder', nickname: '기록한이' };
const OTHER = { id: 'other', nickname: '다른이' };
const OPERATOR = 'operator';
const SCHEDULED_JUDGEMENT_AT = '2026-12-01T01:00:00.000Z';
const DAY_MS = 86_400_000;
/** Before the scheduled judgement (12-01 01:00 UTC), after it, and past the 14-day long delay. */
const BEFORE_SCHEDULE = Date.parse('2026-11-30T00:00:00.000Z');
const AFTER_SCHEDULE = Date.parse('2026-12-01T02:00:00.000Z');
const PAST_LONG_DELAY = Date.parse(SCHEDULED_JUDGEMENT_AT) + 14 * DAY_MS;

/** A CLOSED market, never judged, past nothing on the server's read (`judgementDelayed` false). */
const closed: AdminMarket = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  slug: 'first-snow',
  title: '첫눈이 올까?',
  description: '배경',
  yesCondition: '관측되면 YES',
  noCondition: '11월 안에 관측되지 않으면 NO',
  eventDeadline: '2026-11-30T14:59:00.000Z',
  primarySource: { name: '기상청', url: 'https://www.weather.go.kr' },
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: 14,
  delayHandling: '장기 지연 기한까지 발표가 없으면 무효로 판정합니다.',
  scheduledOpenAt: '2026-11-01T00:00:00.000Z',
  closeAt: '2026-11-29T15:00:00.000Z',
  scheduledAnnouncementAt: null,
  scheduledJudgementAt: SCHEDULED_JUDGEMENT_AT,
  judgementTimeZone: 'Asia/Seoul',
  category: { slug: 'weather', nameKo: '날씨' },
  imageUrl: null,
  status: 'closed',
  judgementDelayed: false,
  disputeUnderReview: false,
  lastPrice: 63,
  lastFillAt: '2026-09-07T00:00:00.000Z',
  lastPrice24hAgo: null,
  volumeCoin: '123456',
  tradeCount: 789,
  traderCount: 321,
  statsRevision: '789',
  openAt: '2026-11-01T00:00:00.000Z',
  resolvedResult: null,
  resolvedAt: null,
  settledAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-11-29T15:00:00.000Z',
  createdBy: 'creator',
  openInterest: { yes: 4321, no: 8765 },
  settlementSteps: [],
  statusEventId: '3',
  events: [],
  tags: ['날씨'],
  missingOpenItems: [],
  leadCloseGapMinutes: 60,
  priceProtectionTicks: 5,
  liquidity: { current: null, openedVersion: null, history: [] },
  review: {
    pending: null,
    createdBy: { id: 'creator', nickname: '만든이' },
    editors: [],
    sameCondition: [],
    log: [],
  },
  ruleVersion: 2,
  judgingRecord: {
    versions: [],
    pauses: [],
    delays: [],
    disputes: { total: 0, byVersion: [], decisions: [] },
    cancellation: null,
    payoutDelayed: false,
  },
  ruleVersions: [],
  supplement: { pending: null, log: [] },
  pause: { history: [], pending: null, log: [] },
  cancel: { pending: null, log: [] },
  judgementVersion: null,
  disputeDeadline: null,
  disputeOpen: false,
  disputes: { holding: 0, items: [] },
  judgementDelay: null,
  judgementDelays: [],
  judgement: { current: null, history: [], pending: null, log: [], disputeWindowUndecided: false },
};

/** The first record, on the CLOSED market, its next review time a day after the judgement time. */
const first: AdminJudgementDelay = {
  id: 'a1b2c3d4-0000-4000-8000-0000000000d1',
  reason: '출처의 발표가 늦어지고 있습니다.',
  nextReviewAt: '2026-12-02T01:00:00.000Z',
  marketStatus: 'closed',
  judgementVersion: null,
  recordedAt: '2026-12-01T01:30:00.000Z',
  recordedBy: RECORDER,
  current: true,
};
/** A second record, newer: it is current, the first one history. */
const second: AdminJudgementDelay = {
  ...first,
  id: 'a1b2c3d4-0000-4000-8000-0000000000d2',
  reason: '출처가 다음 주 발표를 예고했습니다.',
  nextReviewAt: '2026-12-08T01:00:00.000Z',
  recordedAt: '2026-12-02T02:00:00.000Z',
  recordedBy: OTHER,
};

/** The CLOSED market delayed on the server's read, with one record. */
const recorded: AdminMarket = {
  ...closed,
  judgementDelayed: true,
  judgementDelay: {
    reason: first.reason,
    nextReviewAt: first.nextReviewAt,
    nextReviewPassed: false,
  },
  judgementDelays: [first],
};

/** The same market recorded again: two records, newest first. */
const recordedTwice: AdminMarket = {
  ...recorded,
  judgementDelay: {
    reason: second.reason,
    nextReviewAt: second.nextReviewAt,
    nextReviewPassed: false,
  },
  judgementDelays: [second, { ...first, current: false }],
};

/** A first judgement the admin on screen registered, waiting for another admin's approval. */
const registration: MarketJudgementPending = {
  requestId: 'a1b2c3d4-0000-4000-8000-0000000000e1',
  result: 'NO',
  source: { priority: 0, name: '기상청', url: 'https://www.weather.go.kr' },
  fallbackReason: null,
  voidReason: null,
  evidence: { links: ['https://www.weather.go.kr/a'], collectedAt: '2026-12-01T01:10:00.000Z' },
  description: '11월 관측 기록이 없음을 확인했습니다.',
  ruleVersion: 2,
  correction: null,
  requestedBy: { id: OPERATOR, nickname: '등록한이' },
  requestedAt: '2026-12-01T01:20:00.000Z',
};

/** That registration approved by another admin: v1, its 이의 기한 12-03 01:00 UTC. */
const v1: AdminMarketJudgement = {
  version: 1,
  result: registration.result,
  source: registration.source,
  fallbackReason: null,
  voidReason: null,
  evidence: registration.evidence,
  description: registration.description,
  ruleVersion: 2,
  correctionReason: null,
  eventDeadlineConfirmed: true,
  disputeWindowMinutes: 1440,
  publishedAt: '2026-12-02T01:00:00.000Z',
  disputeDeadline: '2026-12-03T01:00:00.000Z',
  approvalId: registration.requestId,
  registeredBy: registration.requestedBy,
  approvedBy: OTHER,
};

/** A 잠정 결과 v1, past its 이의 기한 on the 12-04 read. */
const provisional: AdminMarket = {
  ...closed,
  status: 'provisional',
  resolvedResult: 'NO',
  judgementVersion: 1,
  disputeDeadline: v1.disputeDeadline,
  judgement: { ...closed.judgement, current: v1 },
};
const PAST_DEADLINE = Date.parse('2026-12-04T00:00:00.000Z');

/**
 * The same 잠정 결과 held past its deadline by nothing but a correction of v1 the admin on screen
 * registered (#176): it reads 판정 지연 (#173 item 7).
 */
const correcting: AdminMarket = {
  ...provisional,
  judgement: {
    ...provisional.judgement,
    pending: {
      ...registration,
      requestId: 'a1b2c3d4-0000-4000-8000-0000000000e2',
      result: 'YES',
      description: '기상청이 관측 기록을 정정했습니다.',
      correction: { baseVersion: 1, reason: '출처가 정정 발표를 냈습니다.', disputeIds: [] },
    },
  },
};

const draw = (market: AdminMarket, operatorId: string | undefined, readAt = AFTER_SCHEDULE) =>
  renderWithQueries(
    <JudgementDelaysBody
      market={market}
      readAt={readAt}
      operatorId={operatorId}
      onOpen={() => {}}
    />,
  );

const isOff = (html: string, testId: string) => {
  const element = byTestId(html, testId);
  expect(element, testId).toBeDefined();
  return Object.hasOwn(element?.attributes ?? {}, 'disabled');
};

/**
 * 판정 지연 기록 as the 판정 panel draws it (#142, ADR-0106; ADR-0093 decision 1 #173 items 2·7·11·13,
 * decision 3 '#142 지연 사유', the owner's answers of 2026-11-03 (1)–(4)), per state and per admin
 * on screen. What the record may send and what a refusal says are lib/market-judgement-delay.ts'
 * (market-judgement-delay.test.ts), which the API refuses again; the e2e (delay.spec.ts) drives the
 * dialog and watches the timers come.
 */
describe('JudgementDelaysBody', () => {
  it('offers 지연 기록 등록 to any admin once the market reads 판정 지연, with no record yet', () => {
    const html = draw(closed, OPERATOR);
    expect(byTestId(html, 'market-judgement-delays')?.attributes['data-delayed']).toBe('true');
    expect(byTestId(html, 'market-judgement-delays-title')?.text).toBe(
      copy.adminMarketJudgementDelays,
    );
    expect(byTestId(html, 'market-judgement-delay-record')?.text).toBe(
      copy.adminMarketJudgementDelayRecord,
    );
    expect(isOff(html, 'market-judgement-delay-record')).toBe(false);
    expect(byTestId(html, 'market-judgement-delay-unavailable')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-delay-current')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-delay-history-empty')?.text).toBe(
      copy.adminMarketJudgementDelayHistoryEmpty,
    );
    // Off until the admin on screen is known.
    expect(isOff(draw(closed, undefined), 'market-judgement-delay-record')).toBe(true);
  });

  it('offers it to the registrant of a waiting judgement or correction too (#173 item 2)', () => {
    // A first judgement the admin on screen registered: no approval, so no registrant rule.
    const waiting = draw(
      { ...closed, judgement: { ...closed.judgement, pending: registration } },
      OPERATOR,
    );
    expect(isOff(waiting, 'market-judgement-delay-record')).toBe(false);
    expect(byTestId(waiting, 'market-judgement-delay-unavailable')).toBeUndefined();
    // A correction the admin on screen registered, the one thing holding a 잠정 결과 past its
    // deadline: the market reads 판정 지연 and its registrant records the delay.
    const held = draw(correcting, OPERATOR, PAST_DEADLINE);
    expect(byTestId(held, 'market-judgement-delays')?.attributes['data-delayed']).toBe('true');
    expect(isOff(held, 'market-judgement-delay-record')).toBe(false);
    expect(byTestId(held, 'market-judgement-delay-unavailable')).toBeUndefined();
  });

  it('turns it off with the note why before the market reads 판정 지연', () => {
    const early = draw(closed, OPERATOR, BEFORE_SCHEDULE);
    expect(isOff(early, 'market-judgement-delay-record')).toBe(true);
    expect(byTestId(early, 'market-judgement-delay-unavailable')?.attributes['data-reason']).toBe(
      'early',
    );
    expect(byTestId(early, 'market-judgement-delay-unavailable')?.text).toBe(
      copy.adminMarketJudgementDelayEarly,
    );
    // The server's flag at the read wins over a screen's clock running behind.
    expect(
      isOff(
        draw({ ...closed, judgementDelayed: true }, OPERATOR, BEFORE_SCHEDULE),
        'market-judgement-delay-record',
      ),
    ).toBe(false);
    // A market opened before #22 never reads 판정 지연.
    const unscheduled = draw({ ...closed, scheduledJudgementAt: null }, OPERATOR);
    expect(
      byTestId(unscheduled, 'market-judgement-delay-unavailable')?.attributes['data-reason'],
    ).toBe('unscheduled');
    // A 잠정 결과 before its deadline, or held by nothing.
    const unheld = draw(provisional, OPERATOR, PAST_DEADLINE);
    expect(byTestId(unheld, 'market-judgement-delay-unavailable')?.attributes['data-reason']).toBe(
      'unheld',
    );
    expect(isOff(unheld, 'market-judgement-delay-record')).toBe(true);
    // Held by a dispute past its deadline: on.
    const held = draw(
      { ...provisional, disputes: { holding: 1, items: [] } },
      OPERATOR,
      PAST_DEADLINE,
    );
    expect(isOff(held, 'market-judgement-delay-record')).toBe(false);
  });

  it('shows the current record — reason, next review time, who and when — and no late warning', () => {
    const html = draw(recorded, OPERATOR);
    expect(byTestId(html, 'market-judgement-delay-current-reason')?.text).toBe(first.reason);
    expect(byTestId(html, 'market-judgement-delay-current-next-review')?.text).toBe(
      formatKst(first.nextReviewAt),
    );
    expect(byTestId(html, 'market-judgement-delay-current-by')?.text).toBe('기록한이');
    expect(byTestId(html, 'market-judgement-delay-current-at')?.text).toBe(
      formatKst(first.recordedAt),
    );
    expect(byTestId(html, 'market-judgement-delay-current')?.attributes['data-late']).toBe('false');
    expect(byTestId(html, 'market-judgement-delay-current-passed')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-delay-late')).toBeUndefined();
    // A change is a new record: 지연 기록 등록 stays on (no edit, no withdrawal, owner answer (4)).
    expect(isOff(html, 'market-judgement-delay-record')).toBe(false);
    expect(html).not.toContain('수정');
  });

  it('warns that the update is late once the next review time has passed, still no result', () => {
    // On the screen's clock from the read…
    const late = draw(recorded, OPERATOR, Date.parse(first.nextReviewAt));
    expect(byTestId(late, 'market-judgement-delay-late')?.text).toBe(
      copy.adminMarketJudgementDelayLate,
    );
    expect(byTestId(late, 'market-judgement-delay-current')?.attributes['data-late']).toBe('true');
    expect(byTestId(late, 'market-judgement-delay-current-passed')?.text).toBe(
      copy.adminMarketJudgementDelayPassed,
    );
    // …or the server's own flag at the read.
    const flagged = draw(
      { ...recorded, judgementDelay: { ...recorded.judgementDelay!, nextReviewPassed: true } },
      OPERATOR,
    );
    expect(byTestId(flagged, 'market-judgement-delay-late')).toBeDefined();
    // Not a minute before it, and not for a market no longer reading 판정 지연.
    expect(
      byTestId(
        draw(recorded, OPERATOR, Date.parse(first.nextReviewAt) - 1),
        'market-judgement-delay-late',
      ),
    ).toBeUndefined();
    expect(
      byTestId(
        draw(
          { ...recorded, status: 'resolved', judgementDelayed: false },
          OPERATOR,
          PAST_LONG_DELAY,
        ),
        'market-judgement-delay-late',
      ),
    ).toBeUndefined();
  });

  it('says the version now has no record while the market reads 판정 지연 with history alone', () => {
    // A CLOSED-era record, history once v1 was approved; v1 held past its deadline by a dispute.
    const history = [{ ...first, current: false }];
    const heldAfter: AdminMarket = {
      ...provisional,
      disputes: { holding: 1, items: [] },
      judgementDelays: history,
    };
    const html = draw(heldAfter, OPERATOR, PAST_DEADLINE);
    expect(byTestId(html, 'market-judgement-delay-none-current')?.text).toBe(
      copy.adminMarketJudgementDelayNoCurrent,
    );
    expect(byTestId(html, 'market-judgement-delay-current')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-delay-late')).toBeUndefined();
    expect(isOff(html, 'market-judgement-delay-record')).toBe(false);
    expect(byTestId(html, 'market-judgement-delay-history-0')?.attributes['data-current']).toBe(
      'false',
    );
    // Not while the market does not read 판정 지연: before the deadline, unheld, or confirmed.
    const undelayed: [AdminMarket, number][] = [
      [heldAfter, Date.parse('2026-12-02T00:00:00.000Z')],
      [{ ...heldAfter, disputes: { holding: 0, items: [] } }, PAST_DEADLINE],
      [{ ...heldAfter, status: 'resolved' }, PAST_DEADLINE],
    ];
    for (const [market, readAt] of undelayed) {
      expect(
        byTestId(draw(market, OPERATOR, readAt), 'market-judgement-delay-none-current'),
      ).toBeUndefined();
    }
    // Not with a current record, nor with no record at all.
    expect(
      byTestId(draw(recorded, OPERATOR), 'market-judgement-delay-none-current'),
    ).toBeUndefined();
    expect(
      byTestId(draw(recordedTwice, OPERATOR), 'market-judgement-delay-none-current'),
    ).toBeUndefined();
    expect(byTestId(draw(closed, OPERATOR), 'market-judgement-delay-none-current')).toBeUndefined();
    expect(
      byTestId(
        draw({ ...heldAfter, judgementDelays: [] }, OPERATOR, PAST_DEADLINE),
        'market-judgement-delay-none-current',
      ),
    ).toBeUndefined();
  });

  it('lists every record newest first, the status it was made on, the current one marked', () => {
    const html = draw(recordedTwice, OPERATOR);
    expect(
      testIdsStartingWith(html, 'market-judgement-delay-history-').filter((id) =>
        /-history-\d+$/.test(id),
      ),
    ).toEqual(['market-judgement-delay-history-0', 'market-judgement-delay-history-1']);
    expect(byTestId(html, 'market-judgement-delay-history-0')?.attributes['data-current']).toBe(
      'true',
    );
    expect(byTestId(html, 'market-judgement-delay-history-0-current')?.text).toBe(
      copy.adminMarketJudgementDelayCurrentBadge,
    );
    expect(byTestId(html, 'market-judgement-delay-history-0-by')?.text).toBe('다른이');
    expect(byTestId(html, 'market-judgement-delay-history-0-rows')?.text).toContain(second.reason);
    expect(byTestId(html, 'market-judgement-delay-history-1')?.attributes['data-current']).toBe(
      'false',
    );
    expect(byTestId(html, 'market-judgement-delay-history-1-current')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-delay-history-1-episode')?.text).toBe('거래 마감');
    expect(byTestId(html, 'market-judgement-delay-history-1-rows')?.text).toContain(
      formatKst(first.nextReviewAt),
    );
    // The current record is the newest's; who recorded each is a nickname, never an account id.
    expect(byTestId(html, 'market-judgement-delay-current-reason')?.text).toBe(second.reason);
    for (const id of [RECORDER.id, OTHER.id]) {
      expect(byTestId(html, 'market-judgement-delays')?.text).not.toContain(id);
    }
  });

  it('keeps the history once the market moved on, read-only, a 잠정 결과’s with its version', () => {
    const judged: AdminMarket = {
      ...recordedTwice,
      status: 'resolved',
      judgementDelayed: false,
      judgementDelay: null,
      judgementDelays: [
        {
          ...first,
          id: 'a1b2c3d4-0000-4000-8000-0000000000d3',
          marketStatus: 'provisional',
          judgementVersion: 1,
          current: false,
        },
        { ...second, current: false },
      ],
    };
    const html = draw(judged, OPERATOR);
    expect(byTestId(html, 'market-judgement-delay-record')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-delay-unavailable')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-delay-current')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-delay-history-0-episode')?.text).toBe('잠정 결과 v1');
    expect(byTestId(html, 'market-judgement-delay-history-0')?.attributes['data-status']).toBe(
      'provisional',
    );
  });

  it('draws the headings focus comes back to out of the tab order (WCAG 2.4.3)', () => {
    const targets = {
      title: createRef<HTMLParagraphElement>(),
      current: createRef<HTMLParagraphElement>(),
    };
    const html = renderWithQueries(
      <JudgementDelaysBody
        market={recorded}
        readAt={AFTER_SCHEDULE}
        operatorId={OPERATOR}
        onOpen={() => {}}
        targets={targets}
      />,
    );
    for (const id of ['market-judgement-delays-title', 'market-judgement-delay-current-title']) {
      expect(byTestId(html, id)?.attributes.tabindex, id).toBe('-1');
    }
  });
});

describe('JudgementLongDelay (owner answer 2026-11-03 (3))', () => {
  const warn = (market: AdminMarket, readAt: number) =>
    renderWithQueries(<JudgementLongDelay market={market} readAt={readAt} />);

  it('warns a CLOSED market past its 장기 지연 기한 to apply the rule through 판정 등록', () => {
    const html = warn(closed, PAST_LONG_DELAY);
    expect(byTestId(html, 'market-judgement-long-delay')?.text).toContain(
      copy.adminMarketJudgementLongDelay,
    );
    expect(byTestId(html, 'market-judgement-long-delay-deadline')?.text).toBe(
      formatKst(new Date(PAST_LONG_DELAY).toISOString()),
    );
    expect(byTestId(html, 'market-judgement-long-delay-handling')?.text).toBe(closed.delayHandling);
    // Records change nothing of it.
    expect(
      byTestId(warn(recordedTwice, PAST_LONG_DELAY), 'market-judgement-long-delay'),
    ).toBeDefined();
  });

  it('says nothing before the deadline, on any other status, or with no deadline', () => {
    expect(warn(closed, PAST_LONG_DELAY - 1)).toBe('');
    expect(warn({ ...closed, status: 'provisional' }, PAST_LONG_DELAY)).toBe('');
    expect(warn({ ...closed, longDelayDays: null }, PAST_LONG_DELAY)).toBe('');
    expect(warn({ ...closed, scheduledJudgementAt: null }, PAST_LONG_DELAY)).toBe('');
  });

  it('sits at the top of the 판정 panel, above 판정 등록 it points to', () => {
    const html = renderWithQueries(
      <JudgementPanelBody
        market={closed}
        readAt={PAST_LONG_DELAY}
        operatorId={OPERATOR}
        onOpen={() => {}}
        registerForm={null}
      />,
    );
    expect(html.indexOf('market-judgement-long-delay')).toBeGreaterThan(-1);
    expect(html.indexOf('market-judgement-long-delay')).toBeLessThan(
      html.indexOf('market-judgement-register'),
    );
  });
});

describe('MarketJudgementDelays', () => {
  const me = { id: OPERATOR } as Me;

  it('draws on CLOSED and PROVISIONAL and wherever records are, nothing otherwise', () => {
    const drawn = (market: AdminMarket) =>
      renderWithQueries(<MarketJudgementDelays market={market} readAt={AFTER_SCHEDULE} />, [
        [ME_QUERY_KEY, me],
      ]);
    expect(byTestId(drawn(closed), 'market-judgement-delays')).toBeDefined();
    expect(
      byTestId(drawn({ ...closed, status: 'provisional' }), 'market-judgement-delays'),
    ).toBeDefined();
    expect(drawn({ ...closed, status: 'resolved' })).toBe('');
    expect(
      byTestId(drawn({ ...recorded, status: 'settled' }), 'market-judgement-delay-history-0'),
    ).toBeDefined();
    // No dialog until the button opens it.
    expect(byTestId(drawn(recorded), 'market-judgement-delay-dialog')).toBeUndefined();
  });

  it('offers 지연 기록 등록 to the admin on screen who registered the waiting judgement', () => {
    // In the whole 판정 panel: the registrant may not decide the registration (승인·반려 off, 철회
    // on), and records a delay all the same (#173 item 2: no approval, any admin).
    const waiting: [AdminMarket, number][] = [
      [{ ...closed, judgement: { ...closed.judgement, pending: registration } }, AFTER_SCHEDULE],
      [correcting, PAST_DEADLINE],
    ];
    for (const [market, readAt] of waiting) {
      const html = renderWithQueries(
        <JudgementPanelBody
          market={market}
          readAt={readAt}
          operatorId={OPERATOR}
          onOpen={() => {}}
          registerForm={null}
          delays={<MarketJudgementDelays market={market} readAt={readAt} />}
        />,
        [[ME_QUERY_KEY, me]],
      );
      expect(byTestId(html, 'market-judgement-requester-note'), market.status).toBeDefined();
      expect(isOff(html, 'market-judgement-approve'), market.status).toBe(true);
      expect(isOff(html, 'market-judgement-retract'), market.status).toBe(false);
      expect(isOff(html, 'market-judgement-delay-record'), market.status).toBe(false);
    }
  });

  it('names each element once inside the 판정 panel, so a selector finds one (e2e drives these)', () => {
    const late: AdminMarket = { ...recordedTwice, scheduledJudgementAt: SCHEDULED_JUDGEMENT_AT };
    const html = renderWithQueries(
      <JudgementPanelBody
        market={late}
        readAt={PAST_LONG_DELAY}
        operatorId={OPERATOR}
        onOpen={() => {}}
        registerForm={null}
        delays={<MarketJudgementDelays market={late} readAt={PAST_LONG_DELAY} />}
      />,
      [[ME_QUERY_KEY, me]],
    );
    const ids = testIdsStartingWith(html, 'market-judgement');
    expect(ids).toContain('market-judgement-long-delay');
    expect(ids).toContain('market-judgement-delay-late');
    expect(ids).toContain('market-judgement-delay-history-1-rows');
    expect(ids.filter((id, at) => ids.indexOf(id) !== at)).toEqual([]);
    // A held 잠정 결과 whose record is the CLOSED era's: the note in the current record's place.
    const heldAfter: AdminMarket = {
      ...provisional,
      disputes: { holding: 1, items: [] },
      judgementDelays: [{ ...first, current: false }],
    };
    const held = testIdsStartingWith(
      renderWithQueries(
        <JudgementPanelBody
          market={heldAfter}
          readAt={PAST_DEADLINE}
          operatorId={OPERATOR}
          onOpen={() => {}}
          registerForm={null}
          delays={<MarketJudgementDelays market={heldAfter} readAt={PAST_DEADLINE} />}
        />,
        [[ME_QUERY_KEY, me]],
      ),
      'market-judgement',
    );
    expect(held).toContain('market-judgement-delay-none-current');
    expect(held.filter((id, at) => held.indexOf(id) !== at)).toEqual([]);
  });

  /** The section's and its dialog's source: focus and the timers are no static render's. */
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

  it('waits for each instant with a one-shot timer, and focuses the new current record', () => {
    const panel = source('./market-judgement-delay-panel.tsx');
    // The instants a CLOSED market's detail is not read again at.
    expect(panel).toContain('useClockPast(readAt, judgementDelayStartsAt(market))');
    expect(panel).toContain('useClockPast(readAt, current?.nextReviewAt ?? null)');
    expect(panel).toContain('const now = useClockPast(readAt, deadline);');
    expect(panel).toContain('const wait = judgementDelayInstantWait(at, Date.now()) ?? 0;');
    // Focus once the market the record answered is drawn.
    expect(panel).toContain('(current.current ?? title.current)?.focus();');
    // The dialog draws again at the time's next bound.
    const dialog = source('./market-judgement-delay-dialogs.tsx');
    expect(dialog).toContain('const wait = judgementDelayDraftWait(nextLocal, Date.now()) ?? 0;');
  });
});

describe('JudgementDelayFields', () => {
  const fields = (current: AdminJudgementDelay | null, nextReviewError: string | null = null) =>
    renderWithQueries(
      <JudgementDelayFields
        current={current}
        reason={current?.reason ?? ''}
        onReason={() => {}}
        reasonError={null}
        nextLocal=""
        onNextLocal={() => {}}
        nextReviewError={nextReviewError}
        disabled={false}
      />,
    );

  it('shows the record it replaces as current, the reason prefilled, the time in KST', () => {
    const html = fields(first);
    expect(byTestId(html, 'market-judgement-delay-dialog-current')?.text).toContain(first.reason);
    expect(byTestId(html, 'market-judgement-delay-dialog-current')?.text).toContain(
      formatKst(first.nextReviewAt),
    );
    expect(byTestId(html, 'market-judgement-delay-reason')?.text).toBe(first.reason);
    expect(byTestId(html, 'market-judgement-delay-next-review')?.attributes.type).toBe(
      'datetime-local',
    );
    expect(html).toContain(copy.adminMarketJudgementDelayReasonHint);
    expect(html).toContain(copy.adminMarketJudgementDelayNextReviewHint);
    // Before a first record: nothing to replace.
    expect(byTestId(fields(null), 'market-judgement-delay-dialog-current')).toBeUndefined();
  });

  it('says the time’s refusal under its field', () => {
    const html = fields(null, copy.errMarketJudgementDelayNextReviewTooFar);
    expect(byTestId(html, 'market-judgement-delay-next-review-error')?.text).toBe(
      copy.errMarketJudgementDelayNextReviewTooFar,
    );
  });
});
