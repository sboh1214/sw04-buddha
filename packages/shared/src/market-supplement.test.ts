import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  APPROVAL_KIND_MAX_LENGTH,
  APPROVAL_KIND_PATTERN,
  APPROVAL_REASON_MAX_LENGTH,
  APPROVAL_REFUSALS,
} from './approvals.js';
import {
  INT4_MAX,
  MARKET_FALLBACK_SOURCES_MAX,
  MARKET_TEXT_MAX,
  MARKET_TITLE_MAX,
} from './constants.js';
import { MARKET_STATUSES } from './enums.js';
import { expectedAccountBodySchema } from './expected-account.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import * as shared from './index.js';
import { RULES_EDITED_ITEMS } from './market-edits.js';
import { RULE_ITEMS, STORABLE_INSTANT_TOO_EARLY } from './market-rules.js';
import {
  FIXED_AFTER_OPEN_ITEMS,
  MARKET_SUPPLEMENT_APPROVAL_KIND,
  MARKET_SUPPLEMENT_REFUSALS,
  MARKET_SUPPLEMENT_REJECT_REASONS,
  MARKET_SUPPLEMENT_STATUSES,
  PAUSED_SUPPLEMENT_ITEMS,
  RULE_VERSION_ITEMS,
  SUPPLEMENT_CHANGES_REQUIRED,
  SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED,
  SUPPLEMENT_ITEMS,
  SUPPLEMENT_ITEMS_ONLY,
  SUPPLEMENT_ONLY_WHILE_OPEN,
  adminMarketSupplementItemSchema,
  adminMarketSupplementSchema,
  adminRuleVersionSchema,
  applySupplementChanges,
  approveMarketSupplementBodySchema,
  changedRuleVersionItems,
  marketRuleContentSchema,
  marketRuleVersionSchema,
  marketSupplementChangesSchema,
  marketSupplementLogEntrySchema,
  marketSupplementPendingSchema,
  marketSupplementRequestPayloadSchema,
  rejectMarketSupplementBodySchema,
  requestMarketSupplementBodySchema,
  retractMarketSupplementBodySchema,
  ruleVersionItemSchema,
  supplementChanges,
  supplementItemSchema,
  supplementItemsOf,
} from './market-supplement.js';
import { TIME_ITEMS } from './market-times.js';

const at = '2026-11-01T00:00:00.000Z';
const account = 'admin-1';
const requestId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const marketId = '9b2e1f4c-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const requester = { id: 'admin-1', nickname: '운영자1' };
const approver = { id: 'admin-2', nickname: null };

const issues = (result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];
const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

/** A full text as v1 holds it: every RULE_VERSION_ITEMS item. */
const content = {
  title: '2026년 안에 코스피 3000?',
  description: '코스피 지수의 연말 종가를 묻는다.',
  yesCondition: '12월 30일 코스피 종가가 3000 이상이면 YES.',
  noCondition: '사건 기한까지 3000 이상으로 마감하지 않으면 NO.',
  eventDeadline: '2026-12-30T06:30:00.000Z',
  primarySource: { name: '한국거래소', url: 'https://data.krx.co.kr' },
  fallbackSources: [{ name: '한국거래소 보도자료', url: 'https://www.krx.co.kr' }],
  fallbackCondition: '1차 출처에 종가가 없으면 대체 출처를 본다.',
  longDelayDays: 14,
  delayHandling: '장기 지연 기한까지 종가가 나오지 않으면 무효로 판정한다.',
  scheduledOpenAt: '2026-09-01T00:00:00.000Z',
  closeAt: '2026-12-30T05:00:00.000Z',
  scheduledAnnouncementAt: '2026-12-30T06:30:00.000Z',
  scheduledJudgementAt: '2026-12-31T01:00:00.000Z',
  judgementTimeZone: 'Asia/Seoul',
};

