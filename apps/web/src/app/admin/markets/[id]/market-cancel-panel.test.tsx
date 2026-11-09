import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminMarket, type MarketCancelRequest, type MarketRuleContent } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTestId, renderWithQueries } from '@/test/render';
import { CancelPanelBody, MarketCancelPanel } from './market-cancel-panel';

const REQUESTER = { id: 'requester', nickname: '요청한이' };
const APPROVER = { id: 'approver', nickname: '승인한이' };
const THIRD = 'third';

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

/** A SCHEDULED market, no cancel request. */
const scheduled: AdminMarket = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  slug: 'first-snow',
  ...V1,
  category: { slug: 'weather', nameKo: '날씨' },
  imageUrl: null,
  status: 'scheduled',
  judgementDelayed: false,
  disputeUnderReview: false,
  lastPrice: null,
  lastFillAt: null,
  lastPrice24hAgo: null,
  volumeCoin: '0',
  tradeCount: 0,
  traderCount: 0,
  openAt: null,
  resolvedResult: null,
  resolvedAt: null,
  settledAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  createdBy: 'creator',
  openInterest: { yes: 0, no: 0 },
  settlementSteps: [],
  statusEventId: '1',
  events: [],
  tags: ['날씨'],
  missingOpenItems: [],
  leadCloseGapMinutes: 60,
  priceProtectionTicks: 5,
  review: {
    pending: null,
    createdBy: { id: 'creator', nickname: '만든이' },
    editors: [],
    sameCondition: [],
    log: [],
  },
  ruleVersion: 1,
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
  // Not judged (#152): no judgement, none waiting, the dispute window decided.
  judgementVersion: null,
  disputeDeadline: null,
  disputeOpen: false,
  disputes: { holding: 0, items: [] },
  judgementDelay: null,
  judgementDelays: [],
  judgement: { current: null, history: [], pending: null, log: [], disputeWindowUndecided: false },
};

const pending: MarketCancelRequest = {
  requestId: 'a1b2c3d4-0000-4000-8000-000000000001',
  reason: '출처가 사라져 판정할 수 없습니다.',
  requestedBy: REQUESTER,
  requestedAt: '2026-11-05T04:00:00.000Z',
};

/** A SCHEDULED market with a cancel request waiting, and one retracted before it. */
const waiting: AdminMarket = {
  ...scheduled,
  cancel: {
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
        reason: '먼저 쓴 사유',
        requestedBy: REQUESTER,
        requestedAt: '2026-11-03T05:00:00.000Z',
        status: 'retracted',
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        retractedAt: '2026-11-04T00:00:00.000Z',
      },
    ],
  },
};

const draw = (market: AdminMarket, operatorId: string | undefined) =>
  renderWithQueries(<CancelPanelBody market={market} operatorId={operatorId} onOpen={() => {}} />);

const isOff = (html: string, testId: string) => {
  const element = byTestId(html, testId);
  expect(element, testId).toBeDefined();
  return Object.hasOwn(element?.attributes ?? {}, 'disabled');
};

/**
 * 시장 취소 as drawn (#20, ADR-0117; ADR-0107 결정 5 '#20 운영자의 취소 경로'), per state and per admin
 * on screen. What a refusal says is lib/market-cancel.ts' (market-cancel.test.ts), which the API
 * refuses again; the e2e (cancel.spec.ts) drives the four dialogs.
 */
