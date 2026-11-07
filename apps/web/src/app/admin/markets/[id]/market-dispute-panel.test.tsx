import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { type AdminMarket, type AdminMarketDispute, type AdminMarketJudgement } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { MarketDisputes, MarketDisputesBody } from './market-dispute-panel';

const REGISTRANT = { id: 'registrant', nickname: '등록한이' };
const APPROVER = { id: 'approver', nickname: '승인한이' };
const THIRD = 'third';
const PENDING_ID = 'e1b07384-d9a0-4c9b-8e2f-2d1c0f8a4b11';
const DISMISSED_ID = 'e2b07384-d9a0-4c9b-8e2f-2d1c0f8a4b12';
const PURGED_ID = 'e3b07384-d9a0-4c9b-8e2f-2d1c0f8a4b13';
const ACCEPTED_ID = 'e4b07384-d9a0-4c9b-8e2f-2d1c0f8a4b14';
const CLOSED_ID = 'e5b07384-d9a0-4c9b-8e2f-2d1c0f8a4b15';

const current: AdminMarketJudgement = {
  version: 1,
  result: 'NO',
  source: { priority: 0, name: '기상청', url: 'https://www.weather.go.kr' },
  fallbackReason: null,
  voidReason: null,
  evidence: { links: ['https://www.weather.go.kr/a'], collectedAt: '2026-11-30T01:00:00.000Z' },
  description: '11월 관측 기록이 없음을 확인했습니다.',
  ruleVersion: 1,
  eventDeadlineConfirmed: false,
  disputeWindowMinutes: 1440,
  publishedAt: '2026-11-30T03:00:00.000Z',
  disputeDeadline: '2026-12-01T03:00:00.000Z',
  approvalId: 'a1b2c3d4-0000-4000-8000-000000000001',
  registeredBy: REGISTRANT,
  approvedBy: APPROVER,
  correctionReason: null,
};

const disputeOf = (id: string, fields: Partial<AdminMarketDispute> = {}): AdminMarketDispute => ({
  id,
  judgementVersion: 1,
  links: ['https://example.com/evidence'],
  reason: '규칙의 출처와 다릅니다.',
  status: 'pending',
  submittedAt: '2026-11-30T04:00:00.000Z',
  decidedAt: null,
  decisionReason: null,
  retractedAt: null,
  closedAt: null,
  submitter: { id: 'member', nickname: '낸이' },
  decidedBy: null,
  purgedAt: null,
  ...fields,
});

/**
 * A 잠정 결과 market a 판정 이의 holds — with a market price, a volume and counts, which no dispute
 * screen may show (N03 §5, #152 AC 8).
 */
const held = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  slug: 'first-snow',
  title: '첫눈이 올까?',
  status: 'provisional',
  lastPrice: 63,
  lastFillAt: '2026-11-29T04:00:00.000Z',
  volumeCoin: '123456',
  tradeCount: 789,
  traderCount: 321,
  openInterest: { yes: 4321, no: 8765 },
  judgementVersion: 1,
  disputeDeadline: current.disputeDeadline,
  judgement: { current, history: [], pending: null, log: [], disputeWindowUndecided: false },
  disputes: {
    holding: 1,
    items: [
      disputeOf(PENDING_ID),
      disputeOf(DISMISSED_ID, {
        status: 'dismissed',
        submitter: { id: 'gone', nickname: null },
        decidedAt: '2026-11-30T06:00:00.000Z',
        decisionReason: '출처의 발표와 같습니다.',
        decidedBy: APPROVER,
      }),
      disputeOf(PURGED_ID, {
        status: 'retracted',
        links: [],
        reason: '',
        retractedAt: '2026-11-30T05:00:00.000Z',
        purgedAt: '2027-11-30T00:00:00.000Z',
      }),
    ],
  },
} as unknown as AdminMarket;

const draw = (
  market: AdminMarket,
  operatorId: string | undefined,
  onCorrect?: () => void,
  formOpen = false,
) =>
  renderWithQueries(
    <MarketDisputesBody
      market={market}
      operatorId={operatorId}
      onOpen={() => {}}
      formOpen={formOpen}
      onCorrect={onCorrect}
    />,
  );

