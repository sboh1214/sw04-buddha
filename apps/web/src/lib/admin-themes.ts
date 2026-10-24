import {
  THEME_DATE_MAX,
  THEME_DATE_MIN,
  THEME_DATE_OUT_OF_RANGE,
  THEME_INTRO_MAX,
  THEME_NAME_MAX,
  THEME_NOTICE_BODY_MAX,
  THEME_NOTICE_TITLE_MAX,
  THEME_REFUSALS,
  themeSlugSchema,
} from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';
import { nicknameShown } from './account-closure';
import {
  type AdminTheme,
  type AdminThemeMarket,
  type AdminThemeNotice,
  type CreateThemeBody,
  type UpdateThemeBody,
  isApiError,
  validationField,
  validationMessage,
} from './api';
import { formatKst } from './datetime';

/**
 * 테마 (#81, ADR-0088), the admin half: the theme form and the notice form, the bodies they send,
 * and the words for a refusal — kept out of the components so the node test runner reaches them
 * (vitest runs with no DOM here).
 *
 * Owner decisions (ADR-0069 decision 4, the #81 rows, and of 2026-10-19): every field is
 * required; the period is two Korean dates, both in it; the address is the slug the operator
 * chooses at creation and cannot change once the theme has been published; a theme is published
 * with a market in it; a notice is plain text, title up to 100 and body up to 5,000 characters.
 * And of the second round the same day: the dates lie within 2000-01-01 and 2100-12-31, and the
 * market a publish needs is one that is not a draft.
 */

/** The theme form's values: the strings the inputs hold. Dates are `<input type="date">`'s. */
export interface ThemeFormValues {
  slug: string;
  name: string;
  intro: string;
  /** `YYYY-MM-DD`, a Korean date. */
  startDate: string;
  endDate: string;
}

export const EMPTY_THEME_FORM: ThemeFormValues = {
  slug: '',
  name: '',
  intro: '',
  startDate: '',
  endDate: '',
};

/** A `YYYY-MM-DD` the date input gives, or '' when it holds none. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A date the input holds at all: anything else reads as no date, so the field asks for one. */
const isDate = (value: string) => DATE.test(value);
/**
 * A date the API takes (owner decision 2026-10-19, second round): from `THEME_DATE_MIN` to
 * `THEME_DATE_MAX`, which the inputs' `min` and `max` also offer a browser — but a typed year can
 * still fall outside them, so the form says the range.
 */
const inThemeRange = (value: string) => value >= THEME_DATE_MIN && value <= THEME_DATE_MAX;
const isThemeDate = (value: string) => isDate(value) && inThemeRange(value);

/**
 * The form's rules, the API's restated in the admin's words: the slug in a market slug's alphabet
 * (`themeSlugSchema`, the API's own), the name and the introduction within their bounds, both
 * dates — an empty one asks for it, one outside the range says the range — and an end on or after
 * the start. The API checks everything again; a refusal it alone can give (a taken slug, a fixed
 * one, a start after an end another admin just moved) lands on the field through `themeFormError`.
 */
export const themeFormSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .refine((value) => themeSlugSchema.safeParse(value).success, copy.errThemeSlug),
    name: z.string().trim().min(1, copy.errThemeName).max(THEME_NAME_MAX, copy.errThemeName),
    intro: z.string().trim().min(1, copy.errThemeIntro).max(THEME_INTRO_MAX, copy.errThemeIntro),
    startDate: z
      .string()
      .refine(isDate, copy.errThemeStartDate)
      .refine((value) => !isDate(value) || inThemeRange(value), copy.errThemeDateRange),
    endDate: z
      .string()
      .refine(isDate, copy.errThemeEndDateRequired)
      .refine((value) => !isDate(value) || inThemeRange(value), copy.errThemeDateRange),
  })
  .refine(
    (values) =>
      !isThemeDate(values.startDate) ||
      !isThemeDate(values.endDate) ||
      values.endDate >= values.startDate,
    { message: copy.errThemeEndDate, path: ['endDate'] },
  );

/** `POST /admin/themes`: every field, trimmed. */
export function toCreateThemeBody(values: ThemeFormValues): CreateThemeBody {
  return {
    slug: values.slug.trim(),
    name: values.name.trim(),
    intro: values.intro.trim(),
    startDate: values.startDate,
    endDate: values.endDate,
  };
}

/** The edit form's starting values: the theme as stored. */
export function themeFormValues(theme: AdminTheme): ThemeFormValues {
  return {
    slug: theme.slug,
    name: theme.name,
    intro: theme.intro,
    startDate: theme.startDate,
    endDate: theme.endDate,
  };
}

/**
 * Whether the slug may still change: until the theme is first published (owner decision
 * 2026-10-19). The edit form shows the field read-only from then on.
 */
export function themeSlugEditable(theme: Pick<AdminTheme, 'firstPublishedAt'>): boolean {
  return theme.firstPublishedAt === null;
}

/**
 * `PATCH /admin/themes/:id`: only the fields that differ from the stored theme, or `undefined`
 * when nothing does (the save is then no request). The slug is left out once it is fixed, so a
 * save of the other fields is never refused for it.
 */
export function toUpdateThemeBody(
  values: ThemeFormValues,
  theme: AdminTheme,
): UpdateThemeBody | undefined {
  const next = toCreateThemeBody(values);
  const body: UpdateThemeBody = {};
  if (themeSlugEditable(theme) && next.slug !== theme.slug) body.slug = next.slug;
  if (next.name !== theme.name) body.name = next.name;
  if (next.intro !== theme.intro) body.intro = next.intro;
  if (next.startDate !== theme.startDate) body.startDate = next.startDate;
  if (next.endDate !== theme.endDate) body.endDate = next.endDate;
  return Object.keys(body).length === 0 ? undefined : body;
}

