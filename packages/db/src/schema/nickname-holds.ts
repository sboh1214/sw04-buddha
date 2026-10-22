import { sql } from 'drizzle-orm';
import { bigserial, index, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { timestampTz } from './columns.js';
import { moderationActions } from './moderation.js';

/**
 * Nicknames given up (#58, ADR-0069 decision 1 #57-6 and #37-16): one row each time an account's
 * nickname is replaced — a change in MY 설정, the onboarding's nickname step choosing another one,
 * and later a withdrawal (#140) — so no OTHER account takes it for NICKNAME_HOLD_DAYS after
 * `released_at`, ignoring case (`nickname_held()`, migration 0032). The auto nickname's generator
 * (`create_profile_for_user()`) respects it too.
 *
 * `user_id` names the account that gave it up, which may take it back: it is not another account.
 * A withdrawal cuts that link (#57-18: «계정과의 연결을 끊은 채 재사용을 막는 기록으로만 30일
 * 남는다», `ON DELETE SET NULL` and #140's own UPDATE), and a row with none holds it from everybody.
 * An operator's reset of a nickname to an auto nickname writes one with none from the start (#50,
 * owner decision 2026-10-21, ADR-0081): the nickname taken away is held from the member too. That
 * hold names the reset (`action_id`, one hold per action), so the reset's cancellation hands it to
 * the member — `user_id` set to them: the hold no longer keeps it from them, and while it stands
 * they pick it, exactly as it was taken away, with no change interval (owner decisions 2026-10-22
 * (2차) 1 and (3차) 1 — NicknameService), every other account stays held for the rest of the 30
 * days (owner decision 2026-10-22, ADR-0081 7-13). Every other hold names no action. Former
 * nicknames are never shown (#37-3, PRIVATE_DATA `former-nickname`). A row past the hold no longer
 * counts; removing it is #184's retention work.
 */
export const nicknameHolds = pgTable(
  'nickname_holds',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    nickname: varchar({ length: 20 }).notNull(),
    userId: text().references(() => user.id, { onDelete: 'set null' }),
    releasedAt: timestampTz().defaultNow().notNull(),
    // The operator's nickname reset that took it away (#50), kept as long as the hold (#184 removes
    // the hold first); null for a member's own change and a withdrawal.
    actionId: uuid()
      .unique('nickname_holds_action_id_unique')
      .references(() => moderationActions.id, { onDelete: 'restrict' }),
  },
  (t) => [
    // `nickname_held()`: the holds of one nickname, ignoring case, newest first.
    index('nickname_holds_nickname_lower_released_at_idx').on(
      sql`lower(${t.nickname})`,
      t.releasedAt,
    ),
    index('nickname_holds_user_id_idx').on(t.userId),
  ],
);
