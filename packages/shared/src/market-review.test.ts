import { describe, expect, it } from 'vitest';
import {
  APPROVAL_KIND_MAX_LENGTH,
  APPROVAL_KIND_PATTERN,
  APPROVAL_REASON_MAX_LENGTH,
  APPROVAL_REFUSALS,
  approvalReasonSchema,
} from './approvals.js';
import { MARKET_EVENT_TYPES, MARKET_STATUSES } from './enums.js';
import { STORABLE_INSTANT_TOO_EARLY } from './market-rules.js';
import {
  MARKET_REJECT_REASONS,
  MARKET_REVIEW_APPROVAL_KIND,
  MARKET_REVIEW_CHECKLIST,
  MARKET_REVIEW_EVENT_TYPES,
  MARKET_REVIEW_EXCLUSIONS,
  MARKET_REVIEW_REQUEST_REASON,
  MARKET_REVIEW_UNFINISHED_STATUSES,
  REVIEW_CHECKLIST_INCOMPLETE,
  adminMarketReviewItemSchema,
  adminMarketReviewSchema,
  approveMarketReviewBodySchema,
  isCompleteReviewChecklist,
  marketReviewExclusion,
  marketReviewLogEntrySchema,
  rejectMarketReviewBodySchema,
  rescheduleMarketOpenBodySchema,
  revertMarketBodySchema,
} from './market-review.js';

const at = '2026-11-01T00:00:00.000Z';
const account = 'admin-1';
const requestId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const marketId = '9b2e1f4c-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

const issues = (result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];
const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

describe('market review constants (#78, ADR-0093 decision 2 #172 items 4·5)', () => {
  it('names its approval kind like every consumer, with a non-blank request reason', () => {
    expect(MARKET_REVIEW_APPROVAL_KIND).toBe('market_review');
    expect(APPROVAL_KIND_PATTERN.test(MARKET_REVIEW_APPROVAL_KIND)).toBe(true);
    expect(MARKET_REVIEW_APPROVAL_KIND.length).toBeLessThanOrEqual(APPROVAL_KIND_MAX_LENGTH);
    expect(approvalReasonSchema.parse(MARKET_REVIEW_REQUEST_REASON)).toBe(
      MARKET_REVIEW_REQUEST_REASON,
    );
  });

  it("lists the plan's three bans, then required items, times, lead close, independence", () => {
    expect(MARKET_REVIEW_CHECKLIST).toEqual([
      'knownResult',
      'ambiguity',
      'duplicate',
      'requiredItems',
      'timeOrder',
      'leadClose',
      'independence',
    ]);
    // The bot budget and the config version are #72's.
    for (const later of ['botBudget', 'configVersion']) {
      expect(MARKET_REVIEW_CHECKLIST as readonly string[]).not.toContain(later);
    }
  });

  it('rejects for a checklist item or another reason', () => {
    expect(MARKET_REJECT_REASONS).toEqual([...MARKET_REVIEW_CHECKLIST, 'other']);
    expect(new Set(MARKET_REJECT_REASONS).size).toBe(MARKET_REJECT_REASONS.length);
  });

  it('counts a market unfinished from REVIEW until its result is confirmed (중복)', () => {
    expect(MARKET_REVIEW_UNFINISHED_STATUSES).toEqual([
      'review',
      'scheduled',
      'open',
      'paused',
      'closed',
      'provisional',
    ]);
    for (const status of MARKET_REVIEW_UNFINISHED_STATUSES) {
      expect(MARKET_STATUSES).toContain(status);
    }
  });

  it('excludes the creator, an editor and the submitter, each an approval refusal', () => {
    expect(MARKET_REVIEW_EXCLUSIONS).toEqual(['creator', 'editor', 'requester']);
    for (const exclusion of MARKET_REVIEW_EXCLUSIONS)
      expect(APPROVAL_REFUSALS).toContain(exclusion);
  });

  it('records five market event types, each a market event type', () => {
    expect(MARKET_REVIEW_EVENT_TYPES).toEqual([
      'submitted',
      'approved',
      'rejected',
      'reverted',
      'open_rescheduled',
    ]);
    for (const type of MARKET_REVIEW_EVENT_TYPES) expect(MARKET_EVENT_TYPES).toContain(type);
  });
});

