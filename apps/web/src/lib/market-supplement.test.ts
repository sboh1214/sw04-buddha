import {
  APPROVAL_REASON_MAX_LENGTH,
  APPROVAL_REFUSALS,
  APPROVAL_STATUSES,
  LEAD_CLOSE_GAP_UNDECIDED_MESSAGE,
  MARKET_STATUSES,
  MARKET_SUPPLEMENT_REFUSALS,
  MARKET_SUPPLEMENT_REJECT_REASONS,
  PAUSED_SUPPLEMENT_ITEMS,
  SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED,
  SUPPLEMENT_ITEMS,
  TIME_RULE_MESSAGES,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  type AdminMarket,
  type AdminRuleVersion,
  ApiError,
  type MarketRuleContent,
  type MarketSupplementLogEntry,
  type MarketSupplementPending,
} from './api';
import { formatKst } from './datetime';
import {
  SUPPLEMENT_FORM_UNAVAILABLE_NOTE,
  SUPPLEMENT_REJECT_REASON_LABEL,
  SUPPLEMENT_STATUS_LABEL,
  SUPPLEMENT_UNAPPROVABLE_NOTE,
  SUPPLEMENT_UNAVAILABLE_NOTE,
  adminRuleVersionRows,
  isSupplementRequester,
  marketRuleContent,
  showsSupplementPanel,
  supplementActorName,
  supplementBoundary,
  supplementChangeRows,
  supplementFailure,
  supplementLogRows,
  supplementRefocus,
  supplementRejectBody,
  supplementRejectDraft,
  supplementRejectReasonOf,
  supplementRequestDraft,
  supplementUnapprovable,
  supplementUnavailable,
} from './market-supplement';

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);
const refused = (path: (string | number)[], message: string, code = 'VALIDATION_ERROR') =>
  apiError(code === 'RULES_REQUIRED' ? 422 : 400, code, [{ path, message }]);

const REQUESTER = { id: 'requester', nickname: '요청한이' };
const APPROVER = { id: 'approver', nickname: '승인한이' };
const REQUESTED_AT = '2026-11-02T01:00:00.000Z';

/** v1 as the open fixed it; the market's own fields are the same text (`marketRuleContent`). */
const V1: MarketRuleContent = {
  title: '첫눈이 올까?',
  description: '배경',
  yesCondition: '관측되면 YES',
  noCondition: '아니면 NO',
  eventDeadline: '2026-11-30T14:59:00.000Z',
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

const pending: MarketSupplementPending = {
  requestId: 'r1',
  requestedBy: REQUESTER,
  requestedAt: REQUESTED_AT,
  baseVersion: 1,
  items: ['description', 'closeAt'],
  changes: { description: '고친 배경', closeAt: '2026-11-30T00:00:00.000Z' },
  reason: '오타를 고칩니다.',
  settlementImpact: '판정 기준은 그대로입니다.',
};

const market: AdminMarket = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  slug: 'first-snow',
  ...V1,
  category: { slug: 'weather', nameKo: '날씨' },
  imageUrl: null,
  status: 'open',
  judgementDelayed: false,
  disputeUnderReview: false,
  lastPrice: null,
  lastFillAt: null,
  lastPrice24hAgo: null,
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
  ruleVersions: [v1],
  supplement: { pending: null, log: [] },
  pause: { history: [], pending: null, log: [] },
  // Not judged (#152): no judgement, none waiting, the dispute window decided.
  judgementVersion: null,
  disputeDeadline: null,
  disputeOpen: false,
  disputes: { holding: 0, items: [] },
  judgementDelay: null,
  judgementDelays: [],
  judgement: { current: null, history: [], pending: null, log: [], disputeWindowUndecided: false },
};

/** Before the close (11-29 15:00 UTC) and after it. */
const BEFORE_CLOSE = Date.parse('2026-11-10T00:00:00.000Z');
const AFTER_CLOSE = Date.parse('2026-11-29T15:00:00.000Z');

