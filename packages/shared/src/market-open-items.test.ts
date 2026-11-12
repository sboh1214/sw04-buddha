import { describe, expect, it } from 'vitest';
import {
  OPEN_ITEMS,
  TIME_RELATION_ITEMS,
  categoryUnselectableReason,
  missingOpenItems,
  openItemSchema,
  timeRelationMessage,
} from './market-open-items.js';
import { type MarketRuleItems, RULE_ITEMS } from './market-rules.js';
import { type MarketTimes, REQUIRED_TIME_ITEMS, timeRuleViolations } from './market-times.js';

describe('missingOpenItems (#17, #23, #22, #119)', () => {
  const ruleItems: MarketRuleItems = {
    description: '코스피가 연말에 3000을 넘는지 묻는다.',
    yesCondition: '12월 30일 종가가 3000 이상이면 YES.',
    noCondition: '사건 기한까지 3000 이상으로 마감하지 않으면 NO.',
    eventDeadline: '2026-12-30T06:30:00.000Z',
    primarySource: { name: '한국거래소', url: 'https://data.krx.co.kr' },
    fallbackSources: [],
    fallbackCondition: '',
    longDelayDays: 14,
    delayHandling: '장기 지연 기한까지 종가가 나오지 않으면 무효로 판정한다.',
  };
  const times: MarketTimes = {
    scheduledOpenAt: '2026-11-01T00:00:00.000Z',
    scheduledAnnouncementAt: null,
    scheduledJudgementAt: '2026-12-31T01:00:00.000Z',
    judgementTimeZone: 'Asia/Seoul',
  };
  const ready = {
    title: '2026년 안에 코스피 3000?',
    ...ruleItems,
    ...times,
    closeAt: '2026-12-29T14:59:59.000Z',
    categorySelectable: true,
    tagCount: 1,
    leadCloseGapMinutes: null,
    priceProtectionTicks: 5,
    liquidityVersion: 1,
  };
  const blank = {
    title: '  ',
    description: null,
    yesCondition: '',
    noCondition: '',
    eventDeadline: null,
    primarySource: null,
    fallbackSources: [{ name: '', url: 'https://www.krx.co.kr' }],
    fallbackCondition: '',
    longDelayDays: null,
    delayHandling: '',
    scheduledOpenAt: null,
    // An announcement before the close, while the gap is undecided: the lead close fails.
    scheduledAnnouncementAt: '2026-12-01T00:00:00.000Z',
    scheduledJudgementAt: null,
    judgementTimeZone: null,
    closeAt: '2026-12-29T14:59:59.000Z',
    categorySelectable: false,
    tagCount: 0,
    leadCloseGapMinutes: null,
    priceProtectionTicks: null,
    liquidityVersion: null,
  };

  it('finds nothing missing with every item, a selectable category and 1..5 tags', () => {
    expect(missingOpenItems(ready)).toEqual([]);
    expect(missingOpenItems({ ...ready, tagCount: 5 })).toEqual([]);
  });

  it('names every missing item in OPEN_ITEMS order', () => {
    // The close is listed and never missing (a market always has one). A blank draft's order
    // cannot be judged; with a deadline after its judgement it fails too.
    expect(
      missingOpenItems({
        ...blank,
        eventDeadline: '2027-01-01T00:00:00.000Z',
        scheduledJudgementAt: '2026-12-31T01:00:00.000Z',
      }),
    ).toEqual(
      OPEN_ITEMS.filter(
        (item) => !['closeAt', 'eventDeadline', 'scheduledJudgementAt'].includes(item),
      ),
    );
    expect(missingOpenItems(blank)).toEqual(
      OPEN_ITEMS.filter((item) => item !== 'closeAt' && item !== 'timeOrder'),
    );
    expect(missingOpenItems({ ...ready, tagCount: 0 })).toEqual(['tags']);
    expect(missingOpenItems({ ...ready, tagCount: 6 })).toEqual(['tags']);
    expect(missingOpenItems({ ...ready, categorySelectable: false })).toEqual(['category']);
    expect(missingOpenItems({ ...ready, title: '' })).toEqual(['title']);
    // The 가격 보호 폭 (#119): missing only with neither the market's own nor the default.
    expect(missingOpenItems({ ...ready, priceProtectionTicks: null })).toEqual(['priceProtection']);
    expect(missingOpenItems({ ...ready, priceProtectionTicks: 1 })).toEqual([]);
    expect(missingOpenItems({ ...ready, yesCondition: ' ', tagCount: 0 })).toEqual([
      'yesCondition',
      'tags',
    ]);
    // The rule items as `missingRuleItems` counts them: the switch condition only with a fallback.
    expect(
      missingOpenItems({
        ...ready,
        primarySource: { name: '한국거래소', url: '' },
        fallbackSources: [{ name: 'KRX 정보데이터시스템', url: 'https://data.krx.co.kr/a' }],
      }),
    ).toEqual(['primarySource', 'fallbackCondition']);
  });

  it('names the time items, the order and the lead close after the rule items (#22)', () => {
    expect(missingOpenItems({ ...ready, scheduledOpenAt: null, judgementTimeZone: null })).toEqual([
      'scheduledOpenAt',
      'judgementTimeZone',
    ]);
    expect(missingOpenItems({ ...ready, scheduledJudgementAt: null, tagCount: 0 })).toEqual([
      'scheduledJudgementAt',
      'tags',
    ]);
    // 발표 예정 '없음' is no missing item, decided gap or not.
    expect(missingOpenItems({ ...ready, leadCloseGapMinutes: 60 })).toEqual([]);
    // Out of order: one item for every order rule, the rules in its detail.
    expect(
      missingOpenItems({ ...ready, scheduledJudgementAt: '2026-12-29T14:58:00.000Z' }),
    ).toEqual(['timeOrder']);
    expect(missingOpenItems({ ...ready, scheduledOpenAt: ready.closeAt })).toEqual(['timeOrder']);
    // An announcement: the lead close at the gap, which an undecided setting cannot pass.
    const announced = { ...ready, scheduledAnnouncementAt: '2026-12-29T15:59:59.000Z' };
    expect(missingOpenItems({ ...announced, leadCloseGapMinutes: 60 })).toEqual([]);
    expect(missingOpenItems({ ...announced, leadCloseGapMinutes: 61 })).toEqual(['leadClose']);
    expect(missingOpenItems(announced)).toEqual(['leadClose']);
    expect(
      missingOpenItems({
        ...announced,
        scheduledOpenAt: null,
        scheduledJudgementAt: '2026-12-01T00:00:00.000Z',
        categorySelectable: false,
      }),
    ).toEqual(['scheduledOpenAt', 'timeOrder', 'leadClose', 'category']);
  });

  it('details a relation item by the rules broken: the order rules, or the undecided gap', () => {
    const outOfOrder = {
      ...ready,
      scheduledJudgementAt: '2026-12-01T00:00:00.000Z',
      scheduledAnnouncementAt: '2026-12-29T15:00:00.000Z',
    };
    expect(timeRelationMessage('timeOrder', timeRuleViolations(outOfOrder, 60))).toBe(
      'closeByJudgement, deadlineByJudgement',
    );
    expect(timeRelationMessage('leadClose', timeRuleViolations(outOfOrder, 60))).toBe('leadClose');
    expect(timeRelationMessage('leadClose', timeRuleViolations(outOfOrder, null))).toBe(
      'gap undecided',
    );
  });

  it('keeps the item list a closed enum: title, the rule items, the times, category, tags, width', () => {
    expect(openItemSchema.options).toEqual([
      'title',
      'description',
      'yesCondition',
      'noCondition',
      'eventDeadline',
      'primarySource',
      'fallbackSources',
      'fallbackCondition',
      'longDelayDays',
      'delayHandling',
      'scheduledOpenAt',
      'closeAt',
      'scheduledJudgementAt',
      'judgementTimeZone',
      'timeOrder',
      'leadClose',
      'category',
      'tags',
      'priceProtection',
      'liquidity',
    ]);
    expect(OPEN_ITEMS).toEqual([
      'title',
      ...RULE_ITEMS,
      ...REQUIRED_TIME_ITEMS,
      ...TIME_RELATION_ITEMS,
      'category',
      'tags',
      'priceProtection',
      'liquidity',
    ]);
    // The announcement is optional ('없음', #172 item 13): no open item.
    expect(openItemSchema.safeParse('scheduledAnnouncementAt').success).toBe(false);
    // The old single rules item and its label are gone (ADR-0097).
    expect(openItemSchema.safeParse('rules').success).toBe(false);
  });
});

describe('categoryUnselectableReason (#172 item 1)', () => {
  it('lets a new market go on an active leaf under an active parent, or an active childless top level', () => {
    expect(
      categoryUnselectableReason({ isActive: true, parentActive: true, activeChildCount: 0 }),
    ).toBeNull();
    expect(
      categoryUnselectableReason({ isActive: true, parentActive: null, activeChildCount: 0 }),
    ).toBeNull();
  });

  it('says why one cannot be picked, its own state first', () => {
    expect(
      categoryUnselectableReason({ isActive: false, parentActive: false, activeChildCount: 0 }),
    ).toBe('inactive');
    expect(
      categoryUnselectableReason({ isActive: true, parentActive: false, activeChildCount: 0 }),
    ).toBe('parent_inactive');
    expect(
      categoryUnselectableReason({ isActive: true, parentActive: null, activeChildCount: 2 }),
    ).toBe('subcategories');
  });
});
