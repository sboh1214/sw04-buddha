import { desc, sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
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
    /**
     * The account's public id (#46, ADR-0069 decision 3 #37-2 and decision 5): what public answers
     * name the account by — a post's author, #41's `/u/<publicId>` — so the account id never
     * leaves the server in one. Drawn by the database for every new row (`gen_public_id()`,
     * migration 0033, which gave the existing rows theirs too) and never changed: a link keeps
     * pointing at the same person when the nickname changes. PUBLIC_ID_PATTERN in @buddha/shared
     * is the CHECK's shape.
     */
    publicId: varchar({ length: 10 })
      .notNull()
      .unique('profiles_public_id_unique')
      .default(sql`gen_public_id()`),
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
     * (#58, #57-7: never asked again) — the skip also what its screen sends when the account leaves
     * it, or the start-Coin notice before it, unanswered, and a first pick in MY 설정 answering it
     * too (ADR-0078) — or null while it was not. The categories themselves are
     * `profile_interest_categories`.
     */
    interestsAnsweredAt: timestampTz(),
    /**
     * The 소개 of the public profile (#41, ADR-0069 decision 3 #37-3): plain text the member writes
     * in MY 설정, at most BIO_MAX_LENGTH characters (`varchar` counts characters as
     * `codePointLength` does), line breaks kept, never drawn as a link; null while there is none,
     * and then the profile shows nothing. Normalised by `bioInputSchema` (@buddha/shared), which
     * turns a blank one into null — the CHECK below holds that. During a writing or an account
     * restriction it can be emptied but not set anew (#37-9, decision 7).
     */
    bio: varchar({ length: 160 }),
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
    /** Ten of the 32 characters of PUBLIC_ID_ALPHABET (no 0/o, 1/i). */
    check('profiles_public_id_check', sql`${t.publicId} ~ '^[2-9a-hj-np-z]{10}$'`),
    /** A bio is absent or has text: the API stores a blank one as none, as a post's title. */
    check('profiles_bio_check', sql`${t.bio} IS NULL OR btrim(${t.bio}) <> ''`),
  ],
);
