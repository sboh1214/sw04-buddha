import { type Keyset } from '@buddha/shared';
import { sql, type SQL } from 'drizzle-orm';
import { type AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * How the id half of a cursor must be cast for Postgres to compare it against its column.
 * Mirrors `KeysetIdShape` in packages/shared: `uuid` columns, `bigserial` ids, and better-auth's
 * `text` user id. A closed union of literals THIS package writes, never a caller's string —
 * `sql.raw` below renders it verbatim, so nothing request-supplied may ever reach it.
 */
export type KeysetIdCast = 'uuid' | 'bigint' | 'text';

/**
 * The cursor predicate of a keyset page, as a ROW COMPARISON.
 *
 * Every list in this API pages on `(sortKey, id)` and used to express "the page after this
 * cursor" as the equivalent disjunction — `a < $1 OR (a = $1 AND b < $2)`. It returns the same
 * rows, and that is the only thing it does the same. Postgres cannot turn a disjunction into an
 * index condition, so it attaches it as a FILTER: the scan starts at the top of the index and
 * discards every row before the cursor, one at a time, on every page. Page 5,000 pays for the
 * 100,000 rows in front of it — measured at 9.7 ms and 3,509 buffers on `/admin/payments` at
 * 95,000 rows during the M2 review, on a table with no index to help either way.
 * `(a, b) < ($1, $2)` is a single ordered comparison the planner CAN push into a multicolumn
 * index, so the same page becomes one descent.
 *
 * This is why the M2 and M3 reviews refused four separate "add an index" suggestions and wrote
 * "전역 키셋 목록 넷 + 행 비교 술어" into the M6 item instead (A-M3-10, DECISIONS 587/659/884):
 * the index and this predicate are one change. The index alone leaves a deep page exactly as
 * slow — it is still a Filter — and on `/admin/users` an ordered index makes a RARE search term
 * slower still (3.6 s -> 10.0 s at 2M rows), because it tempts the planner into walking the
 * index to fill a LIMIT the `ILIKE` filter almost never satisfies. That last one is a separate
 * problem this predicate does not solve and is not asked to: it fails on the FIRST page, where
 * there is no cursor at all (ADR-0039, Q-M6-7).
 *
 * The casts are not decoration. A bare parameter inside a row constructor gives Postgres no
 * context to infer a type from, so it either fails to plan or compares as `text` — which sorts
 * `'10'` before `'9'`. The timestamp is passed as an ISO string rather than a `Date` for the
 * same reason the tick probe does (market.service.ts `hasOlderTick`, the one row comparison
 * that predates this): the cast is what fixes the type, so the value must be something
 * `::timestamptz` accepts. Both halves are BOUND PARAMETERS; only the cast keyword is rendered.
 *
 * `timestamp(3)` everywhere is what makes the millisecond cursor exact — see `Keyset` in
 * packages/shared for why that matters and what widening a column would silently break.
 */
export function keysetPredicate(
  sortColumn: AnyPgColumn,
  idColumn: AnyPgColumn,
  keyset: Keyset,
  idCast: KeysetIdCast,
  /** `before` for a DESC page (the default), `after` for an ASC one. */
  direction: 'before' | 'after' = 'before',
): SQL {
  const cursor = sql`(${keyset.createdAt.toISOString()}::timestamptz, ${keyset.id}::${sql.raw(idCast)})`;
  return direction === 'before'
    ? sql`(${sortColumn}, ${idColumn}) < ${cursor}`
    : sql`(${sortColumn}, ${idColumn}) > ${cursor}`;
}

/**
 * The same, for a sort whose first key is not a timestamp: `GET /markets?sort=volume` orders by
 * `(volume_p DESC, id DESC)` and its cursor carries a bigint. Split from `keysetPredicate`
 * rather than made generic over the cast, because the two cursors are decoded by two different
 * validators in packages/shared and mixing them up is exactly the mistake `idShape` exists to
 * prevent.
 */
export function sortKeysetPredicate(
  sortColumn: AnyPgColumn,
  idColumn: AnyPgColumn,
  cursor: { value: string; id: string },
  valueCast: 'bigint',
  idCast: KeysetIdCast,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) < (${cursor.value}::${sql.raw(valueCast)}, ${cursor.id}::${sql.raw(idCast)})`;
}
