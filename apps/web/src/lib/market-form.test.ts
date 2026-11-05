import {
  DEFAULT_JUDGEMENT_TIME_ZONE,
  MARKET_FALLBACK_SOURCES_MAX,
  MARKET_LONG_DELAY_DAYS_MAX,
  MARKET_LONG_DELAY_DAYS_MIN,
  MARKET_TAGS_MAX,
  MARKET_TAGS_MIN,
  PAUSED_SUPPLEMENT_ITEMS,
  TAG_NAME_MAX,
  type TimeRuleField,
  marketTagsSchema,
  missingRuleItems,
  tagNameSchema,
} from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import fc from 'fast-check';
import { createFormControl } from 'react-hook-form';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import { type AdminMarket, type Category } from './api';
import {
  AFTER_SAVE_RESET,
  EMPTY_MARKET_FORM,
  FOLLOW_SERVER_RESET,
  type MarketFormValues,
  addTags,
  formRuleItems,
  formTimes,
  isHttpUrl,
  judgementTimeZoneUnconfirmed,
  formRuleContent,
  marketFormSchema,
  marketToFormValues,
  restoreFixedClose,
  toCreateMarketBody,
  sameTags,
  supplementCloseFixed,
  supplementFormSchema,
  timeRuleDeps,
  toSupplementChanges,
  toUpdateMarketBody,
  withJudgementTimeZonePrefilled,
} from './market-form';

const originalTz = process.env.TZ;
afterAll(() => {
  process.env.TZ = originalTz;
});

const NOW = Date.parse('2026-09-06T00:00:00.000Z');
const now = () => NOW;

const valid: MarketFormValues = {
  ...EMPTY_MARKET_FORM,
  title: '  10월 기준금리가 인하될까?  ',
  description: '배경',
  yesCondition: '한국은행이 기준금리를 내리면 YES',
  noCondition: '사건 기한까지 내리지 않으면 NO',
  eventDeadline: '2026-10-31T23:59',
  primarySourceName: '한국은행',
  primarySourceUrl: 'https://www.bok.or.kr',
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: '14',
  delayHandling: '장기 지연 기한까지 발표가 없으면 무효로 판정한다.',
  categoryId: '3',
  imageUrl: 'https://example.com/a.png',
  // In order (#22): open < close ≤ judgement, and the deadline ≤ judgement (A1); no announcement.
  scheduledOpenAt: '2026-09-07T09:00',
  closeAt: '2026-10-01T09:00',
  scheduledAnnouncementAt: '',
  scheduledJudgementAt: '2026-11-02T10:00',
  judgementTimeZone: 'Asia/Seoul',
  slug: '',
};

