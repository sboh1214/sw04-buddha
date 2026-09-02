import { timestamp } from 'drizzle-orm/pg-core';

/** timestamptz mapped to JS Date (PLAN 7: serialised as ISO 8601 UTC at the API boundary). */
export const timestampTz = () => timestamp({ withTimezone: true, mode: 'date' });

/** created_at: set by the database. */
export const createdAt = () => timestampTz().defaultNow().notNull();

/**
 * updated_at: set by the database on INSERT; drizzle's `$onUpdate` refreshes it on every
 * `db.update()` issued through the ORM. Raw SQL updates (`db.execute`) must set it themselves.
 */
export const updatedAt = () =>
  timestampTz()
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());
