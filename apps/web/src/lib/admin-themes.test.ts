import {
  THEME_DATE_OUT_OF_RANGE,
  THEME_NOTICE_BODY_MAX,
  THEME_NOTICE_TITLE_MAX,
  THEME_REFUSALS,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  EMPTY_THEME_FORM,
  type ThemeFormValues,
  themeFormError,
  themeFormSchema,
  themeFormValues,
  themeNoticeFormSchema,
  themePickState,
  themeSlugEditable,
  themeWriteErrorMessage,
  toCreateThemeBody,
  toThemeNoticeBody,
  toUpdateThemeBody,
} from './admin-themes';
import { type AdminTheme, ApiError, type ErrorEnvelope } from './api';

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const theme: AdminTheme = {
  id: ID,
  slug: '2026-election',
  name: '선거 주간',
  startDate: '2026-10-20',
  endDate: '2026-11-03',
  status: 'upcoming',
  publishedAt: null,
  firstPublishedAt: null,
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
  intro: '소개',
  createdBy: { id: 'admin-1', nickname: '운영자' },
  notices: [],
};

const values: ThemeFormValues = {
  slug: ' 2026-election ',
  name: ' 선거 주간 ',
  intro: ' 소개 ',
  startDate: '2026-10-20',
  endDate: '2026-11-03',
};

const refused = (
  field: string,
  message: string,
  code: ErrorEnvelope['error']['code'] = 'VALIDATION_ERROR',
) => new ApiError(400, { code, message: 'refused', details: [{ path: [field], message }] });

describe('themeFormSchema (#81, owner decision 2026-10-19)', () => {
  const issues = (input: ThemeFormValues) =>
    themeFormSchema.safeParse(input).error?.issues.map((issue) => [issue.path[0], issue.message]);

  it('takes every field filled and the end on or after the start', () => {
    expect(themeFormSchema.safeParse(values).success).toBe(true);
    expect(themeFormSchema.safeParse({ ...values, endDate: values.startDate }).success).toBe(true);
  });

  it('requires every field, in the admin’s words', () => {
    expect(issues(EMPTY_THEME_FORM)).toEqual([
      ['slug', copy.errThemeSlug],
      ['name', copy.errThemeName],
      ['intro', copy.errThemeIntro],
      ['startDate', copy.errThemeStartDate],
      ['endDate', copy.errThemeEndDateRequired],
    ]);
    // An empty end asks for the end, not for an order nothing entered can have.
    expect(issues({ ...values, endDate: '' })).toEqual([['endDate', copy.errThemeEndDateRequired]]);
  });

  it('takes the dates the API takes, from 2000-01-01 to 2100-12-31, and says the range otherwise (owner decision 2026-10-19, second round)', () => {
    expect(
      themeFormSchema.safeParse({ ...values, startDate: '2000-01-01', endDate: '2100-12-31' })
        .success,
    ).toBe(true);
    expect(issues({ ...values, startDate: '1999-12-31' })).toEqual([
      ['startDate', copy.errThemeDateRange],
    ]);
    expect(issues({ ...values, startDate: '0000-01-01' })).toEqual([
      ['startDate', copy.errThemeDateRange],
    ]);
    expect(issues({ ...values, endDate: '2101-01-01' })).toEqual([
      ['endDate', copy.errThemeDateRange],
    ]);
    // Not a date at all: the field asks for one.
    expect(issues({ ...values, endDate: '+10000-01-01' })).toEqual([
      ['endDate', copy.errThemeEndDateRequired],
    ]);
  });

  it("refuses an end before the start, and a slug outside a market slug's alphabet", () => {
    expect(issues({ ...values, endDate: '2026-10-19' })).toEqual([
      ['endDate', copy.errThemeEndDate],
    ]);
    for (const slug of ['ab', 'Upper', 'with space', ID]) {
      expect(issues({ ...values, slug }), slug).toEqual([['slug', copy.errThemeSlug]]);
    }
  });
});

describe('the bodies', () => {
  it('creates with every field trimmed', () => {
    expect(toCreateThemeBody(values)).toEqual({
      slug: '2026-election',
      name: '선거 주간',
      intro: '소개',
      startDate: '2026-10-20',
      endDate: '2026-11-03',
    });
  });

  it('edits only what changed, and sends nothing when nothing did', () => {
    expect(toUpdateThemeBody(themeFormValues(theme), theme)).toBeUndefined();
    expect(toUpdateThemeBody(values, theme)).toBeUndefined();
    expect(
      toUpdateThemeBody(
        { ...themeFormValues(theme), name: '새 이름', endDate: '2026-11-04' },
        theme,
      ),
    ).toEqual({ name: '새 이름', endDate: '2026-11-04' });
    expect(toUpdateThemeBody({ ...themeFormValues(theme), slug: 'new-address' }, theme)).toEqual({
      slug: 'new-address',
    });
  });

  it('leaves the slug out once the theme has been published, so the rest still saves', () => {
    const published = { ...theme, firstPublishedAt: '2026-10-19T01:00:00.000Z' };
    expect(themeSlugEditable(theme)).toBe(true);
    expect(themeSlugEditable(published)).toBe(false);
    expect(
      toUpdateThemeBody(
        { ...themeFormValues(published), slug: 'other', name: '새 이름' },
        published,
      ),
    ).toEqual({ name: '새 이름' });
  });
});