const messages = (result: { error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((issue) => issue.message) ?? [];

const pick = <K extends keyof MarketFormValues>(values: MarketFormValues, keys: readonly K[]) =>
  Object.fromEntries(keys.map((key) => [key, values[key]])) as Pick<MarketFormValues, K>;

/** The form's rule-item fields (#23). */
const RULE_FIELDS = [
  'description',
  'yesCondition',
  'noCondition',
  'eventDeadline',
  'primarySourceName',
  'primarySourceUrl',
  'fallbackSources',
  'fallbackCondition',
  'longDelayDays',
  'delayHandling',
] as const;

describe('isHttpUrl', () => {
  it('accepts http(s) only', () => {
    expect(isHttpUrl('https://example.com/x')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('ftp://example.com')).toBe(false);
    expect(isHttpUrl('example.com')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});

describe('marketFormSchema', () => {
  const schema = marketFormSchema({ now });

  it('accepts a complete form and trims the text fields', () => {
    const result = schema.safeParse(valid);
    expect(result.success).toBe(true);
    expect(result.data?.title).toBe('10월 기준금리가 인하될까?');
  });

  it('accepts every rule item, the image and the slug blank (a draft may lack them, #23)', () => {
    expect(
      schema.safeParse({ ...EMPTY_MARKET_FORM, ...pick(valid, ['title', 'categoryId', 'closeAt']) })
        .success,
    ).toBe(true);
    // A source with one of its inputs blank is a draft's too: the open-items check names it.
    expect(
      schema.safeParse({
        ...valid,
        primarySourceUrl: '',
        fallbackSources: [{ name: '', url: 'https://kosis.kr' }],
        fallbackCondition: '1차 출처가 없으면',
      }).success,
    ).toBe(true);
  });

  it("checks each source as the API's marketSourceSchema: http(s), 500 characters, trimmed", () => {
    const at = (values: Partial<MarketFormValues>) =>
      schema.safeParse({ ...valid, ...values }).error?.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })) ?? [];
    for (const bad of ['ftp://example.com', 'javascript:alert(1)', 'example.com', 'mailto:a@b.c']) {
      expect(at({ primarySourceUrl: bad }), bad).toEqual([
        { path: 'primarySourceUrl', message: copy.errMarketSourceUrl },
      ]);
      expect(
        at({ fallbackSources: [{ name: '통계청', url: bad }], fallbackCondition: '없으면' }),
        bad,
      ).toEqual([{ path: 'fallbackSources.0.url', message: copy.errMarketSourceUrl }]);
    }
    const url500 = `https://e.com/${'a'.repeat(500 - 'https://e.com/'.length)}`;
    expect(at({ primarySourceUrl: url500 })).toEqual([]);
    expect(at({ primarySourceUrl: `${url500}a` })).toEqual([
      { path: 'primarySourceUrl', message: copy.errMarketSourceUrl },
    ]);
    expect(at({ primarySourceName: '가'.repeat(500) })).toEqual([]);
    expect(at({ primarySourceName: '가'.repeat(501) })).toEqual([
      { path: 'primarySourceName', message: copy.errMarketSourceName },
    ]);
    expect(
      schema.safeParse({ ...valid, primarySourceUrl: '  http://bok.or.kr  ' }).data
        ?.primarySourceUrl,
    ).toBe('http://bok.or.kr');
  });

  it('refuses a fallback row with both inputs blank, and a fourth fallback', () => {
    const row = (name: string) => ({ name, url: `https://e.com/${name}` });
    const issues = (values: Partial<MarketFormValues>) =>
      schema
        .safeParse({ ...valid, fallbackCondition: '없으면', ...values })
        .error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];
    expect(issues({ fallbackSources: [row('a'), { name: '  ', url: '' }] })).toEqual([
      `fallbackSources.1: ${copy.errMarketSourceEmpty}`,
    ]);
    const full = Array.from({ length: MARKET_FALLBACK_SOURCES_MAX }, (_, index) =>
      row(String(index)),
    );
    expect(issues({ fallbackSources: full })).toEqual([]);
    expect(issues({ fallbackSources: [...full, row('x')] })).toEqual([
      `fallbackSources: ${copy.errMarketFallbackSourcesMax}`,
    ]);
  });

  it('refuses a switch condition with no fallback to switch to, as the API does', () => {
    expect(
      messages(schema.safeParse({ ...valid, fallbackCondition: '1차 출처가 없으면' })),
    ).toEqual([copy.errMarketFallbackConditionNoSource]);
    expect(schema.safeParse({ ...valid, fallbackCondition: '   ' }).success).toBe(true);
  });

  it('takes the long-delay deadline as whole days from 1 to 365, or blank', () => {
    const days = (longDelayDays: string) => messages(schema.safeParse({ ...valid, longDelayDays }));
    for (const ok of [
      '',
      String(MARKET_LONG_DELAY_DAYS_MIN),
      String(MARKET_LONG_DELAY_DAYS_MAX),
      ' 30 ',
    ]) {
      expect(days(ok), ok).toEqual([]);
    }
    for (const bad of ['0', '366', '1.5', '-3', '1e2', '열흘']) {
      expect(days(bad), bad).toEqual([copy.errMarketLongDelayDays]);
    }
  });

  it('takes the event deadline as a KST time or blank, unordered against the close time', () => {
    // A1 orders it against the scheduled judgement only (below); before the close is fine.
    expect(schema.safeParse({ ...valid, eventDeadline: '' }).success).toBe(true);
    expect(schema.safeParse({ ...valid, eventDeadline: '2026-09-30T09:00' }).success).toBe(true);
    expect(messages(schema.safeParse({ ...valid, eventDeadline: 'nope' }))).toEqual([
      copy.errMarketEventDeadline,
    ]);
  });

  it('refuses an event deadline the API cannot store, under its input (ADR-0097)', () => {
    // 0100-01-01 09:00 KST is STORABLE_INSTANT_MIN, the first instant the API keeps.
    expect(schema.safeParse({ ...valid, eventDeadline: '0100-01-01T09:00' }).success).toBe(true);
    expect(
      schema.safeParse({
        ...valid,
        eventDeadline: '9999-12-31T23:59',
        scheduledJudgementAt: '9999-12-31T23:59',
      }).success,
    ).toBe(true);
    // 0001-01-01 00:00 KST is year 0000 in UTC, which Postgres refuses; one minute before the
    // bound is year 99, which the API would read back as 1999.
    for (const eventDeadline of ['0001-01-01T00:00', '0100-01-01T08:59']) {
      const result = schema.safeParse({ ...valid, eventDeadline });
      expect(
        result.error?.issues.map((issue) => issue.path),
        eventDeadline,
      ).toEqual([['eventDeadline']]);
      expect(messages(result), eventDeadline).toEqual([copy.errMarketEventDeadline]);
    }
  });

  it('bounds every rule text to 5,000 characters', () => {
    for (const field of ['description', 'yesCondition', 'noCondition', 'delayHandling'] as const) {
      expect(schema.safeParse({ ...valid, [field]: 'a'.repeat(5000) }).success, field).toBe(true);
      expect(messages(schema.safeParse({ ...valid, [field]: 'a'.repeat(5001) })), field).toEqual([
        copy.errMarketText,
      ]);
    }
    const withFallback = {
      ...valid,
      fallbackSources: [{ name: '통계청', url: 'https://kosis.kr' }],
    };
    expect(
      messages(schema.safeParse({ ...withFallback, fallbackCondition: 'a'.repeat(5001) })),
    ).toEqual([copy.errMarketText]);
  });

  it('requires a title within 120 characters', () => {
    expect(messages(schema.safeParse({ ...valid, title: '   ' }))).toEqual([copy.errMarketTitle]);
    expect(messages(schema.safeParse({ ...valid, title: 'a'.repeat(121) }))).toEqual([
      copy.errMarketTitle,
    ]);
  });

  it('requires a chosen category', () => {
    expect(messages(schema.safeParse({ ...valid, categoryId: '' }))).toEqual([
      copy.errMarketCategory,
    ]);
  });

  it('refuses a non-http image URL', () => {
    expect(messages(schema.safeParse({ ...valid, imageUrl: 'javascript:alert(1)' }))).toEqual([
      copy.errMarketImageUrl,
    ]);
    expect(
      messages(schema.safeParse({ ...valid, imageUrl: `https://e.com/${'a'.repeat(500)}` })),
    ).toEqual([copy.errMarketImageUrl]);
  });

  it('requires a close time in the future, read as KST', () => {
    process.env.TZ = 'America/New_York';
    // No scheduled open, so only the close's own rule speaks.
    const unopened = { ...valid, scheduledOpenAt: '' };
    // 2026-09-06 08:59 KST = 2026-09-05 23:59Z: one minute before NOW.
    expect(messages(schema.safeParse({ ...unopened, closeAt: '2026-09-06T08:59' }))).toEqual([
      copy.errMarketCloseAt,
    ]);
    expect(schema.safeParse({ ...unopened, closeAt: '2026-09-06T09:01' }).success).toBe(true);
    expect(messages(schema.safeParse({ ...unopened, closeAt: '' }))).toEqual([
      copy.errMarketCloseAt,
    ]);
    expect(messages(schema.safeParse({ ...unopened, closeAt: 'nope' }))).toEqual([
      copy.errMarketCloseAt,
    ]);
  });

  it('exempts an untouched close time from the future rule when editing', () => {
    // A draft whose close time passed can still have its title fixed: the PATCH omits the
    // unchanged closeAt, and the API only checks what is sent.
    const original = { ...valid, scheduledOpenAt: '2019-12-31T00:00', closeAt: '2020-01-01T00:00' };
    const editing = marketFormSchema({ now, original });
    expect(editing.safeParse(original).success).toBe(true);
    expect(messages(editing.safeParse({ ...original, closeAt: '2020-01-02T00:00' }))).toEqual([
      copy.errMarketCloseAt,
    ]);
  });

  it('exempts an untouched blank category (retired since) when editing', () => {
    // The edit form prefills '' for a category no longer in GET /categories; a title-only
    // edit must still pass, since the PATCH omits the blank and the API accepts one without.
    const original = { ...valid, categoryId: '' };
    const editing = marketFormSchema({ now, original });
    expect(editing.safeParse(original).success).toBe(true);
    expect(editing.safeParse({ ...original, title: '고친 질문' }).success).toBe(true);
    expect(editing.safeParse({ ...original, categoryId: '4' }).success).toBe(true);
    expect(messages(editing.safeParse({ ...original, categoryId: 'x' }))).toEqual([
      copy.errMarketCategory,
    ]);
    // Only a blank *original* is exempt: clearing a chosen category is still a refusal.
    const chosen = marketFormSchema({ now, original: valid });
    expect(messages(chosen.safeParse({ ...valid, categoryId: '' }))).toEqual([
      copy.errMarketCategory,
    ]);
  });

  it('checks a typed slug with the shared rule and lets a blank one through', () => {
    expect(schema.safeParse({ ...valid, slug: '' }).success).toBe(true);
    expect(schema.safeParse({ ...valid, slug: '금리-2026' }).success).toBe(true);
    expect(messages(schema.safeParse({ ...valid, slug: 'ab' }))).toEqual([copy.errMarketSlug]);
    expect(messages(schema.safeParse({ ...valid, slug: 'Upper_Case' }))).toEqual([
      copy.errMarketSlug,
    ]);
    expect(
      messages(schema.safeParse({ ...valid, slug: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })),
    ).toEqual([copy.errMarketSlug]);
  });
});

describe('toCreateMarketBody', () => {
  it('converts the form into the API body: KST → UTC, blanks → null', () => {
    process.env.TZ = 'UTC';
    expect(toCreateMarketBody({ ...valid, description: '  ', imageUrl: '' })).toEqual({
      title: '10월 기준금리가 인하될까?',
      description: null,
      yesCondition: '한국은행이 기준금리를 내리면 YES',
      noCondition: '사건 기한까지 내리지 않으면 NO',
      eventDeadline: '2026-10-31T14:59:00.000Z',
      primarySource: { name: '한국은행', url: 'https://www.bok.or.kr' },
      fallbackSources: [],
      fallbackCondition: '',
      longDelayDays: 14,
      delayHandling: '장기 지연 기한까지 발표가 없으면 무효로 판정한다.',
      categoryId: 3,
      tags: [],
      imageUrl: null,
      scheduledOpenAt: '2026-09-07T00:00:00.000Z',
      closeAt: '2026-10-01T00:00:00.000Z',
      scheduledAnnouncementAt: null,
      scheduledJudgementAt: '2026-11-02T01:00:00.000Z',
      judgementTimeZone: 'Asia/Seoul',
    });
  });

  it('sends every time (#22): a blank one null — 없음 for the announcement — and the zone', () => {
    process.env.TZ = 'UTC';
    expect(
      toCreateMarketBody({
        ...EMPTY_MARKET_FORM,
        ...pick(valid, ['title', 'categoryId', 'closeAt']),
      }),
    ).toMatchObject({
      scheduledOpenAt: null,
      closeAt: '2026-10-01T00:00:00.000Z',
      scheduledAnnouncementAt: null,
      scheduledJudgementAt: null,
      // Pre-filled for the operator to confirm (#172 item 11): a new market sends it.
      judgementTimeZone: DEFAULT_JUDGEMENT_TIME_ZONE,
    });
    expect(
      toCreateMarketBody({
        ...valid,
        scheduledAnnouncementAt: '2026-10-02T08:00',
        judgementTimeZone: 'America/New_York',
      }),
    ).toMatchObject({
      scheduledAnnouncementAt: '2026-10-01T23:00:00.000Z',
      judgementTimeZone: 'America/New_York',
    });
  });

  it('sends every rule item, a blank one as blank (#23): a draft may be made without them', () => {
    const body = toCreateMarketBody({
      ...EMPTY_MARKET_FORM,
      ...pick(valid, ['title', 'categoryId', 'closeAt']),
    });
    expect(body).toMatchObject({
      description: null,
      yesCondition: '',
      noCondition: '',
      eventDeadline: null,
      primarySource: null,
      fallbackSources: [],
      fallbackCondition: '',
      longDelayDays: null,
      delayHandling: '',
    });
  });

  it('trims the sources, keeps a half-filled one, and keeps the fallbacks in order', () => {
    const body = toCreateMarketBody({
      ...valid,
      primarySourceName: '  한국은행 ',
      primarySourceUrl: '   ',
      fallbackSources: [
        { name: ' 연합뉴스 ', url: ' https://yna.co.kr ' },
        { name: '', url: 'https://kosis.kr' },
      ],
      fallbackCondition: '  1차 출처에 없으면  ',
    });
    expect(body.primarySource).toEqual({ name: '한국은행', url: '' });
    expect(body.fallbackSources).toEqual([
      { name: '연합뉴스', url: 'https://yna.co.kr' },
      { name: '', url: 'https://kosis.kr' },
    ]);
    expect(body.fallbackCondition).toBe('1차 출처에 없으면');
    // Both primary inputs blank is no source at all.
    expect(
      toCreateMarketBody({ ...valid, primarySourceName: ' ', primarySourceUrl: '' }).primarySource,
    ).toBeNull();
  });

  it('sends the tags in entry order, and none as an empty list (a draft may have none, #17)', () => {
    expect(toCreateMarketBody({ ...valid, tags: ['금리', 'CPI'] }).tags).toEqual(['금리', 'CPI']);
    expect(toCreateMarketBody(valid).tags).toEqual([]);
    // What the box holds and has not added is never sent.
    expect(toCreateMarketBody({ ...valid, tagInput: '서울' })).not.toHaveProperty('tagInput');
  });

  it('sends no initial probability or liquidity: a market is made without them (#125)', () => {
    const body = toCreateMarketBody(valid);
    expect(body).not.toHaveProperty('initialProbBp');
    expect(body).not.toHaveProperty('liquidityB');
  });

  it('sends the slug only when one was typed', () => {
    expect(toCreateMarketBody(valid)).not.toHaveProperty('slug');
    expect(toCreateMarketBody({ ...valid, slug: ' my-slug ' }).slug).toBe('my-slug');
  });
});

describe('toUpdateMarketBody', () => {
  const original: MarketFormValues = {
    ...valid,
    title: '원래 질문',
    scheduledOpenAt: '2019-12-31T00:00',
    closeAt: '2020-01-01T00:00',
  };

  it('is empty when nothing changed, even with a past close time', () => {
    expect(toUpdateMarketBody(original, original)).toEqual({});
    expect(toUpdateMarketBody({ ...original, title: ' 원래 질문 ' }, original)).toEqual({});
  });

  it('sends only the fields that differ', () => {
    expect(
      toUpdateMarketBody(
        { ...original, title: '새 질문', yesCondition: '새 기준', closeAt: '2026-10-01T09:00' },
        original,
      ),
    ).toEqual({ title: '새 질문', yesCondition: '새 기준', closeAt: '2026-10-01T00:00:00.000Z' });
    expect(toUpdateMarketBody({ ...original, description: '' }, original)).toEqual({
      description: null,
    });
    expect(toUpdateMarketBody({ ...original, categoryId: '4' }, original)).toEqual({
      categoryId: 4,
    });
  });

  it('sends each rule item that changed as the API compares it (#23)', () => {
    process.env.TZ = 'UTC';
    expect(
      toUpdateMarketBody(
        {
          ...original,
          noCondition: '  사건 기한까지 내리지 않으면 NO  ',
          eventDeadline: '2026-11-30T23:59',
          longDelayDays: '30',
          delayHandling: '',
        },
        original,
      ),
    ).toEqual({ eventDeadline: '2026-11-30T14:59:00.000Z', longDelayDays: 30, delayHandling: '' });
    // Cleared: null for the nullable items.
    expect(
      toUpdateMarketBody(
        { ...original, eventDeadline: '', longDelayDays: '', description: ' ' },
        original,
      ),
    ).toEqual({ description: null, eventDeadline: null, longDelayDays: null });
    // A source by name and address: the whole source, or null once both inputs are blank.
    expect(
      toUpdateMarketBody({ ...original, primarySourceUrl: 'https://bok.or.kr/a' }, original),
    ).toEqual({
      primarySource: { name: '한국은행', url: 'https://bok.or.kr/a' },
    });
    expect(
      toUpdateMarketBody({ ...original, primarySourceName: '', primarySourceUrl: '' }, original),
    ).toEqual({ primarySource: null });
    expect(toUpdateMarketBody({ ...original, primarySourceName: ' 한국은행 ' }, original)).toEqual(
      {},
    );
  });

  it('sends the fallbacks as the whole ordered list, always with the switch condition', () => {
    const a = { name: '연합뉴스', url: 'https://yna.co.kr' };
    const b = { name: '통계청', url: 'https://kosis.kr' };
    const withFallbacks = { ...original, fallbackSources: [a, b], fallbackCondition: '없으면' };
    expect(toUpdateMarketBody(withFallbacks, withFallbacks)).toEqual({});
    // Reordered, one added, one removed: the list and the condition together.
    expect(
      toUpdateMarketBody({ ...withFallbacks, fallbackSources: [b, a] }, withFallbacks),
    ).toEqual({
      fallbackSources: [b, a],
      fallbackCondition: '없으면',
    });
    expect(
      toUpdateMarketBody(
        { ...original, fallbackSources: [a], fallbackCondition: '없으면' },
        original,
      ),
    ).toEqual({
      fallbackSources: [a],
      fallbackCondition: '없으면',
    });
    // The last one removed: the field cleared the condition, and both go (the API takes [], '').
    expect(
      toUpdateMarketBody(
        { ...withFallbacks, fallbackSources: [], fallbackCondition: '' },
        withFallbacks,
      ),
    ).toEqual({ fallbackSources: [], fallbackCondition: '' });
    // The condition alone.
    expect(
      toUpdateMarketBody({ ...withFallbacks, fallbackCondition: '둘 다 없으면' }, withFallbacks),
    ).toEqual({
      fallbackCondition: '둘 다 없으면',
    });
    // An address only re-spaced is no change.
    expect(
      toUpdateMarketBody(
        { ...withFallbacks, fallbackSources: [{ ...a, url: ` ${a.url} ` }, b] },
        withFallbacks,
      ),
    ).toEqual({});
  });

  it('sends the whole ordered tag set only when it changed (#17)', () => {
    const tagged = { ...original, tags: ['금리', 'CPI'] };
    expect(toUpdateMarketBody(tagged, tagged)).toEqual({});
    // A tag added, one removed, the order changed: the whole set, in its new order.
    expect(toUpdateMarketBody({ ...tagged, tags: ['금리', 'CPI', '서울'] }, tagged)).toEqual({
      tags: ['금리', 'CPI', '서울'],
    });
    expect(toUpdateMarketBody({ ...tagged, tags: ['CPI'] }, tagged)).toEqual({ tags: ['CPI'] });
    expect(toUpdateMarketBody({ ...tagged, tags: ['CPI', '금리'] }, tagged)).toEqual({
      tags: ['CPI', '금리'],
    });
    expect(toUpdateMarketBody({ ...tagged, tags: [] }, tagged)).toEqual({ tags: [] });
    // Re-cased only: the same tag, which the API would keep in its first spelling anyway.
    expect(toUpdateMarketBody({ ...tagged, tags: ['금리', 'cpi'] }, tagged)).toEqual({});
    // The box is never sent.
    expect(toUpdateMarketBody({ ...tagged, tagInput: '서울' }, tagged)).toEqual({});
  });

  it('sends each time whose input changed, and the zone when it is not the stored one (#22)', () => {
    process.env.TZ = 'UTC';
    expect(
      toUpdateMarketBody(
        {
          ...original,
          scheduledOpenAt: '2019-12-30T10:00',
          scheduledAnnouncementAt: '2026-11-01T10:00',
          scheduledJudgementAt: '2026-11-03T10:00',
          judgementTimeZone: 'America/New_York',
        },
        original,
      ),
    ).toEqual({
      scheduledOpenAt: '2019-12-30T01:00:00.000Z',
      scheduledAnnouncementAt: '2026-11-01T01:00:00.000Z',
      scheduledJudgementAt: '2026-11-03T01:00:00.000Z',
      judgementTimeZone: 'America/New_York',
    });
    // Cleared: null, which for the announcement is 없음.
    const announced = { ...original, scheduledAnnouncementAt: '2026-11-01T10:00' };
    expect(toUpdateMarketBody({ ...announced, scheduledAnnouncementAt: '' }, announced)).toEqual({
      scheduledAnnouncementAt: null,
    });
    // The judgement alone: the close is not sent, nor the other way round (#22 AC 2).
    expect(
      toUpdateMarketBody({ ...original, scheduledJudgementAt: '2026-11-04T10:00' }, original),
    ).toEqual({ scheduledJudgementAt: '2026-11-04T01:00:00.000Z' });
    expect(toUpdateMarketBody({ ...original, closeAt: '2026-10-02T09:00' }, original)).toEqual({
      closeAt: '2026-10-02T00:00:00.000Z',
    });
  });

  it("sends a stored market's missing zone pre-filled, so saving confirms it (#172 item 11)", () => {
    // A draft from before #22, or from an adopted proposal: no zone stored.
    const stored = marketToFormValues({ ...market, judgementTimeZone: null }, categories);
    expect(stored.judgementTimeZone).toBe('');
    const start = withJudgementTimeZonePrefilled(stored);
    expect(start.judgementTimeZone).toBe(DEFAULT_JUDGEMENT_TIME_ZONE);
    // Nothing else touched: the body still carries the zone, and the save is enabled for it.
    expect(toUpdateMarketBody(start, stored)).toEqual({
      judgementTimeZone: DEFAULT_JUDGEMENT_TIME_ZONE,
    });
    expect(judgementTimeZoneUnconfirmed(stored)).toBe(true);
    expect(marketFormSchema({ now, original: stored }).safeParse(start).success).toBe(true);
    // Another zone picked instead is what goes.
    expect(toUpdateMarketBody({ ...start, judgementTimeZone: 'Asia/Tokyo' }, stored)).toEqual({
      judgementTimeZone: 'Asia/Tokyo',
    });
    // Once stored, the form starts from it, unchanged, and nothing is sent.
    const confirmed = marketToFormValues({ ...market, judgementTimeZone: 'ROK' }, categories);
    expect(withJudgementTimeZonePrefilled(confirmed)).toBe(confirmed);
    expect(judgementTimeZoneUnconfirmed(confirmed)).toBe(false);
    expect(toUpdateMarketBody(confirmed, confirmed)).toEqual({});
  });

  it('never sends a blank category (a retired one prefilled as "")', () => {
    const noCategory = { ...original, categoryId: '' };
    expect(toUpdateMarketBody(noCategory, noCategory)).toEqual({});
    expect(toUpdateMarketBody({ ...original, categoryId: '' }, original)).toEqual({});
    // A title-only edit of such a market is `{ title }` once the schema has let it through.
    const edited = { ...noCategory, title: '고친 질문' };
    expect(marketFormSchema({ now, original: noCategory }).safeParse(edited).success).toBe(true);
    expect(toUpdateMarketBody(edited, noCategory)).toEqual({ title: '고친 질문' });
  });
});

describe('toSupplementChanges (#80, ADR-0101)', () => {
  // The market as a supplement's form opens on it (`marketToFormValues`).
  const opened: MarketFormValues = { ...valid, tags: ['금리'] };

  it('is empty when nothing changed — an item typed back to what it was is no change', () => {
    expect(toSupplementChanges(opened, opened)).toEqual({});
    expect(
      toSupplementChanges(
        { ...opened, title: `  ${opened.title}  `, description: '배경 ', longDelayDays: ' 14' },
        opened,
      ),
    ).toEqual({});
  });

  it('sends each changed supplement item with its new value, as the update body takes it', () => {
    expect(
      toSupplementChanges(
        {
          ...opened,
          title: '  새 질문  ',
          description: '',
          primarySourceUrl: 'https://www.bok.or.kr/new',
          closeAt: '2026-10-02T09:00',
          scheduledAnnouncementAt: '2026-10-03T09:00',
          judgementTimeZone: 'America/New_York',
        },
        opened,
      ),
    ).toEqual({
      title: '새 질문',
      description: null,
      primarySource: { name: '한국은행', url: 'https://www.bok.or.kr/new' },
      closeAt: '2026-10-02T00:00:00.000Z',
      scheduledAnnouncementAt: '2026-10-03T00:00:00.000Z',
      judgementTimeZone: 'America/New_York',
    });
  });

  it('never sends the scheduled open or judgement, nor the category, the tags or the image', () => {
    const elsewhere: MarketFormValues = {
      ...opened,
      scheduledOpenAt: '2026-09-08T09:00',
      scheduledJudgementAt: '2026-11-03T10:00',
      categoryId: '9',
      tags: [],
      imageUrl: '',
    };
    expect(toSupplementChanges(elsewhere, opened)).toEqual({});
  });

  it('sends the fallbacks as their whole ordered list, and the condition only once it changed', () => {
    const fallback = { name: '연합뉴스', url: 'https://yna.co.kr' };
    const withFallback = { ...opened, fallbackSources: [fallback], fallbackCondition: '없으면' };
    const second = { name: '통계청', url: 'https://kostat.go.kr' };
    expect(
      toSupplementChanges({ ...withFallback, fallbackSources: [second, fallback] }, withFallback),
    ).toEqual({ fallbackSources: [second, fallback] });
    // The last one gone, the field clears the condition with it: both go.
    expect(
      toSupplementChanges(
        { ...withFallback, fallbackSources: [], fallbackCondition: '' },
        withFallback,
      ),
    ).toEqual({ fallbackSources: [], fallbackCondition: '' });
  });

  it('reads both sides as the inputs hold them: a full text with no time to the second', () => {
    expect(formRuleContent(opened)).toEqual({
      title: '10월 기준금리가 인하될까?',
      ...formRuleItems(opened),
      scheduledOpenAt: '2026-09-07T00:00:00.000Z',
      closeAt: '2026-10-01T00:00:00.000Z',
      scheduledAnnouncementAt: null,
      scheduledJudgementAt: '2026-11-02T01:00:00.000Z',
      judgementTimeZone: 'Asia/Seoul',
    });
  });
});

describe('addTags', () => {
  it('normalises a typed name and adds it at the end', () => {
    expect(addTags([], '  서울  ')).toEqual({ tags: ['서울'], rest: '' });
    expect(addTags(['서울'], '한국   영화')).toEqual({ tags: ['서울', '한국 영화'], rest: '' });
    // NFC: a name typed in decomposed jamo is the composed one.
    expect(addTags([], '서울'.normalize('NFD')).tags).toEqual(['서울']);
  });

  it("splits a pasted list on commas, skipping blanks ('a, b,')", () => {
    expect(addTags([], '서울, 기상청,  , CPI,')).toEqual({
      tags: ['서울', '기상청', 'CPI'],
      rest: '',
    });
    // A box of blanks adds nothing and leaves nothing behind.
    expect(addTags(['서울'], ' , ,')).toEqual({ tags: ['서울'], rest: '' });
  });

  it('refuses a second name of one tag, case and spacing aside', () => {
    expect(addTags(['AI'], 'ai')).toEqual({
      tags: ['AI'],
      rest: 'ai',
      error: copy.errMarketTagDuplicate,
    });
    expect(addTags(['한국 영화'], '한국  영화').error).toBe(copy.errMarketTagDuplicate);
    // Within one pasted list too.
    expect(addTags([], 'CPI, cpi')).toEqual({
      tags: ['CPI'],
      rest: 'cpi',
      error: copy.errMarketTagDuplicate,
    });
  });

  it('refuses a sixth tag', () => {
    const five = ['a1', 'a2', 'a3', 'a4', 'a5'];
    expect(five).toHaveLength(MARKET_TAGS_MAX);
    expect(addTags(five, '서울')).toEqual({
      tags: five,
      rest: '서울',
      error: copy.errMarketTagsMax,
    });
    // A list that would run past five adds up to five and keeps the rest in the box.
    expect(addTags(['a1', 'a2', 'a3', 'a4'], 'b1, b2, b3')).toEqual({
      tags: ['a1', 'a2', 'a3', 'a4', 'b1'],
      rest: 'b2, b3',
      error: copy.errMarketTagsMax,
    });
  });

  it('explains a name too long or outside the allowed characters', () => {
    const long = '가'.repeat(TAG_NAME_MAX + 1);
    expect(addTags([], long)).toEqual({ tags: [], rest: long, error: copy.errMarketTagLength });
    expect(addTags([], '가'.repeat(TAG_NAME_MAX)).tags).toHaveLength(1);
    for (const bad of ['#AI', 'K-', '서울!', '-서울', '이모지🙂', '_밑줄']) {
      expect(addTags([], bad), bad).toEqual({
        tags: [],
        rest: bad,
        error: copy.errMarketTagFormat,
      });
    }
    for (const good of ['S&P500', 'K-팝', '2026 지방선거', 'C++', '원·달러', 'v1.0']) {
      expect(addTags([], good).tags, good).toEqual([good]);
    }
  });

  it('adds the names before a refused one and keeps it, with what follows, in the box as typed', () => {
    expect(addTags([], '서울, 기상#청 ,날씨')).toEqual({
      tags: ['서울'],
      rest: '기상#청 ,날씨',
      error: copy.errMarketTagFormat,
    });
  });

  it("takes one name exactly when the shared tagNameSchema does — the API's rule", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 24 }),
          fc.stringMatching(/^[가-힣A-Za-z0-9 \-_.&+·#!]{0,24}$/),
        ),
        (typed) => {
          fc.pre(!typed.includes(',') && typed.trim() !== '');
          const added = addTags([], typed);
          const parsed = tagNameSchema.safeParse(typed);
          expect(added.tags.length === 1, typed).toBe(parsed.success);
          if (parsed.success) expect(added.tags).toEqual([parsed.data]);
        },
      ),
    );
  });

  it('never leaves a list the shared marketTagsSchema would refuse', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[가-힣A-Za-z0-9 ,]{0,12}$/), { maxLength: 8 }),
        (inputs) => {
          let tags: string[] = [];
          for (const input of inputs) tags = addTags(tags, input).tags;
          expect(marketTagsSchema.safeParse(tags).success).toBe(true);
        },
      ),
    );
  });
});

