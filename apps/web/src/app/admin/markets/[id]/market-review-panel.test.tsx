import { MARKET_REJECT_REASONS, MARKET_REVIEW_CHECKLIST } from '@buddha/shared';
import { describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { type AdminMarket, type Me } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { MARKET_EVENT_LABEL, REJECT_REASON_LABEL, REVIEW_CHECK_LABEL } from '@/lib/market-admin';
import { REVIEW_CHECK_HINT } from '@/lib/market-review';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { ApproveFields, RejectFields, RescheduleFields } from './market-review-dialogs';
import { ReviewPanelBody, SubmitReviewButton } from './market-review-panel';

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER = 'a1b2c3d4-0000-4000-8000-000000000001';
const CREATOR = { id: 'creator', nickname: '만든이' };
const EDITOR = { id: 'editor', nickname: '고친이' };
const SUBMITTER = { id: 'submitter', nickname: '낸이' };
const THIRD = 'third';
const SUBMITTED_AT = '2026-11-01T01:00:00.000Z';

const base: AdminMarket = {
  id: ID,
  slug: 'rate-cut-2026',
  title: '기준금리 인하?',
  description: '배경',
  yesCondition: '한국은행이 내리면 YES',
  noCondition: '아니면 NO',
  eventDeadline: '2026-11-19T00:00:00.000Z',
  primarySource: { name: '한국은행', url: 'https://www.bok.or.kr' },
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: 14,
  delayHandling: '무효',
  category: { slug: 'economy', nameKo: '경제' },
  imageUrl: null,
  status: 'draft',
  judgementDelayed: false,
  disputeUnderReview: false,
  lastPrice: null,
  lastFillAt: null,
  lastPrice24hAgo: null,
  volumeCoin: '0',
  tradeCount: 0,
  traderCount: 0,
  scheduledOpenAt: '2026-11-10T00:00:00.000Z',
  closeAt: '2026-11-20T00:00:00.000Z',
  scheduledAnnouncementAt: null,
  scheduledJudgementAt: '2026-11-21T00:00:00.000Z',
  judgementTimeZone: 'Asia/Seoul',
  openAt: null,
  resolvedResult: null,
  resolvedAt: null,
  settledAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  createdBy: CREATOR.id,
  openInterest: { yes: 0, no: 0 },
  settlementSteps: [],
  statusEventId: '1',
  events: [],
  tags: ['금리'],
  // No rule version (#80): not opened yet, or opened before #80 (D4).
  ruleVersion: null,
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
  missingOpenItems: [],
  leadCloseGapMinutes: 60,
  priceProtectionTicks: 5,
  review: { pending: null, createdBy: CREATOR, editors: [EDITOR], sameCondition: [], log: [] },
};

/** The market in review: submitted by SUBMITTER, with one other market of the same conditions. */
const inReview: AdminMarket = {
  ...base,
  status: 'review',
  review: {
    ...base.review,
    pending: { requestId: 'r1', requestedBy: SUBMITTER, requestedAt: SUBMITTED_AT },
    sameCondition: [{ id: OTHER, slug: 'rate-cut-dup', title: '금리 인하 중복?', status: 'open' }],
    log: [
      {
        type: 'submitted',
        actor: SUBMITTER,
        at: SUBMITTED_AT,
        fromStatus: 'draft',
        toStatus: 'review',
        reason: null,
        rejectReason: null,
        checklist: null,
        scheduledOpenBefore: null,
        scheduledOpenAfter: null,
      },
    ],
  },
};

/** The panel for `market` as read at `readAt` (0 unless given: before any close). */
const draw = (market: AdminMarket, operatorId: string | undefined, readAt = 0) =>
  renderWithQueries(
    <ReviewPanelBody market={market} readAt={readAt} operatorId={operatorId} onOpen={() => {}} />,
  );

const isOff = (html: string, testId: string) => {
  const element = byTestId(html, testId);
  expect(element, testId).toBeDefined();
  return Object.hasOwn(element?.attributes ?? {}, 'disabled');
};

/**
 * The 검수 panel as drawn (#78, ADR-0099; ADR-0093 decision 2 #172 items 4·5·6), per status and per
 * admin on screen. What each dialog may send is `lib/market-review.ts`'s (market-review.test.ts),
 * which the API refuses again; the e2e drives the dialogs.
 */
describe('ReviewPanelBody', () => {
  it('offers a review’s decision to a third admin, with who submitted it and when', () => {
    const html = draw(inReview, THIRD);
    expect(byTestId(html, 'market-review')?.attributes['data-status']).toBe('review');
    expect(byTestId(html, 'market-review-pending-by')?.text).toBe('낸이');
    expect(byTestId(html, 'market-review-pending-at')?.text).toBe(formatKst(SUBMITTED_AT));
    expect(byTestId(html, 'market-review-pending')?.text).toContain(
      copy.adminMarketReviewPendingNote,
    );
    expect(byTestId(html, 'market-review-exclusion')).toBeUndefined();
    expect(
      testIdsStartingWith(html, 'market-review-').filter((id) =>
        /^market-review-(approve|reject|revert|reschedule)$/.test(id),
      ),
    ).toEqual(['market-review-approve', 'market-review-reject', 'market-review-revert']);
    for (const id of ['market-review-approve', 'market-review-reject', 'market-review-revert']) {
      expect(isOff(html, id), id).toBe(false);
    }
  });

  it.each([
    [CREATOR.id, 'creator', copy.adminMarketReviewExcludedCreator],
    [EDITOR.id, 'editor', copy.adminMarketReviewExcludedEditor],
    [SUBMITTER.id, 'requester', copy.adminMarketReviewExcludedRequester],
  ])(
    'turns 승인 and 반려 off for %s with the note why, and leaves 되돌리기',
    (viewer, why, note) => {
      const html = draw(inReview, viewer);
      const notice = byTestId(html, 'market-review-exclusion');
      expect(notice?.attributes['data-exclusion']).toBe(why);
      expect(notice?.text).toContain(note);
      expect(isOff(html, 'market-review-approve')).toBe(true);
      expect(isOff(html, 'market-review-reject')).toBe(true);
      // Any admin, the creator too, may send it back (#172 item 6).
      expect(isOff(html, 'market-review-revert')).toBe(false);
    },
  );

  it('offers nothing until the admin on screen is known', () => {
    const html = draw(inReview, undefined);
    expect(byTestId(html, 'market-review-exclusion')).toBeUndefined();
    for (const id of ['market-review-approve', 'market-review-reject', 'market-review-revert']) {
      expect(isOff(html, id), id).toBe(true);
    }
  });

  it('lists the same-condition markets, each to its admin detail, as an aid', () => {
    const html = draw(inReview, THIRD);
    const row = byTestId(html, `market-review-same-condition-${OTHER}`);
    expect(row?.text).toContain('금리 인하 중복?');
    expect(row?.text).toContain(copy.marketStatusOpen);
    expect(byTagName(html, 'a').map((link) => link.attributes.href)).toContain(
      `/admin/markets/${OTHER}`,
    );
    expect(byTestId(html, 'market-review-same-condition')?.text).toContain(
      copy.adminMarketReviewSameConditionHint,
    );
    const none = draw({ ...inReview, review: { ...inReview.review, sameCondition: [] } }, THIRD);
    expect(byTestId(none, 'market-review-same-condition-empty')?.text).toBe(
      copy.adminMarketReviewSameConditionEmpty,
    );
  });

  it('lists who may not decide while a draft or a review, the admin on screen marked', () => {
    const html = draw(inReview, EDITOR.id);
    expect(testIdsStartingWith(html, 'market-review-excluded-')).toEqual([
      'market-review-excluded-creator',
      'market-review-excluded-editor',
      'market-review-excluded-submitter',
    ]);
    expect(byTestId(html, 'market-review-excluded-editor')?.text).toBe(
      `고친이 ${copy.adminMarketReviewViewer} · ${copy.adminMarketReviewRoleEditor}`,
    );
    expect(byTestId(html, 'market-review-excluded-submitter')?.text).toBe(
      `낸이 · ${copy.adminMarketReviewRoleRequester}`,
    );
    // A draft: the creator and the editors, no submitter yet — and nothing to decide.
    const draft = draw(base, THIRD);
    expect(testIdsStartingWith(draft, 'market-review-excluded-')).toEqual([
      'market-review-excluded-creator',
      'market-review-excluded-editor',
    ]);
    expect(byTestId(draft, 'market-review-actions')).toBeUndefined();
    expect(byTestId(draft, 'market-review-pending')).toBeUndefined();
  });

  describe('a scheduled market', () => {
    // Opens 2026-11-10, closes 2026-11-20 (base). The panel judges the row as read at `readAt`.
    const scheduled: AdminMarket = {
      ...inReview,
      status: 'scheduled',
      review: { ...inReview.review, pending: null },
    };
    const drawAt = (readAt: string) => draw(scheduled, CREATOR.id, new Date(readAt).getTime());

    it('says it opens by itself at its scheduled open (#21), until its close passes', () => {
      // Before its scheduled open, and past it while the worker has not run yet.
      for (const now of ['2026-11-05T00:00:00.000Z', '2026-11-15T00:00:00.000Z']) {
        const html = drawAt(now);
        expect(byTestId(html, 'market-review-scheduled')?.text, now).toContain(
          copy.adminMarketReviewScheduledNote,
        );
        expect(byTestId(html, 'market-review-close-passed'), now).toBeUndefined();
      }
    });

    it('keeps the note for a row read before its close, whatever the clock says now', () => {
      // Codex review on #21: a page left open across the close holds a row the worker may have
      // opened since; the detail re-reads it at the close, and only that read may warn.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-11-21T00:00:00.000Z'));
        const html = drawAt('2026-11-19T23:59:59.999Z');
        expect(byTestId(html, 'market-review-scheduled')).toBeDefined();
        expect(byTestId(html, 'market-review-close-passed')).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('warns in place of the note when read after its close: it never opens (#172 item 6)', () => {
      // Read at the close itself the open is refused already (`close_at > now`).
      for (const now of ['2026-11-20T00:00:00.000Z', '2026-11-21T00:00:00.000Z']) {
        const html = drawAt(now);
        const warning = byTestId(html, 'market-review-close-passed');
        expect(warning?.text, now).toContain(copy.adminMarketReviewCloseLapsed);
        expect(warning?.attributes.role, now).toBe('status');
        expect(byTestId(html, 'market-review-scheduled'), now).toBeUndefined();
        // 초안으로 되돌리기 is the way out; the reschedule stays for the server to refuse.
        expect(isOff(html, 'market-review-revert'), now).toBe(false);
        expect(isOff(html, 'market-review-reschedule'), now).toBe(false);
      }
      // It says the market will not open, and to send it back to a draft to fix its times.
      expect(copy.adminMarketReviewCloseLapsed).toContain('열리지 않습니다');
      expect(copy.adminMarketReviewCloseLapsed).toContain('초안으로 되돌려');
    });

    it('offers its reschedule and 되돌리기, and no decision', () => {
      const html = drawAt('2026-11-05T00:00:00.000Z');
      expect(byTestId(html, 'market-review-approve')).toBeUndefined();
      expect(byTestId(html, 'market-review-reject')).toBeUndefined();
      expect(byTestId(html, 'market-review-exclusion')).toBeUndefined();
      // The creator may change the time and send it back (#172 item 6).
      expect(isOff(html, 'market-review-reschedule')).toBe(false);
      expect(isOff(html, 'market-review-revert')).toBe(false);
      expect(byTestId(html, 'market-review-excluded')).toBeUndefined();
      expect(byTestId(html, 'market-review-same-condition')).toBeUndefined();
    });
  });

  it('draws only the 검수 기록 past the review', () => {
    for (const status of ['open', 'closed', 'settled', 'cancelled'] as const) {
      const html = draw(
        { ...inReview, status, review: { ...inReview.review, pending: null } },
        THIRD,
      );
      expect(byTestId(html, 'market-review-actions'), status).toBeUndefined();
      expect(byTestId(html, 'market-review-excluded'), status).toBeUndefined();
      expect(byTestId(html, 'market-review-log'), status).toBeDefined();
    }
  });

  it('draws the 검수 기록 newest first: what, who, when, and what it says', () => {
    const rescheduled = {
      type: 'open_rescheduled' as const,
      actor: { id: 'gone', nickname: null },
      at: '2026-11-03T00:00:00.000Z',
      fromStatus: null,
      toStatus: null,
      reason: '일찍 엽니다',
      rejectReason: null,
      checklist: null,
      scheduledOpenBefore: '2026-11-10T00:00:00.000Z',
      scheduledOpenAfter: '2026-11-09T00:00:00.000Z',
    };
    const rejected = {
      ...rescheduled,
      type: 'rejected' as const,
      actor: EDITOR,
      at: '2026-11-02T00:00:00.000Z',
      fromStatus: 'review' as const,
      toStatus: 'draft' as const,
      reason: '마감이 늦습니다',
      rejectReason: 'leadClose' as const,
      scheduledOpenBefore: null,
      scheduledOpenAfter: null,
    };
    const market = {
      ...inReview,
      review: { ...inReview.review, log: [rescheduled, rejected, ...inReview.review.log] },
    };
    const html = draw(market, THIRD);
    expect(
      testIdsStartingWith(html, 'market-review-log-').filter((id) =>
        /^market-review-log-\d+$/.test(id),
      ),
    ).toEqual(['market-review-log-0', 'market-review-log-1', 'market-review-log-2']);
    expect(byTestId(html, 'market-review-log-0')?.attributes['data-type']).toBe('open_rescheduled');
    expect(byTestId(html, 'market-review-log-0-type')?.text).toBe(copy.eventOpenRescheduled);
    expect(byTestId(html, 'market-review-log-0-actor')?.text).toBe(copy.postAuthorFormer);
    expect(byTestId(html, 'market-review-log-0-rows')?.text).toContain(
      `${copy.reviewLogOpenAfter} ${formatKst('2026-11-09T00:00:00.000Z')}`,
    );
    expect(byTestId(html, 'market-review-log-1-type')?.text).toBe(MARKET_EVENT_LABEL.rejected);
    expect(byTestId(html, 'market-review-log-1-actor')?.text).toBe('고친이');
    const rows = byTestId(html, 'market-review-log-1-rows')?.text ?? '';
    expect(rows).toContain(
      `${copy.reviewLogStatus} ${copy.marketStatusReview} → ${copy.marketStatusDraft}`,
    );
    expect(rows).toContain(`${copy.reviewLogRejectReason} ${REVIEW_CHECK_LABEL.leadClose}`);
    expect(rows).toContain(`${copy.reviewLogDescription} 마감이 늦습니다`);
    expect(byTestId(html, 'market-review-log-2')?.text).toContain(formatKst(SUBMITTED_AT));
    // A market never submitted.
    expect(byTestId(draw(base, THIRD), 'market-review-log-empty')?.text).toBe(
      copy.adminMarketReviewLogEmpty,
    );
  });
});

describe('SubmitReviewButton', () => {
  const me = { id: THIRD } as Me;
  /** The button for `admin` on screen; `null` while `GET /me` has not answered. */
  const drawn = (market: AdminMarket, admin: Me | null = me) =>
    renderWithQueries(
      <SubmitReviewButton market={market} />,
      admin === null ? [] : [[ME_QUERY_KEY, admin]],
    );

  it('submits a complete draft as the admin on screen', () => {
    const html = drawn(base);
    expect(byTestId(html, 'market-review-submit')?.text).toBe(copy.adminMarketReviewSubmit);
    expect(isOff(html, 'market-review-submit')).toBe(false);
  });

  it('is off while the open-items check finds something missing, or the admin is unknown', () => {
    expect(isOff(drawn({ ...base, missingOpenItems: ['tags'] }), 'market-review-submit')).toBe(
      true,
    );
    expect(isOff(drawn(base, null), 'market-review-submit')).toBe(true);
  });

  it('is only a draft’s', () => {
    for (const status of ['review', 'scheduled', 'open'] as const) {
      expect(drawn({ ...base, status }), status).toBe('');
    }
  });
});

describe('the review dialogs’ fields', () => {
  it('draws every checklist item as a checkbox with its name and its line, then the reason', () => {
    const html = renderWithQueries(
      <ApproveFields
        checked={['knownResult', 'leadClose']}
        onToggle={() => {}}
        reason=""
        onReason={() => {}}
        reasonError={null}
        checklistError={null}
        disabled={false}
      />,
    );
    expect(testIdsStartingWith(html, 'market-review-check-')).toEqual(
      MARKET_REVIEW_CHECKLIST.map((item) => `market-review-check-${item}`),
    );
    for (const item of MARKET_REVIEW_CHECKLIST) {
      const box = byTestId(html, `market-review-check-${item}`);
      expect(box?.text, item).toContain(REVIEW_CHECK_LABEL[item]);
      expect(box?.text, item).toContain(REVIEW_CHECK_HINT[item]);
      expect(box?.attributes['data-state'], item).toBe(
        item === 'knownResult' || item === 'leadClose' ? 'checked' : 'unchecked',
      );
    }
    expect(html).toContain(copy.adminMarketReviewChecklistHint);
    expect(byTestId(html, 'market-review-approve-reason')?.attributes.maxLength).toBe('500');
  });

  it('says a refusal of the checklist and of the reason where they are', () => {
    const html = renderWithQueries(
      <ApproveFields
        checked={[]}
        onToggle={() => {}}
        reason="x"
        onReason={() => {}}
        reasonError={copy.errMarketReviewReason}
        checklistError={copy.errMarketReviewChecklist}
        disabled={false}
      />,
    );
    expect(byTestId(html, 'market-review-checklist-error')?.text).toBe(
      copy.errMarketReviewChecklist,
    );
    expect(byTestId(html, 'market-review-approve-reason-error')?.text).toBe(
      copy.errMarketReviewReason,
    );
  });

  it('offers the 반려 사유 from the list, after a placeholder, and asks for the 설명', () => {
    const html = renderWithQueries(
      <RejectFields
        value=""
        onValue={() => {}}
        description=""
        onDescription={() => {}}
        reasonError={null}
        descriptionError={null}
        disabled={false}
      />,
    );
    const options = byTagName(html, 'option');
    expect(options.map((option) => option.attributes.value)).toEqual([
      '',
      ...MARKET_REJECT_REASONS,
    ]);
    expect(options.map((option) => option.text)).toEqual([
      copy.adminMarketReviewRejectReasonPlaceholder,
      ...MARKET_REJECT_REASONS.map((reason) => REJECT_REASON_LABEL[reason]),
    ]);
    expect(html).toContain(copy.adminMarketReviewRejectDescription);
    expect(byTestId(html, 'market-review-reject-description')).toBeDefined();
  });

  it('draws the reschedule’s KST input with the order rule under it', () => {
    const html = renderWithQueries(
      <RescheduleFields
        market={base}
        local="2026-11-20T09:00"
        onLocal={() => {}}
        atError={copy.errMarketTimeOpenBeforeClose}
        reason=""
        onReason={() => {}}
        reasonError={null}
        disabled={false}
      />,
    );
    const input = byTestId(html, 'market-review-reschedule-at');
    expect(input?.attributes.type).toBe('datetime-local');
    expect(input?.attributes.value).toBe('2026-11-20T09:00');
    expect(byTestId(html, 'market-review-reschedule-at-error')?.text).toBe(
      copy.errMarketTimeOpenBeforeClose,
    );
    expect(byTestId(html, 'market-review-reschedule-current')?.text).toContain(
      formatKst(base.closeAt),
    );
    expect(html).toContain(copy.adminMarketReviewRescheduleAt);
    expect(copy.adminMarketReviewRescheduleAt).toContain('(KST)');
  });
});