/**
 * The same market with an accepted dispute waiting for its correction (#176, ADR-0105) beside the
 * pending one.
 */
const accepted = {
  ...held,
  disputes: {
    holding: 2,
    items: [
      ...held.disputes.items,
      disputeOf(ACCEPTED_ID, {
        status: 'accepted',
        decidedAt: '2026-11-30T07:00:00.000Z',
        decisionReason: '출처가 정정 발표를 냈습니다.',
        decidedBy: APPROVER,
      }),
    ],
  },
};

const isOff = (html: string, testId: string) => {
  const element = byTestId(html, testId);
  expect(element, testId).toBeDefined();
  return Object.hasOwn(element?.attributes ?? {}, 'disabled');
};

/** No price, volume, count or holding of the market, nor its label (N03 §5, #152 AC 8). */
const expectNoMarketSignal = (html: string) => {
  const text = byTestId(html, 'market-judgement-disputes')?.text ?? '';
  expect(text).not.toBe('');
  for (const signal of [
    copy.tradeStatsLastPrice,
    copy.marketVolume,
    copy.marketTradeCount,
    copy.marketTraderCount,
    '63%',
    '123,456',
    '4321',
    '8765',
    '789',
    '321',
    'Coin',
  ]) {
    expect(text, signal).not.toContain(signal);
  }
};

/**
 * '판정 이의' in the 판정 panel as drawn (#175, ADR-0104; ADR-0093 decision 1 #173 items 2·7·13),
 * per admin on screen. Who may decide is lib/admin-disputes.ts' (admin-disputes.test.ts), which the
 * API refuses again; the e2e (dispute.spec.ts) drives the block's empty state.
 */
