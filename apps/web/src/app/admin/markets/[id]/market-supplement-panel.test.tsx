import { MARKET_SUPPLEMENT_REJECT_REASONS } from '@buddha/shared';
import { type ReactNode, createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import {
  type AdminMarket,
  type AdminRuleVersion,
  type MarketRuleContent,
  type MarketSupplementPending,
  type Me,
} from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  SUPPLEMENT_FORM_UNAVAILABLE_NOTE,
  SUPPLEMENT_REJECT_REASON_LABEL,
  SUPPLEMENT_STATUS_LABEL,
} from '@/lib/market-supplement';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { SupplementRejectFields } from './market-supplement-dialogs';
import {
  MarketSupplementPanel,
  SupplementPanelBody,
  SupplementRequestForm,
} from './market-supplement-panel';

const REQUESTER = { id: 'requester', nickname: '요청한이' };
const APPROVER = { id: 'approver', nickname: '승인한이' };
const THIRD = 'third';
const REQUESTED_AT = '2026-11-02T01:00:00.000Z';
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

const v1: AdminRuleVersion = {
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  changedItems: [],
  reason: null,
  content: V1,
  approvalId: null,
  requestedBy: null,
  createdBy: null,
  settlementImpact: null,
};

/** An OPEN market at v1, nothing waiting. */
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
  ruleVersions: [v1],
  supplement: { pending: null, log: [] },
  pause: { history: [], pending: null, log: [] },
  // Not judged (#152): no judgement, none waiting, the dispute window decided.
  judgementVersion: null,
  disputeDeadline: null,
  disputeOpen: false,
  disputes: { holding: 0, items: [] },
  judgement: { current: null, history: [], pending: null, log: [], disputeWindowUndecided: false },
};

const pending: MarketSupplementPending = {
  requestId: 'r1',
  requestedBy: REQUESTER,
  requestedAt: REQUESTED_AT,
  baseVersion: 1,
  items: ['description'],
  changes: { description: '고친 배경' },
  reason: '오타를 고칩니다.',
  settlementImpact: '판정 기준은 그대로입니다.',
};

/** The market with `pending` waiting, as the log lists it too. */
const waiting: AdminMarket = {
  ...open,
  supplement: {
    pending,
    log: [
      {
        ...pending,
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        rejectReason: null,
        retractedAt: null,
        version: null,
      },
    ],
  },
};

const draw = (
  market: AdminMarket,
  operatorId: string | undefined,
  readAt = BEFORE_CLOSE,
  requestForm: ReactNode = null,
) =>
  renderWithQueries(
    <SupplementPanelBody
      market={market}
      readAt={readAt}
      operatorId={operatorId}
      onOpen={() => {}}
      requestForm={requestForm}
    />,
  );

const isOff = (html: string, testId: string) => {
  const element = byTestId(html, testId);
  expect(element, testId).toBeDefined();
  return Object.hasOwn(element?.attributes ?? {}, 'disabled');
};

/**
 * 규칙 보충 as drawn (#80, ADR-0101; ADR-0093 decision 2 #172 items 14·15), per state and per admin
 * on screen. What each write may send and what a refusal says are lib/market-supplement.ts'
 * (market-supplement.test.ts), which the API refuses again; the e2e (rule-versions.spec.ts) drives
 * the form and the dialogs.
 */