describe('sameTags', () => {
  it('is the same tags in the same order, case and spacing aside (the API compares so)', () => {
    expect(sameTags([], [])).toBe(true);
    expect(sameTags(['AI', '서울'], ['ai', '서울'])).toBe(true);
    expect(sameTags(['한국 영화'], ['한국  영화'])).toBe(true);
    expect(sameTags(['AI', '서울'], ['서울', 'AI'])).toBe(false);
    expect(sameTags(['AI'], ['AI', '서울'])).toBe(false);
    expect(sameTags(['AI'], ['AJ'])).toBe(false);
  });
});

describe('the rule-item copy', () => {
  it('names the shared bounds of the long-delay deadline and the fallbacks', () => {
    expect(copy.errMarketLongDelayDays).toContain(
      `${String(MARKET_LONG_DELAY_DAYS_MIN)}~${String(MARKET_LONG_DELAY_DAYS_MAX)}일`,
    );
    expect(copy.errMarketFallbackSourcesMax).toContain(`${String(MARKET_FALLBACK_SOURCES_MAX)}개`);
    expect(copy.adminMarketFallbackSources).toContain(`${String(MARKET_FALLBACK_SOURCES_MAX)}개`);
  });
});

describe('the tag copy', () => {
  it('names the shared bounds, so a change to them shows here', () => {
    expect(copy.openItemTags).toContain(`${String(MARKET_TAGS_MIN)}~${String(MARKET_TAGS_MAX)}개`);
    expect(copy.adminMarketTagsHint).toContain(
      `${String(MARKET_TAGS_MIN)}~${String(MARKET_TAGS_MAX)}개`,
    );
    expect(copy.errMarketTagsMax).toContain(`${String(MARKET_TAGS_MAX)}개`);
    expect(copy.errMarketTagLength).toContain(`${String(TAG_NAME_MAX)}자`);
  });
});

