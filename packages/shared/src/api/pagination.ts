import * as z from 'zod';

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

/** `undefined` for a malformed or absent cursor: callers then start from the first page. */
export function decodeKeyset(cursor: string | undefined): Keyset | undefined {
  if (!cursor) return undefined;
  const separator = cursor.indexOf('_');
  if (separator <= 0) return undefined;
  const millis = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (!Number.isSafeInteger(millis) || millis < 0 || id.length === 0) return undefined;
  return { createdAt: new Date(millis), id };
}
