import { describe, expect, it } from 'vitest';
import { adminAccountActorSchema } from './admin-accounts.js';
import { ADMIN_ACTION_TYPES } from './enums.js';
import { findExcludedIdentifier, findExcludedText } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import { PUBLIC_MARKET_STATUSES, marketSummarySchema } from './market.js';
import {
  THEME_DATE_MAX,
  THEME_DATE_MIN,
  THEME_DATE_OUT_OF_RANGE,
  THEME_INTRO_MAX,
  THEME_LIST_STATUS_ORDER,
  THEME_NAME_MAX,
  THEME_NOTICE_BODY_MAX,
  THEME_NOTICE_TITLE_MAX,
  THEME_REFUSALS,
  THEME_RESULT_STATUSES,
  THEME_STATUSES,
  adminThemeMarketSchema,
  createThemeBodySchema,
  createThemeNoticeBodySchema,
  koreanDateAt,
  linkThemeMarketBodySchema,
  themeListQuerySchema,
  themeNoticeSchema,
  themeResultSchema,
  themeSchema,
  themeSlugSchema,
  themeStatusAt,
  themeSummarySchema,
  updateThemeBodySchema,
  updateThemeNoticeBodySchema,
} from './themes.js';

const ID = 'a1b2c3d4-0000-4000-8000-000000000001';

/** A period as the admin enters it (owner decision 2026-10-19): two Korean dates, both in it. */
const PERIOD = { startDate: '2026-10-20', endDate: '2026-11-03' };

describe('koreanDateAt', () => {
  it('is the date in Korea: the UTC date until 15:00 UTC, the next one from then', () => {
    expect(koreanDateAt(Date.parse('2026-10-19T14:59:59.999Z'))).toBe('2026-10-19');
    expect(koreanDateAt(Date.parse('2026-10-19T15:00:00.000Z'))).toBe('2026-10-20');
    expect(koreanDateAt(new Date('2026-12-31T15:00:00.000Z'))).toBe('2027-01-01');
  });
});

describe('themeStatusAt (#81 진행 기간, owner decision 2026-10-19)', () => {
  it('is 예정 before the start date, 진행 중 through the end date, 종료 from the day after', () => {
    const at = (iso: string) => themeStatusAt(PERIOD, Date.parse(iso));
    expect(at('2026-10-19T23:59:59.999+09:00')).toBe('upcoming');
    expect(at('2026-10-20T00:00:00.000+09:00')).toBe('ongoing');
    expect(at('2026-11-03T23:59:59.999+09:00')).toBe('ongoing');
    expect(at('2026-11-04T00:00:00.000+09:00')).toBe('ended');
    expect(at('2027-01-01T00:00:00.000Z')).toBe('ended');
  });

  it('turns at the Korean midnight, which is 15:00 UTC the day before', () => {
    expect(themeStatusAt(PERIOD, new Date('2026-10-19T14:59:59.999Z'))).toBe('upcoming');
    expect(themeStatusAt(PERIOD, new Date('2026-10-19T15:00:00.000Z'))).toBe('ongoing');
    expect(themeStatusAt(PERIOD, new Date('2026-11-03T14:59:59.999Z'))).toBe('ongoing');
    expect(themeStatusAt(PERIOD, new Date('2026-11-03T15:00:00.000Z'))).toBe('ended');
  });

  it('has a one-day theme on for that Korean day only', () => {
    const oneDay = { startDate: '2026-10-20', endDate: '2026-10-20' };
    expect(themeStatusAt(oneDay, Date.parse('2026-10-19T23:59:59.999+09:00'))).toBe('upcoming');
    expect(themeStatusAt(oneDay, Date.parse('2026-10-20T12:00:00+09:00'))).toBe('ongoing');
    expect(themeStatusAt(oneDay, Date.parse('2026-10-21T00:00:00+09:00'))).toBe('ended');
  });

  it('has the three statuses in the order a period passes them, and the list another order', () => {
    expect(THEME_STATUSES).toEqual(['upcoming', 'ongoing', 'ended']);
    expect(THEME_LIST_STATUS_ORDER).toEqual(['ongoing', 'upcoming', 'ended']);
  });
});

