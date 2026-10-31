import { describe, expect, it } from 'vitest';
import {
  OPEN_ITEMS,
  categoryUnselectableReason,
  missingOpenItems,
  openItemSchema,
} from './market-open-items.js';
import { type MarketRuleItems, RULE_ITEMS } from './market-rules.js';

describe('missingOpenItems (#17, #23)', () => {
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
  const ready = {
    title: '2026년 안에 코스피 3000?',
    ...ruleItems,
    categorySelectable: true,
    tagCount: 1,
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
    categorySelectable: false,
    tagCount: 0,
  };

  it('finds nothing missing with every item, a selectable category and 1..5 tags', () => {
    expect(missingOpenItems(ready)).toEqual([]);
    expect(missingOpenItems({ ...ready, tagCount: 5 })).toEqual([]);
  });

  it('names every missing item in OPEN_ITEMS order', () => {
    expect(missingOpenItems(blank)).toEqual([...OPEN_ITEMS]);
    expect(missingOpenItems({ ...ready, tagCount: 0 })).toEqual(['tags']);
    expect(missingOpenItems({ ...ready, tagCount: 6 })).toEqual(['tags']);
    expect(missingOpenItems({ ...ready, categorySelectable: false })).toEqual(['category']);
    expect(missingOpenItems({ ...ready, title: '' })).toEqual(['title']);
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

  it('keeps the item list a closed enum: title, the rule items, category, tags', () => {
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
      'category',
      'tags',
    ]);
    expect(OPEN_ITEMS).toEqual(['title', ...RULE_ITEMS, 'category', 'tags']);
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