describe('the refusals in words', () => {
  it('lands a taken, a fixed and a malformed slug on the slug field, each in its words', () => {
    expect(themeFormError(refused('slug', THEME_REFUSALS.slugTaken.message))).toEqual({
      field: 'slug',
      message: copy.errThemeSlugTaken,
    });
    expect(themeFormError(refused('slug', THEME_REFUSALS.slugFixed.message))).toEqual({
      field: 'slug',
      message: copy.adminThemeSlugFixed,
    });
    expect(themeFormError(refused('slug', 'Invalid string'))).toEqual({
      field: 'slug',
      message: copy.errThemeSlug,
    });
  });

  it('says which half of a period is out of order, in the words for that half', () => {
    expect(themeFormError(refused('endDate', THEME_REFUSALS.endBeforeStart.message))).toEqual({
      field: 'endDate',
      message: copy.errThemeEndDate,
    });
    // A start sent alone after the stored end (another admin moved it): the start is filled,
    // so the words are the order's, not a request to enter it.
    expect(themeFormError(refused('startDate', THEME_REFUSALS.startAfterEnd.message))).toEqual({
      field: 'startDate',
      message: copy.errThemeStartDateOrder,
    });
    expect(themeFormError(refused('startDate', 'Invalid ISO date'))).toEqual({
      field: 'startDate',
      message: copy.errThemeStartDate,
    });
    expect(themeFormError(refused('endDate', 'Invalid ISO date'))).toEqual({
      field: 'endDate',
      message: copy.errThemeEndDateRequired,
    });
  });

  it('says the range for a date outside it, on the field the API named', () => {
    for (const field of ['startDate', 'endDate'] as const) {
      expect(themeFormError(refused(field, THEME_DATE_OUT_OF_RANGE))).toEqual({
        field,
        message: copy.errThemeDateRange,
      });
    }
  });

  it('lands the other fields on theirs, and anything else on the toast', () => {
    expect(themeFormError(refused('name', 'Too big'))).toEqual({
      field: 'name',
      message: copy.errThemeName,
    });
    expect(
      themeFormError(refused('markets', THEME_REFUSALS.noPublicMarket.message)),
    ).toBeUndefined();
    expect(themeFormError(refused('slug', 'x', 'NOT_FOUND'))).toBeUndefined();
    expect(themeFormError(new Error('network'))).toBeUndefined();
  });

  it('says a publish needs a market that is not a draft (owner decisions 2026-10-19)', () => {
    expect(themeWriteErrorMessage(refused('markets', THEME_REFUSALS.noPublicMarket.message))).toBe(
      copy.adminThemePublishNeedsMarket,
    );
    expect(copy.adminThemePublishNeedsMarket).toContain('초안');
    expect(themeWriteErrorMessage(new ApiError(404, { code: 'NOT_FOUND', message: 'x' }))).toBe(
      copy.adminThemeNotFound,
    );
    expect(themeWriteErrorMessage(new Error('x'))).toBe(copy.errUnknown);
  });
});

describe('notices and the picker', () => {
  it('takes a notice of a title and a body within their bounds, trimmed', () => {
    expect(themeNoticeFormSchema.safeParse({ title: '안내', body: '내용' }).success).toBe(true);
    for (const input of [
      { title: ' ', body: '내용' },
      { title: '안내', body: '' },
      { title: '가'.repeat(THEME_NOTICE_TITLE_MAX + 1), body: '내용' },
      { title: '안내', body: '가'.repeat(THEME_NOTICE_BODY_MAX + 1) },
    ]) {
      expect(themeNoticeFormSchema.safeParse(input).success).toBe(false);
    }
    expect(toThemeNoticeBody({ title: ' 안내 ', body: ' 첫 줄\n둘째 줄 ' })).toEqual({
      title: '안내',
      body: '첫 줄\n둘째 줄',
    });
  });

  it('offers to put in a market not in the theme yet, in any case', () => {
    const linked = new Set([ID]);
    expect(themePickState(ID.toUpperCase(), linked)).toBe('linked');
    expect(themePickState('9c858901-8a57-4791-81fe-4c455b099bc9', linked)).toBe('linkable');
  });
});