/** A market opened with every item blank (the open checks nothing again, #21): its v1. */
const blank = {
  title: '빈 시장',
  description: null,
  yesCondition: '',
  noCondition: '',
  eventDeadline: null,
  primarySource: null,
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: null,
  delayHandling: '',
  scheduledOpenAt: null,
  closeAt: '2026-12-30T05:00:00.000Z',
  scheduledAnnouncementAt: null,
  scheduledJudgementAt: null,
  judgementTimeZone: null,
};

describe('rule version items (#80, ADR-0093 decision 2 #172 items 7·14)', () => {
  it('names its approval kind like every consumer', () => {
    expect(MARKET_SUPPLEMENT_APPROVAL_KIND).toBe('market_supplement');
    expect(APPROVAL_KIND_PATTERN.test(MARKET_SUPPLEMENT_APPROVAL_KIND)).toBe(true);
    expect(MARKET_SUPPLEMENT_APPROVAL_KIND.length).toBeLessThanOrEqual(APPROVAL_KIND_MAX_LENGTH);
  });

  it('versions the title, the nine rule items and the five times, in the form’s order', () => {
    expect(RULE_VERSION_ITEMS).toEqual(['title', ...RULE_ITEMS, ...TIME_ITEMS]);
    expect(RULE_VERSION_ITEMS).toHaveLength(15);
    expect(new Set(RULE_VERSION_ITEMS).size).toBe(RULE_VERSION_ITEMS.length);
    // `rules_edited`'s items are a part of it; the category, the tags, the image, the slug and the
    // bot's settings are none of it.
    for (const item of RULES_EDITED_ITEMS) expect(RULE_VERSION_ITEMS).toContain(item);
    for (const outside of ['categoryId', 'category', 'tags', 'imageUrl', 'slug', 'liquidityB']) {
      expect(ruleVersionItemSchema.safeParse(outside).success).toBe(false);
    }
  });

  it('lets a supplement change every item but the scheduled open and judgement', () => {
    expect(FIXED_AFTER_OPEN_ITEMS).toEqual(['scheduledOpenAt', 'scheduledJudgementAt']);
    expect(SUPPLEMENT_ITEMS).toEqual(
      RULE_VERSION_ITEMS.filter(
        (item) => !(FIXED_AFTER_OPEN_ITEMS as readonly string[]).includes(item),
      ),
    );
    expect(SUPPLEMENT_ITEMS).toEqual([
      'title',
      ...RULE_ITEMS,
      'closeAt',
      'scheduledAnnouncementAt',
      'judgementTimeZone',
    ]);
    expect(supplementItemSchema.options).toEqual([...SUPPLEMENT_ITEMS]);
    // The close never moves while PAUSED; the rest does.
    expect(PAUSED_SUPPLEMENT_ITEMS).toEqual(SUPPLEMENT_ITEMS.filter((item) => item !== 'closeAt'));
  });

  it('takes a supplement in OPEN and PAUSED, and rejects one for a meaning change', () => {
    expect(MARKET_SUPPLEMENT_STATUSES).toEqual(['open', 'paused']);
    for (const status of MARKET_SUPPLEMENT_STATUSES) expect(MARKET_STATUSES).toContain(status);
    expect(MARKET_SUPPLEMENT_REJECT_REASONS).toEqual(['meaning_change', 'other']);
    // The request is refused when no other admin could decide it (#139's refusal, reused).
    expect(APPROVAL_REFUSALS).toContain('no_decider');
  });

  it('names its refusals apart, each a message a client maps', () => {
    expect(MARKET_SUPPLEMENT_REFUSALS).toEqual({
      status: 'not open or paused',
      closeAt: 'closed',
      ruleVersion: 'none',
      baseVersion: 'stale',
      supplement: 'pending',
      changes: 'unchanged',
    });
    const messages = [
      ...Object.values(MARKET_SUPPLEMENT_REFUSALS),
      SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED,
      SUPPLEMENT_ONLY_WHILE_OPEN,
      SUPPLEMENT_CHANGES_REQUIRED,
      SUPPLEMENT_ITEMS_ONLY,
    ];
    expect(new Set(messages).size).toBe(messages.length);
    expect(SUPPLEMENT_ONLY_WHILE_OPEN).toBe('supplement only while open');
  });

  it('stores and answers names no excluded feature or private item reads', () => {
    for (const name of [
      'ruleVersion',
      'ruleVersions',
      'changedItems',
      'content',
      'baseVersion',
      'settlementImpact',
      'rejectReason',
      'market_rule_versions',
      'changed_items',
      'settlement_impact',
      MARKET_SUPPLEMENT_APPROVAL_KIND,
      ...MARKET_SUPPLEMENT_REJECT_REASONS,
    ]) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
      expect(findExcludedIdentifier(name, 'storage'), name).toEqual([]);
    }
    // The public version's fields read as nobody's data.
    for (const name of Object.keys(marketRuleVersionSchema.shape)) {
      expect(findPrivateField(name), name).toEqual([]);
    }
  });
});

