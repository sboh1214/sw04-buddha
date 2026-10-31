import { describe, expect, it } from 'vitest';
import { MARKET_FALLBACK_SOURCES_MAX } from './constants.js';
import {
  RULES_EDITED_ITEMS,
  type RulesEditedValues,
  changedRulesEditedItems,
  rulesEditedItemSchema,
  rulesEditedPayload,
} from './market-edits.js';
import { RULE_ITEMS } from './market-rules.js';
import { TIME_ITEMS } from './market-times.js';

const primary = { name: '한국은행 보도자료', url: 'https://www.bok.or.kr' };
const fallback = { name: '한국은행 경제통계시스템', url: 'https://ecos.bok.or.kr' };

/** Every item filled in, no fallback, an announcement time and the zone. */
const complete: RulesEditedValues = {
  description: '한국은행 금융통화위원회가 11월 회의에서 기준금리를 내리는지 묻는다.',
  yesCondition: '11월 회의에서 기준금리를 0.25%p 이상 내리면 YES.',
  noCondition: '사건 기한까지 기준금리를 내리지 않으면 NO.',
  eventDeadline: '2026-11-30T15:00:00.000Z',
  primarySource: primary,
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: 14,
  delayHandling: '장기 지연 기한까지 발표가 없으면 무효로 판정한다.',
  scheduledAnnouncementAt: '2026-11-27T01:00:00.000Z',
  judgementTimeZone: 'Asia/Seoul',
};

/** Every item blank, as a market opened before #23 and #22 has them. */
const blank: RulesEditedValues = {
  description: null,
  yesCondition: '',
  noCondition: '',
  eventDeadline: null,
  primarySource: null,
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: null,
  delayHandling: '',
  scheduledAnnouncementAt: null,
  judgementTimeZone: null,
};

describe('RULES_EDITED_ITEMS (#22, ADR-0098)', () => {
  it('counts the rule items and the two time items that are 판정 항목, in the form order', () => {
    expect(RULES_EDITED_ITEMS).toEqual([
      ...RULE_ITEMS,
      'scheduledAnnouncementAt',
      'judgementTimeZone',
    ]);
    expect(rulesEditedItemSchema.options).toEqual([...RULES_EDITED_ITEMS]);
    // The scheduled open, the close and the judgement are `market_update`'s, as the title is.
    for (const item of ['scheduledOpenAt', 'closeAt', 'scheduledJudgementAt', 'title']) {
      expect(rulesEditedItemSchema.safeParse(item).success, item).toBe(false);
    }
    // Every time item it counts is a time item, in TIME_ITEMS order.
    const times = RULES_EDITED_ITEMS.slice(RULE_ITEMS.length);
    expect(TIME_ITEMS.filter((item) => (times as readonly string[]).includes(item))).toEqual(times);
  });
});

describe('changedRulesEditedItems (#22)', () => {
  it('compares the rule items as #23 does, the announcement by instant and the zone by name', () => {
    expect(changedRulesEditedItems(complete, { ...complete })).toEqual([]);
    // '…00Z' and '…00.000Z' are one instant.
    expect(
      changedRulesEditedItems(complete, {
        ...complete,
        scheduledAnnouncementAt: '2026-11-27T01:00:00Z',
      }),
    ).toEqual([]);
    expect(
      changedRulesEditedItems(complete, {
        ...complete,
        scheduledAnnouncementAt: '2026-11-27T01:00:01.000Z',
      }),
    ).toEqual(['scheduledAnnouncementAt']);
    expect(
      changedRulesEditedItems(complete, { ...complete, scheduledAnnouncementAt: null }),
    ).toEqual(['scheduledAnnouncementAt']);
    // A zone by its name: an alias is another value, as stored.
    expect(changedRulesEditedItems(complete, { ...complete, judgementTimeZone: 'ROK' })).toEqual([
      'judgementTimeZone',
    ]);
    expect(
      changedRulesEditedItems(complete, {
        ...complete,
        yesCondition: ` ${complete.yesCondition} `,
        judgementTimeZone: null,
      }),
    ).toEqual(['judgementTimeZone']);
    expect(changedRulesEditedItems(blank, complete)).toEqual(
      RULES_EDITED_ITEMS.filter(
        (item) => item !== 'fallbackSources' && item !== 'fallbackCondition',
      ),
    );
  });
});

describe('rulesEditedPayload (#23, #22)', () => {
  it('carries the changed items and each one’s value before and after, or nothing', () => {
    expect(rulesEditedPayload(complete, { ...complete })).toBeNull();
    const after = {
      ...complete,
      description: null,
      fallbackSources: [fallback],
      fallbackCondition: '1차 출처에 발표가 없으면 대체 출처를 본다.',
    };
    expect(rulesEditedPayload(complete, after)).toEqual({
      items: ['description', 'fallbackSources', 'fallbackCondition'],
      before: {
        description: complete.description,
        fallbackSources: [],
        fallbackCondition: '',
      },
      after: {
        description: null,
        fallbackSources: [fallback],
        fallbackCondition: '1차 출처에 발표가 없으면 대체 출처를 본다.',
      },
    });
    // A JSON column keeps it as it is.
    const payload = rulesEditedPayload(blank, complete);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    expect(payload?.after.primarySource).toEqual(primary);
    expect(payload?.before.eventDeadline).toBeNull();
    expect(MARKET_FALLBACK_SOURCES_MAX).toBe(3);
  });

  it('lists rule items and time items together, in RULES_EDITED_ITEMS order', () => {
    const after: RulesEditedValues = {
      ...complete,
      judgementTimeZone: 'America/New_York',
      noCondition: '사건 기한까지 내리지 않으면 NO.',
      scheduledAnnouncementAt: null,
    };
    expect(rulesEditedPayload(complete, after)).toEqual({
      items: ['noCondition', 'scheduledAnnouncementAt', 'judgementTimeZone'],
      before: {
        noCondition: complete.noCondition,
        scheduledAnnouncementAt: '2026-11-27T01:00:00.000Z',
        judgementTimeZone: 'Asia/Seoul',
      },
      after: {
        noCondition: '사건 기한까지 내리지 않으면 NO.',
        scheduledAnnouncementAt: null,
        judgementTimeZone: 'America/New_York',
      },
    });
  });
});