describe('THEME_RESULT_STATUSES (#81 결과 목록)', () => {
  it('is 판정 완료·정산 완료·무효: the public statuses a result is known in', () => {
    expect(THEME_RESULT_STATUSES).toEqual(['resolved', 'settled', 'voided']);
    const shown: readonly string[] = THEME_RESULT_STATUSES;
    expect(PUBLIC_MARKET_STATUSES.filter((status) => !shown.includes(status))).toEqual([
      'open',
      'closed',
    ]);
  });
});

describe('createThemeBodySchema', () => {
  const body = {
    slug: '2026-election',
    name: ' 노벨상 주간 ',
    intro: '\n수상자를 맞히는 시장 모음\n',
    ...PERIOD,
  };

  it('takes an address, a name, an introduction and a period, trimmed at the ends', () => {
    expect(createThemeBodySchema.parse(body)).toEqual({
      slug: '2026-election',
      name: '노벨상 주간',
      intro: '수상자를 맞히는 시장 모음',
      ...PERIOD,
    });
    // Line breaks inside the introduction are kept.
    expect(createThemeBodySchema.parse({ ...body, intro: '첫 줄\n둘째 줄' }).intro).toBe(
      '첫 줄\n둘째 줄',
    );
  });

  it('requires every field, none blank, within its length (owner decision 2026-10-19)', () => {
    for (const key of ['slug', 'name', 'intro', 'startDate', 'endDate'] as const) {
      const rest: Record<string, string> = { ...body };
      delete rest[key];
      expect(createThemeBodySchema.safeParse(rest).success, key).toBe(false);
    }
    expect(createThemeBodySchema.safeParse({ ...body, name: '   ' }).success).toBe(false);
    expect(createThemeBodySchema.safeParse({ ...body, intro: '' }).success).toBe(false);
    expect(
      createThemeBodySchema.safeParse({ ...body, name: '가'.repeat(THEME_NAME_MAX) }).success,
    ).toBe(true);
    expect(
      createThemeBodySchema.safeParse({ ...body, name: '가'.repeat(THEME_NAME_MAX + 1) }).success,
    ).toBe(false);
    expect(
      createThemeBodySchema.safeParse({ ...body, intro: '가'.repeat(THEME_INTRO_MAX + 1) }).success,
    ).toBe(false);
  });

  it('takes a one-day period and refuses one that ends before it starts, naming endDate', () => {
    expect(createThemeBodySchema.safeParse({ ...body, endDate: body.startDate }).success).toBe(
      true,
    );
    const result = createThemeBodySchema.safeParse({ ...body, endDate: '2026-10-19' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['endDate']]);
  });

  it('takes calendar dates only: no time, no impossible day', () => {
    for (const startDate of ['2026-10-20T00:00:00Z', '2026-02-30', '20261020', '2026-10-2']) {
      expect(createThemeBodySchema.safeParse({ ...body, startDate }).success, startDate).toBe(
        false,
      );
    }
  });

  it('takes the dates from 2000-01-01 to 2100-12-31 and refuses others naming the field (owner decision 2026-10-19, second round)', () => {
    expect([THEME_DATE_MIN, THEME_DATE_MAX]).toEqual(['2000-01-01', '2100-12-31']);
    for (const period of [
      { startDate: THEME_DATE_MIN, endDate: THEME_DATE_MIN },
      { startDate: THEME_DATE_MIN, endDate: THEME_DATE_MAX },
      { startDate: THEME_DATE_MAX, endDate: THEME_DATE_MAX },
    ]) {
      expect(createThemeBodySchema.safeParse({ ...body, ...period }).success).toBe(true);
    }
    for (const [field, date] of [
      ['startDate', '1999-12-31'],
      ['startDate', '0000-01-01'],
      ['endDate', '2101-01-01'],
      ['endDate', '9999-12-31'],
    ] as const) {
      const result = createThemeBodySchema.safeParse({ ...body, ...PERIOD, [field]: date });
      expect(
        result.error?.issues.map((issue) => [issue.path, issue.message]),
        `${field} ${date}`,
      ).toContainEqual([[field], THEME_DATE_OUT_OF_RANGE]);
    }
    expect(THEME_DATE_OUT_OF_RANGE).toBe('must be between 2000-01-01 and 2100-12-31');
    // A malformed date is one issue, not a second one about the range — whatever its year: a
    // string of the right shape but no such day is no date to check the range of, nor to put in
    // order against the end (`2101-13-01` sorts after `PERIOD.endDate`).
    for (const field of ['startDate', 'endDate'] as const) {
      for (const date of ['', '2026-02-30', '2026-1-1', '1999-02-30', '2101-13-01', '9999-99-99']) {
        for (const result of [
          createThemeBodySchema.safeParse({ ...body, [field]: date }),
          updateThemeBodySchema.safeParse({ ...PERIOD, [field]: date }),
          updateThemeBodySchema.safeParse({ [field]: date }),
        ]) {
          const issues = result.error?.issues.map((issue) => [issue.path, issue.message]);
          expect(issues, `${field} ${date}`).toHaveLength(1);
          expect(issues?.[0]?.[0], `${field} ${date}`).toEqual([field]);
          expect(issues?.[0]?.[1], `${field} ${date}`).not.toBe(THEME_DATE_OUT_OF_RANGE);
        }
      }
    }
    // An edit is held to the same range, each half alone too.
    for (const [field, date] of [
      ['startDate', '1999-12-31'],
      ['startDate', '0000-01-01'],
      ['endDate', '2101-01-01'],
      ['endDate', '9999-12-31'],
    ] as const) {
      expect(
        updateThemeBodySchema
          .safeParse({ [field]: date })
          .error?.issues.map((issue) => [issue.path, issue.message]),
        `${field} ${date}`,
      ).toEqual([[[field], THEME_DATE_OUT_OF_RANGE]]);
    }
    expect(updateThemeBodySchema.safeParse({ startDate: THEME_DATE_MIN }).success).toBe(true);
    expect(updateThemeBodySchema.safeParse({ endDate: THEME_DATE_MAX }).success).toBe(true);
  });
});

