import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { cursorQuerySchema } from './api/pagination.js';
import { uuidSchema } from './api/uuid.js';
import { outcomeSchema } from './enums.js';
import { type PublicMarketStatus, marketSlugSchema, marketSummarySchema } from './market.js';

/**
 * 테마 (#81): the 주제별 시장 묶음과 운영 소개 페이지 of N05 §7 — markets an admin gathers under a
 * name, an introduction and a period, with notices of its own and the results of its markets.
 * Owner decisions (ADR-0069 decision 4, the #81 rows):
 *
 * - The name on screen is '테마'. There is no ranking, winner, entry fee, prize, Coin reward,
 *   badge or sign-up of any kind, and no page says so: the service guide (#136) does.
 * - Visitors reach a theme by the public list, by the market detail's links to the themes it is
 *   in, by the explore home and by its address alone; signed out as well.
 * - The period sorts a theme as 예정·진행 중·종료 (`ThemeStatus`).
 * - Composition is free: no cap on markets, a market may be in several themes, no category tie,
 *   markets that open or close outside the period may be in it, and it may be changed after the
 *   period. A draft market is in no public answer.
 * - The notices are the theme page's own, written by admins (#45 item 8) — not the community's
 *   pinned notices (#138).
 * - The results list is the linked markets that are 판정 완료·정산 완료·무효 with their result
 *   (YES·NO·무효); no one's performance or PnL. Provisional results wait for #174.
 * - A published theme can be unpublished and never deleted.
 * - Creating, editing, linking or unlinking a market and publishing or unpublishing record the
 *   admin and the time; no reason and no second admin (as 관련 시장, ADR-0068).
 *
 * And the owner's answers of 2026-10-19 (ADR-0088): the period is Korean dates, both days in it;
 * a notice is plain text whose addresses become links, hidden and shown again but never deleted,
 * and marked 수정됨 once edited; the public list runs 진행 중 → 예정 → 종료; the address is a slug
 * the operator chooses at creation and cannot change once the theme has been published; a voided
 * market is among the theme's cards; a theme is published only with a market in it. And of the
 * second round the same day: that market must be a public one — a draft does not count; the slug
 * stays fixed from the first publish on, through an unpublish; the introduction's addresses are
 * links too; the dates lie within 2000-01-01 and 2100-12-31; the name and introduction bounds
 * stand.
 *
 * A theme changes nothing of its markets: no rule, status, order, fill, position or settlement
 * path reads `themes` or `theme_markets` (N05 §7 "개별 시장의 거래·정산 규칙은 바꾸지 않는다").
 */

/**
 * A theme's name: one line, as long as a notice's title. Chosen by this PR and kept by the owner
 * (2026-10-19, second round, ADR-0088).
 */
export const THEME_NAME_MAX = 100;
/**
 * A theme's introduction: plain text, line breaks kept and web addresses linked on the page, as
 * long as a market's description (`MARKET_TEXT_MAX`). Chosen by this PR and kept by the owner, as
 * the name's bound is.
 */
export const THEME_INTRO_MAX = 5_000;
/** A notice's title: one line, as long as a community post's title (owner decision 2026-10-18, #46). */
export const THEME_NOTICE_TITLE_MAX = 100;
/**
 * A notice's body: plain text, as long as a community notice's (ADR-0069 decision 4, #138); the
 * owner confirmed both bounds for theme notices on 2026-10-19.
 */
export const THEME_NOTICE_BODY_MAX = 5_000;

/**
 * A theme's address, `/themes/<slug>` (owner decision 2026-10-19): chosen by the operator when the
 * theme is made, in a market slug's alphabet and bounds — `a-z`, `0-9`, Korean syllables and `-`,
 * 3 to 80 characters, never uuid-shaped, NFC — so the two kinds of address read alike and `GET
 * /themes/:idOrSlug` can tell an id from a slug as `GET /markets/:idOrSlug` does. It changes until
 * the theme is first published and never after, unpublished or not (owner decision 2026-10-19,
 * second round): an address announced once keeps working.
 */
export const themeSlugSchema = marketSlugSchema;

