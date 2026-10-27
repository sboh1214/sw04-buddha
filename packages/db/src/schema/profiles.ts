import { desc, sql } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, timestampTz, updatedAt } from './columns.js';
import { roleEnum } from './enums.js';

/**
 * One row per better-auth user. Created together with `balances` by the AFTER INSERT
 * trigger on "user" (migration 0002_user_profile_trigger, PLAN 10.4: same transaction).
 * Nickname is mandatory from day one (PLAN 6.3); charset: nicknameSchema in @buddha/shared.
 * Unique ignoring case (#58, ADR-0069 decision 1 #57-6): the unique index is on `lower(nickname)`,
 * so 'Abc' keeps 'abc' out (`nicknameKey` in @buddha/shared is the same comparison).
 */
export const profiles = pgTable(
  'profiles',
  {
    userId: text()
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    nickname: varchar({ length: 20 }).notNull(),
    role: roleEnum().notNull().default('user'),
    /**
     * The IANA zone the member picked in MY 설정 for reading times (ADR-0061 #60-8, ADR-0063),
     * or null for "follow the browser". Here rather than in a table of its own: it is one
     * display preference of the account, like the nickname, and the trigger already guarantees
     * the row. The name is checked by `timeZoneSchema` (@buddha/shared) and stored as given;
     * TIME_ZONE_MAX_LENGTH is this width.
     */
    timeZone: varchar({ length: 64 }),
    /**
     * When the onboarding's nickname step was done (#58): the nickname offered — the auto one, or
     * a seeded one — confirmed as it is, or another chosen. Null until then: the nickname step is
     * what is left. Not a change (#57-6): `nickname_changed_at` stays as it was.
     */
    nicknameConfirmedAt: timestampTz(),
    /**
     * The last change of the nickname after the onboarding (`PATCH /me`), or null: the next one
     * waits NICKNAME_CHANGE_INTERVAL_DAYS after it (#57-6).
     */
    nicknameChangedAt: timestampTz(),
    /**
     * When the onboarding's interest categories step was answered, categories chosen or skipped
     * (#58, #57-7: never asked again), or null while it was not. The categories themselves are
     * `profile_interest_categories`.
     */
    interestsAnsweredAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * Uniqueness ignoring case (#57-6). Replaced the exact `profiles_nickname_unique` in migration
     * 0032, which gave the case variants already there auto nicknames first. A violation names
     * this index (`NICKNAME_UNIQUE_INDEX` in apps/api), and the auto nickname's generator retries
     * on it as on any unique violation.
     */
    uniqueIndex('profiles_nickname_lower_unique').on(sql`lower(${t.nickname})`),
    /**
     * `GET /admin/users`: the global list, ordered `(created_at DESC, user_id DESC)`. One of the
     * "전역 키셋 목록 넷" A-M3-10 handed to M6.
     *
     * `user_id`, not `"user".id`. The values are identical (the FK guarantees it, so a cursor a
     * client already holds keeps working), but a row comparison can only become an Index Cond
     * when both halves come from ONE table — the M2 review measured 384 ms with the cross-table
     * form, and at 2M rows it is 7.36 s and 8.6 MILLION buffers against 0.19 ms here.
     *
     * Measured at 2M rows: the unfiltered list goes 4193 ms -> 0.22 ms first page and 1810 ms ->
     * 0.19 ms deep (78,098 -> 215 buffers), and a COMMON search term 4535 ms -> 1.06 ms. A RARE
     * search term goes the other way (3.6 s -> 10.0 s) and that regression is real, separate and
     * recorded as Q-M6-7: it is the `ILIKE` filter meeting an ordered `LIMIT`, has nothing to do
     * with the cursor, is not fixed by the row comparison, and its own branch is already
     * unusable at that volume without the index. Its fix is a trigram index, not the withholding
     * of this one.
     */
    index('profiles_created_at_user_id_idx').on(desc(t.createdAt), desc(t.userId)),
  ],
);
