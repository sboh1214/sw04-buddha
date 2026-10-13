/**
 * better-auth 1.7.2 tables (PLAN 6.1). Generated with
 *   pnpm --filter @buddha/db run db:auth-schema
 * (the `auth` CLI, config in packages/db/better-auth.config.ts) and adjusted by hand:
 * every `timestamp()` got `{ withTimezone: true, mode: 'date', precision: 3 }` (repo
 * convention, matching schema/columns.ts — a JS Date holds no more than milliseconds) and the
 * `relations()` block the CLI appends was removed: every relation on these tables lives once
 * in relations.ts (drizzle merges duplicate `relations(user, ...)` calls at runtime but not
 * in the query types). Column names are explicit snake_case, so drizzle's `casing` setting
 * does not affect them. better-auth reads/writes these tables through its Drizzle adapter;
 * application code never writes them (PLAN 6.1) except the seed, test factories and an admin
 * revoke, which deletes the account's `session` rows to sign it out everywhere (#171).
 * Re-run the generator only on a better-auth upgrade and diff against this file.
 */
import { boolean, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamptz('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    // No DB default (CLI output): better-auth always sets it; raw inserts must too.
    updatedAt: timestamptz('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_userId_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    /** 'local:credential' for email/password, the provider issuer or 'local:oauth:<id>' for OAuth. */
    issuer: text('issuer').notNull(),
    /** Provider-side subject; equals user.id for credential accounts. */
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamptz('access_token_expires_at'),
    refreshTokenExpiresAt: timestamptz('refresh_token_expires_at'),
    scope: text('scope'),
    /** scrypt hash "<salt hex>:<key hex>" (better-auth/crypto hashPassword); NULL for OAuth. */
    password: text('password'),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('account_issuer_accountId_uidx').on(table.issuer, table.accountId),
    index('account_userId_idx').on(table.userId),
  ],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);