describe('marketRuleContentSchema', () => {
  it('holds every version item, in RULE_VERSION_ITEMS order', () => {
    expect(Object.keys(marketRuleContentSchema.shape)).toEqual([...RULE_VERSION_ITEMS]);
    expect(marketRuleContentSchema.parse(content)).toEqual(content);
  });

  it('keeps a blank item blank, as the market opened with it', () => {
    expect(marketRuleContentSchema.parse(blank)).toEqual(blank);
  });

  it('requires every item and an instant the database stores', () => {
    for (const item of RULE_VERSION_ITEMS) {
      const { [item]: _gone, ...without } = content;
      expect(paths(marketRuleContentSchema.safeParse(without)), item).toEqual([item]);
    }
    expect(paths(marketRuleContentSchema.safeParse({ ...content, closeAt: null }))).toEqual([
      'closeAt',
    ]);
    expect(
      issues(
        marketRuleContentSchema.safeParse({
          ...content,
          eventDeadline: '0099-12-31T23:59:59.999Z',
        }),
      ),
    ).toEqual([`eventDeadline: ${STORABLE_INSTANT_TOO_EARLY}`]);
  });
});

describe('changedRuleVersionItems', () => {
  it('finds nothing between a text and itself, the trimmed title and the same instant too', () => {
    expect(changedRuleVersionItems(content, content)).toEqual([]);
    expect(
      changedRuleVersionItems(content, {
        ...content,
        title: ` ${content.title} `,
        closeAt: '2026-12-30T05:00:00Z',
      }),
    ).toEqual([]);
  });

  it('lists every changed item in RULE_VERSION_ITEMS order', () => {
    const after = {
      ...content,
      judgementTimeZone: 'Asia/Tokyo',
      closeAt: '2026-12-30T05:30:00.000Z',
      fallbackSources: [],
      description: null,
      title: '2026년 안에 코스피 3000 돌파?',
    };
    expect(changedRuleVersionItems(content, after)).toEqual([
      'title',
      'description',
      'fallbackSources',
      'closeAt',
      'judgementTimeZone',
    ]);
    // Every item, the fixed ones included: a version compares whole texts.
    expect(changedRuleVersionItems(content, { ...blank, title: 'x' })).toEqual([
      ...RULE_VERSION_ITEMS.filter((item) => item !== 'closeAt'),
    ]);
  });
});