describe('when the panel offers a supplement (#80, #172 items 14·15)', () => {
  it('draws the panel on an OPEN or PAUSED market, and on any with a version or a request', () => {
    const blank = { ...market, ruleVersion: null, ruleVersions: [] };
    expect(MARKET_STATUSES.filter((status) => showsSupplementPanel({ ...blank, status }))).toEqual([
      'open',
      'paused',
    ]);
    expect(showsSupplementPanel({ ...market, status: 'settled' })).toBe(true);
    expect(
      showsSupplementPanel({
        ...blank,
        status: 'closed',
        supplement: { pending: null, log: [{ ...pending, ...decision('retracted') }] },
      }),
    ).toBe(true);
  });

  it('offers 보충 요청 while OPEN or PAUSED, versioned, before the close, with none waiting', () => {
    expect(supplementUnavailable(market, BEFORE_CLOSE)).toBeNull();
    expect(supplementUnavailable({ ...market, status: 'paused' }, BEFORE_CLOSE)).toBeNull();
    // In the API's order: the status, the version, the close (by the clock too), one waiting.
    expect(supplementUnavailable({ ...market, status: 'closed', ruleVersion: null }, 0)).toBe(
      'status',
    );
    expect(supplementUnavailable({ ...market, ruleVersion: null }, AFTER_CLOSE)).toBe('none');
    expect(supplementUnavailable(market, AFTER_CLOSE)).toBe('closed');
    expect(
      supplementUnavailable({ ...market, supplement: { pending, log: [] } }, BEFORE_CLOSE),
    ).toBe('pending');
    expect(SUPPLEMENT_UNAVAILABLE_NOTE).toEqual({
      status: copy.adminMarketSupplementUnavailableStatus,
      none: copy.adminMarketSupplementUnavailableNone,
      closed: copy.adminMarketSupplementUnavailableClosed,
    });
  });

  it('says in the open form why it cannot be sent now, another request waiting included', () => {
    expect(SUPPLEMENT_FORM_UNAVAILABLE_NOTE).toEqual({
      ...SUPPLEMENT_UNAVAILABLE_NOTE,
      pending: copy.adminMarketSupplementFormPending,
    });
  });

  it('approves the waiting one only while it could be requested; anyone else may reject', () => {
    const description = { items: ['description' as const] };
    expect(supplementUnapprovable(market, pending, BEFORE_CLOSE)).toBeNull();
    expect(supplementUnapprovable({ ...market, status: 'paused' }, description, BEFORE_CLOSE)).toBe(
      null,
    );
    expect(supplementUnapprovable(market, pending, AFTER_CLOSE)).toBe('closed');
    expect(supplementUnapprovable({ ...market, status: 'closed' }, description, BEFORE_CLOSE)).toBe(
      'closed',
    );
    expect(SUPPLEMENT_UNAPPROVABLE_NOTE).toEqual({
      closed: copy.adminMarketSupplementPendingClosed,
      paused: copy.adminMarketSupplementPendingPaused,
    });
  });

  it('approves no item a PAUSED market fixes while it stays PAUSED (#172 item 14)', () => {
    const paused = { ...market, status: 'paused' as const };
    // The close is the one a PAUSED market's supplement leaves out (the shared constant).
    const fixed = SUPPLEMENT_ITEMS.filter((item) => !PAUSED_SUPPLEMENT_ITEMS.includes(item));
    expect(fixed).toEqual(['closeAt']);
    for (const item of SUPPLEMENT_ITEMS) {
      expect(supplementUnapprovable(paused, { items: [item] }, BEFORE_CLOSE), item).toBe(
        fixed.includes(item) ? 'paused' : null,
      );
    }
    // Among other items too; OPEN again, the same request is approved; past the close, 'closed'.
    expect(supplementUnapprovable(paused, pending, BEFORE_CLOSE)).toBe('paused');
    expect(supplementUnapprovable(market, pending, BEFORE_CLOSE)).toBeNull();
    expect(supplementUnapprovable(paused, pending, AFTER_CLOSE)).toBe('closed');
    expect(copy.adminMarketSupplementPendingPaused).toContain('반려하거나 철회');
  });

  it('tells the requester apart once the admin on screen is known', () => {
    expect(isSupplementRequester(pending, REQUESTER.id)).toBe(true);
    expect(isSupplementRequester(pending, APPROVER.id)).toBe(false);
    expect(isSupplementRequester(pending, undefined)).toBeUndefined();
  });

  it('brings focus back to 보충 요청 once the form closes, or where it went (WCAG 2.4.3)', () => {
    const drawn = { waiting: false, request: true, pending: false };
    expect(supplementRefocus(drawn)).toBe('request');
    // A request sent waits in its place: its heading, once the market holding it is drawn.
    expect(supplementRefocus({ ...drawn, waiting: true })).toBeNull();
    expect(supplementRefocus({ ...drawn, request: false, pending: true })).toBe('pending');
    // Closed on a market that takes none any more, nothing waiting: the panel's own heading.
    expect(supplementRefocus({ ...drawn, request: false })).toBe('title');
  });
});