const categories: Category[] = [
  { id: 1, slug: 'economy', nameKo: '경제', sortOrder: 1, parentId: null },
  { id: 2, slug: 'weather', nameKo: '날씨', sortOrder: 2, parentId: null },
];

const market: AdminMarket = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  slug: 'rate-cut-2026',
  title: '기준금리 인하?',
  description: null,
  yesCondition: '',
  noCondition: '',
  eventDeadline: null,
  primarySource: null,
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: null,
  delayHandling: '',
  category: { slug: 'weather', nameKo: '날씨' },
  imageUrl: null,
  status: 'draft',
  judgementDelayed: false,
  disputeUnderReview: false,
  lastPrice: null,
  volumeCoin: '0',
  tradeCount: 0,
  traderCount: 0,
  scheduledOpenAt: null,
  closeAt: '2026-10-01T00:00:00.000Z',
  scheduledAnnouncementAt: null,
  scheduledJudgementAt: null,
  judgementTimeZone: 'Asia/Seoul',
  openAt: null,
  resolvedResult: null,
  resolvedAt: null,
  settledAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  createdBy: 'admin',
  netCollectedCoin: '0',
  openInterest: { yes: 0, no: 0 },
  settlementSteps: [],
  statusEventId: '1',
  events: [],
  tags: [],
  // No rule version (#80): not opened yet, or opened before #80 (D4).
  ruleVersion: null,
  ruleVersions: [],
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
  missingOpenItems: [],
  leadCloseGapMinutes: null,
  priceProtectionTicks: null,
  // Never submitted (#78): no request, no editor, no record.
  review: {
    pending: null,
    createdBy: { id: 'admin', nickname: '운영자' },
    editors: [],
    sameCondition: [],
    log: [],
  },
};