describe('marketSupplementChangesSchema', () => {
  it('takes any supplement item, trimmed as the update body takes it', () => {
    expect(marketSupplementChangesSchema.parse({ title: ' 새 제목 ' })).toEqual({
      title: '새 제목',
    });
    expect(
      marketSupplementChangesSchema.parse({
        description: ' 배경 ',
        primarySource: { name: ' 거래소 ', url: ' https://krx.co.kr ' },
        fallbackSources: [],
        closeAt: '2026-12-30T06:00:00Z',
        scheduledAnnouncementAt: null,
        judgementTimeZone: ' Asia/Tokyo ',
      }),
    ).toEqual({
      description: '배경',
      primarySource: { name: '거래소', url: 'https://krx.co.kr' },
      fallbackSources: [],
      closeAt: '2026-12-30T06:00:00Z',
      scheduledAnnouncementAt: null,
      judgementTimeZone: 'Asia/Tokyo',
    });
    // Null clears a nullable item; whether that is allowed is the service's (RULES_REQUIRED).
    for (const item of ['description', 'eventDeadline', 'primarySource', 'longDelayDays']) {
      expect(marketSupplementChangesSchema.parse({ [item]: null })).toEqual({ [item]: null });
    }
    for (const item of SUPPLEMENT_ITEMS) {
      expect(Object.keys(marketSupplementChangesSchema.shape)).toContain(item);
    }
    expect(Object.keys(marketSupplementChangesSchema.shape)).toEqual([...SUPPLEMENT_ITEMS]);
  });

  it('requires at least one item', () => {
    for (const changes of [{}, { title: undefined }]) {
      expect(issues(marketSupplementChangesSchema.safeParse(changes))).toEqual([
        `: ${SUPPLEMENT_CHANGES_REQUIRED}`,
      ]);
    }
  });

  it('refuses the fixed times and anything outside the version as one issue naming them', () => {
    for (const key of [...FIXED_AFTER_OPEN_ITEMS, 'categoryId', 'tags', 'imageUrl', 'slug']) {
      expect(
        issues(marketSupplementChangesSchema.safeParse({ title: '새 제목', [key]: null })),
      ).toEqual([`: ${SUPPLEMENT_ITEMS_ONLY}: ${key}`]);
      // Alone, it is still the one issue: the change named something.
      expect(issues(marketSupplementChangesSchema.safeParse({ [key]: null }))).toEqual([
        `: ${SUPPLEMENT_ITEMS_ONLY}: ${key}`,
      ]);
    }
    expect(
      issues(
        marketSupplementChangesSchema.safeParse({
          scheduledOpenAt: at,
          scheduledJudgementAt: at,
        }),
      ),
    ).toEqual([`: ${SUPPLEMENT_ITEMS_ONLY}: scheduledOpenAt, scheduledJudgementAt`]);
  });

  it('holds each item to the update body’s limits', () => {
    const refused = (changes: Record<string, unknown>) =>
      paths(marketSupplementChangesSchema.safeParse(changes));
    expect(refused({ title: '  ' })).toEqual(['title']);
    expect(refused({ title: null })).toEqual(['title']);
    expect(refused({ title: 'x'.repeat(MARKET_TITLE_MAX + 1) })).toEqual(['title']);
    expect(refused({ yesCondition: 'x'.repeat(MARKET_TEXT_MAX + 1) })).toEqual(['yesCondition']);
    expect(refused({ yesCondition: null })).toEqual(['yesCondition']);
    // The close is never cleared, and an instant is one the database stores.
    expect(refused({ closeAt: null })).toEqual(['closeAt']);
    expect(refused({ closeAt: '2026-12-30' })).toEqual(['closeAt']);
    expect(
      issues(marketSupplementChangesSchema.safeParse({ closeAt: '0099-12-31T23:59:59.999Z' })),
    ).toEqual([`closeAt: ${STORABLE_INSTANT_TOO_EARLY}`]);
    expect(refused({ judgementTimeZone: 'Mars/Olympus' })).toEqual(['judgementTimeZone']);
    expect(
      refused({
        fallbackSources: Array.from({ length: MARKET_FALLBACK_SOURCES_MAX + 1 }, () => ({
          name: '출처',
          url: 'https://example.com',
        })),
      }),
    ).toEqual(['fallbackSources']);
    expect(refused({ primarySource: { name: '', url: '' } })).toEqual(['primarySource']);
    expect(refused({ primarySource: { name: '출처', url: 'ftp://example.com' } })).toEqual([
      'primarySource.url',
    ]);
    expect(refused({ longDelayDays: 0 })).toEqual(['longDelayDays']);
    expect(refused({ longDelayDays: 1.5 })).toEqual(['longDelayDays']);
  });
});

