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
 * `timestamp(3)` (packages/db `timestampTz` and `schema/auth.ts`, migration 0005): a JS Date
 * cannot hold more, and drizzle truncates the rest on the way in and out. Widen a column back
 * to microseconds and the comparison silently drops every row sharing the cursor row's
 * millisecond — the loss is one-directional, so it never repeats a row, only omits one.
 */
export interface Keyset {
  createdAt: Date;
  id: string;
}

export function encodeKeyset({ createdAt, id }: Keyset): string {
  return `${createdAt.getTime().toString()}_${id}`;
}

/** ECMA-262 time-value range; past this `new Date(ms)` is an Invalid Date. */
const MAX_DATE_MS = 8_640_000_000_000_000;

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
  // `Number.isSafeInteger` admits 9.007e15 but Date stops at 8.64e15, and drizzle's timestamp
  // encoder calls `toISOString()` on the result — on an Invalid Date that throws RangeError
  // before any query is sent, so the range has to be checked here.
  if (!Number.isSafeInteger(millis) || millis < 0 || millis > MAX_DATE_MS) return undefined;
  if (id.length === 0 || !KEYSET_ID_SHAPES[idShape](id)) return undefined;
  return { createdAt: new Date(millis), id };
}