/** Korea keeps no daylight saving since 1988: a Korean date is the UTC date nine hours on. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

/** The Korean calendar date `now` falls on, `YYYY-MM-DD` — the day a theme's period is read at. */
export function koreanDateAt(now: Date | number): string {
  const at = typeof now === 'number' ? now : now.getTime();
  return new Date(at + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Where a theme stands in its period (ADR-0069 decision 4, #81 '진행 기간'), on screen 예정·진행
 * 중·종료. The period is two Korean dates, both days in it (owner decision 2026-10-19): 예정
 * before 00:00 KST of the start date, 진행 중 from then until the end date is over, 종료 from 00:00
 * KST of the day after the end date. The same wherever the reader is: a Korean midnight is 15:00
 * UTC the day before.
 */
export const THEME_STATUSES = ['upcoming', 'ongoing', 'ended'] as const;
export type ThemeStatus = (typeof THEME_STATUSES)[number];
export const themeStatusSchema = z.enum(THEME_STATUSES);

/**
 * The dates a period may use (owner decision 2026-10-19, second round, ADR-0088): 2000-01-01 to
 * 2100-12-31, both in. The API refuses a date outside them naming the field
 * (`THEME_DATE_OUT_OF_RANGE`), and the admin's date inputs carry both as `min`/`max`. The column
 * itself stores any date Postgres has; the range is the product's, not storage's — and it keeps
 * out the year 0000 `z.iso.date()` takes and Postgres does not (a 500 at the insert otherwise).
 */
export const THEME_DATE_MIN = '2000-01-01';
export const THEME_DATE_MAX = '2100-12-31';
/** The refusal of a date outside `THEME_DATE_MIN`…`THEME_DATE_MAX`, on the field that sent it. */
export const THEME_DATE_OUT_OF_RANGE = `must be between ${THEME_DATE_MIN} and ${THEME_DATE_MAX}`;

/** Whether a string is a real calendar date, `YYYY-MM-DD`: what `z.iso.date()` takes. */
const isCalendarDate = (value: string) => z.iso.date().safeParse(value).success;

/**
 * A period's date as a request sends it: a calendar date within the range. `YYYY-MM-DD` strings
 * order as the dates do. The range is checked on a real calendar date only, so a string that is
 * none — of another shape, or of the right shape but no such day (`2026-02-30`, `1999-02-30`,
 * `2101-13-01`) — is `z.iso.date()`'s one issue, never a second one about the range, whatever its
 * year (zod runs every check, the refinement too, after the date check failed).
 */
const themeDateSchema = z.iso
  .date()
  .refine(
    (value) => !isCalendarDate(value) || (value >= THEME_DATE_MIN && value <= THEME_DATE_MAX),
    { message: THEME_DATE_OUT_OF_RANGE },
  );

/** A theme's period as stored and sent: Korean dates, `YYYY-MM-DD`. */
export interface ThemePeriod {
  startDate: string;
  endDate: string;
}

/**
 * A theme's status at `now`: the one rule every answer's label follows, and the one the API's
 * filters and order spell in SQL against the same Korean date (`koreanDateAt` of one clock read).
 * `YYYY-MM-DD` strings order as the dates do.
 */
export function themeStatusAt(period: ThemePeriod, now: Date | number): ThemeStatus {
  const today = koreanDateAt(now);
  if (today < period.startDate) return 'upcoming';
  if (today <= period.endDate) return 'ongoing';
  return 'ended';
}

/**
 * The order of the public list (owner decision 2026-10-19): 진행 중 first, the soonest to end
 * first; then 예정, the soonest to start first; then 종료, the most recently ended first. A
 * market detail's theme links follow it too.
 */
export const THEME_LIST_STATUS_ORDER = [
  'ongoing',
  'upcoming',
  'ended',
] as const satisfies readonly ThemeStatus[];

/**
 * The statuses of a theme's results list (ADR-0069 decision 4, #81 '결과 목록'): 판정 완료·정산
 * 완료·무효. A judged market's result is YES or NO; a voided one has none. #174 revisits this when
 * a provisional result exists.
 */
export const THEME_RESULT_STATUSES = [
  'resolved',
  'settled',
  'voided',
] as const satisfies readonly PublicMarketStatus[];
export type ThemeResultStatus = (typeof THEME_RESULT_STATUSES)[number];

// ---- public shapes -----------------------------------------------------------------------

const themeSummaryFields = {
  id: z.uuid(),
  /** The page's address, `/themes/<slug>`. */
  slug: z.string(),
  name: z.string(),
  /** The period's first Korean date, `YYYY-MM-DD`: 진행 중 from its 00:00 KST. */
  startDate: z.iso.date(),
  /** The period's last Korean date, in it: 종료 from 00:00 KST of the day after. */
  endDate: z.iso.date(),
  /** At the Korean date of the database clock of the read (`themeStatusAt`). */
  status: themeStatusSchema,
};

/**
 * A theme in a list: the public list (`GET /themes`), the explore home's and a market detail's
 * links (`GET /markets/:id/themes`). Who made or published it is not public.
 */
export const themeSummarySchema = z.object(themeSummaryFields).meta({ id: 'ThemeSummary' });
export type ThemeSummary = z.infer<typeof themeSummarySchema>;

/**
 * One notice of a theme page, plain text whose web addresses the page turns into links (owner
 * decision 2026-10-19). No author: the admin who wrote it is an admin record, and the page speaks
 * for the operators. `editedAt` is the last time its title or body changed, null if never; the
 * page marks an edited notice 수정됨.
 */
export const themeNoticeSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    body: z.string(),
    createdAt: z.iso.datetime(),
    editedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ThemeNotice' });
export type ThemeNotice = z.infer<typeof themeNoticeSchema>;

/**
 * A published theme's page (`GET /themes/:idOrSlug`): the list row, its introduction and the
 * notices it shows, newest first. Its markets and its results are pages of their own (`GET
 * /themes/:id/markets`, `GET /themes/:id/results`), as many as the admin linked.
 */
export const themeSchema = z
  .object({
    ...themeSummaryFields,
    intro: z.string(),
    notices: z.array(themeNoticeSchema),
  })
  .meta({ id: 'Theme' });
export type Theme = z.infer<typeof themeSchema>;

/**
 * One row of a theme's results list (`GET /themes/:id/results`): a linked market that is 판정
 * 완료·정산 완료·무효, its result — YES or NO, null for a voided one — and when that was decided
 * (the judgement, or the voiding). Nothing about anyone's trades in it.
 */
export const themeResultSchema = z
  .object({
    marketId: z.uuid(),
    slug: z.string(),
    title: z.string(),
    status: z.enum(THEME_RESULT_STATUSES),
    result: outcomeSchema.nullable(),
    decidedAt: z.iso.datetime(),
  })
  .meta({ id: 'ThemeResult' });
export type ThemeResult = z.infer<typeof themeResultSchema>;

/**
 * `GET /themes` (no `.meta`: query DTO, expanded per field like `marketListQuerySchema`): the
 * published themes in the list's order (`THEME_LIST_STATUS_ORDER`), or those of one status. The
 * explore home reads the first few of all of them and keeps the leading status's (ADR-0088).
 */
export const themeListQuerySchema = cursorQuerySchema.extend({
  status: themeStatusSchema.optional(),
});
export type ThemeListQuery = z.infer<typeof themeListQuerySchema>;

// ---- admin -------------------------------------------------------------------------------

const themeNameSchema = z.string().trim().min(1).max(THEME_NAME_MAX);
/** Line breaks inside are kept; the ends are trimmed. */
const themeIntroSchema = z.string().trim().min(1).max(THEME_INTRO_MAX);

const themeFields = {
  slug: themeSlugSchema,
  name: themeNameSchema,
  intro: themeIntroSchema,
  startDate: themeDateSchema,
  endDate: themeDateSchema,
};

/**
 * The refusals of the theme writes, as VALIDATION_ERROR details (`{ path: [field], message }`):
 * a slug another theme has, a slug change once the theme has been published, a publish of a
 * theme with no public market in it (owner decisions 2026-10-19: a theme goes public with one
 * market at least, and of the second round, a market that is not a draft — a draft is on no
 * public page, so a theme of drafts alone would be an empty page; taking every market out
 * afterwards is allowed), and a period that would end before it starts, named by the half the
 * request sent — the end when it sent both or the end alone, the start when it sent the start
 * alone (the end is then the stored one). The web reads them to say which, in words that fit.
 */
export const THEME_REFUSALS = {
  slugTaken: { field: 'slug', message: 'already exists' },
  slugFixed: { field: 'slug', message: 'fixed once published' },
  noPublicMarket: {
    field: 'markets',
    message: 'at least one market that is not a draft is required to publish',
  },
  endBeforeStart: { field: 'endDate', message: 'must not be before startDate' },
  startAfterEnd: { field: 'startDate', message: 'must not be after endDate' },
} as const;

/**
 * The period may be one day — both days are in it — and never end before it starts. Only two real
 * calendar dates are compared: a date that is none is its own field's one issue (`themeDateSchema`),
 * and an order against it would be a second issue that means nothing.
 */
function periodInOrder(value: { startDate?: string; endDate?: string }): boolean {
  return (
    value.startDate === undefined ||
    value.endDate === undefined ||
    !isCalendarDate(value.startDate) ||
    !isCalendarDate(value.endDate) ||
    value.endDate >= value.startDate
  );
}
const PERIOD_ORDER = {
  message: THEME_REFUSALS.endBeforeStart.message,
  path: [THEME_REFUSALS.endBeforeStart.field],
};

/**
 * `POST /admin/themes` → an unpublished theme. Every field is required (owner decision
 * 2026-10-19): the address, the name, the introduction and the period.
 */
export const createThemeBodySchema = z
  .object(themeFields)
  .refine(periodInOrder, PERIOD_ORDER)
  .meta({ id: 'CreateThemeBody' });
export type CreateThemeBody = z.infer<typeof createThemeBodySchema>;

/**
 * `PATCH /admin/themes/:id`: any of the fields, at any time — before, during or after the period,
 * published or not — except the slug once the theme has been published (the service refuses it
 * naming `slug`; the same slug again is no change). A period half is checked against the other
 * half as stored, naming the half the body sent.
 */
export const updateThemeBodySchema = z
  .object(themeFields)
  .partial()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'at least one field is required',
  )
  .refine(periodInOrder, PERIOD_ORDER)
  .meta({ id: 'UpdateThemeBody' });
export type UpdateThemeBody = z.infer<typeof updateThemeBodySchema>;

/**
 * `POST /admin/themes/:id/markets`: the market to put in the theme, in any status (a draft too:
 * it shows once it opens), lower-cased on the way in like every request-supplied uuid.
 */
export const linkThemeMarketBodySchema = z
  .object({ marketId: uuidSchema })
  .meta({ id: 'LinkThemeMarketBody' });
export type LinkThemeMarketBody = z.infer<typeof linkThemeMarketBodySchema>;

const themeNoticeFields = {
  title: z.string().trim().min(1).max(THEME_NOTICE_TITLE_MAX),
  /** Plain text, its web addresses linked on the page; line breaks inside kept, the ends trimmed. */
  body: z.string().trim().min(1).max(THEME_NOTICE_BODY_MAX),
};

/** `POST /admin/themes/:id/notices`: a notice the page shows at once (once the theme is public). */
export const createThemeNoticeBodySchema = z
  .object(themeNoticeFields)
  .meta({ id: 'CreateThemeNoticeBody' });
export type CreateThemeNoticeBody = z.infer<typeof createThemeNoticeBodySchema>;

/** `PATCH /admin/themes/:id/notices/:noticeId`: the title, the body or both. */
export const updateThemeNoticeBodySchema = z
  .object(themeNoticeFields)
  .partial()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'at least one field is required',
  )
  .meta({ id: 'UpdateThemeNoticeBody' });
export type UpdateThemeNoticeBody = z.infer<typeof updateThemeNoticeBodySchema>;

const adminThemeSummaryFields = {
  ...themeSummaryFields,
  /** When the theme was last made public; null while it is not (never published, or unpublished). */
  publishedAt: z.iso.datetime().nullable(),
  /** When it was first made public, kept through an unpublish: the slug is fixed from then. */
  firstPublishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

/** A row of the admin's list (`GET /admin/themes`): every theme, published or not. */
export const adminThemeSummarySchema = z
  .object(adminThemeSummaryFields)
  .meta({ id: 'AdminThemeSummary' });
export type AdminThemeSummary = z.infer<typeof adminThemeSummarySchema>;

/**
 * A notice as the admin sees it: hidden ones too, and who wrote it (`AdminAccountActor`, the
 * nickname read with the answer). A hidden notice is off the public page and kept: a notice is
 * hidden and shown again, never deleted, as the theme itself is unpublished and never deleted.
 */
export const adminThemeNoticeSchema = themeNoticeSchema
  .extend({
    hiddenAt: z.iso.datetime().nullable(),
    createdBy: adminAccountActorSchema,
  })
  .meta({ id: 'AdminThemeNotice' });
export type AdminThemeNotice = z.infer<typeof adminThemeNoticeSchema>;

/**
 * One theme for the admin (`GET /admin/themes/:id` and the answer of every theme write but the
 * market links): the list row, the introduction, who made it and every notice, newest first.
 */
export const adminThemeSchema = z
  .object({
    ...adminThemeSummaryFields,
    intro: z.string(),
    createdBy: adminAccountActorSchema,
    notices: z.array(adminThemeNoticeSchema),
  })
  .meta({ id: 'AdminTheme' });
export type AdminTheme = z.infer<typeof adminThemeSchema>;

/**
 * One market of a theme for the admin (`GET /admin/themes/:id/markets` and the answer of a link
 * or an unlink): the list row every screen draws, in any status, and who linked it when — the
 * actor and the time, all that is recorded (as `AdminRelatedMarket`, ADR-0068).
 */
export const adminThemeMarketSchema = marketSummarySchema
  .extend({
    linkedBy: adminAccountActorSchema,
    linkedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminThemeMarket' });
export type AdminThemeMarket = z.infer<typeof adminThemeMarketSchema>;
