import { pgTable, text, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, updatedAt } from './columns.js';
import { roleEnum } from './enums.js';

/**
 * One row per better-auth user. Created together with `balances` by the AFTER INSERT
 * trigger on "user" (migration 0002_user_profile_trigger, PLAN 10.4: same transaction).
 * Nickname is mandatory from day one (PLAN 6.3); charset: nicknameSchema in @buddha/shared.
 */
export const profiles = pgTable('profiles', {
  userId: text()
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  nickname: varchar({ length: 20 }).notNull().unique(),
  role: roleEnum().notNull().default('user'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
