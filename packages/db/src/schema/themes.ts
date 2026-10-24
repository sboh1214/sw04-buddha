import { desc, sql } from 'drizzle-orm';
import { check, date, index, pgTable, primaryKey, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, timestampTz, updatedAt } from './columns.js';
import { markets } from './markets.js';

/**
 * 테마 (#81, ADR-0069 decision 4): markets an admin gathers under a name, an introduction and a
 * period, with the page's own notices. Three tables: the theme, the markets in it, its notices.
 *
 * A theme is unpublished and never deleted (the owner's '공개 뒤' row), and a notice is hidden and
 * never deleted (owner decision 2026-10-19): buddha_app holds no DELETE on `themes` or
 * `theme_notices` (migration 0043). Taking a market out of a theme deletes its `theme_markets`
 * row, as an unlink does in `market_links` (ADR-0068). The history of every write — who and when,
 * no reason — is `admin_actions` (the `theme_*` types), written in the same transaction as the
 * change.
 *
 * Nothing about a market is kept here or changed by these tables: a theme references markets
 * (RESTRICT, markets are never deleted) and no rule, order, fill, position or settlement path
 * reads them (N05 §7). The admin columns are RESTRICT like `admin_actions.admin_id`.
 */
export const themes = pgTable(
  'themes',
  {
    id: uuid().primaryKey().defaultRandom(),
    /**
     * The theme page's address, `/themes/<slug>` (owner decision 2026-10-19): the operator's
     * choice at creation, in a market slug's alphabet (`themeSlugSchema`, @buddha/shared). It may
     * change until the theme is first published, never after (`first_published_at`): the
     * address may have been announced by then.
     */
    slug: varchar({ length: 80 }).notNull().unique(),
    name: varchar({ length: 100 }).notNull(),
    /** Plain text with its line breaks (THEME_INTRO_MAX, @buddha/shared). */
    intro: text().notNull(),
    /**
     * The period in Korean dates, both days included (owner decision 2026-10-19): 예정 before
     * `start_date`, 진행 중 from 00:00 KST of `start_date` through `end_date`, 종료 from 00:00 KST
     * of the day after `end_date` (`themeStatusAt`). Dates rather than instants: the operator
     * enters days and the page shows days ('10월 20일 ~ 11월 3일'). A one-day theme starts and
     * ends on the same date.
     */
    startDate: date({ mode: 'string' }).notNull(),
    endDate: date({ mode: 'string' }).notNull(),
    /**
     * When it was last made public; NULL while it is not — never published, or unpublished. Only
     * a theme with one is in a public answer.
     */
    publishedAt: timestampTz(),
    /**
     * The first time it was made public, kept through every unpublish: from then on the slug is
     * fixed. NULL for a theme never published.
     */
    firstPublishedAt: timestampTz(),
    createdBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * `GET /themes` and a market detail's links read the published themes and sort them by
     * status at the request's Korean date (진행 중 → 예정 → 종료, owner decision 2026-10-19); the
     * status filters are ranges on the two dates. Few rows: the operator makes them.
     */
    index('themes_published_end_date_idx')
      .on(t.endDate, t.startDate)
      .where(sql`${t.publishedAt} IS NOT NULL`),
    /** `GET /admin/themes`: every theme, the newest first. */
    index('themes_created_at_id_idx').on(desc(t.createdAt), desc(t.id)),
    check('themes_period_check', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

/**
 * The markets in a theme, one row per (theme, market). No cap, and a market may be in several
 * themes (the owner's '편성 규칙' row); a market in any status may be put in — the public answers
 * leave out a draft. `created_by` and `created_at` say who put it in, for the admin's list.
 */
export const themeMarkets = pgTable(
  'theme_markets',
  {
    themeId: uuid()
      .notNull()
      .references(() => themes.id, { onDelete: 'restrict' }),
    marketId: uuid()
      .notNull()
      .references(() => markets.id, { onDelete: 'restrict' }),
    createdBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [
    /** One row per pair; its leading `theme_id` serves a theme's markets. */
    primaryKey({ columns: [t.themeId, t.marketId] }),
    /** A market's themes: the links on its detail (`GET /markets/:id/themes`). */
    index('theme_markets_market_id_idx').on(t.marketId),
  ],
);

/**
 * A theme page's notices (#45 item 8: the theme's own, not the community's #138), plain text.
 * `edited_at` is the last change of the title or the body, NULL if none; `hidden_at` takes a
 * notice off the public page, NULL while it shows. Neither is touched by the other.
 */
export const themeNotices = pgTable(
  'theme_notices',
  {
    id: uuid().primaryKey().defaultRandom(),
    themeId: uuid()
      .notNull()
      .references(() => themes.id, { onDelete: 'restrict' }),
    title: varchar({ length: 100 }).notNull(),
    body: text().notNull(),
    createdBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    editedAt: timestampTz(),
    hiddenAt: timestampTz(),
  },
  (t) => [
    /** A theme's notices, the newest first (the page and the admin's). */
    index('theme_notices_theme_id_created_at_id_idx').on(t.themeId, desc(t.createdAt), desc(t.id)),
  ],
);