describe('marketReviewExclusion', () => {
  const parties = { createdBy: 'creator', editorIds: ['editor', 'creator'], requestedBy: 'sub' };

  it('names the first exclusion that holds, in MARKET_REVIEW_EXCLUSIONS order', () => {
    expect(marketReviewExclusion('creator', parties)).toBe('creator');
    expect(marketReviewExclusion('editor', parties)).toBe('editor');
    expect(marketReviewExclusion('sub', parties)).toBe('requester');
    // The submitter who also edited it is refused as an editor; the creator who submitted it, as
    // the creator.
    expect(marketReviewExclusion('editor', { ...parties, requestedBy: 'editor' })).toBe('editor');
    expect(marketReviewExclusion('creator', { ...parties, requestedBy: 'creator' })).toBe(
      'creator',
    );
  });

  it('lets a third admin decide, and names no requester while nothing is pending', () => {
    expect(marketReviewExclusion('third', parties)).toBeNull();
    expect(marketReviewExclusion('sub', { ...parties, requestedBy: null })).toBeNull();
    expect(marketReviewExclusion('editor', { ...parties, editorIds: [] })).toBeNull();
  });
});

describe('isCompleteReviewChecklist', () => {
  it('takes every item exactly once, in any order', () => {
    expect(isCompleteReviewChecklist(MARKET_REVIEW_CHECKLIST)).toBe(true);
    expect(isCompleteReviewChecklist([...MARKET_REVIEW_CHECKLIST].reverse())).toBe(true);
  });

  it('refuses a missing, repeated or unknown item', () => {
    expect(isCompleteReviewChecklist([])).toBe(false);
    expect(isCompleteReviewChecklist(MARKET_REVIEW_CHECKLIST.slice(1))).toBe(false);
    expect(isCompleteReviewChecklist([...MARKET_REVIEW_CHECKLIST.slice(1), 'ambiguity'])).toBe(
      false,
    );
    expect(isCompleteReviewChecklist([...MARKET_REVIEW_CHECKLIST, 'ambiguity'])).toBe(false);
    expect(isCompleteReviewChecklist([...MARKET_REVIEW_CHECKLIST.slice(1), 'botBudget'])).toBe(
      false,
    );
  });
});

describe('approveMarketReviewBodySchema', () => {
  const body = {
    requestId,
    checklist: [...MARKET_REVIEW_CHECKLIST],
    reason: ' 기준과 출처가 분명함 ',
    expectedAccountId: account,
  };

  it('takes every item confirmed and a trimmed reason', () => {
    expect(approveMarketReviewBodySchema.parse(body)).toEqual({
      ...body,
      reason: '기준과 출처가 분명함',
    });
    expect(
      approveMarketReviewBodySchema.parse({ ...body, checklist: [...body.checklist].reverse() })
        .checklist,
    ).toEqual([...MARKET_REVIEW_CHECKLIST].reverse());
  });

  it('refuses an incomplete checklist on the field, every item to be confirmed', () => {
    for (const checklist of [
      [],
      MARKET_REVIEW_CHECKLIST.slice(0, -1),
      [...MARKET_REVIEW_CHECKLIST.slice(1), 'knownResult', 'knownResult'],
      [...MARKET_REVIEW_CHECKLIST, 'duplicate'],
    ]) {
      expect(issues(approveMarketReviewBodySchema.safeParse({ ...body, checklist }))).toEqual([
        `checklist: ${REVIEW_CHECKLIST_INCOMPLETE}`,
      ]);
    }
    // An unknown item is the enum's issue on that item.
    expect(
      paths(
        approveMarketReviewBodySchema.safeParse({
          ...body,
          checklist: [...MARKET_REVIEW_CHECKLIST.slice(1), 'botBudget'],
        }),
      ),
    ).toEqual(['checklist.6']);
    expect(
      paths(approveMarketReviewBodySchema.safeParse({ ...body, checklist: undefined })),
    ).toEqual(['checklist']);
  });

  it('requires a reason within the approval limit and the account on screen', () => {
    for (const reason of ['', '   ', 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1), undefined]) {
      expect(paths(approveMarketReviewBodySchema.safeParse({ ...body, reason }))).toEqual([
        'reason',
      ]);
    }
    expect(
      approveMarketReviewBodySchema.parse({
        ...body,
        reason: 'x'.repeat(APPROVAL_REASON_MAX_LENGTH),
      }).reason,
    ).toHaveLength(APPROVAL_REASON_MAX_LENGTH);
    expect(
      paths(approveMarketReviewBodySchema.safeParse({ ...body, expectedAccountId: undefined })),
    ).toEqual(['expectedAccountId']);
    expect(
      paths(approveMarketReviewBodySchema.safeParse({ ...body, expectedAccountId: '' })),
    ).toEqual(['expectedAccountId']);
  });

  it('names the request its admin reviewed (Codex review of #78)', () => {
    // Any casing reads as the stored, lower-case id.
    expect(
      approveMarketReviewBodySchema.parse({ ...body, requestId: requestId.toUpperCase() })
        .requestId,
    ).toBe(requestId);
    expect(
      rejectMarketReviewBodySchema.parse({
        requestId: requestId.toUpperCase(),
        rejectReason: 'other',
        reason: '다시 봅니다',
        expectedAccountId: account,
      }).requestId,
    ).toBe(requestId);
    for (const requestId of [undefined, '', 'nope']) {
      expect(paths(approveMarketReviewBodySchema.safeParse({ ...body, requestId }))).toEqual([
        'requestId',
      ]);
      expect(paths(rejectMarketReviewBodySchema.safeParse({ ...body, requestId }))).toContain(
        'requestId',
      );
    }
  });
});