describe('marketFormSchema tags', () => {
  const tagMessages = (result: {
    error?: { issues: { message: string; path: PropertyKey[] }[] };
  }) =>
    result.error?.issues
      .filter((issue) => issue.path[0] === 'tags' || issue.path[0] === 'tagInput')
      .map((issue) => `${String(issue.path[0])}: ${issue.message}`) ?? [];

  it('accepts none on a draft, and up to five distinct valid names', () => {
    const schema = marketFormSchema({ now });
    expect(schema.safeParse({ ...valid, tags: [] }).success).toBe(true);
    expect(schema.safeParse({ ...valid, tags: ['a1', 'a2', 'a3', 'a4', 'a5'] }).success).toBe(true);
  });

  it('refuses what the box would have refused (a backstop), on the tags field', () => {
    const schema = marketFormSchema({ now });
    expect(tagMessages(schema.safeParse({ ...valid, tags: ['AI', 'ai'] }))).toEqual([
      `tags: ${copy.errMarketTagDuplicate}`,
    ]);
    expect(
      tagMessages(schema.safeParse({ ...valid, tags: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] })),
    ).toEqual([`tags: ${copy.errMarketTagsMax}`]);
    expect(tagMessages(schema.safeParse({ ...valid, tags: ['#AI'] }))).toEqual([
      `tags: ${copy.errMarketTagFormat}`,
    ]);
  });

  it('refuses an open market edited down to no tags, as the API does', () => {
    const open = marketFormSchema({ now, openMarket: true });
    expect(tagMessages(open.safeParse({ ...valid, tags: [] }))).toEqual([
      `tags: ${copy.errMarketTagsOpen}`,
    ]);
    expect(open.safeParse({ ...valid, tags: ['금리'] }).success).toBe(true);
    // Emptied: refused when the market had tags.
    const tagged = { ...valid, tags: ['금리'] };
    expect(
      tagMessages(
        marketFormSchema({ now, original: tagged, openMarket: true }).safeParse({
          ...tagged,
          tags: [],
        }),
      ),
    ).toEqual([`tags: ${copy.errMarketTagsOpen}`]);
    // Untouched and empty is exempt: a market opened before #17 has no tags, and an edit of its
    // title or close time must still save (the form then sends no tags).
    const legacy = { ...valid, tags: [] };
    expect(
      marketFormSchema({ now, original: legacy, openMarket: true }).safeParse({
        ...legacy,
        title: '새 제목',
      }).success,
    ).toBe(true);
  });

  it('refuses a save while the box holds a name it did not add, rather than dropping it', () => {
    const schema = marketFormSchema({ now });
    expect(tagMessages(schema.safeParse({ ...valid, tagInput: '서울#' }))).toEqual([
      `tagInput: ${copy.errMarketTagPending}`,
    ]);
    expect(schema.safeParse({ ...valid, tagInput: '   ' }).success).toBe(true);
  });
});

describe('supplementFormSchema: the rule items (#23, #80)', () => {
  const tagged = { ...valid, tags: ['금리'] };
  const fallback = { name: '연합뉴스', url: 'https://yna.co.kr' };
  const issues = (original: MarketFormValues, values: MarketFormValues) =>
    supplementFormSchema({ now, original, paused: false, leadCloseGapMinutes: 60 })
      .safeParse(values)
      .error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];

  it('refuses an item the market had emptied, under the input that empties it', () => {
    expect(issues(tagged, { ...tagged, yesCondition: '  ' })).toEqual([
      `yesCondition: ${copy.errMarketRulesOpen}`,
    ]);
    expect(
      issues(tagged, { ...tagged, description: '', eventDeadline: '', longDelayDays: '' }),
    ).toEqual([
      `description: ${copy.errMarketRulesOpen}`,
      `eventDeadline: ${copy.errMarketRulesOpen}`,
      `longDelayDays: ${copy.errMarketRulesOpen}`,
    ]);
    // A source: the blank input, or both once the source is gone.
    expect(issues(tagged, { ...tagged, primarySourceUrl: '' })).toEqual([
      `primarySourceUrl: ${copy.errMarketRulesOpen}`,
    ]);
    expect(issues(tagged, { ...tagged, primarySourceName: '', primarySourceUrl: '' })).toEqual([
      `primarySourceName: ${copy.errMarketRulesOpen}`,
      `primarySourceUrl: ${copy.errMarketRulesOpen}`,
    ]);
    // A fallback left half-filled, and its condition emptied.
    const withFallback = { ...tagged, fallbackSources: [fallback], fallbackCondition: '없으면' };
    expect(
      issues(withFallback, {
        ...withFallback,
        fallbackSources: [fallback, { name: '통계청', url: '' }],
        fallbackCondition: '',
      }),
    ).toEqual([
      `fallbackSources.1.url: ${copy.errMarketRulesOpen}`,
      `fallbackCondition: ${copy.errMarketRulesOpen}`,
    ]);
    // Every one of them is the API's RULES_REQUIRED item for item.
    expect(issues(tagged, tagged)).toEqual([]);
  });

  it('lets the fallbacks go: none is no missing item, and the condition goes with them', () => {
    const withFallback = { ...tagged, fallbackSources: [fallback], fallbackCondition: '없으면' };
    expect(
      issues(withFallback, { ...withFallback, fallbackSources: [], fallbackCondition: '' }),
    ).toEqual([]);
  });

  it('blocks nothing with an item that was already missing: a market opened before #23', () => {
    // Opened with every rule item blank (they did not exist): its other fields stay editable,
    // and filling one item in is no refusal of the others.
    const legacy = { ...tagged, ...pick(EMPTY_MARKET_FORM, RULE_FIELDS) };
    expect(issues(legacy, { ...legacy, title: '고친 질문' })).toEqual([]);
    expect(issues(legacy, { ...legacy, yesCondition: '이제 채운 YES 조건' })).toEqual([]);
    // Once filled, the item is the market's: emptying it again is refused.
    const filled = { ...legacy, yesCondition: '채운 YES 조건' };
    expect(issues(filled, { ...filled, yesCondition: '' })).toEqual([
      `yesCondition: ${copy.errMarketRulesOpen}`,
    ]);
  });

  it('asks none of it of a draft, nor of the open market’s edit, which sends no rule item', () => {
    // Since #80 an open market's rule items change by a supplement alone: the edit form draws them
    // off, and its schema refuses only what it still saves (the tags).
    const blank = { ...tagged, ...pick(EMPTY_MARKET_FORM, RULE_FIELDS) };
    expect(marketFormSchema({ now, original: tagged }).safeParse(blank).success).toBe(true);
    expect(marketFormSchema({ now }).safeParse(blank).success).toBe(true);
    expect(
      marketFormSchema({ now, original: tagged, openMarket: true }).safeParse(blank).success,
    ).toBe(true);
  });

  it('checks the version items alone: never the category, the tags, the image or the slug', () => {
    // The form draws none of them and sends none: a retired category, a stored name the tag box
    // would refuse or a stored slug of another age block no supplement.
    const odd = {
      ...tagged,
      categoryId: 'x',
      tags: [],
      tagInput: '서울#',
      imageUrl: 'ftp://a',
      slug: '!',
    };
    expect(issues(odd, odd)).toEqual([]);
  });

  it("matches the shared check's missing items, so the form refuses what the API would", () => {
    // RULES_REQUIRED compares missingRuleItems before and after the edit; the form compares the
    // same items of its two values (`formRuleItems`).
    expect(missingRuleItems(formRuleItems(valid))).toEqual([]);
    expect(missingRuleItems(formRuleItems(EMPTY_MARKET_FORM))).toEqual([
      'description',
      'yesCondition',
      'noCondition',
      'eventDeadline',
      'primarySource',
      'longDelayDays',
      'delayHandling',
    ]);
  });
});