describe('what a supplement changes', () => {
  it('reads the market’s own text as its current version’s', () => {
    expect(marketRuleContent(market)).toEqual(V1);
  });

  it('says each item in its base version and after, in the admin’s KST', () => {
    expect(supplementChangeRows(market, pending, formatKst)).toEqual([
      { item: 'description', label: '배경', before: '배경', after: '고친 배경' },
      {
        item: 'closeAt',
        label: '거래 마감 시각',
        before: formatKst(V1.closeAt),
        after: formatKst('2026-11-30T00:00:00.000Z'),
      },
    ]);
    // A null clears an item; the base is the version the request names, the market's text else.
    const cleared = { ...pending, items: ['description' as const], changes: { description: null } };
    expect(supplementChangeRows({ ...market, ruleVersions: [] }, cleared, formatKst)).toEqual([
      { item: 'description', label: '배경', before: '배경', after: '—' },
    ]);
  });
});

/** A log entry's ending of `status`. */
function decision(
  status: MarketSupplementLogEntry['status'],
): Omit<MarketSupplementLogEntry, keyof MarketSupplementPending> {
  return {
    status,
    decidedBy: status === 'approved' || status === 'rejected' ? APPROVER : null,
    decidedAt: status === 'approved' || status === 'rejected' ? '2026-11-03T01:00:00.000Z' : null,
    decisionReason: status === 'approved' || status === 'rejected' ? '확인했습니다.' : null,
    rejectReason: status === 'rejected' ? 'meaning_change' : null,
    retractedAt: status === 'retracted' ? '2026-11-03T02:00:00.000Z' : null,
    version: status === 'approved' ? 2 : null,
  };
}