export type ThemeFormField = keyof ThemeFormValues;

const THEME_FORM_FIELDS: readonly ThemeFormField[] = [
  'slug',
  'name',
  'intro',
  'startDate',
  'endDate',
];

/**
 * Where a refused create or edit lands on the form: the field the API named, with words the admin
 * can act on — a slug another theme has, a slug fixed by the first publish, a malformed one; a
 * period out of order, on the half the request sent (`THEME_REFUSALS`: a start sent alone that is
 * after the stored end, which another admin may have just moved, or an end before the start); a
 * date outside the range (`THEME_DATE_OUT_OF_RANGE`); the other fields' bounds. `undefined` for
 * anything else, which is the toast's.
 */
export function themeFormError(
  error: unknown,
): { field: ThemeFormField; message: string } | undefined {
  if (!isApiError(error, 'VALIDATION_ERROR')) return undefined;
  const named = validationField(error);
  const field = THEME_FORM_FIELDS.find((candidate) => candidate === named);
  if (field === undefined) return undefined;
  const reason = validationMessage(error);
  switch (field) {
    case 'slug':
      if (reason === THEME_REFUSALS.slugTaken.message) {
        return { field, message: copy.errThemeSlugTaken };
      }
      if (reason === THEME_REFUSALS.slugFixed.message) {
        return { field, message: copy.adminThemeSlugFixed };
      }
      return { field, message: copy.errThemeSlug };
    case 'name':
      return { field, message: copy.errThemeName };
    case 'intro':
      return { field, message: copy.errThemeIntro };
    case 'startDate':
      return {
        field,
        message:
          reason === THEME_REFUSALS.startAfterEnd.message
            ? copy.errThemeStartDateOrder
            : reason === THEME_DATE_OUT_OF_RANGE
              ? copy.errThemeDateRange
              : copy.errThemeStartDate,
      };
    case 'endDate':
      return {
        field,
        message:
          reason === THEME_REFUSALS.endBeforeStart.message
            ? copy.errThemeEndDate
            : reason === THEME_DATE_OUT_OF_RANGE
              ? copy.errThemeDateRange
              : copy.errThemeEndDateRequired,
      };
  }
}

/**
 * A refused publish or another theme write, in words: a publish of a theme with no market in it
 * that is not a draft (owner decisions 2026-10-19), a theme that is not there, or anything else.
 */
export function themeWriteErrorMessage(error: unknown): string {
  if (
    isApiError(error, 'VALIDATION_ERROR') &&
    validationField(error) === THEME_REFUSALS.noPublicMarket.field
  ) {
    return copy.adminThemePublishNeedsMarket;
  }
  if (isApiError(error, 'NOT_FOUND')) return copy.adminThemeNotFound;
  return copy.errUnknown;
}

/** The notice form: a title and a plain-text body, both required. */
export interface ThemeNoticeFormValues {
  title: string;
  body: string;
}

export const EMPTY_THEME_NOTICE_FORM: ThemeNoticeFormValues = { title: '', body: '' };

export const themeNoticeFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, copy.errThemeNoticeTitle)
    .max(THEME_NOTICE_TITLE_MAX, copy.errThemeNoticeTitle),
  body: z
    .string()
    .trim()
    .min(1, copy.errThemeNoticeBody)
    .max(THEME_NOTICE_BODY_MAX, copy.errThemeNoticeBody),
});

/** A notice's fields as sent, trimmed. */
export function toThemeNoticeBody(values: ThemeNoticeFormValues): ThemeNoticeFormValues {
  return { title: values.title.trim(), body: values.body.trim() };
}

/**
 * What the market picker offers for one market it found: `linked` for one already in the theme —
 * the API would change nothing — and `linkable` for the rest, in any status (ADR-0069 decision 4,
 * '편성 규칙': a draft too, which the public pages show once it opens — and which a publish counts
 * from then, not before; owner decision 2026-10-19, second round).
 */
export function themePickState(
  candidateId: string,
  linkedIds: ReadonlySet<string>,
): 'linked' | 'linkable' {
  return linkedIds.has(candidateId.toLowerCase()) ? 'linked' : 'linkable';
}

/**
 * The admin who made the theme, put a market in it or wrote a notice, as the theme's admin page
 * names them: the nickname, or '탈퇴한 사용자' once that admin has closed the account. An admin
 * closes only once the role is revoked, and the theme, its markets and its notices stay, so the
 * API sends the account by id with a null nickname then (#140, ADR-0086 — as the base's other
 * admin screens name it).
 */
export function themeActorName(actor: Pick<AdminTheme['createdBy'], 'nickname'>): string {
  return nicknameShown(actor.nickname);
}

/** The line under a market in the theme: when it was put in, and by whom. */
export function formatThemeMarketLinked(
  row: Pick<AdminThemeMarket, 'linkedAt' | 'linkedBy'>,
): string {
  return `${copy.adminThemeMarketLinkedAt} ${formatKst(row.linkedAt)} · ${themeActorName(row.linkedBy)}`;
}

/** The line under a notice's title: when and by whom it was written, and its last edit if any. */
export function formatThemeNoticeByline(
  notice: Pick<AdminThemeNotice, 'createdAt' | 'createdBy' | 'editedAt'>,
): string {
  const edited =
    notice.editedAt === null
      ? ''
      : ` · ${copy.adminThemeNoticeEditedAt} ${formatKst(notice.editedAt)}`;
  return `${formatKst(notice.createdAt)} · ${themeActorName(notice.createdBy)}${edited}`;
}