describe('applying a supplement', () => {
  it('lists the items a change names, in SUPPLEMENT_ITEMS order', () => {
    expect(supplementItemsOf({ closeAt: at, title: 'x', description: null })).toEqual([
      'title',
      'description',
      'closeAt',
    ]);
    expect(supplementItemsOf({ title: undefined, yesCondition: 'x' })).toEqual(['yesCondition']);
  });

  it('gives each named item its new value and keeps every other', () => {
    const changes = {
      description: null,
      fallbackSources: [],
      fallbackCondition: '',
      closeAt: '2026-12-30T05:30:00.000Z',
    };
    const after = applySupplementChanges(content, changes);
    expect(after).toEqual({ ...content, ...changes });
    // The text it started from is untouched.
    expect(content.description).toBe('코스피 지수의 연말 종가를 묻는다.');
    expect(changedRuleVersionItems(content, after)).toEqual([
      'description',
      'fallbackSources',
      'fallbackCondition',
      'closeAt',
    ]);
    expect(applySupplementChanges(content, { title: undefined, yesCondition: 'x' })).toEqual({
      ...content,
      yesCondition: 'x',
    });
  });

  it('keeps of a change only what differs from the version', () => {
    const after = applySupplementChanges(content, {
      title: content.title,
      closeAt: '2026-12-30T05:00:00Z',
      noCondition: '새 NO 조건',
    });
    expect(supplementChanges(content, after)).toEqual({ noCondition: '새 NO 조건' });
    expect(supplementChanges(content, content)).toEqual({});
    // The fixed times are never part of a change, even where two texts differ in them.
    expect(
      supplementChanges(content, { ...content, scheduledJudgementAt: at, title: '새 제목' }),
    ).toEqual({ title: '새 제목' });
  });
});

