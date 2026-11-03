import { describe, expect, it } from 'vitest';
import {
  MARKET_FALLBACK_SOURCES_MAX,
  MARKET_LONG_DELAY_DAYS_MAX,
  MARKET_LONG_DELAY_DAYS_MIN,
  MARKET_SOURCE_MAX,
  MARKET_SOURCE_URL_MAX,
} from './constants.js';
import {
  type MarketRuleItems,
  RULE_ITEMS,
  STORABLE_INSTANT_MIN,
  STORABLE_INSTANT_TOO_EARLY,
  changedRuleItems,
  isCompleteSource,
  marketLongDelayDaysSchema,
  marketRuleItemsSchema,
  marketSourceSchema,
  missingRuleItems,
  ruleItemSchema,
  rulesEditedPayload,
  storableInstantSchema,
} from './market-rules.js';

const issues = (result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

const primary = { name: '한국은행 보도자료', url: 'https://www.bok.or.kr' };
const fallback = { name: '한국은행 경제통계시스템', url: 'https://ecos.bok.or.kr' };
const second = { name: '연합뉴스', url: 'https://www.yna.co.kr' };

/** Every item filled in, no fallback. */
const complete: MarketRuleItems = {
  description: '한국은행 금융통화위원회가 11월 회의에서 기준금리를 내리는지 묻는다.',
  yesCondition: '11월 회의에서 기준금리를 0.25%p 이상 내리면 YES.',
  noCondition: '사건 기한까지 기준금리를 내리지 않으면 NO.',
  eventDeadline: '2026-11-30T15:00:00.000Z',
  primarySource: primary,
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: 14,
  delayHandling: '장기 지연 기한까지 발표가 없으면 무효로 판정한다.',
};

/** Every item blank, as a market opened before #23 has them. */
const blank: MarketRuleItems = {
  description: null,
  yesCondition: '',
  noCondition: '',
  eventDeadline: null,
  primarySource: null,
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: null,
  delayHandling: '',
};

describe('RULE_ITEMS (#23)', () => {
  it('lists the nine items in the form order, one key each everywhere', () => {
    expect(RULE_ITEMS).toEqual([
      'description',
      'yesCondition',
      'noCondition',
      'eventDeadline',
      'primarySource',
      'fallbackSources',
      'fallbackCondition',
      'longDelayDays',
      'delayHandling',
    ]);
    // The DTO fragment carries the same keys in the same order, and the enum is closed.
    expect(Object.keys(marketRuleItemsSchema.shape)).toEqual([...RULE_ITEMS]);
    expect(ruleItemSchema.options).toEqual([...RULE_ITEMS]);
    expect(ruleItemSchema.safeParse('rules').success).toBe(false);
  });

  it('parses a market’s items, an older row’s blanks included', () => {
    expect(marketRuleItemsSchema.parse(complete)).toEqual(complete);
    expect(marketRuleItemsSchema.parse(blank)).toEqual(blank);
    const withFallbacks = {
      ...complete,
      fallbackSources: [fallback, second, { name: '통계청', url: 'https://kostat.go.kr' }],
      fallbackCondition: '1차 출처에 발표가 없으면 대체 출처를 순서대로 확인한다.',
    };
    expect(marketRuleItemsSchema.parse(withFallbacks)).toEqual(withFallbacks);
    expect(
      marketRuleItemsSchema.safeParse({
        ...withFallbacks,
        fallbackSources: [...withFallbacks.fallbackSources, fallback],
      }).success,
    ).toBe(false);
    // Required, never defaulted: a mapper that forgot one fails instead of reading as blank.
    const { eventDeadline: _deadline, ...withoutDeadline } = complete;
    expect(marketRuleItemsSchema.safeParse(withoutDeadline).success).toBe(false);
  });
});

describe('storableInstantSchema (#23, ADR-0097)', () => {
  it('takes every ISO instant from STORABLE_INSTANT_MIN through the last of year 9999', () => {
    for (const instant of [
      STORABLE_INSTANT_MIN,
      '0100-01-01T00:00:00Z',
      '2026-11-30T15:00:00.000Z',
      '9999-12-31T23:59:59.999Z',
      // Digits past the millisecond: `new Date()` drops them, so this is still 9999.
      '9999-12-31T23:59:59.999999Z',
    ]) {
      expect(storableInstantSchema.safeParse(instant).success, instant).toBe(true);
    }
  });

  it('refuses year 0000 and any instant before year 100, which storage cannot keep', () => {
    for (const instant of [
      // 0001-01-01 00:00 KST, as the admin form sends it: Postgres has no year 0000 (22008).
      '0000-12-31T15:00:00Z',
      '0000-01-01T00:00:00.000Z',
      // Stored, but drizzle's `new Date(text)` would read these back as 2001 and 1999.
      '0001-01-01T00:00:00Z',
      '0099-12-31T23:59:59.999Z',
      '0099-12-31T23:59:59.9999Z',
    ]) {
      expect(issues(storableInstantSchema.safeParse(instant)), instant).toEqual([
        `: ${STORABLE_INSTANT_TOO_EARLY}`,
      ]);
    }
  });

  it('refuses a malformed value with the format issue alone; no year past 9999 parses', () => {
    for (const value of [
      '2026-12-30',
      '0050-01-01',
      '2026-12-30T15:30:00+09:00',
      '0099-12-31T23:59Z',
      '10000-01-01T00:00:00Z',
      '+010000-01-01T00:00:00.000Z',
    ]) {
      const result = storableInstantSchema.safeParse(value);
      expect(
        result.error?.issues.map((issue) => issue.code),
        value,
      ).toEqual(['invalid_format']);
    }
  });

  it('bounds the event deadline a market carries, naming it', () => {
    expect(
      issuePaths(
        marketRuleItemsSchema.safeParse({ ...complete, eventDeadline: '0000-12-31T15:00:00Z' }),
      ),
    ).toEqual(['eventDeadline']);
    const earliest = { ...complete, eventDeadline: STORABLE_INSTANT_MIN };
    expect(marketRuleItemsSchema.parse(earliest)).toEqual(earliest);
  });
});

describe('marketSourceSchema (ADR-0093 decision 3 #23 출처 주소)', () => {
  it('takes a name and an http or https address, each trimmed', () => {
    expect(
      marketSourceSchema.parse({ name: ' 한국은행 ', url: ' https://www.bok.or.kr/portal ' }),
    ).toEqual({ name: '한국은행', url: 'https://www.bok.or.kr/portal' });
    expect(marketSourceSchema.parse({ name: 'KRX', url: 'http://data.krx.co.kr' }).url).toBe(
      'http://data.krx.co.kr',
    );
    // Stored as entered: the link review normalises the address, the database CHECK is `~*`.
    expect(marketSourceSchema.parse({ name: 'KRX', url: 'HTTPS://Data.KRX.co.kr' }).url).toBe(
      'HTTPS://Data.KRX.co.kr',
    );
  });

  it('lets a draft keep a half-filled source, which the check counts missing', () => {
    expect(marketSourceSchema.parse({ name: '한국은행', url: '' })).toEqual({
      name: '한국은행',
      url: '',
    });
    expect(marketSourceSchema.parse({ name: '한국은행', url: '   ' }).url).toBe('');
    expect(marketSourceSchema.parse({ name: '', url: 'https://www.bok.or.kr' }).name).toBe('');
  });

  it('refuses an address of another scheme or of none', () => {
    for (const url of [
      'ftp://www.bok.or.kr/a.csv',
      'javascript:alert(1)',
      'mailto:press@bok.or.kr',
      'www.bok.or.kr',
      'https://',
      'not a url',
    ]) {
      const parsed = marketSourceSchema.safeParse({ name: '한국은행', url });
      expect(parsed.success, url).toBe(false);
      expect(issuePaths(parsed), url).toEqual(['url']);
    }
  });

  it('holds the name and the address to 500 characters each', () => {
    expect(MARKET_SOURCE_MAX).toBe(500);
    expect(MARKET_SOURCE_URL_MAX).toBe(500);
    const url = (length: number) => `https://www.bok.or.kr/${'a'.repeat(length - 22)}`;
    expect(url(500)).toHaveLength(500);
    expect(marketSourceSchema.safeParse({ name: 'x'.repeat(500), url: url(500) }).success).toBe(
      true,
    );
    expect(issuePaths(marketSourceSchema.safeParse({ name: 'x'.repeat(501), url: '' }))).toEqual([
      'name',
    ]);
    expect(issuePaths(marketSourceSchema.safeParse({ name: 'x', url: url(501) }))).toEqual(['url']);
    // Counted after the trim.
    expect(marketSourceSchema.safeParse({ name: ` ${'x'.repeat(500)} `, url: '' }).success).toBe(
      true,
    );
  });

  it('refuses a source with both blank, naming the source', () => {
    for (const source of [
      { name: '', url: '' },
      { name: '  ', url: ' ' },
    ]) {
      expect(issues(marketSourceSchema.safeParse(source))).toEqual([': empty source']);
    }
    expect(marketSourceSchema.safeParse({ name: '한국은행' }).success).toBe(false);
  });
});

describe('marketLongDelayDaysSchema (#172 item 10)', () => {
  it('takes whole days 1..365', () => {
    expect([MARKET_LONG_DELAY_DAYS_MIN, MARKET_LONG_DELAY_DAYS_MAX]).toEqual([1, 365]);
    for (const days of [1, 14, 30, 365]) expect(marketLongDelayDaysSchema.parse(days)).toBe(days);
    for (const days of [0, -1, 366, 1.5, Number.NaN]) {
      expect(marketLongDelayDaysSchema.safeParse(days).success, String(days)).toBe(false);
    }
  });
});

describe('isCompleteSource', () => {
  it('wants a name and an address, neither blank', () => {
    expect(isCompleteSource(primary)).toBe(true);
    expect(isCompleteSource({ ...primary, url: '' })).toBe(false);
    expect(isCompleteSource({ ...primary, name: ' ' })).toBe(false);
  });
});

describe('missingRuleItems (#23)', () => {
  it('finds nothing missing on a market with every item, with or without fallbacks', () => {
    expect(missingRuleItems(complete)).toEqual([]);
    expect(
      missingRuleItems({
        ...complete,
        fallbackSources: [fallback, second],
        fallbackCondition: '1차 출처에 발표가 없으면 대체 출처를 순서대로 확인한다.',
      }),
    ).toEqual([]);
  });

  it('names every item in RULE_ITEMS order', () => {
    // An incomplete fallback makes the switch condition asked for too.
    expect(
      missingRuleItems({
        ...blank,
        fallbackSources: [{ name: '한국은행 경제통계시스템', url: '' }],
      }),
    ).toEqual([...RULE_ITEMS]);
    expect(missingRuleItems(blank)).toEqual(
      RULE_ITEMS.filter((item) => item !== 'fallbackSources' && item !== 'fallbackCondition'),
    );
  });

  it('counts a null and a blank text alike', () => {
    for (const description of [null, '', ' \n ']) {
      expect(missingRuleItems({ ...complete, description })).toEqual(['description']);
    }
    expect(missingRuleItems({ ...complete, yesCondition: '  ' })).toEqual(['yesCondition']);
    expect(missingRuleItems({ ...complete, noCondition: '' })).toEqual(['noCondition']);
    expect(missingRuleItems({ ...complete, delayHandling: '\t' })).toEqual(['delayHandling']);
    expect(missingRuleItems({ ...complete, eventDeadline: null })).toEqual(['eventDeadline']);
    expect(missingRuleItems({ ...complete, longDelayDays: null })).toEqual(['longDelayDays']);
  });

  it('wants a primary source with a name and an address', () => {
    expect(missingRuleItems({ ...complete, primarySource: null })).toEqual(['primarySource']);
    expect(missingRuleItems({ ...complete, primarySource: { ...primary, url: '' } })).toEqual([
      'primarySource',
    ]);
    expect(missingRuleItems({ ...complete, primarySource: { ...primary, name: '' } })).toEqual([
      'primarySource',
    ]);
  });

  it('wants every listed fallback complete, and a switch condition only while there is one', () => {
    const condition = '1차 출처에 발표가 없으면 대체 출처를 순서대로 확인한다.';
    expect(
      missingRuleItems({
        ...complete,
        fallbackSources: [fallback, { ...second, name: '' }],
        fallbackCondition: condition,
      }),
    ).toEqual(['fallbackSources']);
    expect(missingRuleItems({ ...complete, fallbackSources: [fallback] })).toEqual([
      'fallbackCondition',
    ]);
    expect(
      missingRuleItems({ ...complete, fallbackSources: [fallback], fallbackCondition: ' ' }),
    ).toEqual(['fallbackCondition']);
    // No fallback: the condition is not asked for, blank or not ('no fallback source' is entry's).
    expect(missingRuleItems({ ...complete, fallbackCondition: '' })).toEqual([]);
    expect(missingRuleItems({ ...complete, fallbackCondition: condition })).toEqual([]);
  });
});

describe('changedRuleItems (#23)', () => {
  it('finds no change in the same values, a trimmed text or the same instant', () => {
    expect(changedRuleItems(complete, { ...complete })).toEqual([]);
    expect(changedRuleItems(blank, { ...blank, description: '' })).toEqual([]);
    expect(
      changedRuleItems(complete, { ...complete, yesCondition: ` ${complete.yesCondition}\n` }),
    ).toEqual([]);
    expect(
      changedRuleItems(complete, { ...complete, eventDeadline: '2026-11-30T15:00:00Z' }),
    ).toEqual([]);
    expect(
      changedRuleItems(
        { ...complete, fallbackSources: [fallback, second] },
        { ...complete, fallbackSources: [{ ...fallback }, { ...second }] },
      ),
    ).toEqual([]);
  });

  it('names each changed item in RULE_ITEMS order', () => {
    expect(changedRuleItems(blank, complete)).toEqual(
      RULE_ITEMS.filter((item) => item !== 'fallbackSources' && item !== 'fallbackCondition'),
    );
    expect(
      changedRuleItems(complete, {
        ...complete,
        delayHandling: '바뀐 처리',
        description: '바뀐 배경',
        longDelayDays: 30,
      }),
    ).toEqual(['description', 'longDelayDays', 'delayHandling']);
    expect(changedRuleItems(complete, { ...complete, eventDeadline: null })).toEqual([
      'eventDeadline',
    ]);
    expect(
      changedRuleItems(complete, {
        ...complete,
        eventDeadline: '2026-11-30T15:01:00.000Z',
        primarySource: { ...primary, url: 'https://www.bok.or.kr/portal' },
      }),
    ).toEqual(['eventDeadline', 'primarySource']);
    expect(changedRuleItems(complete, { ...complete, primarySource: null })).toEqual([
      'primarySource',
    ]);
  });

  it('compares the sources by name and address, in order', () => {
    const two = { ...complete, fallbackSources: [fallback, second], fallbackCondition: '조건' };
    expect(changedRuleItems(two, { ...two, fallbackSources: [second, fallback] })).toEqual([
      'fallbackSources',
    ]);
    expect(changedRuleItems(two, { ...two, fallbackSources: [fallback] })).toEqual([
      'fallbackSources',
    ]);
    expect(
      changedRuleItems(two, { ...two, fallbackSources: [fallback, { ...second, name: '연합' }] }),
    ).toEqual(['fallbackSources']);
    expect(changedRuleItems(two, { ...two, fallbackSources: [], fallbackCondition: '' })).toEqual([
      'fallbackSources',
      'fallbackCondition',
    ]);
  });
});

describe('rulesEditedPayload (#23)', () => {
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
});