describe('the 보충 기록 and the 규칙 버전 기록', () => {
  const head = [
    { label: copy.adminMarketSupplementBase, value: 'v1' },
    { label: copy.adminMarketSupplementItems, value: '배경 · 거래 마감 시각' },
    { label: copy.adminMarketSupplementReason, value: pending.reason },
    { label: copy.adminMarketSupplementImpact, value: pending.settlementImpact },
  ];

  it('names every status and 반려 사유', () => {
    expect(Object.keys(SUPPLEMENT_STATUS_LABEL).sort()).toEqual([...APPROVAL_STATUSES].sort());
    expect(Object.keys(SUPPLEMENT_REJECT_REASON_LABEL)).toEqual([
      ...MARKET_SUPPLEMENT_REJECT_REASONS,
    ]);
    // 의미 변경 says the change belongs to the pause procedure (#172 item 15, #114) — which the
    // 반려 itself does not start, as its dialog says, pointing to the pause (실질 기준 변경).
    expect(SUPPLEMENT_REJECT_REASON_LABEL.meaning_change).toContain('거래를 멈추고 검토');
    expect(copy.adminMarketSupplementRejectBody).toContain('반려는 거래를 멈추지 않');
    expect(copy.adminMarketSupplementRejectBody).toContain('실질 기준 변경을 사유로 일시 중단');
    expect(copy.adminMarketSupplementBoundary).toContain(
      '실질 기준 변경을 사유로 거래를 일시 중단',
    );
  });

  it('says each request and how it ended', () => {
    const at = (iso: string) => formatKst(iso);
    expect(supplementLogRows({ ...pending, ...decision('pending') }, at)).toEqual(head);
    expect(supplementLogRows({ ...pending, ...decision('approved') }, at)).toEqual([
      ...head,
      { label: copy.supplementLogDecidedBy, value: '승인한이' },
      { label: copy.supplementLogDecidedAt, value: formatKst('2026-11-03T01:00:00.000Z') },
      { label: copy.supplementLogDecisionReason, value: '확인했습니다.' },
      { label: copy.supplementLogVersion, value: 'v2' },
    ]);
    expect(supplementLogRows({ ...pending, ...decision('rejected') }, at)).toEqual([
      ...head,
      { label: copy.supplementLogDecidedBy, value: '승인한이' },
      { label: copy.supplementLogDecidedAt, value: formatKst('2026-11-03T01:00:00.000Z') },
      { label: copy.supplementLogRejectReason, value: copy.supplementRejectMeaningChange },
      { label: copy.supplementLogDecisionReason, value: '확인했습니다.' },
    ]);
    expect(supplementLogRows({ ...pending, ...decision('retracted') }, at)).toEqual([
      ...head,
      { label: copy.supplementLogRetractedAt, value: formatKst('2026-11-03T02:00:00.000Z') },
    ]);
  });

  it('says who opened v1 and who asked for and approved a later one, with its impact review', () => {
    expect(adminRuleVersionRows(v1, formatKst)).toEqual([
      { label: copy.adminRuleVersionCreatedAt, value: formatKst(v1.createdAt) },
      // The worker's open has no actor.
      { label: copy.adminRuleVersionOpenedBy, value: copy.eventSystem },
    ]);
    const v2: AdminRuleVersion = {
      ...v1,
      version: 2,
      createdAt: '2026-11-03T01:00:00.000Z',
      changedItems: ['closeAt', 'description'],
      reason: pending.reason,
      approvalId: 'a1',
      requestedBy: REQUESTER,
      createdBy: { id: 'gone', nickname: null },
      settlementImpact: pending.settlementImpact,
    };
    expect(adminRuleVersionRows(v2, formatKst)).toEqual([
      { label: copy.adminRuleVersionCreatedAt, value: formatKst(v2.createdAt) },
      { label: copy.eventRulesItems, value: '배경 · 거래 마감 시각' },
      { label: copy.adminMarketSupplementReason, value: pending.reason },
      { label: copy.adminMarketSupplementRequestedBy, value: '요청한이' },
      // An account closed since, as every byline names it.
      { label: copy.adminRuleVersionApprovedBy, value: copy.postAuthorFormer },
      { label: copy.adminMarketSupplementImpact, value: pending.settlementImpact },
    ]);
    expect(supplementActorName(null)).toBe(copy.eventSystem);
  });
});

describe('what a supplement write may send', () => {
  it('takes a reason and a 정산 영향 검토, each 1..500 trimmed', () => {
    expect(supplementRequestDraft('  사유 ', ' 영향 없음 ')).toEqual({
      ready: true,
      reason: '사유',
      settlementImpact: '영향 없음',
      reasonError: null,
      impactError: null,
    });
    const blank = supplementRequestDraft('  ', '');
    expect(blank.ready).toBe(false);
    expect(blank.reasonError).toBe(copy.errMarketReviewReason);
    expect(blank.impactError).toBe(copy.errMarketSupplementImpact);
    const long = 'a'.repeat(APPROVAL_REASON_MAX_LENGTH + 1);
    expect(supplementRequestDraft('사유', long).ready).toBe(false);
    expect(supplementRequestDraft('사유', long.slice(1)).ready).toBe(true);
  });

  it('takes a 반려 from the list with its 설명', () => {
    expect(supplementRejectReasonOf('meaning_change')).toBe('meaning_change');
    expect(supplementRejectReasonOf('')).toBeNull();
    expect(supplementRejectReasonOf('ambiguity')).toBeNull();
    expect(supplementRejectDraft('other', ' 설명 ')).toEqual({
      ready: true,
      rejectReason: 'other',
      reason: '설명',
    });
    expect(supplementRejectDraft('', '설명').ready).toBe(false);
    expect(supplementRejectDraft('other', ' ').ready).toBe(false);
  });

  it('says the boundary the issue asks the request screen to (#80 AC 8), and where it leads', () => {
    // Since #114 (ADR-0102) the way to stop and review is there: a pause as 실질 기준 변경.
    expect(copy.adminMarketSupplementBoundary).toBe(
      '의미를 바꾸는 변경은 보충으로 받지 않습니다. 거래를 멈추고 검토합니다: 실질 기준 변경을 사유로 거래를 일시 중단하세요.',
    );
    expect(supplementBoundary('open')).toBe(copy.adminMarketSupplementBoundary);
    // A PAUSED market takes no second pause and keeps its reason: the next path decides.
    expect(supplementBoundary('paused')).toBe(copy.adminMarketSupplementBoundaryPaused);
    expect(copy.adminMarketSupplementBoundaryPaused).toContain('재개·조기 마감 요청');
    expect(copy.adminMarketSupplementBoundaryPaused).not.toContain('일시 중단하세요');
  });

  it('says in the 반려 dialog the way to stop and review the market’s status leaves', () => {
    expect(supplementRejectBody('open')).toBe(copy.adminMarketSupplementRejectBody);
    expect(supplementRejectBody('paused')).toBe(copy.adminMarketSupplementRejectBodyPaused);
    expect(copy.adminMarketSupplementRejectBodyPaused).toContain('재개·조기 마감 요청');
    for (const status of ['closed', 'provisional', 'settled'] as const) {
      expect(supplementRejectBody(status)).toBe(copy.adminMarketSupplementRejectBodyEnded);
    }
    for (const status of ['paused', 'closed'] as const) {
      expect(supplementRejectBody(status)).not.toContain('일시 중단하세요');
    }
  });
});

