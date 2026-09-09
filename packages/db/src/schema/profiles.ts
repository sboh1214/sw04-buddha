import { desc } from 'drizzle-orm';
import { index, pgTable, text, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, updatedAt } from './columns.js';
import { roleEnum } from './enums.js';

/**
 * One row per better-auth user. Created together with `balances` by the AFTER INSERT
 * trigger on "user" (migration 0002_user_profile_trigger, PLAN 10.4: same transaction).
 * Nickname is mandatory from day one (PLAN 6.3); charset: nicknameSchema in @buddha/shared.
 */
export const profiles = pgTable(
  'profiles',
  {
    userId: text()
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    nickname: varchar({ length: 20 }).notNull().unique(),
    role: roleEnum().notNull().default('user'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
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
