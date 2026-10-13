import { pgTable, text, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt, updatedAt } from './columns.js';

/**
 * Real name and mobile number of an account (ADR-0043), at most one row per user. Collected as
 * a PG's buyer details, which no PG reads since SmartroPay went (ADR-0049, D8 keeps the
 * collection); an account without a row is sent to `/onboarding`. Unverified for now (본인인증
 * comes later): shapes are checked by `contactFieldsSchema` in @buddha/shared (the two stored
 * fields; `contactBodySchema` adds the request's `expectedAccountId`), which stores the phone
 * as digits only.
 *
 * CASCADE like `profiles`: personal data goes with the account, and nothing else references it.
 */
export const userContacts = pgTable('user_contacts', {
  userId: text()
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  realName: varchar({ length: 30 }).notNull(),
  /** Digits only, e.g. 01012345678. */
  phone: varchar({ length: 11 }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