describe('supplementFailure', () => {
  it('closes on another account’s cookie, and says a session or a role gone', () => {
    expect(
      supplementFailure(
        apiError(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'x' }]),
      ),
    ).toEqual({ kind: 'toast', message: copy.sessionChanged });
    expect(supplementFailure(apiError(401, 'UNAUTHENTICATED'))).toEqual({
      kind: 'alert',
      message: copy.errUnauthenticated,
      refresh: false,
    });
    expect(supplementFailure(apiError(403, 'FORBIDDEN'))).toEqual({
      kind: 'alert',
      message: copy.adminOnly,
      refresh: false,
    });
  });

  it('says each two-person refusal, and reads the detail again', () => {
    for (const reason of APPROVAL_REFUSALS) {
      const failure = supplementFailure(refused(['request'], reason, 'APPROVAL_NOT_ALLOWED'));
      expect(failure.kind, reason).toBe('alert');
      expect(failure.kind === 'alert' && failure.refresh, reason).toBe(true);
    }
    const said = (reason: string) =>
      supplementFailure(refused(['request'], reason, 'APPROVAL_NOT_ALLOWED'));
    expect(said('requester')).toMatchObject({
      message: copy.adminMarketSupplementExcludedRequester,
    });
    expect(said('no_decider')).toMatchObject({ message: copy.errApprovalNoDecider });
    expect(said('decided')).toMatchObject({ message: copy.errApprovalDecided });
    expect(said('retracted')).toMatchObject({ message: copy.errApprovalRetracted });
    expect(said('not_requester')).toMatchObject({ message: copy.errApprovalNotRequester });
    expect(said('something new')).toMatchObject({ message: copy.errUnknown });
  });

  it('says each refusal of the market’s state, and reads the detail again', () => {
    const said = {
      status: copy.errMarketSupplementStatus,
      closeAt: copy.errMarketSupplementClosed,
      ruleVersion: copy.errMarketSupplementNoVersion,
      baseVersion: copy.errMarketSupplementStale,
      supplement: copy.errMarketSupplementPending,
      changes: copy.errMarketSupplementUnchanged,
    };
    for (const [path, message] of Object.entries(MARKET_SUPPLEMENT_REFUSALS)) {
      expect(supplementFailure(refused([path], message)), path).toEqual({
        kind: 'alert',
        message: said[path as keyof typeof said],
        refresh: true,
      });
    }
    expect(supplementFailure(refused(['requestId'], 'unknown'))).toEqual({
      kind: 'alert',
      message: copy.errMarketSupplementUnknown,
      refresh: true,
    });
    expect(supplementFailure(apiError(404, 'NOT_FOUND'))).toEqual({
      kind: 'alert',
      message: copy.adminMarketNotFound,
      refresh: true,
    });
  });

  it('puts the reason, the 정산 영향 검토 and the 반려 사유 under their fields', () => {
    expect(supplementFailure(refused(['reason'], 'Too small'))).toEqual({
      kind: 'field',
      field: 'reason',
      message: copy.errMarketReviewReason,
    });
    expect(supplementFailure(refused(['settlementImpact'], 'Too small'))).toEqual({
      kind: 'field',
      field: 'settlementImpact',
      message: copy.errMarketSupplementImpact,
    });
    expect(supplementFailure(refused(['rejectReason'], 'Invalid option'))).toEqual({
      kind: 'field',
      field: 'rejectReason',
      message: copy.errMarketReviewRejectReason,
    });
  });

  it('puts an item’s rule under its input, as the market form says it', () => {
    // RULES_REQUIRED: an item emptied that the market had.
    expect(
      supplementFailure(refused(['yesCondition'], 'required while open', 'RULES_REQUIRED')),
    ).toEqual({
      kind: 'item',
      field: 'yesCondition',
      message: copy.errMarketRulesOpen,
      refresh: false,
    });
    // The close: earlier, while PAUSED (the market moved under the screen), the lead close.
    expect(supplementFailure(refused(['closeAt'], 'cannot move earlier while open'))).toEqual({
      kind: 'item',
      field: 'closeAt',
      message: copy.errMarketCloseEarlier,
      refresh: false,
    });
    expect(supplementFailure(refused(['closeAt'], SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED))).toEqual({
      kind: 'item',
      field: 'closeAt',
      message: copy.errMarketSupplementClosePaused,
      refresh: true,
    });
    expect(
      supplementFailure(refused(['closeAt'], TIME_RULE_MESSAGES.leadClose.closeAt), undefined, 60),
    ).toEqual({
      kind: 'item',
      field: 'closeAt',
      message: `${copy.errMarketLeadCloseBefore} 60${copy.errMarketLeadCloseTail}`,
      refresh: false,
    });
    // A lead close the API could not check: the form asks for the request again, the approval
    // dialog for the approval, each in its words.
    const undecided = refused(['closeAt'], LEAD_CLOSE_GAP_UNDECIDED_MESSAGE);
    const sent = { primarySourceName: '', primarySourceUrl: '', fallbackSources: [] };
    expect(supplementFailure(undecided, sent)).toEqual({
      kind: 'item',
      field: 'closeAt',
      message: copy.errMarketSupplementLeadCloseUndecided,
      refresh: false,
    });
    expect(supplementFailure(undecided)).toMatchObject({
      message: copy.errMarketSupplementApproveLeadCloseUndecided,
    });
    expect(copy.errMarketSupplementApproveLeadCloseUndecided).toMatch(/다시 승인해 주세요\.$/);
    expect(supplementFailure(refused(['fallbackCondition'], 'no fallback source'))).toEqual({
      kind: 'item',
      field: 'fallbackCondition',
      message: copy.errMarketFallbackConditionNoSource,
      refresh: false,
    });
  });

  it('reads an item’s shape under `changes` as the form names it', () => {
    expect(
      supplementFailure(refused(['changes', 'fallbackSources', 1, 'url'], 'Invalid URL')),
    ).toEqual({
      kind: 'item',
      field: 'fallbackSources.1.url',
      message: copy.errMarketSourceUrl,
      refresh: false,
    });
    expect(supplementFailure(refused(['changes', 'title'], 'Too big'))).toEqual({
      kind: 'item',
      field: 'title',
      message: copy.errMarketTitle,
      refresh: false,
    });
    // `changes` itself: a key no item, or none at all — the screen never sends either.
    expect(supplementFailure(refused(['changes'], 'at least one item is required'))).toEqual({
      kind: 'alert',
      message: copy.errMarketInvalid,
      refresh: false,
    });
  });

  it('falls back to the generic messages', () => {
    expect(supplementFailure(refused(['nothing'], 'x'))).toEqual({
      kind: 'alert',
      message: copy.errMarketInvalid,
      refresh: false,
    });
    expect(supplementFailure(apiError(500, 'INTERNAL'))).toEqual({
      kind: 'alert',
      message: copy.errUnknown,
      refresh: false,
    });
    expect(supplementFailure(new Error('offline'))).toEqual({
      kind: 'alert',
      message: copy.errNetwork,
      refresh: false,
    });
  });
});