describe('SupplementPanelBody', () => {
  it('offers 보충 요청 on an open market at its current version, once the admin is known', () => {
    const html = draw(open, THIRD);
    expect(byTestId(html, 'market-supplement')?.attributes['data-status']).toBe('open');
    expect(byTestId(html, 'market-supplement-version')?.text).toBe(
      `${copy.adminMarketSupplementVersion} v1`,
    );
    expect(byTestId(html, 'market-supplement-request')?.text).toBe(
      copy.adminMarketSupplementRequest,
    );
    expect(isOff(html, 'market-supplement-request')).toBe(false);
    expect(byTestId(html, 'market-supplement-unavailable')).toBeUndefined();
    expect(byTestId(html, 'market-supplement-pending')).toBeUndefined();
    expect(isOff(draw(open, undefined), 'market-supplement-request')).toBe(true);
    // A PAUSED market takes one too (its close fixed in the form).
    expect(
      byTestId(draw({ ...open, status: 'paused' }, THIRD), 'market-supplement-request'),
    ).toBeDefined();
  });

  it.each([
    ['none', { ...open, ruleVersion: null, ruleVersions: [] }, BEFORE_CLOSE],
    ['closed', open, AFTER_CLOSE],
    ['status', { ...open, status: 'closed' as const }, BEFORE_CLOSE],
  ])('says why there is no 보충 요청: %s', (reason, market, readAt) => {
    const html = draw(market, THIRD, readAt);
    expect(byTestId(html, 'market-supplement-request')).toBeUndefined();
    expect(byTestId(html, 'market-supplement-unavailable')?.attributes['data-reason']).toBe(reason);
  });

  it('shows the waiting request whole to another admin, with 승인 and 반려', () => {
    const html = draw(waiting, THIRD);
    expect(byTestId(html, 'market-supplement-pending-by')?.text).toBe('요청한이');
    expect(byTestId(html, 'market-supplement-pending-at')?.text).toBe(formatKst(REQUESTED_AT));
    expect(byTestId(html, 'market-supplement-pending-base')?.text).toBe('v1');
    expect(byTestId(html, 'market-supplement-pending-change-description-before')?.text).toBe(
      '배경',
    );
    expect(byTestId(html, 'market-supplement-pending-change-description-after')?.text).toBe(
      '고친 배경',
    );
    expect(byTestId(html, 'market-supplement-pending-reason')?.text).toBe(pending.reason);
    expect(byTestId(html, 'market-supplement-pending-impact')?.text).toBe(pending.settlementImpact);
    expect(isOff(html, 'market-supplement-approve')).toBe(false);
    expect(isOff(html, 'market-supplement-reject')).toBe(false);
    expect(byTestId(html, 'market-supplement-retract')).toBeUndefined();
    expect(byTestId(html, 'market-supplement-requester-note')).toBeUndefined();
    // One at a time: no second request while it waits, and nothing to say why.
    expect(byTestId(html, 'market-supplement-request')).toBeUndefined();
    expect(byTestId(html, 'market-supplement-unavailable')).toBeUndefined();
  });

  it('turns 승인 and 반려 off for the requester with the note why, and offers 철회 alone', () => {
    const html = draw(waiting, REQUESTER.id);
    expect(byTestId(html, 'market-supplement-requester-note')?.text).toContain(
      copy.adminMarketSupplementExcludedRequester,
    );
    expect(isOff(html, 'market-supplement-approve')).toBe(true);
    expect(isOff(html, 'market-supplement-reject')).toBe(true);
    expect(isOff(html, 'market-supplement-retract')).toBe(false);
    // Unknown admin: nothing is live, and no 철회 is offered to nobody.
    const unknown = draw(waiting, undefined);
    expect(isOff(unknown, 'market-supplement-approve')).toBe(true);
    expect(isOff(unknown, 'market-supplement-reject')).toBe(true);
    expect(byTestId(unknown, 'market-supplement-retract')).toBeUndefined();
  });

  it('leaves a request waiting past the close to its 반려 or 철회', () => {
    for (const [market, readAt] of [
      [waiting, AFTER_CLOSE],
      [{ ...waiting, status: 'closed' as const }, BEFORE_CLOSE],
    ] as const) {
      const html = draw(market, THIRD, readAt);
      expect(byTestId(html, 'market-supplement-pending-closed')?.text).toContain(
        copy.adminMarketSupplementPendingClosed,
      );
      expect(isOff(html, 'market-supplement-approve')).toBe(true);
      expect(isOff(html, 'market-supplement-reject')).toBe(false);
    }
  });

  it('approves no close change while PAUSED, and says so; 반려 and 철회 stay (#172 item 14)', () => {
    const closeChange = {
      ...pending,
      items: ['closeAt' as const],
      changes: { closeAt: '2026-11-29T16:00:00.000Z' },
    };
    const paused: AdminMarket = {
      ...waiting,
      status: 'paused',
      supplement: { ...waiting.supplement, pending: closeChange },
    };
    const html = draw(paused, THIRD);
    expect(byTestId(html, 'market-supplement-pending-paused')?.text).toContain(
      copy.adminMarketSupplementPendingPaused,
    );
    expect(byTestId(html, 'market-supplement-pending-closed')).toBeUndefined();
    expect(isOff(html, 'market-supplement-approve')).toBe(true);
    expect(isOff(html, 'market-supplement-reject')).toBe(false);
    expect(isOff(draw(paused, REQUESTER.id), 'market-supplement-retract')).toBe(false);
    // Any other item is approved while PAUSED, and the same close change once OPEN again.
    for (const market of [
      { ...waiting, status: 'paused' as const },
      { ...paused, status: 'open' as const },
    ]) {
      const other = draw(market, THIRD);
      expect(byTestId(other, 'market-supplement-pending-paused')).toBeUndefined();
      expect(isOff(other, 'market-supplement-approve')).toBe(false);
    }
  });

  it('keeps the request form it holds open, whatever the market became; it says why itself', () => {
    const held = <form data-testid="market-supplement-form" />;
    for (const [market, readAt] of [
      [open, BEFORE_CLOSE],
      [waiting, BEFORE_CLOSE],
      [open, AFTER_CLOSE],
      [{ ...open, status: 'closed' as const }, BEFORE_CLOSE],
    ] as const) {
      const html = draw(market, THIRD, readAt, held);
      expect(byTestId(html, 'market-supplement-form')).toBeDefined();
      expect(byTestId(html, 'market-supplement-request')).toBeUndefined();
      expect(byTestId(html, 'market-supplement-unavailable')).toBeUndefined();
    }
  });

  it('draws the headings focus comes back to out of the tab order (WCAG 2.4.3)', () => {
    const targets = {
      title: createRef<HTMLParagraphElement>(),
      request: createRef<HTMLButtonElement>(),
      pending: createRef<HTMLParagraphElement>(),
    };
    const html = renderWithQueries(
      <SupplementPanelBody
        market={waiting}
        readAt={BEFORE_CLOSE}
        operatorId={THIRD}
        onOpen={() => {}}
        requestForm={null}
        targets={targets}
      />,
    );
    // Where 보충 요청 is not drawn once the form closes (`supplementRefocus`): each takes focus
    // from script alone.
    expect(byTestId(html, 'market-supplement-title')?.attributes.tabindex).toBe('-1');
    const heading = byTestId(html, 'market-supplement-pending-title');
    expect(heading?.text).toBe(copy.adminMarketSupplementPending);
    expect(heading?.attributes.tabindex).toBe('-1');
  });

  it('lists every request, newest first, with how it ended', () => {
    const approved = {
      ...pending,
      requestId: 'r0',
      status: 'approved' as const,
      decidedBy: APPROVER,
      decidedAt: '2026-11-01T05:00:00.000Z',
      decisionReason: '확인',
      rejectReason: null,
      retractedAt: null,
      version: 2,
    };
    const html = draw(
      { ...waiting, supplement: { pending, log: [...waiting.supplement.log, approved] } },
      THIRD,
    );
    expect(
      testIdsStartingWith(html, 'market-supplement-log-').filter((id) => /-log-\d+$/.test(id)),
    ).toEqual(['market-supplement-log-0', 'market-supplement-log-1']);
    expect(byTestId(html, 'market-supplement-log-0')?.attributes['data-status']).toBe('pending');
    expect(byTestId(html, 'market-supplement-log-1-status')?.text).toBe(
      SUPPLEMENT_STATUS_LABEL.approved,
    );
    expect(byTestId(html, 'market-supplement-log-1-by')?.text).toBe('요청한이');
    expect(byTestId(html, 'market-supplement-log-1-rows')?.text).toContain('승인한이');
    expect(byTestId(draw(open, THIRD), 'market-supplement-log-empty')?.text).toBe(
      copy.adminMarketSupplementLogEmpty,
    );
  });

  it('lists the versions with who opened v1 and the impact review only admins read', () => {
    const v2: AdminRuleVersion = {
      ...v1,
      version: 2,
      createdAt: '2026-11-03T00:00:00.000Z',
      changedItems: ['description'],
      reason: pending.reason,
      approvalId: 'a1',
      requestedBy: REQUESTER,
      createdBy: APPROVER,
      settlementImpact: pending.settlementImpact,
    };
    const html = draw({ ...open, ruleVersion: 2, ruleVersions: [v2, v1] }, THIRD);
    expect(
      testIdsStartingWith(html, 'market-supplement-version-').filter((id) =>
        /-version-\d+$/.test(id),
      ),
    ).toEqual(['market-supplement-version-2', 'market-supplement-version-1']);
    expect(byTestId(html, 'market-supplement-version-2-rows')?.text).toContain('승인한이');
    expect(byTestId(html, 'market-supplement-version-2-rows')?.text).toContain(
      pending.settlementImpact,
    );
    expect(byTestId(html, 'market-supplement-version-1')?.text).toContain(
      copy.ruleVersionsFixedAtOpen,
    );
    expect(byTestId(html, 'market-supplement-version-1-rows')?.text).toContain(copy.eventSystem);
  });
});