describe('MarketDisputesBody', () => {
  it('lists the current version’s disputes, the oldest first, and how many hold the confirmation', () => {
    const html = draw(held, THIRD);
    expect(byTestId(html, 'market-judgement-disputes')?.attributes['data-holding']).toBe('1');
    expect(byTestId(html, 'market-judgement-disputes-holding')?.text).toBe(
      '결과 확정을 기다리게 하는 이의 1건',
    );
    expect(
      testIdsStartingWith(html, 'market-judgement-dispute-').filter((id) =>
        /^market-judgement-dispute-[0-9a-f-]{36}$/.test(id),
      ),
    ).toEqual([
      `market-judgement-dispute-${PENDING_ID}`,
      `market-judgement-dispute-${DISMISSED_ID}`,
      `market-judgement-dispute-${PURGED_ID}`,
    ]);
    const at = `market-judgement-dispute-${PENDING_ID}`;
    expect(byTestId(html, `${at}-status`)?.text).toBe('검토 중');
    expect(byTestId(html, `${at}-version`)?.text).toContain('v1');
    expect(byTestId(html, `${at}-submitter`)?.text).toBe('낸이');
    expect(byTestId(html, `${at}-submitted-at`)?.text).toBe(formatKst('2026-11-30T04:00:00.000Z'));
    expect(byTestId(html, `${at}-reason`)?.text).toBe('규칙의 출처와 다릅니다.');
    expect(
      byTagName(html, 'a')
        .filter((link) => link.attributes.href === 'https://example.com/evidence')
        .map((link) => link.attributes.target),
    ).toEqual(['_blank', '_blank']);
  });

  it('offers 기각 and 수용 on a pending one to any admin but the registrant — the approver included', () => {
    const at = `market-judgement-dispute-${PENDING_ID}`;
    for (const operator of [THIRD, APPROVER.id]) {
      const html = draw(held, operator);
      expect(isOff(html, `${at}-dismiss`), operator).toBe(false);
      expect(isOff(html, `${at}-accept`), operator).toBe(false);
      expect(byTestId(html, 'market-judgement-disputes-registrant-note'), operator).toBeUndefined();
    }
    // A decided or retracted one offers nothing.
    const html = draw(held, THIRD);
    for (const id of [DISMISSED_ID, PURGED_ID]) {
      expect(byTestId(html, `market-judgement-dispute-${id}-actions`), id).toBeUndefined();
    }
  });

  it('turns both off for the registrant with the note why, and until the admin is known', () => {
    const at = `market-judgement-dispute-${PENDING_ID}`;
    const registrant = draw(held, REGISTRANT.id);
    expect(byTestId(registrant, 'market-judgement-disputes-registrant-note')?.text).toContain(
      copy.adminMarketDisputesRegistrant,
    );
    expect(isOff(registrant, `${at}-dismiss`)).toBe(true);
    expect(isOff(registrant, `${at}-accept`)).toBe(true);
    const unknown = draw(held, undefined);
    expect(isOff(unknown, `${at}-dismiss`)).toBe(true);
    expect(byTestId(unknown, 'market-judgement-disputes-registrant-note')).toBeUndefined();
  });

  it('shows how one ended: the decider, the time and the reason, or the 철회; a purge says so', () => {
    const html = draw(held, THIRD);
    const dismissed = `market-judgement-dispute-${DISMISSED_ID}`;
    expect(byTestId(html, `${dismissed}-submitter`)?.text).toBe(copy.postAuthorFormer);
    expect(byTestId(html, `${dismissed}-decided-by`)?.text).toBe('승인한이');
    expect(byTestId(html, `${dismissed}-decided-at`)?.text).toBe(
      formatKst('2026-11-30T06:00:00.000Z'),
    );
    expect(byTestId(html, `${dismissed}-decision-reason`)?.text).toBe('출처의 발표와 같습니다.');
    const purged = `market-judgement-dispute-${PURGED_ID}`;
    expect(byTestId(html, `${purged}-purged`)?.text).toBe(copy.adminDisputePurged);
    expect(byTestId(html, `${purged}-links`)).toBeUndefined();
    expect(byTestId(html, `${purged}-retracted-at`)?.text).toContain(
      formatKst('2026-11-30T05:00:00.000Z'),
    );
  });

  it('offers 정정 등록 on an accepted one while a correction can be registered (#176)', () => {
    const at = `market-judgement-dispute-${ACCEPTED_ID}`;
    // Any admin, the judgement's registrant included (ADR-0105: as #152's registration).
    for (const operator of [THIRD, REGISTRANT.id]) {
      const html = draw(accepted, operator, () => {});
      expect(byTestId(html, `${at}-correct`)?.text, operator).toBe(copy.adminMarketDisputeCorrect);
      expect(isOff(html, `${at}-correct`), operator).toBe(false);
      expect(byTestId(html, `${at}-dismiss`), operator).toBeUndefined();
      expect(byTestId(html, `${at}-accept`), operator).toBeUndefined();
    }
    expect(
      isOff(
        draw(accepted, undefined, () => {}),
        `${at}-correct`,
      ),
    ).toBe(true);
    // None while one waits (one at a time), once confirmed, or with nothing to open.
    const waiting = {
      ...accepted,
      judgement: { ...accepted.judgement, pending: {} },
    } as unknown as AdminMarket;
    expect(
      byTestId(
        draw(waiting, THIRD, () => {}),
        `${at}-actions`,
      ),
    ).toBeUndefined();
    const resolved = { ...accepted, status: 'resolved' } as AdminMarket;
    expect(
      byTestId(
        draw(resolved, THIRD, () => {}),
        `${at}-actions`,
      ),
    ).toBeUndefined();
    expect(byTestId(draw(accepted, THIRD), `${at}-actions`)).toBeUndefined();
  });

  it('hides 정정 등록 while the panel’s form is open, kept drawn for focus to come back to (#176)', () => {
    const at = `market-judgement-dispute-${ACCEPTED_ID}`;
    // The form's own submit is named 정정 등록 too, and the row would open nothing more: hidden —
    // out of sight and of the accessibility tree — but still drawn, so the panel can put focus
    // back on the row that opened the form once it closes unsent (`useJudgementRefocus`).
    const open = draw(accepted, THIRD, () => {}, true);
    expect(byTestId(open, `${at}-actions`)?.attributes).toHaveProperty('hidden');
    expect(byTestId(open, `${at}-correct`)?.text).toBe(copy.adminMarketDisputeCorrect);
    expect(isOff(open, `${at}-correct`)).toBe(false);
    // Closed, it is shown again.
    expect(
      byTestId(
        draw(accepted, THIRD, () => {}),
        `${at}-actions`,
      )?.attributes,
    ).not.toHaveProperty('hidden');
    // The pending one's 기각 and 수용 are not the form's: they stay.
    const pendingAt = `market-judgement-dispute-${PENDING_ID}`;
    expect(byTestId(open, `${pendingAt}-actions`)?.attributes).not.toHaveProperty('hidden');
    // The block gets it from the panel (`MarketDisputes`).
    expect(
      byTestId(
        renderWithQueries(<MarketDisputes market={accepted} formOpen onCorrect={() => {}} />, [
          [ME_QUERY_KEY, { id: THIRD }],
        ]),
        `${at}-actions`,
      )?.attributes,
    ).toHaveProperty('hidden');
  });

  it('shows a dispute a correction closed with its closing time and no action (#176)', () => {
    const closed = {
      ...held,
      disputes: {
        holding: 0,
        items: [
          disputeOf(CLOSED_ID, {
            status: 'closed_by_correction',
            closedAt: '2026-11-30T08:00:00.000Z',
          }),
        ],
      },
    };
    const at = `market-judgement-dispute-${CLOSED_ID}`;
    const html = draw(closed, THIRD, () => {});
    expect(byTestId(html, `${at}`)?.attributes['data-status']).toBe('closed_by_correction');
    expect(byTestId(html, `${at}-status`)?.text).toBe(copy.disputeStatusClosedByCorrection);
    expect(byTestId(html, `${at}-closed-at`)?.text).toBe(
      `${copy.adminDisputeClosedAt} ${formatKst('2026-11-30T08:00:00.000Z')}`,
    );
    expect(byTestId(html, `${at}-decision`)).toBeUndefined();
    expect(byTestId(html, `${at}-actions`)).toBeUndefined();
  });

  it('says none is filed, and holds no count then', () => {
    const empty = { ...held, disputes: { holding: 0, items: [] } } as AdminMarket;
    const html = draw(empty, THIRD);
    expect(byTestId(html, 'market-judgement-disputes-empty')?.text).toBe(
      copy.adminMarketDisputesEmpty,
    );
    expect(byTestId(html, 'market-judgement-disputes-holding')).toBeUndefined();
  });

  it('names each element once and draws no market price, volume or count (#152 AC 8)', () => {
    const html = draw(accepted, REGISTRANT.id, () => {});
    const ids = testIdsStartingWith(html, 'market-judgement-dispute');
    expect(ids.length).toBeGreaterThan(20);
    expect(ids.filter((id, at) => ids.indexOf(id) !== at)).toEqual([]);
    expectNoMarketSignal(html);
    expectNoMarketSignal(draw(held, THIRD));
  });

  it('draws its heading out of the tab order for the focus to come back to (WCAG 2.4.3)', () => {
    const html = renderWithQueries(
      <MarketDisputesBody
        market={held}
        operatorId={THIRD}
        onOpen={() => {}}
        headingRef={createRef<HTMLParagraphElement>()}
      />,
    );
    expect(byTestId(html, 'market-judgement-disputes-title')?.attributes.tabindex).toBe('-1');
  });
});

describe('MarketDisputes', () => {
  it('draws nothing before a judgement, and the block from one on', () => {
    const before = {
      ...held,
      judgement: {
        current: null,
        history: [],
        pending: null,
        log: [],
        disputeWindowUndecided: false,
      },
    } as AdminMarket;
    expect(renderWithQueries(<MarketDisputes market={before} />)).toBe('');
    const html = renderWithQueries(<MarketDisputes market={held} />, [
      [ME_QUERY_KEY, { id: THIRD }],
    ]);
    expect(byTestId(html, 'market-judgement-disputes')).toBeDefined();
    // The admin on screen is `GET /me`'s (`useOperatorId`).
    expect(isOff(html, `market-judgement-dispute-${PENDING_ID}-dismiss`)).toBe(false);
  });
});
