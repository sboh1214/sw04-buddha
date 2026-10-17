import * as z from 'zod';
import { uuidParamSchema } from './path-param.js';

/** PLAN 7: cursor pagination, 20 by default and 100 at most. */
export const PAGE_LIMIT_DEFAULT = 20;
export const PAGE_LIMIT_MAX = 100;

export const cursorQuerySchema = z
  .object({
    /** Opaque; comes from `meta.nextCursor` of the previous page. */
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  })
  .meta({ id: 'CursorQuery' });
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/**
 * Keyset cursor over `(created_at DESC, id DESC)`: the timestamp alone is not unique, and an
 * offset would skip or repeat rows while new entries arrive. Encoded as `<epochMillis>_<id>`
 * so it stays printable in a query string; treated as opaque by clients.
 *
 * `epochMillis` is only a faithful cursor because every timestamptz column is declared
 * `timestamp(3)` — the `timestampTz` helper in packages/db, the matching local one in
 * `schema/auth.ts`, migrations 0005 and 0007: a JS Date cannot hold more, and drizzle
 * truncates the rest on the way in and out. Widen a column back to microseconds and the
 * comparison silently drops every row sharing the cursor row's millisecond — the loss is
 * one-directional, so it never repeats a row, only omits one.
 */
export interface Keyset {
  createdAt: Date;
  id: string;
}

export function encodeKeyset({ createdAt, id }: Keyset): string {
  return `${createdAt.getTime().toString()}_${id}`;
}

/**
 * The last instant a cursor may name, 9999-12-31T23:59:59.999Z: every time half of every cursor
 * (`decodeKeyset`, the `millis` shapes) is bounded by it. ECMA-262 dates run on to 8.64e15 (year
 * 275760), but from year 10000 on `toISOString()` writes an expanded year
 * ('+010000-01-01T00:00:00.000Z'), and the API binds that string as `::timestamptz`, which Postgres
 * refuses (22009, time zone displacement out of range) — a 500 where a malformed cursor must serve
 * the first page. No real row is later: every time the API stores is `now()` or a
 * `z.iso.datetime()`, which takes four-digit years only, so no cursor the server mints is refused.
 */
const CURSOR_MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/**
 * How the id half may be shaped, because it is compared against a typed column and the caller
 * is the only one that knows which. Unvalidated, `0_not-a-uuid` reaches `id < $1` on a uuid
 * column and Postgres raises 22P02 — a driver error the exception filter can only render as a
 * 500, which is the same reasoning `uuidParamSchema` was added for.
 */
const KEYSET_ID_SHAPES = {
  uuid: (id: string) => uuidParamSchema.safeParse(id).success,
  /**
   * Digits only, so the caller's `Number(keyset.id)` is a safe integer. Rejects 'NaN' and
   * '0.5' (both 22P02 on a bigint) and '99999999999999999999' (22003, out of range).
   */
  int: (id: string) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)),
  /** better-auth's `user.id` is `text`, so any string is a legal comparand. */
  text: () => true,
} as const;
export type KeysetIdShape = keyof typeof KEYSET_ID_SHAPES;

/**
 * `undefined` for a malformed or absent cursor: callers then start from the first page.
 *
 * `idShape` is required on purpose. A default would quietly hand the next call site the
 * permissive branch, which is exactly how a hand-written `?cursor=0_not-a-uuid` came to 500
 * the API; making it explicit costs one word and makes the compiler list every site.
 */
export function decodeKeyset(
  cursor: string | undefined,
  idShape: KeysetIdShape,
): Keyset | undefined {
  if (!cursor) return undefined;
  const separator = cursor.indexOf('_');
  if (separator <= 0) return undefined;
  const millis = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  // `Number.isSafeInteger` admits 9.007e15 but Date stops at 8.64e15, and the predicate calls
  // `toISOString()` on the result — on an Invalid Date that throws RangeError before any query is
  // sent, and past year 9999 it writes a year Postgres refuses — so the range is checked here.
  if (!Number.isSafeInteger(millis) || millis < 0 || millis > CURSOR_MAX_MS) return undefined;
  if (id.length === 0 || !KEYSET_ID_SHAPES[idShape](id)) return undefined;
  return { createdAt: new Date(millis), id };
}