describe('rejectMarketReviewBodySchema', () => {
  const body = {
    requestId,
    rejectReason: 'ambiguity',
    reason: ' YES 조건이 모호함 ',
    expectedAccountId: account,
  };

  it('takes one of the reject reasons and a trimmed description', () => {
    for (const rejectReason of MARKET_REJECT_REASONS) {
      expect(rejectMarketReviewBodySchema.parse({ ...body, rejectReason })).toEqual({
        ...body,
        rejectReason,
        reason: 'YES 조건이 모호함',
      });
    }
  });

  it('refuses another reason, a blank or missing description and a missing account', () => {
    for (const rejectReason of ['botBudget', 'spam', '', undefined]) {
      expect(paths(rejectMarketReviewBodySchema.safeParse({ ...body, rejectReason }))).toEqual([
        'rejectReason',
      ]);
    }
    for (const reason of ['', '  ', 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1), undefined]) {
      expect(paths(rejectMarketReviewBodySchema.safeParse({ ...body, reason }))).toEqual([
        'reason',
      ]);
    }
    expect(
      paths(rejectMarketReviewBodySchema.safeParse({ ...body, expectedAccountId: undefined })),
    ).toEqual(['expectedAccountId']);
  });
});

describe('revertMarketBodySchema', () => {
  it('requires a trimmed reason and the account on screen', () => {
    expect(
      revertMarketBodySchema.parse({ reason: ' 시각 수정 ', expectedAccountId: account }),
    ).toEqual({ reason: '시각 수정', expectedAccountId: account });
    for (const reason of ['', ' ', 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1), undefined]) {
      expect(
        paths(revertMarketBodySchema.safeParse({ reason, expectedAccountId: account })),
      ).toEqual(['reason']);
    }
    expect(paths(revertMarketBodySchema.safeParse({ reason: '시각 수정' }))).toEqual([
      'expectedAccountId',
    ]);
  });
});

describe('rescheduleMarketOpenBodySchema', () => {
  const body = { scheduledOpenAt: at, reason: ' 일찍 연다 ', expectedAccountId: account };

  it('takes an instant, a past one included, and a trimmed reason', () => {
    expect(rescheduleMarketOpenBodySchema.parse(body)).toEqual({ ...body, reason: '일찍 연다' });
    // The service checks the order against the close; a past instant opens the market at once.
    expect(
      rescheduleMarketOpenBodySchema.parse({ ...body, scheduledOpenAt: '2020-01-01T00:00:00Z' })
        .scheduledOpenAt,
    ).toBe('2020-01-01T00:00:00Z');
  });

  it('requires the instant, never null, an ISO instant the database stores', () => {
    for (const scheduledOpenAt of [
      undefined,
      null,
      '',
      '2026-11-01',
      '2026-11-01T09:00:00+09:00',
    ]) {
      expect(paths(rescheduleMarketOpenBodySchema.safeParse({ ...body, scheduledOpenAt }))).toEqual(
        ['scheduledOpenAt'],
      );
    }
    expect(
      issues(
        rescheduleMarketOpenBodySchema.safeParse({
          ...body,
          scheduledOpenAt: '0099-12-31T23:59:59.999Z',
        }),
      ),
    ).toEqual([`scheduledOpenAt: ${STORABLE_INSTANT_TOO_EARLY}`]);
  });

  it('requires a reason and the account on screen', () => {
    for (const reason of ['', ' ', 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1), undefined]) {
      expect(paths(rescheduleMarketOpenBodySchema.safeParse({ ...body, reason }))).toEqual([
        'reason',
      ]);
    }
    expect(
      paths(rescheduleMarketOpenBodySchema.safeParse({ ...body, expectedAccountId: undefined })),
    ).toEqual(['expectedAccountId']);
  });
});