describe('MarketSupplementPanel', () => {
  it('draws nothing before the open: nothing is versioned yet', () => {
    for (const status of ['draft', 'review', 'scheduled'] as const) {
      expect(
        renderWithQueries(
          <MarketSupplementPanel
            market={{ ...open, status, ruleVersion: null, ruleVersions: [] }}
            readAt={BEFORE_CLOSE}
          />,
        ),
        status,
      ).toBe('');
    }
  });
});

describe('SupplementRequestForm', () => {
  const me = { id: THIRD } as Me;
  const drawn = (market: AdminMarket, admin: Me | null = me, readAt = BEFORE_CLOSE) =>
    renderWithQueries(
      <SupplementRequestForm market={market} readAt={readAt} onClose={() => {}} />,
      admin === null ? [] : [[ME_QUERY_KEY, admin]],
    );

  it('opens on the market’s version items at its version, with the boundary, the reason and the impact', () => {
    const html = drawn(open);
    expect(byTestId(html, 'market-supplement-form-base')?.text).toBe(
      `${copy.adminMarketSupplementBase} v1`,
    );
    expect(byTestId(html, 'market-supplement-boundary')?.text).toContain(
      copy.adminMarketSupplementBoundary,
    );
    // The version items' inputs, the form's own (react-hook-form fills them in once mounted).
    for (const id of [
      'market-title',
      'market-description',
      'market-yes-condition',
      'market-close-at',
    ]) {
      expect(byTestId(html, id), id).toBeDefined();
    }
    expect(byTestId(html, 'market-supplement-reason')).toBeDefined();
    expect(byTestId(html, 'market-supplement-impact')).toBeDefined();
    expect(html).toContain(copy.adminMarketSupplementImpactHint);
    expect(byTestId(html, 'market-supplement-form-stale')).toBeUndefined();
    expect(byTestId(html, 'market-supplement-form-unavailable')).toBeUndefined();
    expect(isOff(html, 'market-supplement-submit')).toBe(false);
    // Focus goes into the form as it opens, at its heading (out of the tab order).
    expect(byTestId(html, 'market-supplement-form-title')?.attributes.tabindex).toBe('-1');
    expect(byTestId(html, 'market-supplement-form-title')?.text).toBe(
      copy.adminMarketSupplementFormTitle,
    );
    // Neither the category, the tags nor the image: no supplement changes them.
    for (const id of ['market-category', 'market-tags-input', 'market-image-url']) {
      expect(byTestId(html, id), id).toBeUndefined();
    }
  });

  it('fixes the scheduled open and judgement, and the close while PAUSED (#172 item 14)', () => {
    const html = drawn(open);
    expect(isOff(html, 'market-scheduled-open-at')).toBe(true);
    expect(isOff(html, 'market-scheduled-judgement-at')).toBe(true);
    expect(isOff(html, 'market-close-at')).toBe(false);
    const paused = drawn({ ...open, status: 'paused' });
    expect(isOff(paused, 'market-close-at')).toBe(true);
    expect(paused).toContain(copy.adminMarketCloseLockedPausedHint);
  });

  it.each([
    ['pending', waiting, BEFORE_CLOSE],
    ['closed', open, AFTER_CLOSE],
    ['status', { ...open, status: 'closed' as const }, BEFORE_CLOSE],
  ] as const)(
    'stays once the market takes no request, says why and sends nothing: %s',
    (reason, market, readAt) => {
      const html = drawn(market, me, readAt);
      const alert = byTestId(html, 'market-supplement-form-unavailable');
      expect(alert?.attributes['data-reason']).toBe(reason);
      expect(alert?.text).toContain(SUPPLEMENT_FORM_UNAVAILABLE_NOTE[reason]);
      expect(isOff(html, 'market-supplement-submit')).toBe(true);
      // 취소 closes it; what was typed stays until then (the inputs are drawn, live).
      expect(isOff(html, 'market-supplement-cancel')).toBe(false);
      expect(isOff(html, 'market-description')).toBe(false);
    },
  );

  it('holds every field off until the admin on screen is known', () => {
    const html = drawn(open, null);
    expect(byTagName(html, 'fieldset')[0]?.attributes).toHaveProperty('disabled');
    expect(isOff(html, 'market-supplement-submit')).toBe(true);
  });
});

describe('SupplementRejectFields', () => {
  it('lists the 반려 사유, 의미 변경 first, and the 설명', () => {
    const html = renderWithQueries(
      <SupplementRejectFields
        value=""
        onValue={() => {}}
        description=""
        onDescription={() => {}}
        reasonError={null}
        descriptionError={null}
        disabled={false}
      />,
    );
    expect(
      byTagName(html, 'option')
        .map((option) => option.text)
        .filter((text) => text !== copy.adminMarketReviewRejectReasonPlaceholder),
    ).toEqual(
      MARKET_SUPPLEMENT_REJECT_REASONS.map((reason) => SUPPLEMENT_REJECT_REASON_LABEL[reason]),
    );
    expect(byTestId(html, 'market-supplement-reject-description')).toBeDefined();
  });
});