describe('CancelPanelBody', () => {
  it('offers 시장 취소 요청 on a scheduled market, once the admin is known', () => {
    const html = draw(scheduled, THIRD);
    expect(byTestId(html, 'market-cancel')?.attributes['data-status']).toBe('scheduled');
    expect(byTestId(html, 'market-cancel-request')?.text).toBe(copy.adminMarketCancelRequest);
    expect(isOff(html, 'market-cancel-request')).toBe(false);
    expect(isOff(draw(scheduled, undefined), 'market-cancel-request')).toBe(true);
    expect(byTestId(html, 'market-cancel-pending')).toBeUndefined();
    expect(byTestId(html, 'market-cancel-history')).toBeUndefined();
  });

  it('shows the waiting request: 승인·반려 for another admin, 철회 for its requester alone', () => {
    const other = draw(waiting, THIRD);
    expect(byTestId(other, 'market-cancel-request')).toBeUndefined();
    expect(byTestId(other, 'market-cancel-pending-by')?.text).toBe('요청한이');
    expect(byTestId(other, 'market-cancel-pending-at')?.text).toBe(formatKst(pending.requestedAt));
    expect(byTestId(other, 'market-cancel-pending-reason')?.text).toBe(pending.reason);
    expect(isOff(other, 'market-cancel-approve')).toBe(false);
    expect(isOff(other, 'market-cancel-reject')).toBe(false);
    expect(byTestId(other, 'market-cancel-retract')).toBeUndefined();
    expect(byTestId(other, 'market-cancel-requester-note')).toBeUndefined();
    const own = draw(waiting, REQUESTER.id);
    expect(isOff(own, 'market-cancel-approve')).toBe(true);
    expect(isOff(own, 'market-cancel-reject')).toBe(true);
    expect(isOff(own, 'market-cancel-retract')).toBe(false);
    expect(byTestId(own, 'market-cancel-requester-note')?.text).toBe(
      copy.adminMarketPauseExcludedRequester,
    );
    // Nobody known yet: nothing live.
    const unknown = draw(waiting, undefined);
    expect(isOff(unknown, 'market-cancel-approve')).toBe(true);
    expect(isOff(unknown, 'market-cancel-reject')).toBe(true);
  });

  it('turns 승인 off once the market left SCHEDULED, keeping 반려 and 철회', () => {
    for (const status of ['open', 'draft'] as const) {
      const html = draw({ ...waiting, status }, THIRD);
      expect(byTestId(html, 'market-cancel-pending-status')?.text).toBe(
        copy.adminMarketCancelPendingNotScheduled,
      );
      expect(isOff(html, 'market-cancel-approve')).toBe(true);
      expect(isOff(html, 'market-cancel-reject')).toBe(false);
      expect(byTestId(html, 'market-cancel-request')).toBeUndefined();
      expect(byTestId(html, 'market-cancel-retract')).toBeUndefined();
      // Its requester still ends it: a waiting request does not hold the open (ADR-0117 11-o),
      // so 철회 is live in any status while 승인·반려 stay off for them.
      const own = draw({ ...waiting, status }, REQUESTER.id);
      expect(isOff(own, 'market-cancel-retract'), status).toBe(false);
      expect(isOff(own, 'market-cancel-approve'), status).toBe(true);
      expect(isOff(own, 'market-cancel-reject'), status).toBe(true);
    }
  });

  it('lists the 시장 취소 기록 newest first, each with its status and rows', () => {
    const html = draw(waiting, THIRD);
    expect(byTestId(html, 'market-cancel-log-0')?.attributes['data-status']).toBe('pending');
    expect(byTestId(html, 'market-cancel-log-0-status')?.text).toBe(
      copy.pauseDecisionStatusPending,
    );
    expect(byTestId(html, 'market-cancel-log-1')?.attributes['data-status']).toBe('retracted');
    expect(byTestId(html, 'market-cancel-log-1-rows')?.text).toContain('먼저 쓴 사유');
    expect(byTestId(html, 'market-cancel-log-1-rows')?.text).toContain(
      formatKst('2026-11-04T00:00:00.000Z'),
    );
  });
});

describe('MarketCancelPanel', () => {
  it('draws nothing on a market that is not scheduled and never had a request', () => {
    for (const status of ['draft', 'review', 'open', 'paused', 'closed', 'cancelled'] as const) {
      expect(
        renderWithQueries(<MarketCancelPanel market={{ ...scheduled, status }} />),
        status,
      ).toBe('');
    }
  });

  it('keeps a cancelled market’s record, with no button', () => {
    const cancelled: AdminMarket = {
      ...scheduled,
      status: 'cancelled',
      cancel: {
        pending: null,
        log: [
          {
            ...pending,
            status: 'approved',
            decidedBy: APPROVER,
            decidedAt: '2026-11-06T00:00:00.000Z',
            decisionReason: '확인했습니다.',
            retractedAt: null,
          },
        ],
      },
    };
    const html = renderWithQueries(<MarketCancelPanel market={cancelled} />);
    expect(byTestId(html, 'market-cancel-log-0')?.attributes['data-status']).toBe('approved');
    expect(byTestId(html, 'market-cancel-log-0-rows')?.text).toContain('승인한이');
    expect(byTestId(html, 'market-cancel-log-0-rows')?.text).toContain('확인했습니다.');
    expect(byTestId(html, 'market-cancel-request')).toBeUndefined();
    expect(byTestId(html, 'market-cancel-pending')).toBeUndefined();
  });
});