describe('the review read models', () => {
  const actor = { id: 'admin-1', nickname: '운영자1' };
  const closed = { id: 'admin-2', nickname: null };
  const submitted = {
    type: 'submitted',
    actor,
    at,
    fromStatus: 'draft',
    toStatus: 'review',
    reason: null,
    rejectReason: null,
    checklist: null,
    scheduledOpenBefore: null,
    scheduledOpenAfter: null,
  };
  const rescheduled = {
    ...submitted,
    type: 'open_rescheduled',
    actor: null,
    fromStatus: null,
    toStatus: null,
    reason: '일찍 연다',
    scheduledOpenBefore: at,
    scheduledOpenAfter: '2026-10-31T00:00:00.000Z',
  };

  it('parses a log entry of each type, the fields its type carries none of null', () => {
    expect(marketReviewLogEntrySchema.parse(submitted)).toEqual(submitted);
    expect(marketReviewLogEntrySchema.parse(rescheduled)).toEqual(rescheduled);
    const approved = {
      ...submitted,
      type: 'approved',
      fromStatus: 'review',
      toStatus: 'scheduled',
      reason: '확인함',
      checklist: [...MARKET_REVIEW_CHECKLIST],
    };
    expect(marketReviewLogEntrySchema.parse(approved)).toEqual(approved);
    const rejected = {
      ...submitted,
      type: 'rejected',
      fromStatus: 'review',
      toStatus: 'draft',
      reason: '모호함',
      rejectReason: 'other',
    };
    expect(marketReviewLogEntrySchema.parse(rejected)).toEqual(rejected);
    // Only the review's types, and every field present.
    expect(marketReviewLogEntrySchema.safeParse({ ...submitted, type: 'opened' }).success).toBe(
      false,
    );
    const { checklist: _checklist, ...withoutChecklist } = submitted;
    expect(marketReviewLogEntrySchema.safeParse(withoutChecklist).success).toBe(false);
  });

  it('parses the review of a market in REVIEW and of one with no review yet', () => {
    const review = {
      pending: { requestId, requestedBy: actor, requestedAt: at },
      createdBy: actor,
      editors: [actor, closed],
      sameCondition: [{ id: marketId, slug: 'kospi-3000', title: '코스피 3000?', status: 'open' }],
      log: [submitted],
    };
    expect(adminMarketReviewSchema.parse(review)).toEqual(review);
    const draft = { pending: null, createdBy: actor, editors: [], sameCondition: [], log: [] };
    expect(adminMarketReviewSchema.parse(draft)).toEqual(draft);
    expect(
      adminMarketReviewSchema.safeParse({
        ...review,
        pending: { ...review.pending, requestId: 'x' },
      }).success,
    ).toBe(false);
    expect(adminMarketReviewSchema.safeParse({ ...draft, createdBy: null }).success).toBe(false);
  });

  it('parses a queue row', () => {
    const item = {
      marketId,
      slug: 'kospi-3000',
      title: '코스피 3000?',
      categoryName: '주택',
      scheduledOpenAt: null,
      closeAt: at,
      requestedBy: actor,
      requestedAt: at,
      createdBy: closed,
    };
    expect(adminMarketReviewItemSchema.parse(item)).toEqual(item);
    expect(adminMarketReviewItemSchema.safeParse({ ...item, closeAt: null }).success).toBe(false);
  });
});