/** Each issue as `path: message`, in the order the schema raised them. */
const issuesOf = (result: { error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`) ??
  [];

describe('marketFormSchema times (#22)', () => {
  const schema = marketFormSchema({ now });

  it('accepts every time blank but the close, and the zone pre-filled (a draft may lack them)', () => {
    expect(EMPTY_MARKET_FORM.judgementTimeZone).toBe(DEFAULT_JUDGEMENT_TIME_ZONE);
    const draft = {
      ...valid,
      scheduledOpenAt: '',
      scheduledAnnouncementAt: '',
      scheduledJudgementAt: '',
    };
    expect(schema.safeParse(draft).success).toBe(true);
  });

  it('refuses a time the API cannot store, under its input', () => {
    for (const field of [
      'scheduledOpenAt',
      'scheduledAnnouncementAt',
      'scheduledJudgementAt',
    ] as const) {
      expect(issuesOf(schema.safeParse({ ...valid, [field]: 'nope' })), field).toEqual([
        `${field}: ${copy.errMarketScheduledTime}`,
      ]);
      // One minute before STORABLE_INSTANT_MIN (0100-01-01 09:00 KST), as for 사건 기한.
      expect(issuesOf(schema.safeParse({ ...valid, [field]: '0100-01-01T08:59' }))[0], field).toBe(
        `${field}: ${copy.errMarketScheduledTime}`,
      );
    }
  });

  it('takes an IANA zone this browser knows, as the API does, and refuses the rest', () => {
    for (const zone of ['America/New_York', 'UTC', 'Etc/GMT+5', 'ROK']) {
      expect(schema.safeParse({ ...valid, judgementTimeZone: zone }).success, zone).toBe(true);
    }
    for (const zone of ['Mars/Olympus', '+09:00', 'asia/seoul', 'KST']) {
      expect(issuesOf(schema.safeParse({ ...valid, judgementTimeZone: zone })), zone).toEqual([
        `judgementTimeZone: ${copy.errMarketTimeZone}`,
      ]);
    }
  });

  it('refuses a scheduled open at or after the close, under both, by the minute (#172 item 12)', () => {
    const both = [
      `scheduledOpenAt: ${copy.errMarketTimeOpenBeforeClose}`,
      `closeAt: ${copy.errMarketTimeOpenBeforeClose}`,
    ];
    expect(issuesOf(schema.safeParse({ ...valid, scheduledOpenAt: '2026-10-01T09:00' }))).toEqual(
      both,
    );
    expect(issuesOf(schema.safeParse({ ...valid, scheduledOpenAt: '2026-10-02T09:00' }))).toEqual(
      both,
    );
    expect(schema.safeParse({ ...valid, scheduledOpenAt: '2026-10-01T08:59' }).success).toBe(true);
  });

  it('refuses a close after the scheduled judgement, under both; the same minute is fine', () => {
    expect(
      issuesOf(schema.safeParse({ ...valid, closeAt: '2026-11-02T10:01' })).filter(
        (issue) => !issue.startsWith('eventDeadline'),
      ),
    ).toEqual([
      `closeAt: ${copy.errMarketTimeCloseByJudgement}`,
      `scheduledJudgementAt: ${copy.errMarketTimeCloseByJudgement}`,
    ]);
    expect(
      schema.safeParse({ ...valid, closeAt: '2026-11-02T10:00', eventDeadline: '' }).success,
    ).toBe(true);
  });

  it('refuses a 사건 기한 after the scheduled judgement, under both (owner answer A1)', () => {
    expect(issuesOf(schema.safeParse({ ...valid, eventDeadline: '2026-11-02T10:01' }))).toEqual([
      `eventDeadline: ${copy.errMarketTimeDeadlineByJudgement}`,
      `scheduledJudgementAt: ${copy.errMarketTimeDeadlineByJudgement}`,
    ]);
    expect(schema.safeParse({ ...valid, eventDeadline: '2026-11-02T10:00' }).success).toBe(true);
    // A judgement moved before both breaks both rules, each said under its own inputs.
    expect(
      issuesOf(schema.safeParse({ ...valid, scheduledJudgementAt: '2026-09-30T09:00' })),
    ).toEqual([
      `closeAt: ${copy.errMarketTimeCloseByJudgement}`,
      `scheduledJudgementAt: ${copy.errMarketTimeCloseByJudgement}`,
      `eventDeadline: ${copy.errMarketTimeDeadlineByJudgement}`,
      `scheduledJudgementAt: ${copy.errMarketTimeDeadlineByJudgement}`,
    ]);
  });

  it('checks a rule only with both its ends filled in', () => {
    expect(
      schema.safeParse({ ...valid, scheduledJudgementAt: '', eventDeadline: '2027-01-01T00:00' })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ ...valid, scheduledOpenAt: '' }).success).toBe(true);
  });

  it('never refuses a draft its lead close: the open-items check names it (decision C8)', () => {
    // An announcement before the close breaks 선행 마감 at any gap; a draft still saves.
    const announced = { ...valid, scheduledAnnouncementAt: '2026-10-01T08:00' };
    expect(schema.safeParse(announced).success).toBe(true);
    const original = { ...valid };
    expect(marketFormSchema({ now, original }).safeParse(announced).success).toBe(true);
  });

  it('reads the times as the API would store them (formTimes)', () => {
    process.env.TZ = 'UTC';
    expect(formTimes({ ...valid, scheduledAnnouncementAt: '2026-10-02T08:00' })).toEqual({
      scheduledOpenAt: '2026-09-07T00:00:00.000Z',
      closeAt: '2026-10-01T00:00:00.000Z',
      scheduledAnnouncementAt: '2026-10-01T23:00:00.000Z',
      scheduledJudgementAt: '2026-11-02T01:00:00.000Z',
      judgementTimeZone: 'Asia/Seoul',
      eventDeadline: '2026-10-31T14:59:00.000Z',
    });
    expect(formTimes({ ...EMPTY_MARKET_FORM, judgementTimeZone: '' })).toEqual({
      scheduledOpenAt: null,
      closeAt: null,
      scheduledAnnouncementAt: null,
      scheduledJudgementAt: null,
      judgementTimeZone: null,
      eventDeadline: null,
    });
  });
});

describe('supplementFormSchema: the times (#22, #80, #172 item 14, owner answer A2)', () => {
  // An open market as stored: opened, closing 10-01 09:00, judged 11-02 10:00.
  const opened: MarketFormValues = { ...valid, tags: ['금리'] };
  const issues = (
    values: Partial<MarketFormValues>,
    original: MarketFormValues = opened,
    leadCloseGapMinutes: number | null = 60,
    paused = false,
  ) =>
    issuesOf(
      supplementFormSchema({ now, original, paused, leadCloseGapMinutes }).safeParse({
        ...original,
        ...values,
      }),
    );

  it('moves the close later only — an earlier instant is an early close', () => {
    expect(issues({ closeAt: '2026-10-01T08:59' })).toEqual([
      `closeAt: ${copy.errMarketCloseEarlier}`,
    ]);
    expect(issues({ closeAt: '2026-10-01T09:01' })).toEqual([]);
    expect(issues({ closeAt: '2026-11-02T10:00' })).toEqual([]);
  });

  it('keeps an extended close at or before the unchanged scheduled judgement (A2)', () => {
    expect(issues({ closeAt: '2026-11-02T10:01' })).toEqual([
      `closeAt: ${copy.errMarketTimeCloseByJudgement}`,
      `scheduledJudgementAt: ${copy.errMarketTimeCloseByJudgement}`,
    ]);
  });

  it('refuses any change to the scheduled open or judgement, set or not (decision C5)', () => {
    expect(issues({ scheduledJudgementAt: '2026-11-03T10:00' })).toEqual([
      `scheduledJudgementAt: ${copy.errMarketTimeFixed}`,
    ]);
    expect(issues({ scheduledOpenAt: '' })).toEqual([
      `scheduledOpenAt: ${copy.errMarketTimeFixed}`,
    ]);
    // A market opened before #22 has none, and gets none set on the form either.
    const legacy = { ...opened, scheduledOpenAt: '', scheduledJudgementAt: '' };
    expect(issues({ scheduledJudgementAt: '2026-11-03T10:00' }, legacy)).toEqual([
      `scheduledJudgementAt: ${copy.errMarketTimeFixed}`,
    ]);
    expect(issues({ title: '고친 질문' }, legacy)).toEqual([]);
  });

  it('keeps the zone and the announcement editable, but never clears the zone', () => {
    expect(issues({ judgementTimeZone: 'America/New_York' })).toEqual([]);
    expect(issues({ judgementTimeZone: '' })).toEqual([
      `judgementTimeZone: ${copy.errMarketRulesOpen}`,
    ]);
    // None stored (opened before #22): nothing to clear.
    expect(issues({ title: '고친 질문' }, { ...opened, judgementTimeZone: '' })).toEqual([]);
  });

  it('checks the lead close again at the gap the market is held to, when an end moves', () => {
    const announced = { ...opened, scheduledAnnouncementAt: '2026-10-01T11:00' };
    const lead = [
      `closeAt: ${copy.errMarketLeadCloseBefore} 60${copy.errMarketLeadCloseTail}`,
      `scheduledAnnouncementAt: ${copy.errMarketLeadCloseBefore} 60${copy.errMarketLeadCloseTail}`,
    ];
    // 60 minutes: a close at the announcement − 59 is refused under both; − 60 passes.
    expect(issues({ closeAt: '2026-10-01T10:01' }, announced)).toEqual(lead);
    expect(issues({ closeAt: '2026-10-01T10:00' }, announced)).toEqual([]);
    // The announcement moved closer is checked too.
    expect(issues({ scheduledAnnouncementAt: '2026-10-01T09:59' }, announced)).toEqual(lead);
    // Another gap the market is held to.
    expect(issues({ closeAt: '2026-10-01T10:01' }, announced, 0)).toEqual([]);
    // Neither end moved: not checked, as the API checks only what is sent.
    expect(issues({ title: '고친 질문' }, announced, 600)).toEqual([]);
    // 없음: no lead close to check.
    expect(issues({ closeAt: '2026-10-01T10:59' })).toEqual([]);
  });

  it('refuses the lead fields sent while the gap is undecided, as the API cannot check them', () => {
    const announced = { ...opened, scheduledAnnouncementAt: '2026-10-01T11:00' };
    // In the form's own words: its action is 보충 요청, not 저장.
    expect(copy.errMarketSupplementLeadCloseUndecided).toMatch(/다시 요청해 주세요\.$/);
    expect(issues({ closeAt: '2026-10-01T09:30' }, announced, null)).toEqual([
      `closeAt: ${copy.errMarketSupplementLeadCloseUndecided}`,
    ]);
    expect(issues({ scheduledAnnouncementAt: '2026-10-02T11:00' }, opened, null)).toEqual([
      `scheduledAnnouncementAt: ${copy.errMarketSupplementLeadCloseUndecided}`,
    ]);
    // Cleared to 없음: nothing to check.
    expect(issues({ scheduledAnnouncementAt: '' }, announced, null)).toEqual([]);
  });

  it('fixes the close while PAUSED, said once under it, and keeps the rest (#172 item 14)', () => {
    expect(issues({ closeAt: '2026-10-01T09:01' }, opened, 60, true)).toEqual([
      `closeAt: ${copy.errMarketSupplementClosePaused}`,
    ]);
    // Earlier, or with an announcement it would break: still the one refusal, the one to fix.
    const announced = { ...opened, scheduledAnnouncementAt: '2026-10-01T11:00' };
    expect(issues({ closeAt: '2026-10-01T10:30' }, announced, 60, true)).toEqual([
      `closeAt: ${copy.errMarketSupplementClosePaused}`,
    ]);
    expect(issues({ closeAt: '2026-10-01T08:00' }, opened, 60, true)).toEqual([
      `closeAt: ${copy.errMarketSupplementClosePaused}`,
    ]);
    // Every other item stays a supplement's while PAUSED.
    expect(issues({ title: '고친 질문', description: '고친 배경' }, opened, 60, true)).toEqual([]);
  });

  it('fixes the close as the shared PAUSED_SUPPLEMENT_ITEMS leaves it out, and only then', () => {
    expect(supplementCloseFixed(true)).toBe(!PAUSED_SUPPLEMENT_ITEMS.includes('closeAt'));
    expect(supplementCloseFixed(true)).toBe(true);
    expect(supplementCloseFixed(false)).toBe(false);
  });

  /** The request form as the panel mounts it (market-supplement-panel.tsx), PAUSED. */
  function pausedForm() {
    const form = createFormControl<MarketFormValues>({
      defaultValues: opened,
      resolver: zodResolver(
        supplementFormSchema({ now, original: opened, paused: true, leadCloseGapMinutes: 60 }),
      ),
    });
    for (const name of Object.keys(EMPTY_MARKET_FORM) as (keyof MarketFormValues)[]) {
      form.register(name);
    }
    form.control._state.mount = true;
    return form;
  }

  it('puts back a close edited before the pause, so nothing is sent behind its locked input', () => {
    const form = pausedForm();
    form.setValue('closeAt', '2026-10-02T09:00');
    form.setValue('title', '고친 질문');
    restoreFixedClose(form, opened, false);
    expect(form.getValues().closeAt).toBe(opened.closeAt);
    // The rest of what was typed stays; the request sends it alone.
    expect(form.getValues().title).toBe('고친 질문');
    expect(toSupplementChanges(form.getValues(), opened)).toEqual({ title: '고친 질문' });
    expect(form.control._formState.errors).toEqual({});
  });

  it('once sent, takes away what the edited close was refused for', async () => {
    const form = pausedForm();
    form.setValue('closeAt', '2026-10-02T09:00');
    await form.handleSubmit(() => undefined)();
    const errors = () => form.control._formState.errors;
    expect(errors().closeAt?.message).toBe(copy.errMarketSupplementClosePaused);
    restoreFixedClose(form, opened, true);
    expect(form.getValues().closeAt).toBe(opened.closeAt);
    await vi.waitFor(() => {
      expect(errors().closeAt).toBeUndefined();
    });
    // As it opened: nothing to put back.
    const untouched = pausedForm();
    restoreFixedClose(untouched, opened, true);
    expect(untouched.getValues()).toEqual(opened);
  });

  it('asks none of this of a draft', () => {
    expect(
      issuesOf(
        marketFormSchema({ now, original: opened }).safeParse({
          ...opened,
          closeAt: '2026-09-30T09:00',
          scheduledJudgementAt: '2026-11-03T10:00',
          scheduledAnnouncementAt: '2026-09-30T09:30',
        }),
      ),
    ).toEqual([]);
  });
});

/**
 * The edit form's reset policies, run against react-hook-form's form control without a DOM
 * (what `useForm` wraps): the `values` prop resets under FOLLOW_SERVER_RESET, a save resets
 * with AFTER_SAVE_RESET, and every `reset()` inherits the former unless told otherwise.
 */
describe('timeRuleDeps (#22)', () => {
  it('names the inputs every time rule an input is on shares with it', () => {
    expect(timeRuleDeps('scheduledOpenAt')).toEqual(['closeAt']);
    expect(timeRuleDeps('closeAt')).toEqual([
      'scheduledOpenAt',
      'scheduledJudgementAt',
      'scheduledAnnouncementAt',
    ]);
    expect(timeRuleDeps('scheduledAnnouncementAt')).toEqual(['closeAt']);
    expect(timeRuleDeps('scheduledJudgementAt')).toEqual(['closeAt', 'eventDeadline']);
    expect(timeRuleDeps('eventDeadline')).toEqual(['scheduledJudgementAt']);
  });

  it('after a failed save, mending a rule from one input clears its message under the other', async () => {
    const times: readonly string[] = [
      'scheduledOpenAt',
      'closeAt',
      'scheduledAnnouncementAt',
      'scheduledJudgementAt',
      'eventDeadline',
    ] satisfies TimeRuleField[];
    // The close a minute past the judgement: the message stands under both inputs.
    const form = createFormControl<MarketFormValues>({
      defaultValues: { ...valid, closeAt: '2026-11-02T10:01' },
      resolver: zodResolver(marketFormSchema({ now })),
    });
    // Registered as the inputs are (market-time-fields.tsx, market-rule-fields.tsx).
    for (const name of Object.keys(EMPTY_MARKET_FORM) as (keyof MarketFormValues)[]) {
      form.register(
        name,
        times.includes(name) ? { deps: timeRuleDeps(name as TimeRuleField) } : {},
      );
    }
    form.control._state.mount = true;

    await form.handleSubmit(() => undefined)();
    const errors = () => form.control._formState.errors;
    expect(errors().closeAt?.message).toBe(copy.errMarketTimeCloseByJudgement);
    expect(errors().scheduledJudgementAt?.message).toBe(copy.errMarketTimeCloseByJudgement);

    // The judgement moved a day later, as typed into its input: the close's message goes too (the
    // re-check of the other end runs after the change's own).
    await form.register('scheduledJudgementAt').onChange({
      target: { name: 'scheduledJudgementAt', value: '2026-11-03T10:00' },
      type: 'change',
    });
    expect(errors().scheduledJudgementAt).toBeUndefined();
    await vi.waitFor(() => {
      expect(errors().closeAt).toBeUndefined();
    });
  });
});

describe('edit-form reset policies', () => {
  const keys = Object.keys(EMPTY_MARKET_FORM) as (keyof MarketFormValues)[];

  /** A form as the screen mounts it, every field registered. */
  function mounted(values: MarketFormValues) {
    const form = createFormControl<MarketFormValues>({ values, resetOptions: FOLLOW_SERVER_RESET });
    for (const name of keys) form.register(name);
    form.control._state.mount = true;
    return form;
  }

  it('a background refetch keeps the fields the admin edited and follows the server elsewhere', () => {
    const original = marketToFormValues(market, categories);
    const form = mounted(original);
    form.setValue('title', '  새 제목  ', { shouldDirty: true });

    // Another writer changed the rules; the `values` prop resets the form to the new row.
    const fromServer = { ...original, yesCondition: '다른 관리자가 고친 YES 조건' };
    form.reset(fromServer, FOLLOW_SERVER_RESET);
    expect(form.getValues()).toEqual({ ...fromServer, title: '  새 제목  ' });
    expect(form.control._getDirty()).toBe(true);
  });

  it('a save restarts clean on the saved row, including the fields just saved', () => {
    const original = marketToFormValues(market, categories);
    const saved = marketToFormValues({ ...market, title: '새 제목' }, categories);

    const form = mounted(original);
    form.setValue('title', '  새 제목  ', { shouldDirty: true });
    form.reset(saved, AFTER_SAVE_RESET);
    expect(form.getValues()).toEqual(saved);
    expect(form.control._getDirty()).toBe(false);

    // The trap the explicit options exist for: a bare reset() inherits the follow-server
    // policy, keeps the untrimmed input of the field just saved, and leaves the form dirty.
    const bare = mounted(original);
    bare.setValue('title', '  새 제목  ', { shouldDirty: true });
    bare.reset(saved);
    expect(bare.getValues().title).toBe('  새 제목  ');
    expect(bare.control._getDirty()).toBe(true);
  });
});

describe('marketToFormValues', () => {
  it('prefills the form, looking the category id up by slug and rendering KST', () => {
    process.env.TZ = 'UTC';
    expect(marketToFormValues(market, categories)).toEqual({
      title: '기준금리 인하?',
      description: '',
      yesCondition: '',
      noCondition: '',
      eventDeadline: '',
      primarySourceName: '',
      primarySourceUrl: '',
      fallbackSources: [],
      fallbackCondition: '',
      longDelayDays: '',
      delayHandling: '',
      categoryId: '2',
      tags: [],
      tagInput: '',
      imageUrl: '',
      scheduledOpenAt: '',
      closeAt: '2026-10-01T09:00',
      scheduledAnnouncementAt: '',
      scheduledJudgementAt: '',
      judgementTimeZone: 'Asia/Seoul',
      slug: 'rate-cut-2026',
    });
  });

  it('prefills the times in KST to the minute, and the zone as stored (#22)', () => {
    process.env.TZ = 'UTC';
    const timed: AdminMarket = {
      ...market,
      scheduledOpenAt: '2026-09-06T23:00:30.000Z',
      closeAt: '2026-10-31T14:59:59.000Z',
      scheduledAnnouncementAt: '2026-11-01T23:00:00.000Z',
      scheduledJudgementAt: '2026-11-02T01:00:00.000Z',
      judgementTimeZone: 'America/New_York',
    };
    const values = marketToFormValues(timed, categories);
    expect(pick(values, ['scheduledOpenAt', 'closeAt', 'scheduledAnnouncementAt'])).toEqual({
      scheduledOpenAt: '2026-09-07T08:00',
      closeAt: '2026-10-31T23:59',
      scheduledAnnouncementAt: '2026-11-02T08:00',
    });
    expect(values.scheduledJudgementAt).toBe('2026-11-02T10:00');
    expect(values.judgementTimeZone).toBe('America/New_York');
    // Nothing touched, nothing sent: a stored close with seconds is never sent back as 23:59:00.
    expect(toUpdateMarketBody(values, values)).toEqual({});
    // A stored zone this browser may not list is kept as stored, and passes as it is.
    const odd = marketToFormValues({ ...timed, judgementTimeZone: 'Mars/Olympus' }, categories);
    expect(marketFormSchema({ now, original: odd }).safeParse(odd).success).toBe(true);
  });

  it('prefills the tags as stored, in order, and an empty box', () => {
    const values = marketToFormValues({ ...market, tags: ['AI', '서울'] }, categories);
    expect(values.tags).toEqual(['AI', '서울']);
    expect(values.tagInput).toBe('');
    expect(toUpdateMarketBody(values, values)).toEqual({});
  });

  it('leaves the category blank when it is no longer in the active list', () => {
    expect(marketToFormValues(market, [categories[0] as Category]).categoryId).toBe('');
  });

  it('round-trips through toUpdateMarketBody as "no change"', () => {
    const values = marketToFormValues(market, categories);
    expect(toUpdateMarketBody(values, values)).toEqual({});
  });

  it('prefills every rule item (#23): the deadline in KST, the sources as their inputs', () => {
    process.env.TZ = 'UTC';
    const ruled: AdminMarket = {
      ...market,
      description: '배경',
      yesCondition: 'YES 조건',
      noCondition: 'NO 조건',
      eventDeadline: '2026-10-31T14:59:59.000Z',
      primarySource: { name: '한국은행', url: 'https://www.bok.or.kr' },
      fallbackSources: [
        { name: '연합뉴스', url: 'https://yna.co.kr' },
        { name: '통계청', url: '' },
      ],
      fallbackCondition: '없으면',
      longDelayDays: 14,
      delayHandling: '무효로 판정한다.',
    };
    const values = marketToFormValues(ruled, categories);
    expect(values).toMatchObject({
      description: '배경',
      yesCondition: 'YES 조건',
      noCondition: 'NO 조건',
      // Seconds dropped, as for the close time: the control has none.
      eventDeadline: '2026-10-31T23:59',
      primarySourceName: '한국은행',
      primarySourceUrl: 'https://www.bok.or.kr',
      fallbackSources: [
        { name: '연합뉴스', url: 'https://yna.co.kr' },
        { name: '통계청', url: '' },
      ],
      fallbackCondition: '없으면',
      longDelayDays: '14',
      delayHandling: '무효로 판정한다.',
    });
    // Nothing touched, nothing sent — the deadline's seconds included.
    expect(toUpdateMarketBody(values, values)).toEqual({});
    // The fallbacks are copies: editing the form never edits the cached row.
    expect(values.fallbackSources[0]).not.toBe(ruled.fallbackSources[0]);
  });
});

describe('the one-admin 판정 (#152, ADR-0103)', () => {
  it('has no form any more: a judgement is registered in the 판정 panel and approved by another', async () => {
    const exported = Object.keys(await import('./market-form'));
    for (const name of ['resolveMarketFormSchema', 'toResolveMarketBody']) {
      expect(exported, name).not.toContain(name);
    }
  });
});
