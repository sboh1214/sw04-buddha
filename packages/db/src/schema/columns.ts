import { timestamp } from 'drizzle-orm/pg-core';

/**
 * timestamptz mapped to JS Date (PLAN 7: serialised as ISO 8601 UTC at the API boundary).
 *
 * Millisecond precision on purpose. Postgres defaults to microseconds, but a JS Date holds
 * only milliseconds and drizzle truncates in both directions: it installs its own TIMESTAMPTZ
 * parser (node-postgres never sees the value, so `types.setTypeParser` on the Pool has no
 * effect here) and reads through `new Date(text)`, then writes through `toISOString()`. A
 * microsecond value read back is therefore strictly older than the one still in the column.
 *
 * That silently breaks the keyset cursors of @buddha/shared, whose comparison is
 * `(created_at, id) < (cursor, cursorId)` (apps/api common/keyset.ts; it was the equivalent
 * `a < $1 OR (a = $1 AND b < $2)` disjunction until M6 made it a row comparison, and the
 * failure below is the same either way): a row inside the cursor row's own millisecond is
 * ordered before it and dropped — a whole page when a batch INSERT gives many rows one
 * `now()`. Rounding in the database keeps both sides of that comparison at one
 * precision, and `Date` becomes an exact representation of the column.
 */
export const timestampTz = () => timestamp({ withTimezone: true, mode: 'date', precision: 3 });

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