describe('THEME_REFUSALS', () => {
  it('names markets when a publish has no public market: a draft does not count (owner decision 2026-10-19, second round)', () => {
    expect(THEME_REFUSALS.noPublicMarket).toEqual({
      field: 'markets',
      message: 'at least one market that is not a draft is required to publish',
    });
  });
});

describe('themeSlugSchema (owner decision 2026-10-19)', () => {
  it("is a market slug's alphabet: lower-case letters, digits, Korean syllables and -", () => {
    for (const slug of ['2026-election', '노벨상-주간', 'abc']) {
      expect(themeSlugSchema.safeParse(slug).success, slug).toBe(true);
    }
    for (const slug of ['ab', 'Election', 'a b', 'a_b', 'a'.repeat(81), ID]) {
      expect(themeSlugSchema.safeParse(slug).success, slug).toBe(false);
    }
  });
});

describe('updateThemeBodySchema', () => {
  it('takes any one field, and refuses an empty body', () => {
    expect(updateThemeBodySchema.parse({ name: '새 이름' })).toEqual({ name: '새 이름' });
    expect(updateThemeBodySchema.parse({ endDate: PERIOD.endDate })).toEqual({
      endDate: PERIOD.endDate,
    });
    expect(updateThemeBodySchema.parse({ slug: 'new-address' })).toEqual({ slug: 'new-address' });
    expect(updateThemeBodySchema.safeParse({}).success).toBe(false);
  });

  it('checks the period when both halves come, naming endDate with the refusal the web reads', () => {
    const result = updateThemeBodySchema.safeParse({
      startDate: PERIOD.endDate,
      endDate: PERIOD.startDate,
    });
    expect(result.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [[THEME_REFUSALS.endBeforeStart.field], THEME_REFUSALS.endBeforeStart.message],
    ]);
  });
});

