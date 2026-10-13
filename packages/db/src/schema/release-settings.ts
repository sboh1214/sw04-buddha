import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { timestampTz } from './columns.js';
import { releaseSettingStatusEnum } from './enums.js';

/**
 * The stored status and value of each release setting (#170). What an item IS lives in code
 * (RELEASE_SETTINGS in @buddha/shared); a registered key with no row here is `undecided`, and a row
 * is first written by the first change.
 *
 * Changed only together with its record: a deferred constraint trigger (migration 0020) refuses,
 * at COMMIT, an INSERT or UPDATE without an `admin_actions` row of type `release_setting_change`
 * naming this key, `updated_by`, `updated_at` and the new status and value (payload `after`), and
 * an UPDATE that does not move `updated_at` forward — so a record an earlier write used cannot be
 * replayed. buddha_app cannot DELETE a row either — going back to `undecided` is a change like
 * any other — so the record is the whole history. Only the API's ReleaseSettingsService writes
 * here, the record in the same transaction; no seed or migration sets a value, so every item
 * starts `undecided` after a dev setup or a reset (owner decision 2026-10-13~14). Read the value
 * through `storedReleaseSettingValue` / `getReleaseSetting` (release-settings.ts), never the bare
 * column.
 */
export const releaseSettings = pgTable(
  'release_settings',
  {
    /** RELEASE_SETTING_KEY_PATTERN, at most RELEASE_SETTING_KEY_MAX_LENGTH. */
    key: varchar({ length: 64 }).primaryKey(),
    /** The definition's schema output; SQL NULL exactly while `undecided` (never JSON null). */
    value: jsonb().$type<unknown>(),
    status: releaseSettingStatusEnum().notNull(),
    /**
     * The change's instant: equal to its admin_actions `created_at`, and later than the previous
     * one of the key. Written explicitly.
     */
    updatedAt: timestampTz().notNull(),
    updatedBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
  },
  (t) => [
    check(
      'release_settings_value_status_check',
      sql`(${t.status} = 'undecided') = (${t.value} IS NULL) AND jsonb_typeof(${t.value}) IS DISTINCT FROM 'null'`,
    ),
  ],
);