describe('the supplement bodies', () => {
  const body = {
    baseVersion: 1,
    changes: { description: ' 보충한 배경 ' },
    reason: ' 배경의 오타 ',
    settlementImpact: ' 판정 기준이 같아 영향 없음 ',
    expectedAccountId: account,
  };

  it('take a request against a version, trimmed', () => {
    expect(requestMarketSupplementBodySchema.parse(body)).toEqual({
      baseVersion: 1,
      changes: { description: '보충한 배경' },
      reason: '배경의 오타',
      settlementImpact: '판정 기준이 같아 영향 없음',
      expectedAccountId: account,
    });
    expect(
      requestMarketSupplementBodySchema.parse({ ...body, baseVersion: INT4_MAX }).baseVersion,
    ).toBe(INT4_MAX);
  });

  it('refuse a request missing its version, change, reason, impact review or account', () => {
    for (const baseVersion of [undefined, null, 0, 1.5, '1', INT4_MAX + 1]) {
      expect(paths(requestMarketSupplementBodySchema.safeParse({ ...body, baseVersion }))).toEqual([
        'baseVersion',
      ]);
    }
    for (const changes of [undefined, null, {}]) {
      expect(paths(requestMarketSupplementBodySchema.safeParse({ ...body, changes }))).toEqual([
        'changes',
      ]);
    }
    expect(
      issues(
        requestMarketSupplementBodySchema.safeParse({
          ...body,
          changes: { scheduledJudgementAt: at },
        }),
      ),
    ).toEqual([`changes: ${SUPPLEMENT_ITEMS_ONLY}: scheduledJudgementAt`]);
    for (const field of ['reason', 'settlementImpact'] as const) {
      for (const value of ['', '   ', 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1), undefined]) {
        expect(
          paths(requestMarketSupplementBodySchema.safeParse({ ...body, [field]: value })),
        ).toEqual([field]);
      }
    }
    expect(
      paths(requestMarketSupplementBodySchema.safeParse({ ...body, expectedAccountId: '' })),
    ).toEqual(['expectedAccountId']);
  });

  it('take an approval with a reason and a 반려 with a reason from the list', () => {
    expect(
      approveMarketSupplementBodySchema.parse({
        reason: ' 의미 같음 ',
        expectedAccountId: account,
      }),
    ).toEqual({ reason: '의미 같음', expectedAccountId: account });
    for (const reason of ['', ' ', 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1), undefined]) {
      expect(
        paths(approveMarketSupplementBodySchema.safeParse({ reason, expectedAccountId: account })),
      ).toEqual(['reason']);
    }
    expect(paths(approveMarketSupplementBodySchema.safeParse({ reason: '같음' }))).toEqual([
      'expectedAccountId',
    ]);
    for (const rejectReason of MARKET_SUPPLEMENT_REJECT_REASONS) {
      expect(
        rejectMarketSupplementBodySchema.parse({
          rejectReason,
          reason: ' 의미가 바뀜 ',
          expectedAccountId: account,
        }),
      ).toEqual({ rejectReason, reason: '의미가 바뀜', expectedAccountId: account });
    }
    for (const rejectReason of ['ambiguity', '', undefined]) {
      expect(
        paths(
          rejectMarketSupplementBodySchema.safeParse({
            rejectReason,
            reason: '의미가 바뀜',
            expectedAccountId: account,
          }),
        ),
      ).toEqual(['rejectReason']);
    }
    expect(
      paths(
        rejectMarketSupplementBodySchema.safeParse({
          rejectReason: 'other',
          reason: ' ',
          expectedAccountId: account,
        }),
      ),
    ).toEqual(['reason']);
  });

  it('take a retraction with the account alone', () => {
    expect(retractMarketSupplementBodySchema).toBe(expectedAccountBodySchema);
    expect(retractMarketSupplementBodySchema.parse({ expectedAccountId: account })).toEqual({
      expectedAccountId: account,
    });
    expect(paths(retractMarketSupplementBodySchema.safeParse({}))).toEqual(['expectedAccountId']);
  });
});