describe('notice bodies', () => {
  it('take a title and a plain-text body, both required to create, either to edit', () => {
    expect(createThemeNoticeBodySchema.parse({ title: ' 안내 ', body: '내용\n둘째 줄 ' })).toEqual({
      title: '안내',
      body: '내용\n둘째 줄',
    });
    expect(createThemeNoticeBodySchema.safeParse({ title: '안내' }).success).toBe(false);
    expect(createThemeNoticeBodySchema.safeParse({ title: ' ', body: '내용' }).success).toBe(false);
    expect(
      createThemeNoticeBodySchema.safeParse({
        title: '가'.repeat(THEME_NOTICE_TITLE_MAX + 1),
        body: '내용',
      }).success,
    ).toBe(false);
    expect(
      createThemeNoticeBodySchema.safeParse({
        title: '안내',
        body: '가'.repeat(THEME_NOTICE_BODY_MAX + 1),
      }).success,
    ).toBe(false);
    expect(updateThemeNoticeBodySchema.parse({ body: '고친 내용' })).toEqual({ body: '고친 내용' });
    expect(updateThemeNoticeBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('the other request shapes', () => {
  it('lists every status or one, a page at a time', () => {
    expect(themeListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(themeListQuerySchema.parse({ status: 'ongoing', limit: '5' })).toEqual({
      status: 'ongoing',
      limit: 5,
    });
    expect(themeListQuerySchema.safeParse({ status: 'open' }).success).toBe(false);
  });

  it('links one market by id, lower-cased on the way in', () => {
    expect(linkThemeMarketBodySchema.parse({ marketId: ID.toUpperCase() })).toEqual({
      marketId: ID,
    });
    expect(linkThemeMarketBodySchema.safeParse({ marketId: 'x' }).success).toBe(false);
  });
});

describe('the answers', () => {
  it('give the admin a market row with who linked it and when, nothing more', () => {
    const extra = Object.keys(adminThemeMarketSchema.shape).filter(
      (key) => !(key in marketSummarySchema.shape),
    );
    expect(extra.sort()).toEqual(['linkedAt', 'linkedBy']);
    expect(adminThemeMarketSchema.shape.linkedBy).toBe(adminAccountActorSchema);
  });

  it('carry nothing private and name no excluded feature in public (#113)', () => {
    const publicKeys = [
      ...Object.keys(themeSummarySchema.shape),
      ...Object.keys(themeSchema.shape),
      ...Object.keys(themeNoticeSchema.shape),
      ...Object.keys(themeResultSchema.shape),
    ];
    for (const key of publicKeys) {
      expect(findPrivateField(key), key).toEqual([]);
      expect(findExcludedIdentifier(key, 'api'), key).toEqual([]);
    }
    // No author on a public notice, no one's results: the page speaks for the operators.
    expect(Object.keys(themeNoticeSchema.shape).sort()).toEqual([
      'body',
      'createdAt',
      'editedAt',
      'id',
      'title',
    ]);
  });

  it('record each theme write as its own admin action type, all of them clean names', () => {
    const types = ADMIN_ACTION_TYPES.filter((type) => type.startsWith('theme_'));
    expect(types).toEqual([
      'theme_create',
      'theme_update',
      'theme_publish',
      'theme_unpublish',
      'theme_market_link',
      'theme_market_unlink',
      'theme_notice_create',
      'theme_notice_update',
      'theme_notice_hide',
      'theme_notice_show',
    ]);
    for (const type of types) {
      expect(type.length).toBeLessThanOrEqual(40); // admin_actions.type is varchar(40)
      expect(findExcludedIdentifier(type, 'storage'), type).toEqual([]);
    }
  });

  it('use the screen name 테마, which no excluded word holds', () => {
    expect(findExcludedText('테마 · 예정 · 진행 중 · 종료 · 결과 목록 · 공지')).toEqual([]);
  });
});