/** Largest int8 Postgres accepts; anything above is SQLSTATE 22003. */
const INT8_MAX = 9_223_372_036_854_775_807n;

/**
 * What a value part of a tuple cursor may say for a NULL key: `open_at` before a market opens,
 * which the open-time key of 신규 and 추천 sorts after every open time (`NULLS LAST`, ADR-0065) —
 * last in 신규, last among its own 24-hour volume in 추천. Not digits, so no shape but
 * `nullableMillis` accepts it, and free of `_`, the separator.
 */
export const CURSOR_NULL = 'null';

const millisShape = (value: string) =>
  /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= CURSOR_MAX_MS;

const SORT_VALUE_SHAPES = {
  /** A non-negative bigint (volume_coin, a SUM of fills.amount_coin): digits only, within int8. */
  int: (value: string) => /^\d+$/.test(value) && BigInt(value) <= INT8_MAX,
  /** Epoch milliseconds for a timestamp(3) column, with the same range as `decodeKeyset`. */
  millis: millisShape,
  /** The same for a nullable column, `CURSOR_NULL` standing for NULL. */
  nullableMillis: (value: string) => value === CURSOR_NULL || millisShape(value),
  /**
   * Which of an order's two groups the row is in, `0` or `1`: 마감 임박 over a list that can hold
   * ended markets, the 진행 중 ones first (ADR-0066, owner decision 2026-10-16).
   */
  group: (value: string) => value === '0' || value === '1',
} as const;
export type TupleCursorValueShape = keyof typeof SORT_VALUE_SHAPES;

/**
 * Keyset cursor for an order of several keys and the id, `<value>_<value>_…_<id>`: the market
 * orders of ADR-0065, whose keys are more than one value or may be NULL. `GET /markets?sort=newest`
 * pages on `(open_at, id)` with `open_at` nullable; `sort=recommended` on the window end it was
 * first read at, the 24-hour volume under that window and `(open_at, id)` again; `sort=closing`,
 * on a list that can hold ended markets, on the market's group (진행 중 or ended), its close time
 * and the id (ADR-0066). The values are digits or `CURSOR_NULL`, never `_`, so every separator
 * before the id is one of theirs and the id itself may contain one (a `text` id). With one value
 * it is the `<value>_<id>` cursor the volume order of `GET /markets` paged on (`(volume_coin
 * DESC, id DESC)`, `int`) until ADR-0065 removed that order; #132 brings it back on this cursor
 * and `tupleKeysetPredicate`.
 */
export interface TupleCursor {
  /** One decimal string (or `CURSOR_NULL`) per value shape the caller named, in order. */
  values: string[];
  id: string;
}

export function encodeTupleCursor(values: readonly string[], id: string): string {
  return [...values, id].join('_');
}

/**
 * `undefined` for a malformed or absent cursor, like `decodeKeyset`: a part missing, a part too
 * many before an id that is not of `idShape`, or a value not of its shape. A cursor of another
 * order is one of those unless it happens to have the same shape — an order with the same parts
 * then reads it as a page of its own, as two `<millis>_<uuid>` orders always have. The value
 * shapes are named by the caller for the same reason `idShape` is: every part is compared against
 * a typed column, and a bad comparand is a 500 rather than an empty page.
 */
export function decodeTupleCursor(
  cursor: string | undefined,
  valueShapes: readonly TupleCursorValueShape[],
  idShape: KeysetIdShape,
): TupleCursor | undefined {
  if (!cursor) return undefined;
  const values: string[] = [];
  let rest = cursor;
  for (const shape of valueShapes) {
    const separator = rest.indexOf('_');
    if (separator <= 0) return undefined;
    const value = rest.slice(0, separator);
    if (!SORT_VALUE_SHAPES[shape](value)) return undefined;
    values.push(value);
    rest = rest.slice(separator + 1);
  }
  if (rest.length === 0 || !KEYSET_ID_SHAPES[idShape](rest)) return undefined;
  return { values, id: rest };
}