describe('the supplement records and read models', () => {
  const versionOne = { version: 1, createdAt: at, changedItems: [], reason: null, content };
  const versionTwo = {
    version: 2,
    createdAt: '2026-11-02T00:00:00.000Z',
    changedItems: ['description'],
    reason: '배경의 오타',
    content: { ...content, description: '보충한 배경' },
  };
  const pending = {
    requestId,
    requestedBy: requester,
    requestedAt: at,
    baseVersion: 2,
    items: ['closeAt'],
    changes: { closeAt: '2026-12-30T05:30:00.000Z' },
    reason: '마감을 늦춘다',
    settlementImpact: '발표 전 마감이라 영향 없음',
  };
  const undecided = {
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    rejectReason: null,
    retractedAt: null,
    version: null,
  };

  it('store the request payload frozen at the insert', () => {
    const payload = {
      baseVersion: 1,
      changes: { description: '보충한 배경' },
      settlementImpact: '영향 없음',
    };
    expect(marketSupplementRequestPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      paths(marketSupplementRequestPayloadSchema.safeParse({ ...payload, changes: {} })),
    ).toEqual(['changes']);
  });

  it('show a version publicly without anybody and the admin one with them', () => {
    expect(marketRuleVersionSchema.parse(versionOne)).toEqual(versionOne);
    expect(marketRuleVersionSchema.parse(versionTwo)).toEqual(versionTwo);
    for (const version of [0, 1.5]) {
      expect(paths(marketRuleVersionSchema.safeParse({ ...versionOne, version }))).toEqual([
        'version',
      ]);
    }
    expect(Object.keys(marketRuleVersionSchema.shape)).toEqual([
      'version',
      'createdAt',
      'changedItems',
      'reason',
      'content',
    ]);
    // v1: no request, the worker's open (nobody); v2: the requester and the approver.
    const adminOne = {
      ...versionOne,
      approvalId: null,
      requestedBy: null,
      createdBy: null,
      settlementImpact: null,
    };
    const adminTwo = {
      ...versionTwo,
      approvalId: requestId,
      requestedBy: requester,
      createdBy: approver,
      settlementImpact: '영향 없음',
    };
    expect(adminRuleVersionSchema.parse(adminOne)).toEqual(adminOne);
    expect(adminRuleVersionSchema.parse(adminTwo)).toEqual(adminTwo);
    expect(marketRuleVersionSchema.parse(adminTwo)).toEqual(versionTwo);
  });

  it('show the waiting request, every request with how it ended, and the queue', () => {
    expect(marketSupplementPendingSchema.parse(pending)).toEqual(pending);
    expect(
      paths(marketSupplementPendingSchema.safeParse({ ...pending, items: ['scheduledOpenAt'] })),
    ).toEqual(['items.0']);
    const waiting = { ...pending, status: 'pending', ...undecided };
    const approved = {
      ...pending,
      status: 'approved',
      ...undecided,
      decidedBy: approver,
      decidedAt: at,
      decisionReason: '의미 같음',
      version: 3,
    };
    const rejected = {
      ...pending,
      status: 'rejected',
      ...undecided,
      decidedBy: approver,
      decidedAt: at,
      decisionReason: '판정 기준이 바뀐다',
      rejectReason: 'meaning_change',
    };
    const retracted = { ...pending, status: 'retracted', ...undecided, retractedAt: at };
    for (const entry of [waiting, approved, rejected, retracted]) {
      expect(marketSupplementLogEntrySchema.parse(entry)).toEqual(entry);
    }
    const { version: _version, ...withoutVersion } = approved;
    expect(paths(marketSupplementLogEntrySchema.safeParse(withoutVersion))).toEqual(['version']);
    const supplement = { pending, log: [waiting, rejected] };
    expect(adminMarketSupplementSchema.parse(supplement)).toEqual(supplement);
    const none = { pending: null, log: [] };
    expect(adminMarketSupplementSchema.parse(none)).toEqual(none);
    const item = {
      requestId,
      marketId,
      slug: 'kospi-3000',
      title: content.title,
      status: 'closed',
      closeAt: content.closeAt,
      requestedBy: requester,
      requestedAt: at,
      baseVersion: 2,
      items: ['description', 'closeAt'],
    };
    expect(adminMarketSupplementItemSchema.parse(item)).toEqual(item);
  });
});

describe('the OpenAPI component ids', () => {
  it('name each component once across the package', () => {
    const ids = new Map<string, unknown>();
    for (const [name, value] of Object.entries(shared)) {
      if (!(value instanceof z.ZodType)) continue;
      const id = z.globalRegistry.get(value)?.id;
      if (id === undefined) continue;
      const seen = ids.get(id);
      expect(seen === undefined || seen === value, `${name}: ${id}`).toBe(true);
      ids.set(id, value);
    }
    for (const id of [
      'RuleVersionItem',
      'SupplementItem',
      'MarketRuleContent',
      'MarketSupplementChanges',
      'MarketSupplementRejectReason',
      'RequestMarketSupplementBody',
      'ApproveMarketSupplementBody',
      'RejectMarketSupplementBody',
      'MarketRuleVersion',
      'AdminRuleVersion',
      'MarketSupplementPending',
      'MarketSupplementLogEntry',
      'AdminMarketSupplement',
      'AdminMarketSupplementItem',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    // Every new component converts together with the market DTOs, which a duplicate id breaks.
    expect(() =>
      z.toJSONSchema(
        z.object({
          market: shared.adminMarketSchema,
          request: requestMarketSupplementBodySchema,
          queue: adminMarketSupplementItemSchema,
        }),
      ),
    ).not.toThrow();
  });
});
